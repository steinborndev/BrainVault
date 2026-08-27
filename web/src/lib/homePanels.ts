/**
 * The second panel beside the vault's shape (2026-08-27).
 *
 * The graph used the whole width of the stock zone and needed about half of it - a fitted
 * force layout in a box twice its size is empty canvas, not information. The half it gives
 * back holds a panel that says something the picture cannot, and there are five candidates
 * for that, all derived from payloads the screen already fetches:
 *
 *   growth      the page count over time              (stats.growth)
 *   domains     what the vault is about, by weight    (graph nodes)
 *   this week   which pages it actually learned       (the activity stream)
 *   gaps        what it links to but has not written  (graph gaps)
 *
 * Everything here is a pure derivation - no fetching, no clock of its own; `now` is passed
 * in - so the panel's content is testable without rendering it.
 */

import type { GraphNode } from '../api/types.ts'
import type { ActivityEvent } from './activity.ts'
import { isHubPage } from './homeArticle.ts'
import { isUnfiled, knowledgePages } from './vaultShape.ts'

export const PANEL_IDS = ['growth', 'domains', 'week', 'gaps'] as const
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

/** "Today", "Yesterday", then a plain count - the two named days are the ones worth naming. */
export function dayLabel(ago: number): string {
  if (ago === 0) return 'Today'
  if (ago === 1) return 'Yesterday'
  return `${ago} days ago`
}
