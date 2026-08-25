/**
 * The activity model behind Home (redesign 2026-08-25, second pass).
 *
 * Home and the Inbox used to describe the same events twice: a feed of cards on one screen,
 * a filterable table on the other, with two different vocabularies for the same filter. One
 * model now feeds one table, and the four kinds of thing that change a vault are equal
 * citizens in it:
 *
 *   ingest       a file, link or message became pages (a `jobs` row)
 *   research     a web-enabled run the user started on purpose
 *   maintenance  something the vault did to itself (lint, hot cache, domains, tags)
 *   edit         a commit no job or run explains: a manual page save or delete
 *
 * Pure functions over plain arrays - no fetching, no `Date.now()` inside - so the merge and
 * the windows stay unit-testable; Home feeds them from the queries it already runs.
 */

import type {
  AgentRunRecord,
  Commit,
  Job,
  JobStatus,
  MaintenanceAreaState,
  MaintenanceRun,
} from '../api/types.ts'
import { parsePages } from './format.ts'

export type ActivityKind = 'ingest' | 'research' | 'maintenance' | 'edit'

/**
 * The state axis of the filter. `running` collapses the queue's two working states
 * (`preprocessing`, `ingesting`) plus any live agent run - "what is moving right now" is one
 * question, not three.
 */
export type ActivityState = 'running' | 'queued' | 'done' | 'failed' | 'deferred' | 'duplicate' | 'cancelled'

export interface ActivityEvent {
  readonly id: string
  readonly kind: ActivityKind
  readonly state: ActivityState
  readonly title: string
  /** Where it came from: the job's source, the run kind, or `manual` for a hand edit. */
  readonly channel: string
  readonly whenIso: string
  readonly pages: readonly string[]
  readonly costUsd: number | null
  readonly commit: string | null
  /** True while the service is still working on it - these rows ride at the top, untinted by
   *  the time range (something running now is never "older than 30 days"). */
  readonly live: boolean
  /** Present for ingest rows: opens the job drawer with log, commit, retry and revert. */
  readonly job?: Job
  /** Present for live agent runs: drives the progress line. */
  readonly run?: MaintenanceRun
  /** The raw run kind (`lint`, `research`, …) for run rows - the row names it from this. */
  readonly runKind?: string
  /** When the run started, where that is known - the table shows a duration from it. */
  readonly startedIso?: string
  /** Failure reason, duplicate note, deferral reason - the one line that explains the state. */
  readonly note?: string
}

const WORKING: JobStatus[] = ['preprocessing', 'ingesting']

/** The state a job row reports under. */
export function jobState(status: JobStatus): ActivityState {
  if (WORKING.includes(status)) return 'running'
  return status as ActivityState
}

/**
 * System pages ride along in every ingest commit (underscore-prefixed index hubs, the wiki
 * root's hot/index/log/overview) and would drown the actual knowledge in a row's page chips.
 * The job drawer still lists everything.
 */
export function contentPages(paths: readonly string[]): string[] {
  return paths.filter((p) => {
    const base = p.split('/').pop() ?? p
    if (base.startsWith('_')) return false
    return !/^wiki\/(hot|index|log|overview)\.md$/.test(p)
  })
}

/** Research is its own kind; every other agent run is maintenance. */
const kindOfRun = (runKind: string): ActivityKind => (runKind === 'research' ? 'research' : 'maintenance')

/**
 * What a commit was, read off the subject the service itself wrote:
 *
 *   ingest: …        the ingest queue           (`queue.ts`)
 *   maintenance: …   an agent maintenance run   (`maintenance.ts`)
 *   chat: …          a saved conversation       (`maintenance.ts`)
 *   edit: / delete:  a page written by hand     (`routes/pages.ts`)
 *   domains: add …   a domain added by hand     (`routes/domains.ts`)
 *
 * This matters after "clear history": while a job row exists its commit is attributed to it
 * and never becomes an event of its own. Once the row is deleted the commit is all that is
 * left - and calling an ingest commit a "manual edit" because its job record is gone would
 * be a lie the vault's own history contradicts.
 */
export function classifyCommit(subject: string): { kind: ActivityKind; channel: string } {
  if (subject.startsWith('ingest:')) return { kind: 'ingest', channel: 'git' }
  if (subject.startsWith('maintenance:') || subject.startsWith('chat:')) {
    return { kind: 'maintenance', channel: 'git' }
  }
  // Everything else is a person writing the vault: the page editor, the domain form, or a
  // commit made outside the service entirely (Obsidian, a terminal).
  return { kind: 'edit', channel: 'manual' }
}

export interface ActivityInput {
  readonly jobs: readonly Job[]
  /** Agent runs in flight (research, lint, hot cache …) - no queue tracks these. */
  readonly activeRuns: readonly MaintenanceRun[]
  /**
   * The persistent run log (schema v12): every settled agent run, with what it cost and how
   * long it took. Preferred over `lastRuns`, which only ever holds the newest run per kind.
   */
  readonly runHistory?: readonly AgentRunRecord[]
  /** Restart-proof last settle per run kind - the fallback for runs older than the log. */
  readonly lastRuns: readonly MaintenanceAreaState[]
  /** Recent vault commits, for the events nothing else explains. */
  readonly commits: readonly Commit[]
}

/**
 * One stream out of four sources, newest first.
 *
 * A commit is dropped when a job already claims it, or when a maintenance run settled within
 * 90 s of it - the settle record carries no hash, so time proximity is the only join
 * available. Without that, every agent run would also appear as an anonymous "edit".
 */
export function buildActivity(input: ActivityInput): ActivityEvent[] {
  const out: ActivityEvent[] = []
  const jobCommits = new Set<string>()

  for (const j of input.jobs) {
    const state = jobState(j.status)
    const live = state === 'running' || state === 'queued'
    if (j.commit_hash != null) jobCommits.add(j.commit_hash.slice(0, 8))
    out.push({
      id: `job:${j.id}`,
      kind: 'ingest',
      state,
      title: j.original_name ?? j.url ?? j.id,
      channel: j.source,
      whenIso: live ? (j.started_at ?? j.created_at) : (j.finished_at ?? j.started_at ?? j.created_at),
      pages: contentPages(parsePages(j.created_pages)),
      costUsd: j.cost_usd,
      commit: j.commit_hash ?? null,
      live,
      job: j,
      ...(j.error !== null && j.error !== '' ? { note: j.error } : {}),
    })
  }

  for (const r of input.activeRuns) {
    out.push({
      id: `run:${r.id}`,
      kind: kindOfRun(r.kind),
      state: 'running',
      title: r.label ?? '',
      runKind: r.kind,
      channel: r.kind,
      whenIso: r.startedAt,
      pages: [],
      costUsd: null,
      commit: null,
      live: true,
      run: r,
    })
  }

  const settleTimes: number[] = []
  const loggedIds = new Set<string>()
  const loggedKinds = new Map<string, number>()

  for (const r of input.runHistory ?? []) {
    loggedIds.add(r.id)
    const at = Date.parse(r.finishedAt)
    settleTimes.push(at)
    loggedKinds.set(r.kind, Math.max(loggedKinds.get(r.kind) ?? 0, at))
    out.push({
      id: `logrun:${r.id}`,
      kind: kindOfRun(r.kind),
      state: r.ok ? 'done' : 'failed',
      title: r.label ?? '',
      runKind: r.kind,
      channel: r.kind,
      whenIso: r.finishedAt,
      pages: contentPages(r.pages),
      costUsd: r.costUsd,
      commit: null,
      live: false,
      startedIso: r.startedAt,
      ...(r.error !== null ? { note: r.error } : {}),
    })
  }

  for (const a of input.lastRuns) {
    // The log is the better record; the settle row only fills in for runs that predate it.
    if (loggedIds.has(a.runId)) continue
    const at = Date.parse(a.finishedAt)
    if ((loggedKinds.get(a.kind) ?? -Infinity) >= at) continue
    settleTimes.push(at)
    out.push({
      id: `settle:${a.kind}:${a.runId}`,
      kind: kindOfRun(a.kind),
      state: a.ok ? 'done' : 'failed',
      title: '',
      runKind: a.kind,
      channel: a.kind,
      whenIso: a.finishedAt,
      pages: [],
      costUsd: null,
      commit: null,
      live: false,
      ...(a.error !== null ? { note: a.error } : {}),
    })
  }

  for (const c of input.commits) {
    if (jobCommits.has(c.hash.slice(0, 8))) continue
    const t = Date.parse(c.date)
    if (settleTimes.some((rt) => Math.abs(rt - t) < 90_000)) continue
    const { kind, channel } = classifyCommit(c.subject)
    out.push({
      id: `commit:${c.hash}`,
      kind,
      state: 'done',
      title: c.subject,
      channel,
      whenIso: c.date,
      pages: contentPages(c.pages),
      costUsd: null,
      commit: c.hash,
      live: false,
    })
  }

  return out.sort((a, b) => Date.parse(b.whenIso) - Date.parse(a.whenIso))
}

export interface ActivityFilter {
  readonly kind: ActivityKind | 'all'
  readonly state: ActivityState | null
  readonly channel: string | null
  /** Time window in days for settled rows; null = everything the store still holds. */
  readonly days: number | null
  readonly query: string
}

export const EMPTY_FILTER: ActivityFilter = { kind: 'all', state: null, channel: null, days: 30, query: '' }

const DAY_MS = 24 * 60 * 60 * 1000

/** Does this event survive the filter? Live rows ignore the time range on purpose. */
export function matchesFilter(e: ActivityEvent, f: ActivityFilter, now: Date): boolean {
  if (f.kind !== 'all' && e.kind !== f.kind) return false
  if (f.state !== null && e.state !== f.state) return false
  if (f.channel !== null && e.channel !== f.channel) return false
  const q = f.query.trim().toLowerCase()
  if (q !== '' && !e.title.toLowerCase().includes(q)) return false
  if (!e.live && f.days !== null && now.getTime() - Date.parse(e.whenIso) > f.days * DAY_MS) return false
  return true
}

export function filterActivity(
  events: readonly ActivityEvent[],
  f: ActivityFilter,
  now: Date,
): ActivityEvent[] {
  return events.filter((e) => matchesFilter(e, f, now))
}

/** Per-channel counts over the unfiltered stream - the panel's channel list. */
export function channelCounts(events: readonly ActivityEvent[]): Array<[string, number]> {
  const m = new Map<string, number>()
  for (const e of events) m.set(e.channel, (m.get(e.channel) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
