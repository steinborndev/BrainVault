/**
 * The ingestion queue and worker pool (SPEC.md §3.1, §3.2). The `jobs` table is the
 * single source of truth; this class is the engine that drives rows through it:
 *
 *   queued → preprocessing → ingesting → done | failed | deferred
 *
 * Responsibilities (TASKS-M1 §2):
 *   - a worker pool of default concurrency 2 (SPEC.md §3.1)
 *   - preprocessing via the plugin chain, then a headless agent ingest run
 *   - up to 2 automatic retries on transient errors, then `failed` (SPEC.md §3.1)
 *   - pause on a usage-limit signal, auto-resume (SPEC.md §7.1) — a pause never burns a retry
 *   - persist the agent stream to job_logs (SPEC.md §3.1)
 *   - one git commit per successful ingest (TASKS-M1 §0)
 *
 * Every external effect (agent run, git, tool detection, timers) is injectable so the
 * logic is unit-testable without a real SDK, a real vault, or the toolchain.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ulid } from 'ulid'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { JobRow, JobSource, JobType, CreateJobResult } from '../db/jobs.js'
import { JobStore } from '../db/jobs.js'
import type { AgentAuth, AgentRunResult } from './agent-runner.js'
import { runAgent, DEFAULT_TIMEOUT_MS } from './agent-runner.js'
import { formatMessage } from './format-message.js'
import { sha256File } from './hash.js'
import {
  preprocess,
  detectTools,
  PreprocessError,
  type PreprocessResult,
  type Manifest,
  type ToolAvailability,
} from './preprocess/index.js'
import { preprocessUrl } from './preprocess/web.js'
import { extensionOf } from './preprocess/detect.js'
import { commitVault, commitPaths, dirtyPaths, newWikiPaths, BOOKKEEPING_PATHS, type CommitResult, type CommitOptions } from './git.js'
import { RunRegistry } from './run-registry.js'
import { extractWrittenPaths } from './written-paths.js'
import { msUntilReset } from './budget.js'
import { readDomainRegistry, domainSystemPrompt } from './domains.js'
import { ENTITY_NOTABILITY_RULES, PAGE_HYGIENE_CHECKLIST } from './system-prompt.js'
import type { Validator } from './validator.js'
import type { EventBus } from './events.js'
import { Mutex } from '../util/mutex.js'

export type FailureClass = 'rate_limit' | 'transient' | 'permanent'

/** One member of a batch to enqueue: an uploaded/dropped file, or a URL. */
export type BatchItem =
  | { readonly kind: 'file'; readonly sourcePath: string; readonly originalName?: string }
  | { readonly kind: 'url'; readonly url: string }

/** In-memory record of a batch waiting for (or retrying) its combined ingest run. */
interface BatchUnit {
  readonly batchId: string
  readonly memberIds: string[]
}

/** Signature of the ingest agent run — injectable so tests supply a fake. */
export type IngestRunner = (opts: {
  readonly vaultRoot: string
  readonly prompt: string
  readonly auth: AgentAuth
  readonly timeoutMs: number
  readonly onMessage: (message: SDKMessage) => void
  /** Vault-derived system-prompt extension (the domain registry, SPEC.md §12.4). */
  readonly systemPromptExtra?: string
}) => Promise<AgentRunResult>

export interface IngestQueueOptions {
  readonly store: JobStore
  readonly vaultRoot: string
  /** `null` in setup mode (no credential yet): the queue accepts jobs but must not be started. */
  readonly auth: AgentAuth | null
  readonly concurrency?: number
  readonly timeoutMs?: number
  readonly maxRetries?: number
  /** How long to hold the queue after a usage-limit signal before auto-resuming. */
  readonly rateLimitPauseMs?: number
  /**
   * Base delay before retrying a TRANSIENT preprocess failure (e.g. a YouTube bot check
   * or HTTP 429), scaled linearly by attempt. Unlike agent retries these are delayed:
   * an immediate retry against a rate-limiting upstream is three fast failures in a row.
   */
  readonly preprocessRetryDelayMs?: number
  readonly runIngest?: IngestRunner
  readonly preprocessFile?: typeof preprocess
  readonly preprocessUrlFn?: typeof preprocessUrl
  readonly detectToolsFn?: () => Promise<ToolAvailability>
  readonly commit?: (vaultRoot: string, message: string, opts?: CommitOptions) => Promise<CommitResult>
  /** Hot-cache refresh hook; returns a note logged against the job. See file note in queue.ts. */
  readonly refreshHotCache?: (vaultRoot: string) => Promise<string>
  readonly setTimeoutFn?: (fn: () => void, ms: number) => void
  /**
   * Whether an ingest auto-commits to the vault ("Git-Commit-Verhalten", SPEC.md §6.4). Read
   * per commit — a provider, not a value — so a settings change applies live without a restart.
   * When it returns false the pages still land on disk; only the commit is skipped.
   */
  readonly autoCommit?: () => boolean
  /**
   * Daily-budget check (SPEC.md §7.1, §11.3). A provider, like `autoCommit`, so a settings
   * change applies live. When it returns true the queue pauses before claiming more work and
   * auto-resumes at the next local midnight. In-flight jobs always run to completion.
   */
  readonly budgetExceeded?: () => boolean
  /** Milliseconds until the budget window resets; injected so tests control the clock. */
  readonly msUntilBudgetReset?: () => number
  /** Live-update bus; the queue signals `stats` when a commit changes vault-visible numbers. */
  readonly events?: EventBus
  /**
   * Commit serialization mutex. Pass a shared instance so maintenance runs (lint, research,
   * hot-cache — M4) never interleave a commit with an ingest commit (TASKS-M4 §2: one writer).
   * Defaults to a fresh mutex when the queue is the only writer.
   */
  readonly commitMutex?: Mutex
  /**
   * Shared with the maintenance runner so each side can tell whether it is the sole vault writer
   * (finding F4). Defaults to a private registry when the queue is the only writer.
   */
  readonly runRegistry?: RunRegistry
  /**
   * Post-run validator (validator.ts): deterministic checks over the pages a run touched,
   * logged as warnings against the job. Read-only and advisory — findings never change the
   * job's outcome. Omitted (e.g. in the CLI) means no validation.
   */
  readonly validate?: Validator
}

/**
 * What a run wants staged for its commit. `written` (Write/Edit tool calls) is the only signal
 * that is reliably per-run; `dirtyBefore` lets a SOLE writer additionally recover pages the agent
 * created or renamed via Bash, which the tool stream never reports (finding F4).
 */
interface CommitScope {
  readonly written: ReadonlySet<string>
  readonly dirtyBefore: ReadonlySet<string>
  /** Job-specific extras, e.g. `.raw/<job-id>`. */
  readonly extra: readonly string[]
}

/** Classifies an agent failure to decide retry vs pause vs give-up. */
export function classifyFailure(res: AgentRunResult): FailureClass {
  if (res.timedOut) return 'transient'
  const text = `${res.error ?? ''} ${res.result ?? ''}`
  if (/rate.?limit|usage limit|quota|429|too many requests/i.test(text)) return 'rate_limit'
  if (
    /overloaded|529|503|500|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|temporar/i.test(
      text,
    )
  ) {
    return 'transient'
  }
  return 'permanent'
}

/**
 * Tries to extract "when does the limit lift" from a usage-limit error (SPEC.md §7.1 wants the
 * pause to honour the expected release time when it is available). Understood shapes: a
 * `retry-after: <seconds>` header echo, the Claude usage-limit `…|<epoch-seconds>` marker, and
 * an ISO `resets at <timestamp>`. Returns undefined when nothing parseable is present — the
 * caller falls back to its fixed pause.
 */
export function parseRetryAfterMs(text: string, now: number = Date.now()): number | undefined {
  const secs = text.match(/retry[- ]?after[:\s]+(\d{1,6})(?:\D|$)/i)
  if (secs) return Number(secs[1]) * 1000
  const epoch = text.match(/\|(\d{10})(?:\D|$)/)
  if (epoch) {
    const ms = Number(epoch[1]) * 1000 - now
    return ms > 0 ? ms : undefined
  }
  const iso = text.match(/resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i)
  if (iso) {
    const t = Date.parse(iso[1]!)
    return Number.isNaN(t) || t <= now ? undefined : t - now
  }
  return undefined
}

/** Provisional type from the extension — corrected to the real type after preprocessing. */
export function guessType(name: string): JobType {
  const ext = extensionOf(name)
  if (ext === 'pdf') return 'pdf'
  if (['docx', 'doc', 'odt', 'pptx', 'ppt', 'xlsx', 'xls', 'ods', 'odp'].includes(ext)) return 'office'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'm4v'].includes(ext))
    return 'av'
  if (['zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'xz'].includes(ext)) return 'other'
  return 'text'
}

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep)

/**
 * Reduces a client-supplied filename to a bare basename. Upload names arrive verbatim from
 * the multipart Content-Disposition header, and `original_name` is later joined onto
 * `.raw/<job-id>/` for staging, preprocessing, and deferral — a `../`-carrying name would
 * escape the vault from OUTSIDE the agent sandbox (hard rule 1). Backslashes are treated as
 * separators too so a Windows-shaped `..\..\x` cannot smuggle segments past POSIX basename.
 */
export function sanitizeOriginalName(name: string): string {
  const base = path.basename(name.replaceAll('\\', '/'))
  return base === '' || base === '.' || base === '..' ? `upload-${ulid()}` : base
}

export class IngestQueue {
  private readonly store: JobStore
  private readonly vaultRoot: string
  private readonly auth: AgentAuth | null
  /** Not readonly: settings can raise/lower it live (SPEC.md §6.4 "Parallelität"). */
  private concurrency: number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly rateLimitPauseMs: number
  private readonly preprocessRetryDelayMs: number
  private readonly runIngest: IngestRunner
  private readonly preprocessFile: typeof preprocess
  private readonly preprocessUrlFn: typeof preprocessUrl
  private readonly detectToolsFn: () => Promise<ToolAvailability>
  private readonly commit: (vaultRoot: string, message: string, opts?: CommitOptions) => Promise<CommitResult>
  private readonly refreshHotCache: (vaultRoot: string) => Promise<string>
  private readonly setTimeoutFn: (fn: () => void, ms: number) => void
  private readonly events: EventBus | undefined
  private readonly autoCommit: () => boolean
  private readonly budgetExceeded: () => boolean
  private readonly msUntilBudgetReset: () => number

  private readonly commitMutex: Mutex
  private readonly runRegistry: RunRegistry
  private readonly validate: Validator | undefined
  private running = false
  private paused = false
  /**
   * True while startup reconciliation of interrupted jobs is in flight. pump() is gated on it so
   * no newly-enqueued job can claim a worker and commit while reconcile is still reading the dirty
   * tree — otherwise reconcile could sweep the new job's pages into a recovered commit.
   */
  private reconciling = false
  /**
   * Resolves once startup reconciliation has finished and pumping has (re)started. Production
   * ignores it (jobs arrive later, long after reconcile); tests await it to assert recovery.
   */
  ready: Promise<void> = Promise.resolve()
  /** Why the queue is paused — the dashboard distinguishes a rate limit from a spent budget. */
  private pauseReason: 'rate-limit' | 'budget' | null = null
  private inFlight = 0
  private toolsCache: ToolAvailability | undefined
  private idleWaiters: Array<() => void> = []
  /** Batches awaiting their combined ingest run. A slot in the pool is one batch OR one job. */
  private pendingBatches: BatchUnit[] = []

  constructor(opts: IngestQueueOptions) {
    this.store = opts.store
    this.vaultRoot = opts.vaultRoot
    this.auth = opts.auth
    this.concurrency = opts.concurrency ?? 2
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = opts.maxRetries ?? 2
    this.rateLimitPauseMs = opts.rateLimitPauseMs ?? 60_000
    this.preprocessRetryDelayMs = opts.preprocessRetryDelayMs ?? 60_000
    this.runIngest = opts.runIngest ?? ((o) => runAgent(o))
    this.preprocessFile = opts.preprocessFile ?? preprocess
    this.preprocessUrlFn = opts.preprocessUrlFn ?? preprocessUrl
    this.detectToolsFn = opts.detectToolsFn ?? detectTools
    this.commit = opts.commit ?? commitVault
    this.refreshHotCache =
      opts.refreshHotCache ??
      (async () =>
        'hot cache is maintained by the ingest skill itself (M0 evidence); no separate refresh pass in M1')
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => void setTimeout(fn, ms))
    this.events = opts.events
    this.autoCommit = opts.autoCommit ?? ((): boolean => true)
    this.budgetExceeded = opts.budgetExceeded ?? ((): boolean => false)
    this.msUntilBudgetReset = opts.msUntilBudgetReset ?? ((): number => msUntilReset())
    this.commitMutex = opts.commitMutex ?? new Mutex()
    this.runRegistry = opts.runRegistry ?? new RunRegistry()
    this.validate = opts.validate
  }

  /**
   * Live-applies a concurrency change from settings (SPEC.md §6.4). Raising it starts more work
   * immediately; lowering it lets in-flight jobs finish and simply claims fewer afterwards.
   */
  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, Math.floor(concurrency))
    this.pump()
  }

  /**
   * The credential for a run. Runs are unreachable in setup mode (start() is never called,
   * pump() checks `running`), so this throwing means a wiring bug, not a user error.
   */
  private assertAuth(): AgentAuth {
    if (this.auth === null) throw new Error('agent run attempted with no credential configured (setup mode)')
    return this.auth
  }

  /** Starts pumping. Existing `queued` rows (e.g. after a restart) are picked up, and
   * batches whose members are still queued are reconstructed into pending units. Jobs stranded
   * mid-flight by an abrupt stop are first reconciled — a run that had finished writing the vault
   * before the crash is recovered to `done`, the rest to `failed` (retryable).
   *
   * Stays synchronous (the setup-mode guard must throw synchronously — callers and tests rely on
   * it, and ~30 call sites fire-and-forget this). The vault-aware reconcile is async, so it runs
   * off the synchronous path with pump() gated behind it via `reconciling`; enqueue's own pump()
   * calls are no-ops until reconcile finishes and re-pumps. */
  start(): void {
    if (this.auth === null) throw new Error('IngestQueue.start() requires a configured credential (setup mode)')
    this.running = true
    this.reconciling = true
    this.ready = this.reconcileInterrupted()
      .catch((err: unknown) => {
        // 'queue' is a pseudo-source, not a job row, so this goes to the event bus (job_logs
        // would break its FK to jobs.id) — the same channel the reconcile warn uses.
        this.events?.publish({
          kind: 'log',
          log: {
            jobId: 'queue',
            ts: new Date().toISOString(),
            level: 'error',
            message: `startup reconcile failed: ${(err as Error).message}`,
          },
        })
      })
      .finally(() => {
        this.reconciling = false
        this.reloadPendingBatches()
        this.pump()
      })
  }

  /**
   * Recovers jobs an abrupt stop left in `preprocessing`/`ingesting` (queue.start only). Unlike
   * the store's blanket {@link JobStore.recoverInterrupted}, this looks at the VAULT to tell the
   * two cases apart:
   *
   *   - An `ingesting` run whose final log entry is already in `wiki/log.md` had FINISHED writing;
   *     only its commit and status update were lost to the crash → commit its dirty pages and flip
   *     to `done`.
   *   - An `ingesting` run with NO completion marker was genuinely mid-write → still commit the
   *     pages it had already written (see below), then mark `failed` (retryable). A `preprocessing`
   *     job never reached the agent and wrote nothing → `failed`, no commit.
   *
   * Both `ingesting` cases commit the dirty wiki pages (via commitPaths — an explicit pathspec,
   * never `git add -A`, so nothing outside this run is swept in), differing only in the resulting
   * STATUS. The marker decides whether the JOB is done, not whether its on-disk pages get
   * versioned: committing a not-completed run's pages is what stops the RETRY from orphaning them
   * (its `dirtyBefore` snapshot would otherwise exclude them from the F4 sweep, and no later pass
   * ever picks them up — the 2026-07-23 retry-orphan bug). Committing happens BEFORE the status
   * flip, so a second crash mid-reconcile re-enters here (still `ingesting`) rather than stranding
   * a terminal job with uncommitted pages.
   *
   * Residual risk (SPEC §11.3 risk 5): the dirty-wiki set can, in principle, include a page the
   * user was editing in Obsidian at restart, which would then land in the recovered commit. It
   * only fires when a crash left an ingest's pages uncommitted, and the page stays fully versioned
   * and revertable — strictly better than orphaning it, or than the old `git add -A` sweeping it
   * into an unrelated run's commit.
   */
  private async reconcileInterrupted(): Promise<void> {
    const stuck = this.store.interruptedJobs()
    if (stuck.length === 0) return

    let recoveredToFailed = 0
    // A batch's members share one output set: once the first confirmed-complete member commits
    // the dirty tree, its siblings find nothing to commit and reuse the same page list.
    const committedByBatch = new Map<string, string[]>()

    for (const job of stuck) {
      const completed = job.status === 'ingesting' && this.ingestLoggedCompletion(job)

      // Commit any wiki pages an interrupted INGESTING run already wrote — whether or not it
      // reached its log-marker. The marker decides the job's STATUS (done vs failed-retryable),
      // NOT whether its on-disk pages get versioned. A run cut off after writing pages but before
      // the marker (or before its own commit) would otherwise ORPHAN those pages permanently: the
      // NEXT attempt cannot recover them either — its `dirtyBefore` snapshot already contains them,
      // so the F4 sweep (`newWikiPaths`) excludes them, the retried agent sees them already on disk
      // and does not re-Write them, and once the job reaches `done` reconcile never revisits it
      // (it only scans non-terminal jobs). This bit a real ingest (2026-07-23): a restart mid-write
      // left 7 content pages, the retry committed only bookkeeping, and the pages sat untracked.
      // Committing here is the fix — the pages are versioned/revertable, and the retry (for the
      // not-completed case) then runs on a clean tree. A `preprocessing` job wrote nothing, so
      // there is nothing to commit. Batch members share one output set (the cache), so the first
      // member commits the tree and its siblings reuse the list.
      let pages: string[] = []
      if (job.status === 'ingesting') {
        const label = job.original_name ?? job.url ?? job.id
        const cached = job.batch_id !== null ? committedByBatch.get(job.batch_id) : undefined
        if (cached !== undefined) {
          pages = cached
        } else {
          pages = await this.commitReconciledPages(job, label, completed)
          if (job.batch_id !== null) committedByBatch.set(job.batch_id, pages)
        }
      }

      if (completed) {
        this.store.transition(job.id, 'done', {
          patch: pages.length > 0 ? { createdPages: pages } : {},
          log: 'reconciled to done after restart: run had completed; commit recovered',
        })
      } else {
        this.store.transition(job.id, 'failed', {
          patch: { error: 'interrupted by a service restart before it finished — retry to run it again' },
          log:
            pages.length > 0
              ? `recovered after restart: mid-flight with no completion marker — committed ${pages.length} page(s) it had already written so the retry cannot orphan them (retry to finish)`
              : 'recovered after restart: mid-flight with no completion marker in wiki/log.md',
        })
        recoveredToFailed++
      }
    }

    if (recoveredToFailed > 0) {
      this.events?.publish({
        kind: 'log',
        log: {
          jobId: 'queue',
          ts: new Date().toISOString(),
          level: 'warn',
          message: `recovered ${recoveredToFailed} interrupted job(s) after restart → failed (retryable)`,
        },
      })
    }
    this.events?.publish({ kind: 'stats' })
  }

  /**
   * Commits the wiki pages an interrupted run left dirty; returns what landed. Called for both
   * the completed branch (commit + `done`) and the not-completed branch (commit so the retry
   * cannot orphan them + `failed`); `completed` only varies the commit subject.
   */
  private async commitReconciledPages(job: JobRow, label: string, completed: boolean): Promise<string[]> {
    if (!this.autoCommit()) {
      this.store.log(job.id, 'info', 'reconcile: auto-commit disabled — pages left on disk, not committed')
      return []
    }
    const dirtyWiki = [...(await dirtyPaths(this.vaultRoot))].filter((p) => p.startsWith('wiki/'))
    if (dirtyWiki.length === 0) {
      this.store.log(job.id, 'info', 'reconcile: run had completed and its pages were already committed')
      return []
    }
    // Include the job's .raw dir only when it is actually on disk — `git add -- <missing path>`
    // throws "pathspec did not match", which would abort the whole recovery commit.
    const rawDir = path.posix.join('.raw', job.id)
    const paths = fs.existsSync(path.join(this.vaultRoot, rawDir)) ? [...dirtyWiki, rawDir] : dirtyWiki
    const subject = completed
      ? `ingest: ${label} (recovered after restart)`
      : `ingest: ${label} (recovered after restart — incomplete run, retry pending)`
    try {
      const result = await this.commitMutex.runExclusive(() => commitPaths(this.vaultRoot, subject, paths))
      if (result.committed) {
        if (result.hash) this.store.setCommitHash(job.id, result.hash)
        this.store.log(
          job.id,
          'info',
          `reconcile: committed ${result.hash?.slice(0, 8)} (${result.committedPages.length} page(s)) the crash left uncommitted`,
        )
        this.events?.publish({ kind: 'stats' })
        return result.committedPages
      }
      this.store.log(job.id, 'info', `reconcile: nothing to commit (${result.note ?? 'no changes'})`)
    } catch (err) {
      this.store.log(job.id, 'warn', `reconcile: git commit failed (pages are on disk): ${(err as Error).message}`)
    }
    return []
  }

  /** True when `wiki/log.md` carries this job's final ingest entry — the skill writes it (naming
   * the job's `.raw` dir) only as its last action, so its presence means the run finished. */
  private ingestLoggedCompletion(job: JobRow): boolean {
    try {
      const log = fs.readFileSync(path.join(this.vaultRoot, 'wiki', 'log.md'), 'utf8')
      return log.includes(`.raw/${job.id}`) || (job.raw_path !== null && log.includes(job.raw_path))
    } catch {
      return false
    }
  }

  /** Reconstructs pending batch units from queued batch members not already tracked in memory. */
  private reloadPendingBatches(): void {
    const known = new Set(this.pendingBatches.map((u) => u.batchId))
    for (const b of this.store.queuedBatches()) {
      if (!known.has(b.batchId)) this.pendingBatches.push(b)
    }
  }

  /**
   * Manually re-queues a `failed` or `deferred` job (SPEC.md §6.2 "Erneut versuchen"). The
   * runner already retries *transient* errors automatically; this is the operator's path for
   * permanent failures and deferred jobs. A batch member is re-registered as a pending batch
   * so it rejoins its combined run. Throws if the job isn't in a re-queueable state.
   */
  retryJob(id: string): JobRow {
    const job = this.store.getOrThrow(id)
    if (job.status !== 'failed' && job.status !== 'deferred') {
      throw new Error(`job ${id} is ${job.status}, not failed/deferred — nothing to retry`)
    }
    const updated = this.store.transition(id, 'queued', { log: 'manual retry requested (SPEC.md §6.2)' })
    if (job.batch_id) this.reloadPendingBatches()
    this.pump()
    return updated
  }

  /** Stops claiming new work. In-flight jobs run to completion. */
  stop(): void {
    this.running = false
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Live queue state for the health/overview endpoints (SPEC.md §6.1). */
  stats(): {
    readonly inFlight: number
    readonly paused: boolean
    /** Distinguishes a usage-limit pause from a spent daily budget for the dashboard. */
    readonly pauseReason: 'rate-limit' | 'budget' | null
    readonly concurrency: number
  } {
    return {
      inFlight: this.inFlight,
      paused: this.paused,
      pauseReason: this.pauseReason,
      concurrency: this.concurrency,
    }
  }

  /**
   * Enqueues a file. Computes its SHA-256 (dedupe), records the job, and — unless it is a
   * duplicate — copies the original into `.raw/<job-id>/` where preprocessing expects it.
   */
  async enqueueFile(input: {
    readonly sourcePath: string
    readonly source: JobSource
    readonly originalName?: string
    readonly batchId?: string
    /** Where to report the terminal state, e.g. 'telegram:<chat_id>' (SPEC.md §4.3). */
    readonly notifyChannel?: string
  }): Promise<CreateJobResult> {
    const originalName = sanitizeOriginalName(input.originalName ?? path.basename(input.sourcePath))
    const sha256 = await sha256File(input.sourcePath)
    const created = this.store.create({
      source: input.source,
      type: guessType(originalName),
      originalName,
      sha256,
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.notifyChannel ? { notifyChannel: input.notifyChannel } : {}),
    })
    if (created.duplicateOf === undefined) {
      try {
        this.stageFile(created.job.id, input.sourcePath, originalName)
      } catch (err) {
        // The row exists but the original never reached `.raw/` — the job could only hang in
        // `queued` forever. Fail it visibly instead; a retry after fixing the cause re-stages.
        const job = this.store.transition(created.job.id, 'failed', {
          patch: { error: `staging failed: ${(err as Error).message}` },
          log: `staging into .raw/ failed: ${(err as Error).message}`,
          level: 'error',
        })
        this.pump()
        return { job }
      }
    }
    this.pump()
    return created
  }

  /** Copies an original into its `.raw/<job-id>/` dir where preprocessing expects it. */
  private stageFile(jobId: string, sourcePath: string, originalName: string): void {
    const jobDir = path.join(this.vaultRoot, '.raw', jobId)
    // Callers sanitize; this assert is the backstop for any future caller that forgets.
    const dest = path.resolve(jobDir, originalName)
    if (path.dirname(dest) !== path.resolve(jobDir)) {
      throw new Error(`refusing to stage "${originalName}": name must resolve to a direct child of the job dir`)
    }
    fs.mkdirSync(jobDir, { recursive: true })
    fs.copyFileSync(sourcePath, dest)
    this.store.setRawPath(jobId, path.posix.join('.raw', jobId))
  }

  /**
   * Enqueues a batch (SPEC.md §4.1): every member is preprocessed individually, then the
   * whole batch is ingested with ONE combined `ingest all of these` run so the agent can
   * cross-reference the sources. Members share a `batch_id`; duplicates are skipped and
   * left out of the run. Occupies ONE worker-pool slot for the whole batch.
   */
  async enqueueBatch(
    items: readonly BatchItem[],
    source: JobSource,
    opts: { readonly notifyChannel?: string } = {},
  ): Promise<{ batchId: string; jobs: CreateJobResult[] }> {
    const batchId = ulid()
    const notify = opts.notifyChannel ? { notifyChannel: opts.notifyChannel } : {}
    const jobs: CreateJobResult[] = []
    for (const item of items) {
      if (item.kind === 'url') {
        jobs.push(this.store.create({ source, type: 'web', url: item.url, batchId, ...notify }))
        continue
      }
      const originalName = sanitizeOriginalName(item.originalName ?? path.basename(item.sourcePath))
      // One unreadable member must not strand its siblings: without the pending-batch unit
      // (pushed only after this loop) queued batch members are never claimed, so a throw here
      // used to freeze the whole batch until a restart. Fail the member visibly and carry on.
      let created: CreateJobResult | undefined
      try {
        const sha256 = await sha256File(item.sourcePath)
        created = this.store.create({ source, type: guessType(originalName), originalName, sha256, batchId, ...notify })
        if (created.duplicateOf === undefined) this.stageFile(created.job.id, item.sourcePath, originalName)
        jobs.push(created)
      } catch (err) {
        created ??= this.store.create({ source, type: guessType(originalName), originalName, batchId, ...notify })
        const job = this.store.transition(created.job.id, 'failed', {
          patch: { error: `could not read/stage the file: ${(err as Error).message}` },
          log: `batch member failed before preprocessing: ${(err as Error).message}`,
          level: 'error',
        })
        jobs.push({ job })
      }
    }
    // Only members still queued join the combined run — duplicates and stage-failed drop out.
    const memberIds = jobs.filter((r) => r.duplicateOf === undefined && r.job.status === 'queued').map((r) => r.job.id)
    if (memberIds.length > 0) this.pendingBatches.push({ batchId, memberIds })
    this.pump()
    return { batchId, jobs }
  }

  /**
   * Records an over-limit file as a visible `failed` job (SPEC.md §4.2 applies the §4.1 size
   * cap to the watch folder too — uploads get a 413, the watcher lands here). The original is
   * still staged into `.raw/<job-id>/` so the inbox can be emptied without losing data, and a
   * retry after raising `maxUploadBytes` re-enters the pipeline normally. No hash is computed —
   * hashing a file we refuse to process would cost the most exactly when it helps the least.
   */
  rejectOversizedFile(input: {
    readonly sourcePath: string
    readonly originalName: string
    readonly source: JobSource
    readonly sizeBytes: number
    readonly limitBytes: number
  }): JobRow {
    const originalName = sanitizeOriginalName(input.originalName)
    const created = this.store.create({
      source: input.source,
      type: guessType(originalName),
      originalName,
    })
    this.stageFile(created.job.id, input.sourcePath, originalName)
    return this.store.transition(created.job.id, 'failed', {
      patch: {
        error: `file is ${input.sizeBytes} bytes — over the ${input.limitBytes}-byte limit (maxUploadBytes); raise the limit in settings and retry`,
      },
      log: `refused: ${input.sizeBytes} bytes exceeds the configured maxUploadBytes (${input.limitBytes})`,
      level: 'error',
    })
  }

  /** Enqueues a URL job (not content-addressed, so not deduped). */
  enqueueUrl(input: {
    readonly url: string
    readonly source?: JobSource
    readonly batchId?: string
    readonly notifyChannel?: string
  }): CreateJobResult {
    const created = this.store.create({
      source: input.source ?? 'url',
      type: 'web',
      url: input.url,
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.notifyChannel ? { notifyChannel: input.notifyChannel } : {}),
    })
    this.pump()
    return created
  }

  /** Resolves once the queue has no in-flight jobs and nothing left to claim. */
  onIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /**
   * Manually resumes after a pause (also called by both auto-resume timers). If the reason still
   * holds — e.g. the budget is still spent — `pump()` simply pauses again rather than spinning.
   */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.pauseReason = null
    this.pump()
  }

  private isIdle(): boolean {
    if (this.inFlight > 0) return false
    // A paused queue makes no further progress until it resumes, so with nothing in
    // flight it counts as settled even though jobs are still queued behind the pause.
    if (this.paused) return true
    if (this.pendingBatches.length > 0) return false
    return (this.store.counts()['queued'] ?? 0) === 0
  }

  private settleIdle(): void {
    if (this.isIdle()) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private pump(): void {
    if (!this.running || this.paused || this.reconciling) {
      this.settleIdle()
      return
    }
    // Checked before claiming, never mid-job: an in-flight run always finishes, so a budget
    // can be overshot by at most the runs already started (SPEC.md §11.3).
    if (this.budgetExceeded()) {
      this.pauseForBudget()
      this.settleIdle()
      return
    }
    while (this.inFlight < this.concurrency) {
      // A batch occupies one slot for its whole combined run; drain pending batches first.
      const unit = this.pendingBatches.shift()
      if (unit !== undefined) {
        this.inFlight++
        void this.processBatch(unit)
          .catch((err: unknown) => {
            const id = unit.memberIds[0] ?? 'unknown'
            this.store.log(id, 'error', `batch worker crashed: ${(err as Error).message}`)
          })
          .finally(() => {
            this.inFlight--
            this.pump()
          })
        continue
      }
      const job = this.store.claimNextQueued()
      if (job === undefined) break
      this.inFlight++
      void this.processJob(job)
        .catch((err: unknown) => {
          // A crash here is a bug, not an ingest failure — record it and don't wedge the job.
          this.store.log(job.id, 'error', `worker crashed: ${(err as Error).message}`)
          try {
            this.store.transition(job.id, 'failed', { patch: { error: `worker crash: ${(err as Error).message}` } })
          } catch {
            /* job may already be terminal */
          }
        })
        .finally(() => {
          this.inFlight--
          this.pump()
        })
    }
    this.settleIdle()
  }

  private async processJob(job: JobRow): Promise<void> {
    const jobDir = path.join(this.vaultRoot, '.raw', job.id)
    this.store.setRawPath(job.id, path.posix.join('.raw', job.id))

    let pre: PreprocessResult
    try {
      pre = await this.preprocessStep(job, jobDir)
    } catch (err) {
      const message = (err as Error).message
      this.store.transition(job.id, 'failed', {
        patch: { error: `preprocessing failed: ${message}` },
        log: `preprocessing failed: ${message}`,
        level: 'error',
      })
      if (err instanceof PreprocessError && err.transient) this.schedulePreprocessRetry(job.id)
      return
    }

    this.store.setType(job.id, pre.type)

    if (pre.deferred) {
      this.deferJob(job, jobDir)
      this.store.transition(job.id, 'deferred', {
        log: pre.manifest.notes.join('; ') || 'unsupported type — deferred',
        level: 'warn',
      })
      return
    }

    this.store.transition(job.id, 'ingesting', { log: `preprocessed as ${pre.type}` })
    await this.ingestStep(job, pre)
  }

  /** Runs preprocessing, skipping it when a prior attempt already produced a manifest. */
  private async preprocessStep(job: JobRow, jobDir: string): Promise<PreprocessResult> {
    const manifestPath = path.join(jobDir, 'manifest.json')
    if (fs.existsSync(manifestPath)) {
      this.store.log(job.id, 'info', 'preprocessing skipped — manifest from a prior attempt reused')
      return resultFromManifest(this.vaultRoot, jobDir, manifestPath)
    }
    this.toolsCache ??= await this.detectToolsFn()

    // A URL job is identified by carrying a url, NOT by `source`: `source` is the channel
    // (drop | watch | url), so a URL dropped via the dashboard/CLI has source 'drop' but
    // is still a web job. Keying off `source` here mis-routed it as a file (the M1 test's
    // one failure) — the presence of `url` is the correct discriminator.
    if (job.url) {
      return this.preprocessUrlFn({ jobId: job.id, url: job.url, vaultRoot: this.vaultRoot, jobDir, tools: this.toolsCache })
    }
    if (!job.original_name) throw new Error('file job has no original_name')
    return this.preprocessFile({
      jobId: job.id,
      source: job.source,
      sourcePath: path.join(jobDir, job.original_name),
      originalName: job.original_name,
      vaultRoot: this.vaultRoot,
      jobDir,
      ...(job.sha256 ? { sha256: job.sha256 } : {}),
      tools: this.toolsCache,
    })
  }

  private async ingestStep(job: JobRow, pre: PreprocessResult): Promise<void> {
    const attempt = this.store.incrementAttempts(job.id)
    const prompt = `ingest ${pre.primaryArtifact}`
    this.store.log(job.id, 'info', `ingest attempt ${attempt}: ${prompt}`)

    // Bracket + register as a writer so Bash-written pages can be swept into the commit, but
    // only when this turns out to be the sole writer (finding F4).
    const dirtyBefore = await dirtyPaths(this.vaultRoot)
    const endRun = this.runRegistry.begin()
    const written = new Set<string>()
    const res = await this.runIngest({
      vaultRoot: this.vaultRoot,
      prompt,
      auth: this.assertAuth(),
      timeoutMs: this.timeoutMs,
      // Read per run, not cached: the registry is a vault page the user may edit at any
      // time, and the next ingest should honour the edit without a service restart.
      systemPromptExtra: [
        domainSystemPrompt(readDomainRegistry(this.vaultRoot)),
        PAGE_HYGIENE_CHECKLIST,
        ENTITY_NOTABILITY_RULES,
      ]
        .filter(Boolean)
        .join('\n\n'),
      onMessage: (m) => {
        const line = formatMessage(m)
        if (line !== undefined) this.store.log(job.id, 'info', line)
        for (const p of extractWrittenPaths(m, this.vaultRoot)) written.add(p)
      },
    })

    if (res.ok) {
      this.store.transition(job.id, 'done', {
        patch: {
          tokensIn: res.usage.tokensIn,
          tokensOut: res.usage.tokensOut,
          costUsd: res.usage.costUsd,
        },
        log: `ingest complete over ${res.numTurns} turns`,
      })
      // created_pages comes from the actual commit (see commitVault): the only
      // authoritative record of what landed, correct even at concurrency 2.
      const committed = await this.commitStep(job, {
        written,
        dirtyBefore,
        extra: [path.posix.join('.raw', job.id)],
      })
      endRun()
      this.validateStep(job.id, [...written, ...committed])
      const note = await this.refreshHotCache(this.vaultRoot)
      this.store.log(job.id, 'info', note)
      return
    }

    endRun()
    const outcome = classifyFailure(res)
    this.store.transition(job.id, 'failed', {
      patch: {
        error: res.error ?? 'ingest failed',
        tokensIn: res.usage.tokensIn,
        tokensOut: res.usage.tokensOut,
        costUsd: res.usage.costUsd,
      },
      log: `ingest failed (${outcome}): ${res.error ?? 'unknown error'}`,
      level: 'error',
    })

    if (outcome === 'rate_limit') {
      this.store.decrementAttempts(job.id) // a usage-limit pause is not the job's fault
      this.store.transition(job.id, 'queued', { log: 'requeued — will retry after the usage-limit pause' })
      this.pauseForRateLimit(job.id, res.error)
      return
    }
    if (outcome === 'transient' && attempt <= this.maxRetries) {
      this.store.transition(job.id, 'queued', {
        log: `retry ${attempt}/${this.maxRetries} scheduled after transient error`,
      })
      return
    }
    this.store.log(
      job.id,
      'error',
      outcome === 'transient'
        ? `gave up after ${attempt} attempt(s) — retries exhausted`
        : 'permanent failure — not retried',
    )
  }

  /**
   * Builds the commit pathspec. MUST be called inside the commit mutex: the sole-writer question
   * and the sweep have to happen together, or another run could start writing in between.
   */
  private async buildPathspec(scope: CommitScope, log: (message: string) => void): Promise<string[]> {
    const sole = this.runRegistry.isSoleWriter()
    const swept = sole ? newWikiPaths(scope.dirtyBefore, await dirtyPaths(this.vaultRoot)) : []
    if (swept.length > 0) {
      log(`staging ${swept.length} page(s) the tool stream did not report (F4)`)
    } else if (!sole) {
      log('another run is writing — staging only tool-reported paths (F4 sweep skipped)')
    }
    return [...new Set([...scope.written, ...swept, ...scope.extra, ...BOOKKEEPING_PATHS])]
  }

  /** Returns the committed wiki pages, so the validation step can cover Bash-written pages
   * the tool stream never reported (empty when the commit was skipped or failed). */
  private async commitStep(job: JobRow, scope: CommitScope): Promise<string[]> {
    const label = job.original_name ?? job.url ?? job.id
    if (!this.autoCommit()) {
      // Pages are already written; only the commit is skipped, so nothing is lost — the
      // operator (or the next run with auto-commit on) picks them up.
      this.store.log(job.id, 'info', 'auto-commit disabled in settings — pages are on disk, not committed')
      return []
    }
    try {
      const result = await this.commitMutex.runExclusive(async () => {
        const pathspec = await this.buildPathspec(scope, (m) => this.store.log(job.id, 'info', m))
        return this.commit(this.vaultRoot, `ingest: ${label}`, { pathspec })
      })
      if (result.committed) {
        this.store.setCreatedPages(job.id, result.committedPages)
        // Anchor for "revert this ingest" (v9): persisted, not scraped back out of the log text.
        if (result.hash) this.store.setCommitHash(job.id, result.hash)
        this.store.log(
          job.id,
          'info',
          `committed ${result.hash?.slice(0, 8)} (${result.committedPages.length} wiki page(s))`,
        )
        // Vault-visible numbers (page counts, git history) changed → refresh the Overview.
        this.events?.publish({ kind: 'stats' })
        return result.committedPages
      }
      this.store.log(job.id, 'info', `not committed: ${result.note ?? 'no changes'}`)
    } catch (err) {
      // A commit failure must not undo a completed ingest — the pages are on disk. Note the job
      // is already `done` (terminal) by now, and the old net that eventually swept these in (a
      // later run's `git add -A`) is gone (see commitVault), so they are NOT auto-recovered:
      // the operator commits them from the dashboard. This is deliberately narrow — a commit
      // throwing while inside the mutex with a staged tree means disk-full or a broken repo,
      // where a silent later sweep would have failed too. Surface it loudly, don't fail the job.
      this.store.log(job.id, 'warn', `git commit failed (pages are on disk, commit manually): ${(err as Error).message}`)
    }
    return []
  }

  /**
   * Post-run validation (validator.ts): the mechanical lint checks, scoped to the pages this
   * run touched, logged as warnings while the job's context is still on screen. Advisory by
   * design — a finding never fails a `done` job, and a validator crash only logs.
   */
  private validateStep(jobId: string, touched: readonly string[]): void {
    if (this.validate === undefined) return
    try {
      const findings = this.validate(touched)
      if (findings.length === 0) {
        this.store.log(jobId, 'info', 'post-run validation: no findings')
        return
      }
      for (const f of findings) this.store.log(jobId, 'warn', `validation [${f.rule}] ${f.path}: ${f.message}`)
      this.store.log(
        jobId,
        'warn',
        `post-run validation: ${findings.length} finding(s) — advisory only, nothing was modified`,
      )
    } catch (err) {
      this.store.log(jobId, 'warn', `post-run validation crashed (ignored): ${(err as Error).message}`)
    }
  }

  /**
   * Processes one batch: preprocess each member individually, then a single combined
   * `ingest all of these` run over the surviving artifacts, one commit, all members done.
   * Deferred/failed members drop out but never sink the rest of the batch.
   */
  private async processBatch(unit: BatchUnit): Promise<void> {
    const ready: Array<{ id: string; artifact: string }> = []
    const names: string[] = []

    for (const id of unit.memberIds) {
      const job = this.store.get(id)
      if (job === undefined || job.status !== 'queued') continue // already handled/cancelled
      const jobDir = path.join(this.vaultRoot, '.raw', id)
      this.store.setRawPath(id, path.posix.join('.raw', id))
      try {
        this.store.transition(id, 'preprocessing', { log: 'batch: preprocessing member' })
        const pre = await this.preprocessStep(job, jobDir)
        this.store.setType(id, pre.type)
        if (pre.deferred) {
          this.deferJob(job, jobDir)
          this.store.transition(id, 'deferred', {
            log: pre.manifest.notes.join('; ') || 'unsupported type — deferred',
            level: 'warn',
          })
          continue
        }
        ready.push({ id, artifact: pre.primaryArtifact })
        names.push(job.original_name ?? job.url ?? id)
      } catch (err) {
        this.store.transition(id, 'failed', {
          patch: { error: `preprocessing failed: ${(err as Error).message}` },
          log: `batch member preprocessing failed: ${(err as Error).message}`,
          level: 'error',
        })
      }
    }

    if (ready.length === 0) return

    for (const r of ready) this.store.transition(r.id, 'ingesting', { log: 'batch: combined ingest' })
    const attempt = this.store.incrementAttempts(ready[0]!.id)
    for (const r of ready.slice(1)) this.store.incrementAttempts(r.id)

    const lead = ready[0]!.id
    const prompt = `ingest all of these:\n${ready.map((r) => `- ${r.artifact}`).join('\n')}`
    this.store.log(lead, 'info', `batch combined ingest of ${ready.length} artifact(s), attempt ${attempt}`)

    // Same F4 bracket as the single-job path.
    const dirtyBefore = await dirtyPaths(this.vaultRoot)
    const endRun = this.runRegistry.begin()
    const written = new Set<string>()
    const res = await this.runIngest({
      vaultRoot: this.vaultRoot,
      prompt,
      auth: this.assertAuth(),
      timeoutMs: this.timeoutMs,
      // Read per run, not cached: the registry is a vault page the user may edit at any
      // time, and the next ingest should honour the edit without a service restart.
      systemPromptExtra: [
        domainSystemPrompt(readDomainRegistry(this.vaultRoot)),
        PAGE_HYGIENE_CHECKLIST,
        ENTITY_NOTABILITY_RULES,
      ]
        .filter(Boolean)
        .join('\n\n'),
      onMessage: (m) => {
        const line = formatMessage(m)
        if (line !== undefined) this.store.log(lead, 'info', line)
        for (const p of extractWrittenPaths(m, this.vaultRoot)) written.add(p)
      },
    })

    if (res.ok) {
      // Split usage evenly so aggregate dashboard totals aren't multiplied by batch size;
      // the remainder lands on the lead member.
      const n = ready.length
      const perIn = Math.floor(res.usage.tokensIn / n)
      const perOut = Math.floor(res.usage.tokensOut / n)
      ready.forEach((r, i) => {
        this.store.transition(r.id, 'done', {
          patch: {
            tokensIn: perIn + (i === 0 ? res.usage.tokensIn - perIn * n : 0),
            tokensOut: perOut + (i === 0 ? res.usage.tokensOut - perOut * n : 0),
            costUsd: res.usage.costUsd / n,
          },
          log: `batch ingest complete (member ${i + 1}/${n}, ${res.numTurns} turns)`,
        })
      })
      const committed = await this.batchCommit(ready.map((r) => r.id), names, {
        written,
        dirtyBefore,
        extra: ready.map((r) => path.posix.join('.raw', r.id)),
      })
      endRun()
      this.validateStep(lead, [...written, ...committed])
      const note = await this.refreshHotCache(this.vaultRoot)
      this.store.log(lead, 'info', note)
      return
    }

    endRun()
    const outcome = classifyFailure(res)
    // A failed batch run still spent tokens — split them like the success path does, or the
    // usage aggregate and daily budget under-count exactly the runs that waste the most.
    const n = ready.length
    const perIn = Math.floor(res.usage.tokensIn / n)
    const perOut = Math.floor(res.usage.tokensOut / n)
    ready.forEach((r, i) => {
      this.store.transition(r.id, 'failed', {
        patch: {
          error: res.error ?? 'batch ingest failed',
          tokensIn: perIn + (i === 0 ? res.usage.tokensIn - perIn * n : 0),
          tokensOut: perOut + (i === 0 ? res.usage.tokensOut - perOut * n : 0),
          costUsd: res.usage.costUsd / n,
        },
        log: `batch ingest failed (${outcome}): ${res.error ?? 'unknown error'}`,
        level: 'error',
      })
    })
    const requeue = (logLine: string): void => {
      for (const r of ready) this.store.transition(r.id, 'queued', { log: logLine })
      this.pendingBatches.push({ batchId: unit.batchId, memberIds: ready.map((r) => r.id) })
    }
    if (outcome === 'rate_limit') {
      for (const r of ready) this.store.decrementAttempts(r.id)
      requeue('batch requeued — will retry after the usage-limit pause')
      this.pauseForRateLimit(lead, res.error)
      return
    }
    if (outcome === 'transient' && attempt <= this.maxRetries) {
      requeue(`batch retry ${attempt}/${this.maxRetries} after transient error`)
      return
    }
    this.store.log(
      lead,
      'error',
      outcome === 'transient' ? `batch gave up after ${attempt} attempt(s)` : 'batch permanent failure — not retried',
    )
  }

  /** One commit for a whole batch; every member is attributed the same committed pages.
   * Returns the committed wiki pages for the validation step (empty when skipped/failed). */
  private async batchCommit(memberIds: string[], names: string[], scope: CommitScope): Promise<string[]> {
    const label = names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1} more`
    if (!this.autoCommit()) {
      this.store.log(memberIds[0]!, 'info', 'auto-commit disabled in settings — pages are on disk, not committed')
      return []
    }
    try {
      const result = await this.commitMutex.runExclusive(async () => {
        const pathspec = await this.buildPathspec(scope, (m) => this.store.log(memberIds[0]!, 'info', m))
        return this.commit(this.vaultRoot, `ingest: ${label}`, { pathspec })
      })
      if (result.committed) {
        for (const id of memberIds) this.store.setCreatedPages(id, result.committedPages)
        // Every member gets the SAME hash: one commit covers the batch, so reverting through any
        // one of them undoes all of them (the UI says so before arming the action).
        if (result.hash) for (const id of memberIds) this.store.setCommitHash(id, result.hash)
        this.store.log(memberIds[0]!, 'info', `committed ${result.hash?.slice(0, 8)} (${result.committedPages.length} pages, batch of ${memberIds.length})`)
        this.events?.publish({ kind: 'stats' })
        return result.committedPages
      }
      this.store.log(memberIds[0]!, 'info', `not committed: ${result.note ?? 'no changes'}`)
    } catch (err) {
      this.store.log(memberIds[0]!, 'warn', `git commit failed (pages are on disk): ${(err as Error).message}`)
    }
    return []
  }

  private deferJob(job: JobRow, jobDir: string): void {
    if (job.source === 'url' || !job.original_name) return
    const src = path.join(jobDir, job.original_name)
    if (!fs.existsSync(src)) return
    const deferredDir = path.join(this.vaultRoot, '.raw', 'deferred')
    fs.mkdirSync(deferredDir, { recursive: true })
    fs.renameSync(src, path.join(deferredDir, `${job.id}-${job.original_name}`))
  }

  /**
   * Retries a transient preprocess failure (bot check, upstream 429, timeout) after a
   * linear-backoff delay. The job sits in `failed` until the timer fires — visible and
   * manually retryable the whole time — then requeues itself; a manual retry or cancel
   * in the meantime wins (the timer checks the status before touching the job). Unlike
   * a usage-limit pause this never parks the whole queue: only this job waits.
   */
  private schedulePreprocessRetry(jobId: string): void {
    const attempt = this.store.incrementAttempts(jobId)
    if (attempt > this.maxRetries) {
      this.store.log(jobId, 'error', `gave up after ${attempt} attempt(s) — preprocess retries exhausted`)
      return
    }
    const delayMs = this.preprocessRetryDelayMs * attempt
    this.store.log(
      jobId,
      'info',
      `transient preprocess failure — retry ${attempt}/${this.maxRetries} in ${Math.round(delayMs / 1000)}s`,
    )
    this.setTimeoutFn(() => {
      if (!this.running) return
      if (this.store.get(jobId)?.status !== 'failed') return // manually retried or cancelled meanwhile
      this.store.transition(jobId, 'queued', {
        log: `retry ${attempt}/${this.maxRetries} after transient preprocess failure`,
      })
      this.pump()
    }, delayMs)
  }

  private pauseForRateLimit(jobId: string, errorText?: string): void {
    if (this.paused) return
    this.paused = true
    this.pauseReason = 'rate-limit'
    // Honour the expected release time when the error carries one (SPEC.md §7.1), clamped to
    // sane bounds: never shorter than the configured pause, never longer than 6 h (a garbled
    // timestamp must not park the queue for a week).
    const parsed = errorText ? parseRetryAfterMs(errorText) : undefined
    const pauseMs =
      parsed === undefined ? this.rateLimitPauseMs : Math.min(Math.max(parsed, this.rateLimitPauseMs), 6 * 3600_000)
    this.store.log(
      jobId,
      'warn',
      `queue paused on a usage-limit signal; auto-resume in ${Math.round(pauseMs / 1000)}s` +
        `${parsed !== undefined ? ' (from the reported reset time)' : ''} (SPEC.md §7.1)`,
    )
    this.setTimeoutFn(() => this.resume(), pauseMs)
  }

  /**
   * Pauses because today's budget is spent, releasing at the next local midnight (SPEC.md §11.3).
   * There is no job to attribute this to — it happens before claiming — so it is announced on the
   * bus's `queue` channel rather than in a job log.
   */
  private pauseForBudget(): void {
    if (this.paused) return
    this.paused = true
    this.pauseReason = 'budget'
    const ms = this.msUntilBudgetReset()
    this.events?.publish({
      kind: 'log',
      log: {
        jobId: 'queue',
        ts: new Date().toISOString(),
        level: 'warn',
        message: `queue paused: daily budget reached; resumes in ${Math.round(ms / 60_000)} min (SPEC.md §11.3)`,
      },
    })
    this.events?.publish({ kind: 'stats' })
    this.setTimeoutFn(() => this.resume(), ms)
  }
}

/** Reconstructs a preprocess result from a manifest a prior attempt already wrote. */
function resultFromManifest(vaultRoot: string, jobDir: string, manifestPath: string): PreprocessResult {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest
  const primaryName = manifest.normalized ?? manifest.original
  const primaryAbs = path.join(jobDir, primaryName)
  return {
    type: manifest.type,
    deferred: manifest.deferred,
    manifestPath,
    primaryArtifact: toPosix(path.relative(vaultRoot, primaryAbs)),
    manifest,
  }
}
