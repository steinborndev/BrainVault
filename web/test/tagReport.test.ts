import { describe, it, expect } from 'vitest'
import { computeTagReport, conflictingTag, type TagNode } from '../src/lib/tagReport.ts'

const page = (tags: string[], domain: string | null = null, kind = 'knowledge'): TagNode => ({
  tags,
  domain,
  kind: kind as TagNode['kind'],
})

describe('computeTagReport', () => {
  it('flags spelling-variant pairs: plural, separators, shared stem', () => {
    const nodes = [
      ...Array.from({ length: 3 }, () => page(['biomedical'])),
      ...Array.from({ length: 2 }, () => page(['biomedicine'])),
      page(['carbon-fiber']),
      page(['carbon_fiber']),
      page(['method']),
      page(['methods']),
    ]
    const r = computeTagReport(nodes)
    const pairs = r.variants.map((v) => `${v.a}|${v.b}`)
    expect(pairs).toContain('biomedical|biomedicine') // shared stem "biomedic"
    expect(pairs).toContain('carbon-fiber|carbon_fiber') // separator variant
    expect(pairs).toContain('method|methods') // plural
    // Unrelated tags never pair up.
    expect(pairs.some((p) => p.includes('method') && p.includes('carbon'))).toBe(false)
  })

  it('does not pair tags on a short accidental prefix', () => {
    const nodes = [page(['stability']), page(['statistics'])]
    expect(computeTagReport(nodes).variants).toEqual([])
  })

  it('matches spelling twins with equal word counts ("fibre"/"fiber")', () => {
    const nodes = [page(['carbon-fiber']), page(['carbon-fibre'])]
    const r = computeTagReport(nodes)
    expect(r.variants).toHaveLength(1)
  })

  it('never pairs different words at edit distance 2 or with concept-changing suffixes', () => {
    // All four surfaced as false positives on the live vault: concept/context and
    // product/project are two substitutions apart (different words — only a transposition
    // like fibre/fiber counts as a spelling), productivity is product + a concept-changing
    // suffix. research/researcher stays FLAGGED by design: short-suffix derivations are
    // genuinely ambiguous and left to the human checkbox.
    const nodes = [
      page(['concept']),
      page(['context']),
      page(['product']),
      page(['project']),
      page(['productivity']),
      page(['research']),
      page(['researcher']),
    ]
    const pairs = computeTagReport(nodes).variants.map((v) => `${v.a}|${v.b}`)
    expect(pairs).toEqual(['research|researcher'])
  })

  it('never pairs a base tag with a compound or hierarchical tag (real false positives)', () => {
    // The three false-positive families the whole-string stem rule produced on the live
    // vault: base vs compound, adjective compound, and tag hierarchies.
    const nodes = [
      page(['person']),
      page(['personal-finance']),
      page(['organization']),
      page(['organizational-structure']),
      page(['regulator']),
      page(['regulatory-affairs']),
      page(['claude']),
      page(['claude-ecosystem']),
      page(['claude-code']),
    ]
    expect(computeTagReport(nodes).variants).toEqual([])
  })

  it('finds implications and collapses mutual ones', () => {
    // #gmp appears on 5 pages, always alongside #quality (which has 3 more of its own):
    // gmp → quality, one-directional. #alpha/#beta always together: mutual.
    const nodes = [
      ...Array.from({ length: 5 }, () => page(['gmp', 'quality'])),
      ...Array.from({ length: 3 }, () => page(['quality'])),
      ...Array.from({ length: 4 }, () => page(['alpha', 'beta'])),
    ]
    const r = computeTagReport(nodes)
    const gmp = r.implications.find((i) => i.a === 'gmp')
    expect(gmp).toBeDefined()
    expect(gmp!.b).toBe('quality')
    expect(gmp!.mutual).toBe(false)
    const ab = r.implications.find((i) => i.mutual)
    expect(ab).toBeDefined()
    expect([ab!.a, ab!.b].sort()).toEqual(['alpha', 'beta'])
    // Below the support floor nothing fires.
    expect(computeTagReport([page(['x', 'y']), page(['x', 'y'])]).implications).toEqual([])
  })

  it('flags domain echoes only when the tag blankets the domain and lives there', () => {
    // #brewing on 8 of 10 brewing pages (80% coverage), nowhere else -> echo. #hops on 2
    // pages -> far below coverage. Same shape in a 4-page domain -> below the size floor.
    const nodes = [
      ...Array.from({ length: 8 }, () => page(['brewing'], 'brewing')),
      page(['hops'], 'brewing'),
      page(['hops'], 'brewing'),
      ...Array.from({ length: 4 }, () => page(['tiny'], 'tiny-domain')),
    ]
    const r = computeTagReport(nodes)
    expect(r.domainEchoes).toHaveLength(1)
    expect(r.domainEchoes[0]!.tag).toBe('brewing')
    expect(r.domainEchoes[0]!.domain).toBe('brewing')
  })

  it('lists single-use tags and ignores system pages entirely', () => {
    const nodes = [
      page(['once']),
      page(['twice']),
      page(['twice']),
      page(['report-only'], null, 'system'),
    ]
    const r = computeTagReport(nodes)
    expect(r.singletons).toEqual(['once'])
    expect(r.distinctTags).toBe(2) // the system page's tag never enters the stats
    expect(r.knowledgePages).toBe(3)
  })
})

describe('conflictingTag', () => {
  it('flags a tag consumed by two repairs, allows shared merge targets', () => {
    // The live case: #project checked into two merges at once.
    expect(
      conflictingTag([
        { kind: 'merge', from: 'project', to: 'product' },
        { kind: 'merge', from: 'project', to: 'projects' },
      ]),
    ).toBe('project')
    // Dropping a tag another repair merges into is a conflict too.
    expect(
      conflictingTag([
        { kind: 'drop', tag: 'fiber' },
        { kind: 'merge', from: 'fibre', to: 'fiber' },
      ]),
    ).toBe('fiber')
    // Two merges INTO one target are consistent.
    expect(
      conflictingTag([
        { kind: 'merge', from: 'fibre', to: 'fiber' },
        { kind: 'merge', from: 'fibers', to: 'fiber' },
      ]),
    ).toBeNull()
    expect(conflictingTag([{ kind: 'drop', tag: 'brewing' }])).toBeNull()
  })
})
