/**
 * The second panel beside the vault's shape (2026-08-27).
 *
 * The graph used the whole width of the stock zone and needed about half of it - a fitted
 * force layout in a box twice its size is empty canvas, not information. The half it gives
 * back holds a panel that says something the picture cannot, and there are three candidates
 * for that, all derived from payloads the screen already fetches:
 *
 *   domains     what the vault is about, by weight    (graph nodes)
 *   this week   which pages it actually learned       (the activity stream)
 *   gaps        what it links to but has not written  (graph gaps)
 *
 * Growth was a fourth. It is a single number per window, not a picture, so it reads better
 * as two more lines among the countable facts in the hero than as a panel of its own -
 * `newPagesIn` below is what those lines (and the hero's own delta) are computed with.
 *
 * Everything here is a pure derivation - no fetching, no clock of its own; `now` is passed
 * in - so the panel's content is testable without rendering it.
 */

import type { GraphNode, GrowthPoint } from '../api/types.ts'
import type { ActivityEvent } from './activity.ts'
import { isHubPage } from './homeArticle.ts'
import { isUnfiled, knowledgePages } from './vaultShape.ts'

export const PANEL_IDS = ['domains', 'week', 'gaps'] as const
export type PanelId = (typeof PANEL_IDS)[number]

export const isPanelId = (v: unknown): v is PanelId =>
  typeof v === 'string' && (PANEL_IDS as readonly string[]).includes(v)

/** How many days the week panel looks back. */
export const WEEK_DAYS = 7

const DAY_MS = 24 * 3600_000

export interface DomainCount {
  readonly domain: string
  readonly pages: number
}

/**
 * Pages per domain, biggest first, over the knowledge pages only. Unfiled ones are counted
 * apart rather than as a domain of their own: "unfiled" is a state, and ranking it against
 * real fields of knowledge would put a backlog at the top of a list about subject matter.
 *
 * Both predicates come from `vaultShape` rather than being restated here. Restating them was
 * exactly the bug its own header documents: the vault parks a page it cannot classify in a
 * catch-all domain, and counting that as a domain reported 19 domains and zero unfiled pages
 * on a vault the hero next door called 17 and 11.
 */
export function domainCounts(nodes: readonly GraphNode[]): { domains: DomainCount[]; unfiled: number } {
  const by = new Map<string, number>()
  let unfiled = 0
  for (const n of knowledgePages(nodes)) {
    if (isUnfiled(n)) unfiled++
    else by.set(n.domain as string, (by.get(n.domain as string) ?? 0) + 1)
  }
  const domains = [...by.entries()]
    .map(([domain, pages]) => ({ domain, pages }))
    // Ties on the name, so two builds over the same vault list them the same way.
    .sort((a, b) => b.pages - a.pages || a.domain.localeCompare(b.domain))
  return { domains, unfiled }
}

export interface DayGroup {
  /** Days back from today: 0 = today, 1 = yesterday. */
  readonly ago: number
  readonly pages: readonly string[]
}

/**
 * What the vault LEARNED in the last `days`, grouped by the day it landed.
 *
 * Built from what the runs wrote, not from file mtimes. A page's mtime is when the file was
 * last touched, and a vault-wide operation - a checkout, a lint pass, a frontmatter rewrite -
 * resets it for everything: measured against mtimes this panel reported 812 pages learned in
 * four days on a vault that had grown by 151 in seven. A run's own page list and its own
 * timestamp say exactly what was written and when.
 *
 * A page written twice in the window is listed once, on the newer day - "learned" happens
 * the first time you see it, and the same title on three days reads as three pages.
 */
export function recentPages(
  events: readonly ActivityEvent[],
  now: number,
  days = WEEK_DAYS,
): DayGroup[] {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const groups = new Map<number, string[]>()
  const seen = new Set<string>()
  const newestFirst = [...events].sort((a, b) => Date.parse(b.whenIso) - Date.parse(a.whenIso))
  for (const e of newestFirst) {
    const ago = Math.floor((midnight - new Date(e.whenIso).setHours(0, 0, 0, 0)) / DAY_MS)
    if (ago < 0 || ago >= days) continue
    for (const path of e.pages) {
      if (isHubPage(path) || seen.has(path)) continue
      seen.add(path)
      const list = groups.get(ago)
      if (list === undefined) groups.set(ago, [path])
      else list.push(path)
    }
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([ago, pages]) => ({ ago, pages }))
}

/** The local calendar day of a timestamp, as the `YYYY-MM-DD` the growth series uses. */
function isoDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * How many pages the wiki gained over the last `days`, from the cumulative growth series.
 *
 * A point's `total` is the page count at the END of that day, so the baseline is the newest
 * point on or before `today - days` and the answer is today's total minus it. Reading the
 * series by INDEX instead ("seven entries back") is only the same thing on a vault that
 * changed every single day: the server emits a point per day the vault actually moved, so on
 * a quiet week the eighth-from-last point can be a month old.
 *
 * Returns null when there is no history to measure against. When the series starts INSIDE
 * the window (a young vault, or a 30-day question against a 30-day series) the first point
 * is the baseline, which undercounts by whatever that first day itself added - the honest
 * alternative would be a longer series than the API sends.
 */
export function newPagesIn(points: readonly GrowthPoint[], days: number, now: number): number | null {
  if (points.length < 2) return null
  const total = points[points.length - 1]!.total
  const cutoff = isoDay(now - days * DAY_MS)
  let base: number | null = null
  for (const p of points) {
    if (p.date > cutoff) break
    base = p.total
  }
  return total - (base ?? points[0]!.total)
}

/** "Today", "Yesterday", then a plain count - the two named days are the ones worth naming. */
export function dayLabel(ago: number): string {
  if (ago === 0) return 'Today'
  if (ago === 1) return 'Yesterday'
  return `${ago} days ago`
}
