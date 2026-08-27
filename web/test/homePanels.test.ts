/**
 * The second panel's derivations. Both are about ORDER and HONESTY: the ranking is
 * deterministic and uses the vault's own idea of "unfiled", and the day grouping is anchored
 * to local midnights and reads what the runs wrote rather than when files were touched.
 */
import { describe, expect, it } from 'vitest'
import { dayLabel, domainCounts, newPagesIn, recentPages } from '../src/lib/homePanels.ts'
import type { GraphNode } from '../src/api/types.ts'
import type { ActivityEvent } from '../src/lib/activity.ts'
import { UNFILED_DOMAIN } from '../src/lib/vaultShape.ts'

const NOW = new Date('2026-08-27T14:30:00').getTime()
const daysAgo = (n: number, hour = 12): number => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - n)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  path: 'wiki/concepts/A.md',
  title: 'A',
  type: 'concepts',
  tags: [],
  domain: 'computing',
  out: 1,
  in: 1,
  ...over,
})

const ev = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 'e',
  kind: 'ingest',
  state: 'done',
  title: 'x',
  channel: 'drop',
  whenIso: new Date(daysAgo(0)).toISOString(),
  pages: [],
  costUsd: null,
  commit: null,
  live: false,
  ...over,
})

describe('domainCounts', () => {
  it('ranks by page count, biggest first', () => {
    const { domains } = domainCounts([
      node({ domain: 'a' }), node({ domain: 'b' }), node({ domain: 'b' }), node({ domain: 'c' }),
      node({ domain: 'b' }), node({ domain: 'c' }),
    ])
    expect(domains.map((d) => `${d.domain}:${d.pages}`)).toEqual(['b:3', 'c:2', 'a:1'])
  })

  it('breaks ties on the name, so the same vault lists the same way twice', () => {
    const nodes = [node({ domain: 'zeta' }), node({ domain: 'alpha' })]
    expect(domainCounts(nodes).domains.map((d) => d.domain)).toEqual(['alpha', 'zeta'])
    expect(domainCounts([...nodes].reverse()).domains.map((d) => d.domain)).toEqual(['alpha', 'zeta'])
  })

  /**
   * The vault parks a page it cannot classify in a catch-all domain. Counting that as a
   * domain of its own inflates the count and reports zero unfiled pages on a vault that has
   * some - which is what this panel did on first contact with a real vault, and exactly the
   * bug `vaultShape`'s own header already documented.
   */
  it('treats the catch-all domain as unfiled, not as a domain', () => {
    const { domains, unfiled } = domainCounts([
      node({ domain: null }), node({ domain: UNFILED_DOMAIN }), node({ domain: 'x' }),
    ])
    expect(unfiled).toBe(2)
    expect(domains).toEqual([{ domain: 'x', pages: 1 }])
  })

  it('counts knowledge pages only, never the vault\'s own meta pages', () => {
    const { domains, unfiled } = domainCounts([
      node({ domain: 'x' }),
      node({ domain: 'y', kind: 'meta' }),
      node({ domain: null, kind: 'meta' }),
    ])
    expect(domains).toEqual([{ domain: 'x', pages: 1 }])
    expect(unfiled).toBe(0)
  })
})

describe('recentPages', () => {
  const iso = (n: number, hour = 12): string => new Date(daysAgo(n, hour)).toISOString()

  it('groups what the runs wrote by the day they ran, and drops what falls outside', () => {
    const groups = recentPages(
      [
        ev({ id: 'a', whenIso: iso(0), pages: ['wiki/concepts/A.md'] }),
        ev({ id: 'b', whenIso: iso(1), pages: ['wiki/concepts/B.md'] }),
        ev({ id: 'c', whenIso: iso(9), pages: ['wiki/concepts/C.md'] }),
      ],
      NOW,
    )
    expect(groups.map((g) => g.ago)).toEqual([0, 1])
    expect(groups[0]!.pages).toEqual(['wiki/concepts/A.md'])
  })

  it('anchors on midnight, not on a rolling 24 hours', () => {
    // 01:00 today and 23:00 yesterday are two hours apart but two different days.
    const groups = recentPages(
      [
        ev({ id: 'a', whenIso: iso(0, 1), pages: ['wiki/concepts/A.md'] }),
        ev({ id: 'b', whenIso: iso(1, 23), pages: ['wiki/concepts/B.md'] }),
      ],
      NOW,
    )
    expect(groups.map((g) => g.ago)).toEqual([0, 1])
  })

  /** Every run touches the index hubs. Listing them as things the vault learned is noise. */
  it('leaves the index hubs out', () => {
    const groups = recentPages(
      [ev({ pages: ['wiki/index.md', 'wiki/hot.md', 'wiki/concepts/_index.md', 'wiki/concepts/A.md'] })],
      NOW,
    )
    expect(groups[0]!.pages).toEqual(['wiki/concepts/A.md'])
  })

  it('lists a page written twice in the window once, on the newer day', () => {
    const groups = recentPages(
      [
        ev({ id: 'old', whenIso: iso(3), pages: ['wiki/concepts/A.md'] }),
        ev({ id: 'new', whenIso: iso(1), pages: ['wiki/concepts/A.md'] }),
      ],
      NOW,
    )
    expect(groups.map((g) => g.ago)).toEqual([1])
    expect(groups[0]!.pages).toEqual(['wiki/concepts/A.md'])
  })

  it('skips a run that wrote nothing rather than emitting an empty day', () => {
    expect(recentPages([ev({ pages: [] })], NOW)).toEqual([])
    expect(recentPages([ev({ pages: ['wiki/log.md'] })], NOW)).toEqual([])
  })

  it('never returns a future day', () => {
    expect(recentPages([ev({ whenIso: iso(-2), pages: ['wiki/concepts/A.md'] })], NOW)).toEqual([])
  })
})

describe('dayLabel', () => {
  it('names the two days worth naming and counts the rest', () => {
    expect(dayLabel(0)).toBe('Today')
    expect(dayLabel(1)).toBe('Yesterday')
    expect(dayLabel(4)).toBe('4 days ago')
  })
})

describe('newPagesIn', () => {
  /** A cumulative series: `total` is the page count at the END of that day. */
  const point = (ago: number, total: number): { date: string; total: number } => {
    const d = new Date(NOW)
    d.setDate(d.getDate() - ago)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, total }
  }

  it('measures against the day the window starts on, not an index into the series', () => {
    // Dense: one point per day. Seven days back is the point seven entries back.
    const dense = [7, 6, 5, 4, 3, 2, 1, 0].map((ago, i) => point(ago, 100 + i * 10))
    expect(newPagesIn(dense, 7, NOW)).toBe(70)
  })

  it('reads a sparse series by date - a quiet week is not seven entries', () => {
    // The vault moved on three days only; the eighth-from-last point does not exist, and the
    // last point before the cutoff is what the window started from.
    const sparse = [point(20, 400), point(9, 500), point(5, 540), point(0, 600)]
    expect(newPagesIn(sparse, 7, NOW)).toBe(100) // 600 - 500 (day 9 is outside the window)
    expect(newPagesIn(sparse, 30, NOW)).toBe(200) // 600 - 400
  })

  it('falls back to the first point when the series starts inside the window', () => {
    const young = [point(3, 20), point(0, 55)]
    expect(newPagesIn(young, 30, NOW)).toBe(35)
  })

  it('has no answer without history to measure against', () => {
    expect(newPagesIn([], 7, NOW)).toBeNull()
    expect(newPagesIn([point(0, 12)], 7, NOW)).toBeNull()
  })

  it('reports a shrinking vault as a negative number', () => {
    expect(newPagesIn([point(8, 90), point(2, 80), point(0, 75)], 7, NOW)).toBe(-15)
  })
})
