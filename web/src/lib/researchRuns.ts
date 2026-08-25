/**
 * The research run list (redesign 2026-08-25, second pass).
 *
 * With no run in flight the Research screen used to be empty, because the only run state it
 * knew was the one the current browser session had started. The server keeps its run
 * registry in memory and evicts it, and the restart-proof `maintenance_state` keeps just the
 * last settle per kind - so neither alone is a history.
 *
 * The vault is: every run files a synthesis page under a deterministic title
 * (`Research: <topic><lens suffix>`), and those pages are in the graph the dashboard already
 * loads, with their mtime. This module merges the three sources into one list:
 *
 *   run record   topic, lens, status, cost, pages - complete, but only until eviction
 *   settle state one restart-proof record per kind, which is how a FAILED run survives
 *   vault page   topic and lens parsed back out of the title, dated by mtime - permanent
 *
 * A page is dropped when a run record already claims it, so a finished run appears once.
 * Pure functions over plain arrays (no fetching, no `Date.now()`), so the merge is testable.
 */

import type { GraphNode, MaintenanceAreaState, MaintenanceRun, ResearchProfile } from '../api/types.ts'

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
  /** `run` = a live/tracked run record, `page` = reconstructed from the vault, `state` = a settle record. */
  readonly source: 'run' | 'page' | 'state'
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
  const runFingerprints: Array<{ topic: string; profileKey: string | null; at: number }> = []

  for (const r of input.runs) {
    if (r.kind !== 'research') continue
    const status: ResearchRunEntry['status'] =
      r.status === 'running' ? 'running' : r.status === 'error' || r.result?.ok === false ? 'failed' : 'done'
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
    if (out.some((e) => e.id === a.runId)) continue
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
