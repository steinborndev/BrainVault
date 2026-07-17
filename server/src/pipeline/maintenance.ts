/**
 * Maintenance runs (SPEC.md §6.4, TASKS-M4 §2): lint, autoresearch, hot-cache refresh. Each
 * is a vault-mutating agent run, so — unlike chat — it goes through the SAME commit
 * discipline as ingest: a shared commit mutex (one writer) and a per-run commit. Progress is
 * streamed live to the dashboard over the event bus under a stable per-kind channel id
 * (`maintenance:lint` etc.), which the Wartung tab renders as a live log.
 *
 * Profiles (permissions.ts): lint + hot-cache use `ingest` (write, no web); autoresearch
 * uses `research` (write AND web egress — the one flow allowed the web, CLAUDE.md hard rule 4).
 */

import path from 'node:path'
import fs from 'node:fs'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { runAgent, type AgentAuth, type AgentRunResult, DEFAULT_TIMEOUT_MS } from './agent-runner.js'
import { formatMessage } from './format-message.js'
import { commitVault, type CommitResult, type CommitOptions } from './git.js'
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
  /** Present for a successful lint run: the parsed report. */
  readonly lint?: LintReport
  /** Where the lint report was written (vault-relative), if found. */
  readonly reportPath?: string
}

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

  constructor(opts: MaintenanceRunnerOptions) {
    this.vaultRoot = opts.vaultRoot
    this.auth = opts.auth
    this.events = opts.events
    this.commitMutex = opts.commitMutex
    this.runAgentFn = opts.runAgent ?? runAgent
    this.commit = opts.commit ?? commitVault
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  lint(): Promise<MaintenanceResult> {
    return this.run('lint', 'lint the wiki', 'ingest')
  }

  research(topic: string): Promise<MaintenanceResult> {
    return this.run('research', `/autoresearch ${topic}`, 'research')
  }

  refreshHotCache(): Promise<MaintenanceResult> {
    return this.run('hot-cache', 'update hot cache', 'ingest')
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
      const pathspec = [...written, '.vault-meta', '.raw/.manifest.json']
      const commit = await this.commitMutex.runExclusive(() =>
        this.commit(this.vaultRoot, `maintenance: ${kind}`, { pathspec }),
      )
      const pages = commit.committed ? commit.committedPages : []
      log('info', commit.committed ? `committed ${commit.hash?.slice(0, 8)} (${pages.length} page(s))` : 'nothing to commit')
      this.events.publish({ kind: 'stats' })

      const base: MaintenanceResult = { ok: true, kind, pages, usage: res.usage }
      if (kind === 'lint') {
        const parsed = this.readLatestLintReport()
        if (parsed) return { ...base, lint: parsed.report, reportPath: parsed.path }
      }
      log('info', `maintenance: ${kind} complete`)
      return base
    })
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
