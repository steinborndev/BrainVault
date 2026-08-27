/**
 * Which page a finished job's detail opens on. The interesting cases are all about ORDER:
 * a run that filed both a synthesis and a source is about the synthesis, and the hubs every
 * run touches are never the answer.
 */
import { describe, expect, it } from 'vitest'
import { isHubPage, mainArticle, readerPages } from '../src/lib/homeArticle.ts'

const INGEST = [
  'wiki/concepts/Ghost GDP.md',
  'wiki/concepts/Crowding-Out Effect.md',
  'wiki/sources/The 2028 Global Intelligence Crisis.md',
  'wiki/concepts/_index.md',
  'wiki/sources/_index.md',
  'wiki/index.md',
  'wiki/hot.md',
  'wiki/log.md',
]

const RUN = [
  'wiki/concepts/Climate Gentrification.md',
  'wiki/questions/Research: climate change impact on European property prices.md',
  'wiki/sources/2022 ECB Climate Risk Stress Test.md',
  'wiki/index.md',
]

describe('isHubPage', () => {
  it('catches the four wiki hubs and every MOC', () => {
    for (const p of ['wiki/index.md', 'wiki/hot.md', 'wiki/log.md', 'wiki/overview.md']) {
      expect(isHubPage(p), p).toBe(true)
    }
    expect(isHubPage('wiki/concepts/_index.md')).toBe(true)
  })

  it('leaves real pages alone, including ones whose name starts like a hub', () => {
    expect(isHubPage('wiki/concepts/Index Funds.md')).toBe(false)
    expect(isHubPage('wiki/sources/Log-Structured Merge Trees.md')).toBe(false)
    expect(isHubPage('wiki/meta/domains.md')).toBe(false)
  })
})

describe('mainArticle', () => {
  it('opens an ingest on the source it read', () => {
    expect(mainArticle(INGEST)).toBe('wiki/sources/The 2028 Global Intelligence Crisis.md')
  })

  it('opens a research run on its synthesis, not on a source it also filed', () => {
    expect(mainArticle(RUN)).toBe(
      'wiki/questions/Research: climate change impact on European property prices.md',
    )
  })

  it('is null for a run that wrote no article', () => {
    expect(mainArticle([])).toBeNull()
    expect(mainArticle(['wiki/index.md', 'wiki/hot.md'])).toBeNull()
    expect(mainArticle(['wiki/concepts/A.md', 'wiki/concepts/B.md'])).toBeNull()
  })

  it('does not mistake an ordinary question page for a synthesis', () => {
    expect(mainArticle(['wiki/questions/Why is this slow.md'])).toBeNull()
  })

  it('never returns a hub, even when it is the only page', () => {
    expect(mainArticle(['wiki/sources/_index.md'])).toBeNull()
  })
})

describe('readerPages', () => {
  it('drops the hubs and leads with the article', () => {
    expect(readerPages(INGEST)).toEqual([
      'wiki/sources/The 2028 Global Intelligence Crisis.md',
      'wiki/concepts/Ghost GDP.md',
      'wiki/concepts/Crowding-Out Effect.md',
    ])
  })

  it('keeps every content page exactly once', () => {
    const out = readerPages(RUN)
    expect(out).toHaveLength(3)
    expect(new Set(out).size).toBe(3)
    expect(out[0]).toContain('Research: ')
  })

  it('returns the content pages unreordered when there is no article', () => {
    expect(readerPages(['wiki/concepts/B.md', 'wiki/concepts/A.md', 'wiki/log.md'])).toEqual([
      'wiki/concepts/B.md',
      'wiki/concepts/A.md',
    ])
  })
})
