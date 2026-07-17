/**
 * Job store: the domain layer over the `jobs` and `job_logs` tables (SPEC.md §8).
 *
 * The `jobs` table is the single source of truth for the queue (SPEC.md §3.1). Two
 * invariants are enforced here so no call site can violate them:
 *
 *   1. State machine. Status only ever moves along `ALLOWED_TRANSITIONS`; an illegal
 *      move throws (a programmer error, not a runtime condition). The eight states are
 *      exactly SPEC.md §8 / CLAUDE.md conventions.
 *   2. Every transition is logged. CLAUDE.md requires "log every transition to
 *      job_logs"; `transition()` writes the row and the log line in ONE SQLite
 *      transaction, so the history can never disagree with the status.
 */

import { ulid } from 'ulid'
import type { Db } from './index.js'
import { nowIso } from './index.js'
import type { EventBus } from '../pipeline/events.js'

export type JobStatus =
  | 'queued'
  | 'preprocessing'
  | 'ingesting'
  | 'done'
  | 'failed'
  | 'deferred'
  | 'duplicate'
  | 'cancelled'

export type JobSource = 'drop' | 'watch' | 'url'
export type JobType = 'pdf' | 'office' | 'web' | 'image' | 'text' | 'av' | 'other'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** States from which no transition is legal — the job is finished, one way or another. */
export const TERMINAL_STATES: readonly JobStatus[] = [
  'done',
  'duplicate',
  'cancelled',
]

/**
 * Legal status moves. `duplicate` is intentionally absent as a *target*: a duplicate is
 * decided at creation (dedupe), never reached by transition. `failed`/`deferred` route
 * back to `queued` — that is how a retry (SPEC.md §3.1) and a later manual re-trigger of
 * a deferred job re-enter the pipeline.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['preprocessing', 'cancelled', 'failed'],
  preprocessing: ['ingesting', 'deferred', 'failed', 'cancelled'],
  ingesting: ['done', 'failed', 'cancelled'],
  failed: ['queued', 'cancelled'],
  deferred: ['queued', 'cancelled'],
  done: [],
  duplicate: [],
  cancelled: [],
}

export interface JobRow {
  id: string
  user_id: string
  batch_id: string | null
  source: JobSource
  type: JobType
  original_name: string | null
  url: string | null
  sha256: string | null
  status: JobStatus
  raw_path: string | null
  created_pages: string | null
  error: string | null
  attempts: number
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface CreateJobInput {
  readonly source: JobSource
  readonly type: JobType
  readonly originalName?: string
  readonly url?: string
  /** Content hash for dedupe. Omit for URL jobs, which are not content-addressed. */
  readonly sha256?: string
  readonly batchId?: string
  readonly userId?: string
  readonly rawPath?: string
}

export interface CreateJobResult {
  readonly job: JobRow
  /** Set when this job was recognised as a duplicate: the id of the job it duplicates. */
  readonly duplicateOf?: string
}

/** Fields a transition may patch alongside the status change. */
export interface JobPatch {
  readonly error?: string | null
  readonly rawPath?: string
  readonly createdPages?: readonly string[]
  readonly tokensIn?: number
  readonly tokensOut?: number
  readonly costUsd?: number
  readonly batchId?: string
}

export class JobStateError extends Error {
  override readonly name = 'JobStateError'
}

export class JobStore {
  /**
   * `bus` is optional so unit tests (and the CLIs) can construct a store without wiring the
   * live-update channel; the service passes one so the dashboard's SSE stream sees every
   * transition and log line. Events are published AFTER the SQLite write commits, never from
   * inside a transaction that might still roll back (SPEC.md §6.5).
   */
  constructor(
    private readonly db: Db,
    private readonly bus?: EventBus,
  ) {}

  /**
   * Creates a job. If `sha256` matches an existing job that still owns its hash, the new
   * job is recorded as a `duplicate` (visible in history, SPEC.md §3.2) and skipped.
   *
   * The duplicate row stores `sha256 = NULL`: the column is UNIQUE, so only the first
   * job keeps the hash and later dupes point at it via a log line. This keeps dedupe a
   * single indexed lookup while still leaving every attempt visible in the dashboard.
   */
  create(input: CreateJobInput): CreateJobResult {
    const id = ulid()
    const now = nowIso()
    const userId = input.userId ?? 'local'

    const run = this.db.transaction((): CreateJobResult => {
      const original =
        input.sha256 !== undefined
          ? (this.db
              .prepare('SELECT id FROM jobs WHERE sha256 = ?')
              .get(input.sha256) as { id: string } | undefined)
          : undefined

      const isDuplicate = original !== undefined
      const status: JobStatus = isDuplicate ? 'duplicate' : 'queued'

      this.db
        .prepare(
          `INSERT INTO jobs
             (id, user_id, batch_id, source, type, original_name, url, sha256, status,
              raw_path, attempts, created_at, finished_at)
           VALUES
             (@id, @user_id, @batch_id, @source, @type, @original_name, @url, @sha256, @status,
              @raw_path, 0, @created_at, @finished_at)`,
        )
        .run({
          id,
          user_id: userId,
          batch_id: input.batchId ?? null,
          source: input.source,
          type: input.type,
          original_name: input.originalName ?? null,
          url: input.url ?? null,
          // A duplicate stores no hash — the original owns the UNIQUE hash.
          sha256: isDuplicate ? null : (input.sha256 ?? null),
          status,
          raw_path: input.rawPath ?? null,
          created_at: now,
          // Duplicates are terminal on arrival, so they get a finish time immediately.
          finished_at: isDuplicate ? now : null,
        })

      this.log(
        id,
        isDuplicate ? 'warn' : 'info',
        isDuplicate
          ? `duplicate of job ${original!.id} (sha256 match) — skipped`
          : `job created from ${input.source}${input.originalName ? ` (${input.originalName})` : ''}`,
      )

      return { job: this.getOrThrow(id), ...(isDuplicate ? { duplicateOf: original!.id } : {}) }
    })

    return run()
  }

  get(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
  }

  getOrThrow(id: string): JobRow {
    const job = this.get(id)
    if (job === undefined) throw new JobStateError(`no such job: ${id}`)
    return job
  }

  listByStatus(status: JobStatus): JobRow[] {
    return this.db
      .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at')
      .all(status) as JobRow[]
  }

  /** Most-recently-created jobs first — for the Ingestion tab (SPEC.md §6.2). */
  recent(limit = 100): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as JobRow[]
  }

  /**
   * Job counts by status for jobs that FINISHED at or after `sinceIso` — the 7-day KPIs on
   * the Overview tab (SPEC.md §6.1). Keyed off `finished_at` so a long-running job counts on
   * the day it completed, not the day it was queued.
   */
  countsSince(sinceIso: string): Record<string, number> {
    const rows = this.db
      .prepare(
        'SELECT status, COUNT(*) n FROM jobs WHERE finished_at IS NOT NULL AND finished_at >= ? GROUP BY status',
      )
      .all(sinceIso) as Array<{ status: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.status, r.n]))
  }

  /**
   * Statuses a user may clear from the Ingestion history — everything that is at rest.
   * The three active states (`queued`, `preprocessing`, `ingesting`) are deliberately absent
   * so a clear can never drop a job that is still queued or running.
   */
  static readonly CLEARABLE_STATUSES: readonly JobStatus[] = ['done', 'failed', 'deferred', 'duplicate', 'cancelled']

  /**
   * Deletes at-rest jobs from history ("Verlauf leeren", SPEC.md §6.2). With `status` set,
   * only that status is cleared (respecting the active filter chip); otherwise all clearable
   * statuses go. Active jobs are never touched. `job_logs` rows cascade (FK ON DELETE CASCADE).
   *
   * This only removes OPERATIONAL rows — the vault (source of truth) is untouched (hard
   * rule 1), and the created wiki pages remain. Returns the number of jobs removed.
   */
  clearHistory(status?: JobStatus): number {
    const targets = status
      ? JobStore.CLEARABLE_STATUSES.filter((s) => s === status)
      : JobStore.CLEARABLE_STATUSES
    if (targets.length === 0) return 0
    const placeholders = targets.map(() => '?').join(',')
    const res = this.db.prepare(`DELETE FROM jobs WHERE status IN (${placeholders})`).run(...targets)
    return res.changes
  }

  /** Job counts grouped by status — for the dashboard/health overview (SPEC.md §6.1). */
  counts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all() as Array<{
      status: string
      n: number
    }>
    return Object.fromEntries(rows.map((r) => [r.status, r.n]))
  }

  /**
   * Atomically claims the oldest `queued` job by moving it to `preprocessing`, returning
   * it — or undefined if the queue is empty. The SELECT and UPDATE run in one
   * transaction so two workers can never claim the same job (SPEC.md §3.1, concurrency 2).
   */
  claimNextQueued(): JobRow | undefined {
    const claim = this.db.transaction((): JobRow | undefined => {
      // Batch members (batch_id set) are NEVER claimed individually — the batch
      // coordinator drives them as a unit so they share one combined ingest run
      // (SPEC.md §4.1). Only standalone jobs are claimed here.
      const next = this.db
        .prepare("SELECT id FROM jobs WHERE status = 'queued' AND batch_id IS NULL ORDER BY created_at LIMIT 1")
        .get() as { id: string } | undefined
      if (next === undefined) return undefined
      return this.transition(next.id, 'preprocessing', { log: 'claimed by worker' })
    })
    return claim()
  }

  /**
   * Reconciles jobs stranded in an active state (`preprocessing`/`ingesting`) by an abrupt
   * stop — a WSL restart, a crash, a SIGKILL. The worker that owned them is gone, so they can
   * never progress on their own. Mark them `failed` with an interrupted reason: this makes
   * them diagnosable and one-click retryable (SPEC.md §10 M5), which is how in-flight work
   * "resumes" after a restart. We deliberately do NOT auto-re-run them — an `ingesting` job
   * may have partially written the vault, and silently replaying a mid-commit write risks
   * vault integrity (hard rule 1). `queued` jobs are untouched; the queue resumes those itself.
   * Returns the ids recovered. Idempotent (a second call finds nothing active).
   */
  recoverInterrupted(): string[] {
    const stuck = this.db
      .prepare("SELECT id FROM jobs WHERE status IN ('preprocessing', 'ingesting')")
      .all() as Array<{ id: string }>
    const recovered: string[] = []
    for (const { id } of stuck) {
      this.transition(id, 'failed', {
        patch: { error: 'interrupted by a service restart before it finished — retry to run it again' },
        log: 'recovered after service restart: job was mid-flight when the service stopped',
      })
      recovered.push(id)
    }
    return recovered
  }

  /** Queued batch members grouped by batch_id — for reconstructing pending batches after a restart. */
  queuedBatches(): Array<{ batchId: string; memberIds: string[] }> {
    const rows = this.db
      .prepare(
        "SELECT batch_id, id FROM jobs WHERE status = 'queued' AND batch_id IS NOT NULL ORDER BY created_at",
      )
      .all() as Array<{ batch_id: string; id: string }>
    const byBatch = new Map<string, string[]>()
    for (const r of rows) {
      const list = byBatch.get(r.batch_id) ?? []
      list.push(r.id)
      byBatch.set(r.batch_id, list)
    }
    return [...byBatch.entries()].map(([batchId, memberIds]) => ({ batchId, memberIds }))
  }

  /**
   * Moves a job to `to`, patching related fields and logging the transition — all in one
   * transaction. Throws `JobStateError` on an illegal move. `started_at` is stamped the
   * first time a job leaves `queued`; `finished_at` when it reaches a terminal state.
   */
  transition(
    id: string,
    to: JobStatus,
    opts: { readonly patch?: JobPatch; readonly log?: string; readonly level?: LogLevel } = {},
  ): JobRow {
    const run = this.db.transaction((): JobRow => {
      const current = this.getOrThrow(id)
      const allowed = ALLOWED_TRANSITIONS[current.status]
      if (!allowed.includes(to)) {
        throw new JobStateError(
          `illegal transition ${current.status} → ${to} for job ${id}` +
            ` (allowed: ${allowed.length ? allowed.join(', ') : 'none — terminal'})`,
        )
      }

      const now = nowIso()
      const patch = opts.patch ?? {}
      const isRetry = to === 'queued'

      this.db
        .prepare(
          `UPDATE jobs SET
             status = @status,
             error = COALESCE(@error, error),
             raw_path = COALESCE(@raw_path, raw_path),
             created_pages = COALESCE(@created_pages, created_pages),
             tokens_in = COALESCE(@tokens_in, tokens_in),
             tokens_out = COALESCE(@tokens_out, tokens_out),
             cost_usd = COALESCE(@cost_usd, cost_usd),
             batch_id = COALESCE(@batch_id, batch_id),
             started_at = CASE WHEN started_at IS NULL AND @set_started = 1 THEN @now ELSE started_at END,
             finished_at = CASE WHEN @set_finished = 1 THEN @now ELSE NULL END
           WHERE id = @id`,
        )
        .run({
          id,
          status: to,
          // `error === null` in the patch clears it (used on retry); `undefined` leaves it.
          error: patch.error === undefined ? null : patch.error,
          raw_path: patch.rawPath ?? null,
          created_pages:
            patch.createdPages !== undefined ? JSON.stringify(patch.createdPages) : null,
          tokens_in: patch.tokensIn ?? null,
          tokens_out: patch.tokensOut ?? null,
          cost_usd: patch.costUsd ?? null,
          batch_id: patch.batchId ?? null,
          now,
          set_started: to !== 'queued' && current.started_at === null ? 1 : 0,
          set_finished: TERMINAL_STATES.includes(to) ? 1 : 0,
        })

      // A retry clears the previous error explicitly (COALESCE above won't overwrite a
      // real value with NULL), so a re-queued job doesn't carry a stale failure message.
      if (isRetry && patch.error === undefined) {
        this.db.prepare('UPDATE jobs SET error = NULL, finished_at = NULL WHERE id = ?').run(id)
      }

      this.log(id, opts.level ?? (to === 'failed' ? 'error' : 'info'), opts.log ?? `→ ${to}`)
      return this.getOrThrow(id)
    })
    const job = run()
    // Publish only after the transaction has committed — a subscriber must never see a
    // status the DB rolled back (SPEC.md §6.5).
    this.bus?.publish({ kind: 'job', job })
    return job
  }

  /** Increments the retry counter and returns the new value (SPEC.md §3.1: max 2 retries). */
  incrementAttempts(id: string): number {
    this.db.prepare('UPDATE jobs SET attempts = attempts + 1 WHERE id = ?').run(id)
    return this.getOrThrow(id).attempts
  }

  /**
   * Gives back a consumed attempt. Used when a run failed for a reason that must NOT
   * burn a retry — a usage-limit pause is the queue's fault, not the job's (SPEC.md §7.1).
   */
  decrementAttempts(id: string): number {
    this.db.prepare('UPDATE jobs SET attempts = MAX(0, attempts - 1) WHERE id = ?').run(id)
    return this.getOrThrow(id).attempts
  }

  /** Corrects the provisional type once preprocessing has detected the real one. */
  setType(id: string, type: JobType): void {
    this.db.prepare('UPDATE jobs SET type = ? WHERE id = ?').run(type, id)
  }

  /** Records where the job's `.raw/<job-id>/` directory lives (vault-relative). */
  setRawPath(id: string, rawPath: string): void {
    this.db.prepare('UPDATE jobs SET raw_path = ? WHERE id = ?').run(rawPath, id)
  }

  /** Records the wiki pages this ingest committed (read back from the commit itself). */
  setCreatedPages(id: string, pages: readonly string[]): void {
    this.db.prepare('UPDATE jobs SET created_pages = ? WHERE id = ?').run(JSON.stringify(pages), id)
  }

  /** Appends a line to the job's log (agent stream + pipeline events, SPEC.md §8). */
  log(id: string, level: LogLevel, message: string): void {
    const ts = nowIso()
    this.db
      .prepare('INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)')
      .run(id, ts, level, message)
    // Stream the line live (the DoD's per-job agent log). Callers invoke log() only after
    // the row it references exists, and never in a path that subsequently rolls back.
    this.bus?.publish({ kind: 'log', log: { jobId: id, ts, level, message } })
  }

  logs(id: string): Array<{ ts: string; level: LogLevel; message: string }> {
    return this.db
      .prepare('SELECT ts, level, message FROM job_logs WHERE job_id = ? ORDER BY id')
      .all(id) as Array<{ ts: string; level: LogLevel; message: string }>
  }
}
