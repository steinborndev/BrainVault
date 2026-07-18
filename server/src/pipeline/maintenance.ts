/**
 * Maintenance runs (SPEC.md §6.4, TASKS-M4 §2): lint, autoresearch, hot-cache refresh. Each
 * is a vault-mutating agent run, so — unlike chat — it goes through the SAME commit
 * discipline as ingest: a shared commit mutex (one writer) and a per-run commit. Progress is
 * streamed live to the dashboard over the event bus under a stable per-kind channel id
 * (`maintenance:lint` etc.), which the Wartung tab renders as a live log.
 *
 * Runs are ASYNC/job-style (TASKS-M5 §0): `start*()` registers a run, kicks it off in the
 * background and returns a `runId` immediately — the HTTP request is NOT held for the (up to
 * 15-min) agent run, so a slow or stuck lint can no longer wedge the request or a worker. The
 * caller polls `getRun(id)` for the result while watching the live log on the bus channel.
 * A stuck run is now bounded by the agent runner's hard, group-level kill (Finding F1).
 *
 * Profiles (permissions.ts): lint + hot-cache use `ingest` (write, no web); autoresearch
 * uses `research` (write AND web egress — the one flow allowed the web, CLAUDE.md hard rule 4).
 */

import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { runAgent, type AgentAuth, type AgentRunResult, DEFAULT_TIMEOUT_MS } from './agent-runner.js'
import { formatMessage } from './format-message.js'
import { commitVault, BOOKKEEPING_PATHS, type CommitResult, type CommitOptions } from './git.js'
import { extractWrittenPaths } from './written-paths.js'
import { parseLintReport, type LintReport } from './lint-report.js'
import { indexWikiPages } from './citations.js'
import type { EventBus } from './events.js'
import { Mutex } from '../util/mutex.js'

export type MaintenanceKind = 'lint' | 'research' | 'hot-cache'

/** Stable SSE channel id per kind, so the UI can subscribe to a run's live log. */
export const maintenanceChannel = (kind: MaintenanceKind): string => `maintenance:${kind}`

/** Injectable agent runner (tests supply a fake — no real SDK). Matches runAgent's shape. */
export type MaintenanceAgentRunner = typeof runAgent

export interface MaintenanceRunnerOptions {
  readonly vaultRoot: string
  readonly auth: AgentAuth
  readonly events: EventBus
  /** Shared with the ingest queue so commits never interleave (TASKS-M4 §2). */
  readonly commitMutex: Mutex
  readonly runAgent?: MaintenanceAgentRunner
  readonly commit?: (vaultRoot: string, message: string, opts?: CommitOptions) => Promise<CommitResult>
  readonly timeoutMs?: number
}

export interface MaintenanceResult {
  readonly ok: boolean
  readonly kind: MaintenanceKind
  /** Committed wiki pages touched by the run (from the commit). */
  readonly pages: string[]
  readonly usage: AgentRunResult['usage']
  readonly error?: string
  /** The agent's final text — a summary/fallback the UI can render as markdown. */
  readonly answer?: string
  /** Present for a lint run: the parsed report (from the written file, or the answer text). */
  readonly lint?: LintReport
  /** Where the lint report was written (vault-relative), if a file was found. */
  readonly reportPath?: string
}

export type MaintenanceRunStatus = 'running' | 'done' | 'error'

/**
 * A tracked async run. `start*()` returns this immediately (status `running`); the client
 * polls `getRun(id)` until it settles to `done`/`error`, at which point `result` is present.
 */
export interface MaintenanceRun {
  readonly id: string
  readonly kind: MaintenanceKind
  /** SSE channel carrying this run's live log — the UI subscribes to it. */
  readonly channel: string
  readonly status: MaintenanceRunStatus
  readonly startedAt: string
  readonly finishedAt?: string
  readonly result?: MaintenanceResult
  /** Failure reason when `status === 'error'` (agent failure or an unexpected throw). */
  readonly error?: string
}

/** How many finished runs to retain for polling before the oldest is evicted. */
const RUN_HISTORY_CAP = 25

export class MaintenanceRunner {
  private readonly vaultRoot: string
  private readonly auth: AgentAuth
  private readonly events: EventBus
  private readonly commitMutex: Mutex
  private readonly runAgentFn: MaintenanceAgentRunner
  private readonly commit: (vaultRoot: string, message: string, opts?: CommitOptions) => Promise<CommitResult>
  private readonly timeoutMs: number
  /** One maintenance run at a time — they all write the vault. */
  private readonly runMutex = new Mutex()
  /** In-memory registry of async runs, keyed by run id (insertion-ordered for eviction). */
  private readonly runs = new Map<string, MaintenanceRun>()

  constructor(opts: MaintenanceRunnerOptions) {
    this.vaultRoot = opts.vaultRoot
    this.auth = opts.auth
    this.events = opts.events
    this.commitMutex = opts.commitMutex
    this.runAgentFn = opts.runAgent ?? runAgent
    this.commit = opts.commit ?? commitVault
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Starts a lint run in the background; returns its tracked run immediately. */
  startLint(): MaintenanceRun {
    // Be explicit: run the skill, WRITE the report file (the dashboard reads it back), and
    // report-only — never auto-fix, so a lint can't silently rewrite content pages.
    return this.start(
      'lint',
      'Use the wiki-lint skill to health-check the entire wiki and WRITE the full report to ' +
        'wiki/meta/lint-report-<today>.md (date as YYYY-MM-DD). Report only — do NOT auto-fix or ' +
        'modify any existing wiki page. Keep the standard report sections (Orphan Pages, Dead Links, ' +
        'Missing Pages, Frontmatter Gaps, Stale Claims, Cross-Reference Gaps). ' +
        // Belt-and-braces with the hard kill (F1): the DragonScale Mechanism 3 "semantic tiling"
        // path runs embeddings via a long bash call. The runner will now group-kill a stuck run,
        // but the report only needs the read-based checks, so still skip the heavy embedding pass.
        'Do NOT run DragonScale Mechanism 3 semantic tiling or any embedding/similarity pass — ' +
        'use only the read-based checks (Read/Grep/Glob).',
      'ingest',
    )
  }

  /** Starts an autoresearch run in the background; returns its tracked run immediately. */
  startResearch(topic: string): MaintenanceRun {
    return this.start('research', `/autoresearch ${topic}`, 'research')
  }

  /** Starts a hot-cache refresh in the background; returns its tracked run immediately. */
  startHotCache(): MaintenanceRun {
    return this.start('hot-cache', 'update hot cache', 'ingest')
  }

  /** A tracked run by id (for the poll endpoint), or undefined once evicted. */
  getRun(id: string): MaintenanceRun | undefined {
    return this.runs.get(id)
  }

  /** All tracked runs, newest first (most-recent history for the UI). */
  listRuns(): MaintenanceRun[] {
    return [...this.runs.values()].reverse()
  }

  /**
   * Registers a run and kicks it off in the background. Returns the `running` record at once —
   * the (up to 15-min) agent work happens off the request path. Concurrent starts still
   * serialize on the run mutex; a queued one simply reports `running` until its turn.
   */
  private start(kind: MaintenanceKind, prompt: string, profile: 'ingest' | 'research'): MaintenanceRun {
    const id = randomUUID()
    const run: MaintenanceRun = {
      id,
      kind,
      channel: maintenanceChannel(kind),
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    this.runs.set(id, run)
    this.evictOldRuns()
    // Fire-and-forget: execute() never rejects (it records failures on the run record).
    void this.execute(id, kind, prompt, profile)
    return run
  }

  /** Runs the agent work, then settles the run record to `done`/`error`. Never rejects. */
  private async execute(
    id: string,
    kind: MaintenanceKind,
    prompt: string,
    profile: 'ingest' | 'research',
  ): Promise<void> {
    try {
      const result = await this.run(kind, prompt, profile)
      this.settle(id, result.ok ? 'done' : 'error', {
        result,
        ...(result.ok ? {} : { error: result.error ?? `${kind} failed` }),
      })
    } catch (err) {
      // run() only throws on unexpected (non-agent) errors; record them so the poll surfaces it.
      const message = err instanceof Error ? err.message : String(err)
      this.events.publish({
        kind: 'log',
        log: { jobId: maintenanceChannel(kind), ts: new Date().toISOString(), level: 'error', message: `maintenance: ${kind} crashed: ${message}` },
      })
      this.settle(id, 'error', { error: message })
    }
  }

  /** Transitions a tracked run to its terminal state (records may already be evicted — no-op then). */
  private settle(id: string, status: MaintenanceRunStatus, patch: { result?: MaintenanceResult; error?: string }): void {
    const prev = this.runs.get(id)
    if (!prev) return
    this.runs.set(id, { ...prev, status, finishedAt: new Date().toISOString(), ...patch })
  }

  /** Bounds the registry so long-lived services don't accumulate run records without limit. */
  private evictOldRuns(): void {
    while (this.runs.size > RUN_HISTORY_CAP) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined) break
      this.runs.delete(oldest)
    }
  }

  private async run(
    kind: MaintenanceKind,
    prompt: string,
    profile: 'ingest' | 'research',
  ): Promise<MaintenanceResult> {
    return this.runMutex.runExclusive(async () => {
      const channel = maintenanceChannel(kind)
      const log = (level: 'info' | 'warn' | 'error', message: string): void =>
        this.events.publish({ kind: 'log', log: { jobId: channel, ts: new Date().toISOString(), level, message } })

      log('info', `maintenance: ${kind} started`)
      const written = new Set<string>()
      const res = await this.runAgentFn({
        vaultRoot: this.vaultRoot,
        prompt,
        auth: this.auth,
        profile,
        timeoutMs: this.timeoutMs,
        onMessage: (m: SDKMessage) => {
          const line = formatMessage(m)
          if (line !== undefined) log('info', line)
          for (const p of extractWrittenPaths(m, this.vaultRoot)) written.add(p)
        },
      })

      if (!res.ok) {
        log('error', `maintenance: ${kind} failed: ${res.error ?? 'unknown error'}`)
        return { ok: false, kind, pages: [], usage: res.usage, error: res.error ?? `${kind} failed` }
      }

      // One commit per run, serialized against ingest commits.
      const pathspec = [...written, ...BOOKKEEPING_PATHS]
      const commit = await this.commitMutex.runExclusive(() =>
        this.commit(this.vaultRoot, `maintenance: ${kind}`, { pathspec }),
      )
      const pages = commit.committed ? commit.committedPages : []
      log('info', commit.committed ? `committed ${commit.hash?.slice(0, 8)} (${pages.length} page(s))` : 'nothing to commit')
      this.events.publish({ kind: 'stats' })

      const base: MaintenanceResult = { ok: true, kind, pages, usage: res.usage, answer: res.result }
      if (kind === 'lint') {
        // Prefer the written report file; fall back to parsing the agent's inline answer, so
        // a run that summarised in text instead of writing a file still yields structure.
        const fromFile = this.readLatestLintReport()
        if (fromFile && fromFile.report.totalFindings > 0) {
          return { ...base, lint: fromFile.report, reportPath: fromFile.path }
        }
        const fromText = this.parseReportText(res.result)
        if (fromFile) return { ...base, lint: fromFile.report, reportPath: fromFile.path }
        if (fromText.totalFindings > 0 || fromText.sections.length > 0) return { ...base, lint: fromText }
      }
      log('info', `maintenance: ${kind} complete`)
      return base
    })
  }

  /** Parses a lint report out of arbitrary answer text (fallback when no file was written). */
  private parseReportText(text: string): LintReport {
    const pageIndex = indexWikiPages(this.vaultRoot)
    return parseLintReport(text, (label) => ({
      label,
      path: pageIndex.get(label.toLowerCase()) ?? null,
    }))
  }

  /** Finds and parses the newest `wiki/meta/lint-report-*.md` the run just wrote. */
  private readLatestLintReport(): { report: LintReport; path: string } | undefined {
    const metaDir = path.join(this.vaultRoot, 'wiki', 'meta')
    let files: string[]
    try {
      files = fs
        .readdirSync(metaDir)
        .filter((f) => /^lint-report-.*\.md$/.test(f))
        .sort()
    } catch {
      return undefined
    }
    const newest = files[files.length - 1]
    if (!newest) return undefined
    const markdown = fs.readFileSync(path.join(metaDir, newest), 'utf8')
    const pageIndex = indexWikiPages(this.vaultRoot)
    const report = parseLintReport(markdown, (label) => ({
      label,
      path: pageIndex.get(label.toLowerCase()) ?? null,
    }))
    return { report, path: path.posix.join('wiki', 'meta', newest) }
  }
}
