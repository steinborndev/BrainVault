/**
 * Spend aggregation for the System screen's "Usage & cost" section.
 *
 * The service has always recorded what every agent run cost - `jobs.cost_usd` per ingest,
 * `result.usage` per maintenance run - and the dashboard only ever showed it one row at a
 * time. These helpers roll both sources into the two questions the number is actually asked
 * for: where does the money go, and which runs were the expensive ones.
 *
 * Pure functions over plain arrays (no fetching, no Date.now inside) so the windows stay
 * unit-testable; the section feeds them from the queries it already runs.
 */

import type { AgentRunRecord, Job } from '../api/types.ts'

export interface SpendItem {
  /** Stable id, for keys and for opening the underlying record. */
  readonly id: string
  /** What was paid for: a file name, a URL, or a run label. */
  readonly label: string
  /** The channel it is booked under: the job's source, or the run's kind. */
  readonly channel: string
  readonly costUsd: number
  readonly tokensIn: number
  readonly tokensOut: number
  /** When the run settled - the moment the cost was incurred. */
  readonly whenIso: string
  readonly kind: 'ingest' | 'run'
}

export interface ChannelSpend {
  readonly channel: string
  readonly costUsd: number
  readonly runs: number
}

/**
 * Every priced agent run the client knows about, newest first.
 *
 * `runs` comes from the persistent run log (`GET /maintenance/history`), not from the
 * runner's in-memory registry. The section used to read the registry, which the runner
 * rebuilds empty on every start - so "where did the money go" answered "nowhere" after each
 * restart, while the log right beside it held the runs and their cost.
 */
export function spendItems(jobs: readonly Job[], runs: readonly AgentRunRecord[]): SpendItem[] {
  const out: SpendItem[] = []

  for (const j of jobs) {
    if (j.cost_usd === null || j.cost_usd === 0) continue
    out.push({
      id: j.id,
      label: j.original_name ?? j.url ?? j.id,
      channel: j.source,
      costUsd: j.cost_usd,
      tokensIn: j.tokens_in ?? 0,
      tokensOut: j.tokens_out ?? 0,
      whenIso: j.finished_at ?? j.started_at ?? j.created_at,
      kind: 'ingest',
    })
  }

  for (const r of runs) {
    // A run with no cost recorded is not the same as a free run, but neither belongs in a
    // "where it went" chart: both contribute nothing to explain.
    if (r.costUsd === null || r.costUsd === 0) continue
    out.push({
      id: r.id,
      label: r.label ?? r.kind,
      channel: r.kind,
      costUsd: r.costUsd,
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
      whenIso: r.finishedAt,
      kind: 'run',
    })
  }

  return out.sort((a, b) => Date.parse(b.whenIso) - Date.parse(a.whenIso))
}

/** Items no older than `days`, measured from `now`. `days = null` keeps everything. */
export function withinDays(items: readonly SpendItem[], days: number | null, now: Date): SpendItem[] {
  if (days === null) return [...items]
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000
  return items.filter((i) => Date.parse(i.whenIso) >= cutoff)
}

/** Spend per channel, biggest first - the "where did it go" bar chart. */
export function spendByChannel(items: readonly SpendItem[]): ChannelSpend[] {
  const m = new Map<string, ChannelSpend>()
  for (const i of items) {
    const prev = m.get(i.channel)
    m.set(i.channel, {
      channel: i.channel,
      costUsd: (prev?.costUsd ?? 0) + i.costUsd,
      runs: (prev?.runs ?? 0) + 1,
    })
  }
  return [...m.values()].sort((a, b) => b.costUsd - a.costUsd)
}

/** The `limit` most expensive runs in the window. */
export function topSpend(items: readonly SpendItem[], limit: number): SpendItem[] {
  return [...items].sort((a, b) => b.costUsd - a.costUsd).slice(0, limit)
}

export const totalSpend = (items: readonly SpendItem[]): number =>
  items.reduce((sum, i) => sum + i.costUsd, 0)
