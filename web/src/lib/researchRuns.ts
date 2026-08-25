/**
 * The research run list (redesign 2026-08-25, second pass).
 *
 * Since schema v12 the server keeps one row per settled run (`GET /maintenance/history`),
 * which is the source of record: topic, lens, pages, tokens, cost, duration, and the failed
 * runs that never wrote a page. Three older sources still contribute, in this order:
 *
 *   history      the persistent run log - everything, for every run since v12 landed
 *   run record   the in-memory registry, which is the only one that knows about a run
 *                still IN FLIGHT
 *   settle state one restart-proof row per kind; a pre-v12 failure can only appear here
 *   vault page   topic and lens parsed back out of the deterministic
 *                `Research: <topic><lens suffix>` title, dated by mtime - this is what
 *                surfaces runs from before the run log existed
 *
 * Each source is dropped where a better one already covers the same run: by id, by claimed
 * page path, or by topic+lens within an hour of the same settle. Pure functions over plain
 * arrays (no fetching, no `Date.now()`), so the merge stays testable.
 */

import type {
  AgentRunRecord,
  GraphNode,
  MaintenanceAreaState,
  MaintenanceRun,
  ResearchProfile,
} from '../api/types.ts'

export interface ResearchRunEntry {
  readonly id: string
  /** The topic as typed, with the lens suffix stripped back off. */
  readonly topic: string
  readonly profileKey: string | null
  readonly status: 'running' | 'done' | 'failed'
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly pages: readonly string[]
  readonly costUsd: number | null
  readonly error: string | null
  /**
   * Where the row's facts come from: `history` = the persistent run log, `run` = the
   * in-memory registry (a run in flight), `state` = a per-kind settle record, `page` =
   * reconstructed from the synthesis page in the vault (pre-v12 runs).
   */
  readonly source: 'history' | 'run' | 'page' | 'state'
  /** The synthesis page, when this entry came from one. */
  readonly pagePath: string | null
}

export const RESEARCH_PREFIX = 'Research: '

/** How far apart a page mtime and a run settle may be and still be the same run. */
const SAME_RUN_MS = 60 * 60 * 1000

/**
 * Splits a synthesis page title back into topic and lens. Longest suffix first, so
 * ` - State of the Art` never loses to the empty default suffix.
 */
export function splitResearchTitle(
  title: string,
  profiles: readonly ResearchProfile[],
): { topic: string; profileKey: string | null } | null {
  if (!title.startsWith(RESEARCH_PREFIX)) return null
  const rest = title.slice(RESEARCH_PREFIX.length)
  const withSuffix = [...profiles]
    .filter((p) => p.titleSuffix !== '')
    .sort((a, b) => b.titleSuffix.length - a.titleSuffix.length)
  for (const p of withSuffix) {
    // Titles are written with the profile's own suffix, but a vault page may carry an
    // em-dash variant from an earlier version - compare on a normalized dash.
    const suffix = normalizeDashes(p.titleSuffix)
    if (normalizeDashes(rest).endsWith(suffix)) {
      return { topic: rest.slice(0, rest.length - suffix.length).trim(), profileKey: p.key }
    }
  }
  return { topic: rest.trim(), profileKey: null }
}

const normalizeDashes = (s: string): string => s.replace(/[–—]/g, '-')

export interface ResearchRunsInput {
  /** The persistent run log from `GET /maintenance/history?kind=research` (schema v12). */
  readonly history?: readonly AgentRunRecord[]
  /** Tracked runs from `GET /maintenance/runs` (all kinds; research is picked out here). */
  readonly runs: readonly MaintenanceRun[]
  /** Restart-proof settle records; only a failed research one adds anything a page cannot. */
  readonly lastRuns: readonly MaintenanceAreaState[]
  /** Graph nodes, for the synthesis pages that outlive every run record. */
  readonly nodes: readonly GraphNode[]
  readonly profiles: readonly ResearchProfile[]
}

export function buildResearchRuns(input: ResearchRunsInput): ResearchRunEntry[] {
  const out: ResearchRunEntry[] = []
  const claimedPages = new Set<string>()
  const seenIds = new Set<string>()
  const runFingerprints: Array<{ topic: string; profileKey: string | null; at: number }> = []

  for (const h of input.history ?? []) {
    if (h.kind !== 'research') continue
    seenIds.add(h.id)
    for (const p of h.pages) claimedPages.add(p)
    runFingerprints.push({
      topic: (h.label ?? '').trim().toLowerCase(),
      profileKey: h.profileKey,
      at: Date.parse(h.finishedAt),
    })
    out.push({
      id: h.id,
      topic: h.label ?? 'Research run',
      profileKey: h.profileKey,
      status: h.ok ? 'done' : 'failed',
      startedAt: h.startedAt,
      finishedAt: h.finishedAt,
      pages: h.pages,
      costUsd: h.costUsd,
      error: h.error,
      source: 'history',
      pagePath: null,
    })
  }

  for (const r of input.runs) {
    if (r.kind !== 'research') continue
    // The run log already carries every settled run; the registry only adds what is live.
    if (seenIds.has(r.id)) continue
    const status: ResearchRunEntry['status'] =
      r.status === 'running' ? 'running' : r.status === 'error' || r.result?.ok === false ? 'failed' : 'done'
    seenIds.add(r.id)
    const pages = r.result?.pages ?? []
    for (const p of pages) claimedPages.add(p)
    const finishedAt = r.finishedAt ?? null
    if (finishedAt !== null) {
      runFingerprints.push({
        topic: (r.label ?? '').trim().toLowerCase(),
        profileKey: r.profileKey ?? null,
        at: Date.parse(finishedAt),
      })
    }
    out.push({
      id: r.id,
      topic: r.label ?? 'Research run',
      profileKey: r.profileKey ?? null,
      status,
      startedAt: r.startedAt,
      finishedAt,
      pages,
      costUsd: r.result?.usage.costUsd ?? null,
      error: r.error ?? r.result?.error ?? null,
      source: 'run',
      pagePath: null,
    })
  }

  for (const n of input.nodes) {
    if (claimedPages.has(n.path)) continue
    const split = splitResearchTitle(n.title, input.profiles)
    if (split === null) continue
    const mtime = n.mtimeMs
    const finishedAt = mtime !== undefined ? new Date(mtime).toISOString() : null
    const duplicate = runFingerprints.some(
      (f) =>
        f.topic === split.topic.trim().toLowerCase() &&
        f.profileKey === split.profileKey &&
        (mtime === undefined || Math.abs(f.at - mtime) < SAME_RUN_MS),
    )
    if (duplicate) continue
    out.push({
      id: `page:${n.path}`,
      topic: split.topic,
      profileKey: split.profileKey,
      status: 'done',
      startedAt: null,
      finishedAt,
      pages: [n.path],
      costUsd: null,
      error: null,
      source: 'page',
      pagePath: n.path,
    })
  }

  // A failed run writes no page and leaves no tracked record after a restart - the settle
  // record is the only trace it ever happened, so it earns a row of its own.
  for (const a of input.lastRuns) {
    if (a.kind !== 'research' || a.ok) continue
    if (seenIds.has(a.runId) || out.some((e) => e.id === a.runId)) continue
    out.push({
      id: `state:${a.runId}`,
      topic: 'Research run',
      profileKey: null,
      status: 'failed',
      startedAt: null,
      finishedAt: a.finishedAt,
      pages: [],
      costUsd: null,
      error: a.error,
      source: 'state',
      pagePath: null,
    })
  }

  const when = (e: ResearchRunEntry): number => Date.parse(e.finishedAt ?? e.startedAt ?? '') || 0
  return out.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1
    if (b.status === 'running' && a.status !== 'running') return 1
    return when(b) - when(a)
  })
}

/** The deterministic page title a run with this topic and lens will file as. */
export function targetTitle(topic: string, profile: ResearchProfile | undefined): string {
  return `${RESEARCH_PREFIX}${topic}${profile?.titleSuffix ?? ''}`
}
