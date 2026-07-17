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
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { JobRow, JobSource, JobType, CreateJobResult } from '../db/jobs.js'
import { JobStore } from '../db/jobs.js'
import type { AgentAuth, AgentRunResult } from './agent-runner.js'
import { runAgent, DEFAULT_TIMEOUT_MS } from './agent-runner.js'
import { formatMessage } from './format-message.js'
import { sha256File } from './hash.js'
import { preprocess, detectTools, type PreprocessResult, type Manifest, type ToolAvailability } from './preprocess/index.js'
import { preprocessUrl } from './preprocess/web.js'
import { extensionOf } from './preprocess/detect.js'
import { commitVault, type CommitResult } from './git.js'
import { Mutex } from '../util/mutex.js'

export type FailureClass = 'rate_limit' | 'transient' | 'permanent'

/** Signature of the ingest agent run — injectable so tests supply a fake. */
export type IngestRunner = (opts: {
  readonly vaultRoot: string
  readonly prompt: string
  readonly auth: AgentAuth
  readonly timeoutMs: number
  readonly onMessage: (message: SDKMessage) => void
}) => Promise<AgentRunResult>

export interface IngestQueueOptions {
  readonly store: JobStore
  readonly vaultRoot: string
  readonly auth: AgentAuth
  readonly concurrency?: number
  readonly timeoutMs?: number
  readonly maxRetries?: number
  /** How long to hold the queue after a usage-limit signal before auto-resuming. */
  readonly rateLimitPauseMs?: number
  readonly runIngest?: IngestRunner
  readonly preprocessFile?: typeof preprocess
  readonly preprocessUrlFn?: typeof preprocessUrl
  readonly detectToolsFn?: () => Promise<ToolAvailability>
  readonly commit?: (vaultRoot: string, message: string) => Promise<CommitResult>
  /** Hot-cache refresh hook; returns a note logged against the job. See file note in queue.ts. */
  readonly refreshHotCache?: (vaultRoot: string) => Promise<string>
  readonly setTimeoutFn?: (fn: () => void, ms: number) => void
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

export class IngestQueue {
  private readonly store: JobStore
  private readonly vaultRoot: string
  private readonly auth: AgentAuth
  private readonly concurrency: number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly rateLimitPauseMs: number
  private readonly runIngest: IngestRunner
  private readonly preprocessFile: typeof preprocess
  private readonly preprocessUrlFn: typeof preprocessUrl
  private readonly detectToolsFn: () => Promise<ToolAvailability>
  private readonly commit: (vaultRoot: string, message: string) => Promise<CommitResult>
  private readonly refreshHotCache: (vaultRoot: string) => Promise<string>
  private readonly setTimeoutFn: (fn: () => void, ms: number) => void

  private readonly commitMutex = new Mutex()
  private running = false
  private paused = false
  private inFlight = 0
  private toolsCache: ToolAvailability | undefined
  private idleWaiters: Array<() => void> = []

  constructor(opts: IngestQueueOptions) {
    this.store = opts.store
    this.vaultRoot = opts.vaultRoot
    this.auth = opts.auth
    this.concurrency = opts.concurrency ?? 2
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = opts.maxRetries ?? 2
    this.rateLimitPauseMs = opts.rateLimitPauseMs ?? 60_000
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
  }

  /** Starts pumping. Existing `queued` rows (e.g. after a restart) are picked up. */
  start(): void {
    this.running = true
    this.pump()
  }

  /** Stops claiming new work. In-flight jobs run to completion. */
  stop(): void {
    this.running = false
  }

  get isPaused(): boolean {
    return this.paused
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
  }): Promise<CreateJobResult> {
    const originalName = input.originalName ?? path.basename(input.sourcePath)
    const sha256 = await sha256File(input.sourcePath)
    const created = this.store.create({
      source: input.source,
      type: guessType(originalName),
      originalName,
      sha256,
      ...(input.batchId ? { batchId: input.batchId } : {}),
    })
    if (created.duplicateOf === undefined) {
      const jobDir = path.join(this.vaultRoot, '.raw', created.job.id)
      fs.mkdirSync(jobDir, { recursive: true })
      fs.copyFileSync(input.sourcePath, path.join(jobDir, originalName))
      this.store.setRawPath(created.job.id, path.posix.join('.raw', created.job.id))
    }
    this.pump()
    return created
  }

  /** Enqueues a URL job (not content-addressed, so not deduped). */
  enqueueUrl(input: { readonly url: string; readonly source?: JobSource; readonly batchId?: string }): CreateJobResult {
    const created = this.store.create({
      source: input.source ?? 'url',
      type: 'web',
      url: input.url,
      ...(input.batchId ? { batchId: input.batchId } : {}),
    })
    this.pump()
    return created
  }

  /** Resolves once the queue has no in-flight jobs and nothing left to claim. */
  onIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /** Manually resumes after a usage-limit pause (also called by the auto-resume timer). */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.pump()
  }

  private isIdle(): boolean {
    if (this.inFlight > 0) return false
    // A paused queue makes no further progress until it resumes, so with nothing in
    // flight it counts as settled even though jobs are still queued behind the pause.
    if (this.paused) return true
    return this.store.listByStatus('queued').length === 0
  }

  private settleIdle(): void {
    if (this.isIdle()) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private pump(): void {
    if (!this.running || this.paused) {
      this.settleIdle()
      return
    }
    while (this.inFlight < this.concurrency) {
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

    const res = await this.runIngest({
      vaultRoot: this.vaultRoot,
      prompt,
      auth: this.auth,
      timeoutMs: this.timeoutMs,
      onMessage: (m) => {
        const line = formatMessage(m)
        if (line !== undefined) this.store.log(job.id, 'info', line)
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
      await this.commitStep(job)
      const note = await this.refreshHotCache(this.vaultRoot)
      this.store.log(job.id, 'info', note)
      return
    }

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
      this.pauseForRateLimit(job.id)
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

  private async commitStep(job: JobRow): Promise<void> {
    const label = job.original_name ?? job.url ?? job.id
    try {
      const result = await this.commitMutex.runExclusive(() => this.commit(this.vaultRoot, `ingest: ${label}`))
      if (result.committed) {
        this.store.setCreatedPages(job.id, result.committedPages)
        this.store.log(
          job.id,
          'info',
          `committed ${result.hash?.slice(0, 8)} (${result.committedPages.length} wiki page(s))`,
        )
      } else {
        this.store.log(job.id, 'info', `not committed: ${result.note ?? 'no changes'}`)
      }
    } catch (err) {
      // A commit failure must not undo a completed ingest — the pages are on disk and the
      // next successful job's `git add -A` will sweep them in. Surface it, don't fail.
      this.store.log(job.id, 'warn', `git commit failed (pages are on disk): ${(err as Error).message}`)
    }
  }

  private deferJob(job: JobRow, jobDir: string): void {
    if (job.source === 'url' || !job.original_name) return
    const src = path.join(jobDir, job.original_name)
    if (!fs.existsSync(src)) return
    const deferredDir = path.join(this.vaultRoot, '.raw', 'deferred')
    fs.mkdirSync(deferredDir, { recursive: true })
    fs.renameSync(src, path.join(deferredDir, `${job.id}-${job.original_name}`))
  }

  private pauseForRateLimit(jobId: string): void {
    if (this.paused) return
    this.paused = true
    this.store.log(
      jobId,
      'warn',
      `queue paused on a usage-limit signal; auto-resume in ${Math.round(this.rateLimitPauseMs / 1000)}s (SPEC.md §7.1)`,
    )
    this.setTimeoutFn(() => this.resume(), this.rateLimitPauseMs)
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
