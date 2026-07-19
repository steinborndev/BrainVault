/**
 * Domain candidate detection + the governance loop's moving parts (SPEC.md §12.4 Stufe 3):
 * the deterministic finder, the registry mutation, the dismissal store and the agent-review
 * parser.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findDomainCandidates, MIN_CANDIDATE_PAGES } from '../src/pipeline/domain-candidates.js'
import { parseDomainReview } from '../src/pipeline/domain-review.js'
import { appendDomainSection, parseDomainRegistry, isValidDomainKey, UNASSIGNED } from '../src/pipeline/domains.js'
import { DomainDismissalStore, MemoryDismissalStore } from '../src/db/domain-dismissals.js'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import type { VaultGraph, GraphNode } from '../src/pipeline/graph.js'

/** Builds a graph where every page is `unassigned` unless a domain is given. */
function graphOf(
  pages: Array<{ title: string; tags: string[]; domain?: string | null }>,
  edges: Array<[number, number]> = [],
): VaultGraph {
  const nodes: GraphNode[] = pages.map((p) => ({
    path: `wiki/concepts/${p.title}.md`,
    title: p.title,
    type: 'concepts',
    tags: p.tags,
    domain: p.domain === undefined ? UNASSIGNED : p.domain,
    out: 0,
    in: 0,
  }))
  return { nodes, edges, unresolved: 0, builtAt: '2026-07-19T00:00:00.000Z' }
}

const pagesWithTag = (n: number, tag: string, prefix = 'P'): Array<{ title: string; tags: string[] }> =>
  Array.from({ length: n }, (_, i) => ({ title: `${prefix}${i}`, tags: [tag] }))

const registry = parseDomainRegistry(
  '## Domains\n\n## biomedicine\n\nBio.\n\n**Tags:** `mrna-delivery`, `biomedical`\n',
)

describe('findDomainCandidates', () => {
  it('proposes a theme once it reaches the threshold, and not before', () => {
    const below = findDomainCandidates({ graph: graphOf(pagesWithTag(MIN_CANDIDATE_PAGES - 1, 'design')), registry })
    expect(below.candidates).toEqual([])

    const at = findDomainCandidates({ graph: graphOf(pagesWithTag(MIN_CANDIDATE_PAGES, 'design')), registry })
    expect(at.candidates).toHaveLength(1)
    expect(at.candidates[0]!.key).toBe('design')
    expect(at.candidates[0]!.pageCount).toBe(MIN_CANDIDATE_PAGES)
    expect(at.unassignedCount).toBe(MIN_CANDIDATE_PAGES)
  })

  it('only counts explicit `unassigned`, and reports missing-field pages separately', () => {
    // Pages with NO domain field mean "never classified" (backfill due), not "nothing fits";
    // treating them as evidence would re-propose domains the registry already has.
    const graph = graphOf([
      ...pagesWithTag(6, 'design').map((p) => ({ ...p, domain: null })),
      { title: 'Filed', tags: ['design'], domain: 'biomedicine' },
    ])
    const report = findDomainCandidates({ graph, registry })
    expect(report.candidates).toEqual([])
    expect(report.unassignedCount).toBe(0)
    expect(report.undomainedCount).toBe(6)
  })

  it('ignores tags an existing domain already claims', () => {
    // 6 unassigned pages tagged `biomedical` are a MISFILING for the backfill to fix,
    // not evidence that a new domain is missing.
    const report = findDomainCandidates({ graph: graphOf(pagesWithTag(6, 'biomedical')), registry })
    expect(report.candidates).toEqual([])
    expect(report.unassignedCount).toBe(6)
  })

  it('ignores structural tags that describe what a page IS', () => {
    const report = findDomainCandidates({ graph: graphOf(pagesWithTag(8, 'person')), registry })
    expect(report.candidates).toEqual([])
  })

  it('merges tags that describe the same pages and names the candidate after the dominant one', () => {
    const graph = graphOf([
      ...Array.from({ length: 6 }, (_, i) => ({ title: `W${i}`, tags: ['llm-wiki', 'llm-wiki-pattern'] })),
      { title: 'W6', tags: ['llm-wiki'] },
    ])
    const report = findDomainCandidates({ graph, registry })
    expect(report.candidates).toHaveLength(1)
    const c = report.candidates[0]!
    expect(c.key).toBe('llm-wiki') // 7 pages vs 6 → dominant
    expect(c.tags).toEqual(['llm-wiki', 'llm-wiki-pattern'])
    expect(c.pageCount).toBe(7)
  })

  it('keeps distinct themes apart even when a few pages carry both tags', () => {
    const graph = graphOf([
      ...pagesWithTag(6, 'design', 'D'),
      ...pagesWithTag(6, 'history', 'H'),
      { title: 'Both', tags: ['design', 'history'] },
    ])
    const keys = findDomainCandidates({ graph, registry }).candidates.map((c) => c.key)
    expect(keys.sort()).toEqual(['design', 'history'])
  })

  it('scores cohesion from wikilinks between the candidate’s own pages', () => {
    const unlinked = findDomainCandidates({ graph: graphOf(pagesWithTag(5, 'design')), registry })
    expect(unlinked.candidates[0]!.cohesion).toBe(0) // shared label only

    const linked = findDomainCandidates({
      graph: graphOf(pagesWithTag(5, 'design'), [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
      ]),
      registry,
    })
    expect(linked.candidates[0]!.cohesion).toBe(1) // every page connects to another
  })

  it('suppresses dismissed candidates', () => {
    const graph = graphOf(pagesWithTag(6, 'design'))
    expect(findDomainCandidates({ graph, registry, dismissed: new Set(['design']) }).candidates).toEqual([])
    expect(findDomainCandidates({ graph, registry }).candidates).toHaveLength(1)
  })

  it('works with no registry installed at all', () => {
    const report = findDomainCandidates({ graph: graphOf(pagesWithTag(5, 'design')), registry: null })
    expect(report.candidates.map((c) => c.key)).toEqual(['design'])
  })
})

describe('appendDomainSection', () => {
  const base = '## Domains\n\n## biomedicine\n\nBio.\n\n**Tags:** `biomedical`\n'

  it('appends a parseable section that round-trips through the parser', () => {
    const next = appendDomainSection(base, { key: 'history', description: 'The past.', tags: ['history', 'war'] })!
    const parsed = parseDomainRegistry(next)
    expect(parsed.domains.map((d) => d.key)).toEqual(['biomedicine', 'history'])
    const added = parsed.domains[1]!
    expect(added.description).toBe('The past.')
    expect(added.tags).toEqual(['history', 'war'])
  })

  it('refuses a duplicate key, since the parser would silently shadow it', () => {
    expect(appendDomainSection(base, { key: 'biomedicine', description: 'x', tags: [] })).toBeNull()
  })

  it('handles a domain without tags and normalises trailing whitespace', () => {
    const next = appendDomainSection(`${base}\n\n\n`, { key: 'misc', description: 'Odds and ends.', tags: [] })!
    expect(next).not.toContain('**Tags:**\n')
    expect(parseDomainRegistry(next).domains[1]).toMatchObject({ key: 'misc', tags: [] })
  })

  it('validates key shape', () => {
    expect(isValidDomainKey('ai-tooling')).toBe(true)
    expect(isValidDomainKey('AI Tooling')).toBe(false)
    expect(isValidDomainKey('-leading')).toBe(false)
    expect(isValidDomainKey('')).toBe(false)
  })
})

describe('dismissal stores', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => db.close())

  for (const [name, make] of [
    ['sqlite', (): DomainDismissalStore | MemoryDismissalStore => new DomainDismissalStore(db)],
    ['memory', (): DomainDismissalStore | MemoryDismissalStore => new MemoryDismissalStore()],
  ] as const) {
    it(`${name}: dismiss is idempotent, restore undoes it`, () => {
      const store = make()
      store.dismiss('design')
      store.dismiss('design')
      expect([...store.keys()]).toEqual(['design'])
      expect(store.list()).toHaveLength(1)

      store.restore('design')
      expect(store.keys().size).toBe(0)
    })
  }
})

describe('parseDomainReview', () => {
  it('parses one block per candidate across all three verdicts', () => {
    const review = parseDomainReview(
      [
        '## design',
        'verdict: new-domain',
        'key: design',
        'description: Visual and brand design guidance.',
        'tags: design, svg, brand',
        'reason: Five pages all define visual conventions.',
        '',
        '## transport',
        'verdict: existing',
        'existing: ai-tooling',
        'reason: These describe the service, not a subject.',
        '',
        '## misc',
        'verdict: not-a-domain',
        'reason: Unrelated pages sharing a generic label.',
      ].join('\n'),
    )
    expect(review.entries).toHaveLength(3)
    expect(review.entries[0]).toMatchObject({
      candidate: 'design',
      verdict: 'new-domain',
      key: 'design',
      tags: ['design', 'svg', 'brand'],
    })
    expect(review.entries[1]).toMatchObject({ candidate: 'transport', verdict: 'existing', existing: 'ai-tooling' })
    expect(review.entries[2]!.verdict).toBe('not-a-domain')
  })

  it('ignores prose and blocks without a recognisable verdict', () => {
    expect(parseDomainReview('Here is what I think.\n\n## design\nI like it.\n').entries).toEqual([])
    expect(parseDomainReview('').entries).toEqual([])
  })

  it('strips backticks and lowercases keys the agent may have decorated', () => {
    const review = parseDomainReview('## Design\nverdict: new-domain\nkey: Design\ntags: `SVG`, Brand\n')
    expect(review.entries[0]).toMatchObject({ candidate: 'design', key: 'design', tags: ['svg', 'brand'] })
  })
})
