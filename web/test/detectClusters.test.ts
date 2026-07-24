import { describe, it, expect } from 'vitest'
import { detectClusters, louvainCommunities } from '../src/tabs/Vault.tsx'
import type { GraphNode } from '../src/api/types.ts'

/** Minimal node fixture — only the fields detectClusters reads (domain, tags). */
const node = (domain: string | null, tags: string[] = []): GraphNode => ({
  path: `${domain ?? 'none'}/${tags.join('-')}/${Math.random()}`,
  title: `${domain}:${tags.join(',')}`,
  type: 'concepts',
  tags,
  domain,
  kind: 'knowledge',
  out: 0,
  in: 0,
})

const clique = (base: number, count: number): Array<[number, number]> => {
  const e: Array<[number, number]> = []
  for (let i = base; i < base + count; i++) for (let j = i + 1; j < base + count; j++) e.push([i, j])
  return e
}

/** The down-weighting rule detectClusters applies, isolated for the topology tests. */
const domainWeight =
  (nodes: GraphNode[]) =>
  (a: number, b: number): number => {
    const da = nodes[a]!.domain
    const db = nodes[b]!.domain
    return da !== null && db !== null && da !== db ? 0.25 : 1
  }

describe('louvainCommunities cross-domain weighting', () => {
  // alpha is a dense K5 (0-4); two beta pages (5,6) hang off it — page 5 links only INTO alpha,
  // page 6 links into alpha too, and 5-6 are linked to each other. This is the shape that bit us:
  // a foreign-domain page whose links point mostly at another domain.
  const nodes = [
    ...Array.from({ length: 5 }, () => node('alpha', ['alpha'])),
    node('beta', ['beta']),
    node('beta', ['beta']),
  ]
  const edges: Array<[number, number]> = [
    ...clique(0, 5),
    [5, 0],
    [5, 1],
    [6, 2],
    [6, 3],
    [5, 6],
  ]

  it('at equal weight a beta page is absorbed into the alpha clique (the bug)', () => {
    const label = louvainCommunities(nodes.length, edges) // default weight 1
    expect(label[5]).toBe(label[0]) // page 5 swallowed by alpha
  })

  it('down-weighting cross-domain edges keeps the beta pages out of alpha', () => {
    const label = louvainCommunities(nodes.length, edges, domainWeight(nodes))
    expect(label[5]).not.toBe(label[0]) // no longer pulled into alpha
    expect(label[5]).toBe(label[6]) // the two beta pages stay together
  })
})

describe('detectClusters', () => {
  it('keeps a domain-pure cluster tinted by its domain and labelled by its tags', () => {
    const nodes = Array.from({ length: 5 }, () => node('alpha', ['alpha']))
    const edges = clique(0, 5)
    const { clusterIds, clusterLabels, clusterDomains } = detectClusters(nodes, edges, nodes.length)
    const cid = clusterIds[0]!
    expect(cid).toBeGreaterThanOrEqual(0)
    expect(clusterDomains.get(cid)).toBe('alpha')
    expect(clusterLabels.get(cid)).toBe('#alpha') // pure -> tag label
  })

  it('labels a domain-mixed cluster by its dominant domain, not its tags', () => {
    // K7: 4 "beta" pages + 3 uncategorized pages, all one thematic tag. Edges touching an
    // uncategorized page keep full weight, so the whole K7 is one community. Its dominant
    // domain beta holds 4/7 ≈ 57% < 70% -> mixed.
    const nodes = [
      ...Array.from({ length: 4 }, () => node('beta', ['shared'])),
      ...Array.from({ length: 3 }, () => node(null, ['shared'])),
    ]
    const edges = clique(0, 7)
    const { clusterIds, clusterLabels, clusterDomains } = detectClusters(nodes, edges, nodes.length)
    const cid = clusterIds[0]!
    expect(cid).toBeGreaterThanOrEqual(0)
    expect(clusterDomains.get(cid)).toBe('beta')
    expect(clusterLabels.get(cid)).toBe('beta') // mixed -> dominant-domain label
  })
})
