import { describe, expect, it } from 'vitest'
import { knowledgePages, knowledgeSubgraph, vaultShape } from '../src/lib/vaultShape.ts'
import type { GraphNode, VaultGraph } from '../src/api/types.ts'

function node(p: Partial<GraphNode> & { path: string }): GraphNode {
  return {
    title: p.path,
    type: 'concepts',
    tags: [],
    domain: null,
    out: 0,
    in: 0,
    ...p,
  } as GraphNode
}

function graph(nodes: GraphNode[], extra: Partial<VaultGraph> = {}): VaultGraph {
  return { nodes, edges: [], unresolved: 0, gaps: [], builtAt: '2026-08-26T00:00:00.000Z', ...extra }
}

describe('vaultShape', () => {
  it('returns null before the graph has loaded', () => {
    expect(vaultShape(undefined)).toBeNull()
  })

  it('counts knowledge pages only - scaffolding and artifacts are not what the vault knows', () => {
    const g = graph([
      node({ path: 'a.md' }),
      node({ path: 'index.md', kind: 'structural' }),
      node({ path: 'lint.md', kind: 'artifact' }),
    ])
    // a.md carries no `kind` at all, which the server means as knowledge
    expect(vaultShape(g)?.pages).toBe(1)
    expect(knowledgePages(g.nodes).map((n) => n.path)).toEqual(['a.md'])
  })

  it('takes the median degree, not the mean a hub would skew', () => {
    const g = graph([
      node({ path: 'a.md', in: 0, out: 1 }),
      node({ path: 'b.md', in: 2, out: 2 }),
      node({ path: 'c.md', in: 400, out: 400 }),
    ])
    expect(vaultShape(g)?.medianDegree).toBe(4)
  })

  it('averages the two middle degrees on an even count', () => {
    const g = graph([
      node({ path: 'a.md', in: 1, out: 0 }),
      node({ path: 'b.md', in: 2, out: 0 }),
      node({ path: 'c.md', in: 3, out: 0 }),
      node({ path: 'd.md', in: 10, out: 0 }),
    ])
    expect(vaultShape(g)?.medianDegree).toBe(3) // (2 + 3) / 2, rounded
  })

  it('separates unresolved links from the distinct pages they point at', () => {
    const g = graph([node({ path: 'a.md' })], {
      unresolved: 54,
      gaps: [
        { title: 'Missing One', refBy: [0] },
        { title: 'Missing Two', refBy: [0] },
      ] as VaultGraph['gaps'],
    })
    const shape = vaultShape(g)
    expect(shape?.unresolved).toBe(54)
    expect(shape?.gaps).toBe(2)
  })

  it('counts domains in use, orphans, stubs and unfiled pages', () => {
    const g = graph([
      node({ path: 'a.md', domain: 'cooking', in: 1, out: 1, size: 4000 }),
      node({ path: 'b.md', domain: 'cooking', in: 0, out: 0, size: 4000 }),
      node({ path: 'c.md', domain: 'finance', in: 1, out: 1, size: 100 }),
      node({ path: 'd.md', in: 1, out: 1, size: 4000 }),
    ])
    const shape = vaultShape(g)
    expect(shape).toMatchObject({ domains: 2, undomained: 1, orphans: 1, stubs: 1 })
  })
})

describe('knowledgeSubgraph', () => {
  it('drops scaffolding and remaps the edges that survive', () => {
    const g = graph(
      [
        node({ path: 'a.md' }),
        node({ path: 'index.md', kind: 'structural' }),
        node({ path: 'b.md' }),
      ],
      { edges: [[0, 1], [1, 2], [0, 2]] },
    )
    const sub = knowledgeSubgraph(g)
    expect(sub.nodes.map((n) => n.path)).toEqual(['a.md', 'b.md'])
    // 0→1 and 1→2 ran through the hub and are gone; 0→2 survives as 0→1.
    expect(sub.edges).toEqual([[0, 1]])
  })
})

describe('unfiled pages', () => {
  it('counts the catch-all domain as unfiled rather than as a domain of its own', () => {
    const g = graph([
      node({ path: 'a.md', domain: 'cooking' }),
      node({ path: 'b.md', domain: 'unassigned' }),
      node({ path: 'c.md', domain: null }),
    ])
    expect(vaultShape(g)).toMatchObject({ domains: 1, undomained: 2 })
  })
})
