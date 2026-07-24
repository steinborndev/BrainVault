import { describe, it, expect } from 'vitest'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
} from 'd3-force'
import {
  domainGroups,
  crossGroup,
  forceGroupCentroid,
  LINK_DISTANCE,
  LINK_STRENGTH,
  CROSS_GROUP_DISTANCE,
  CROSS_GROUP_STRENGTH,
} from '../src/lib/graphForces.ts'

describe('domainGroups', () => {
  it('assigns compact ids in first-seen order, null → -1', () => {
    expect([...domainGroups(['bio', 'ai', null, 'bio', 'ai', 'cooking'])]).toEqual([0, 1, -1, 0, 1, 2])
  })

  it('handles the empty list', () => {
    expect(domainGroups([]).length).toBe(0)
  })
})

describe('crossGroup', () => {
  const groups = new Int32Array([0, 0, 1, -1])

  it('detects a link spanning two known groups, with raw-index or node endpoints', () => {
    expect(crossGroup(groups, { source: 0, target: 2 })).toBe(true)
    expect(crossGroup(groups, { source: { index: 0 }, target: { index: 2 } })).toBe(true)
  })

  it('same group or an uncategorized endpoint is NOT cross-group (full weight)', () => {
    expect(crossGroup(groups, { source: 0, target: 1 })).toBe(false)
    expect(crossGroup(groups, { source: 0, target: 3 })).toBe(false)
    expect(crossGroup(groups, { source: 3, target: 3 })).toBe(false)
  })
})

describe('forceGroupCentroid', () => {
  interface N extends SimulationNodeDatum {
    index: number
  }
  const node = (index: number, x: number, y: number): N => ({ index, x, y, vx: 0, vy: 0 })

  it('pulls members toward their own group centroid, leaves ungrouped nodes alone', () => {
    // Group 0 at x = 0 and x = 10 (centroid 5), group 1 far right, one ungrouped straggler.
    const nodes = [node(0, 0, 0), node(1, 10, 0), node(2, 100, 0), node(3, 110, 0), node(4, 50, 50)]
    const groups = new Int32Array([0, 0, 1, 1, -1])
    const force = forceGroupCentroid<N>(groups, () => 0.1)
    force.initialize(nodes)
    force(1)
    expect(nodes[0]!.vx).toBeCloseTo(0.5) // toward 5
    expect(nodes[1]!.vx).toBeCloseTo(-0.5)
    expect(nodes[2]!.vx).toBeCloseTo(0.5) // toward 105
    expect(nodes[3]!.vx).toBeCloseTo(-0.5)
    expect(nodes[4]!.vx).toBe(0)
    expect(nodes[4]!.vy).toBe(0)
  })

  it('skips singleton groups — a lone member IS its centroid', () => {
    const nodes = [node(0, 3, 4)]
    const force = forceGroupCentroid<N>(new Int32Array([0]), () => 1)
    force.initialize(nodes)
    force(1)
    expect(nodes[0]!.vx).toBe(0)
    expect(nodes[0]!.vy).toBe(0)
  })
})

describe('domain-aware layout (worker force assembly)', () => {
  interface SimNode extends SimulationNodeDatum {
    index: number
    degree: number
  }

  const clique = (base: number, count: number): Array<[number, number]> => {
    const e: Array<[number, number]> = []
    for (let i = base; i < base + count; i++) for (let j = i + 1; j < base + count; j++) e.push([i, j])
    return e
  }

  /** Mirror of the worker's simulation setup, with the domain forces toggleable. */
  const settle = (
    n: number,
    edges: Array<[number, number]>,
    groups: Int32Array,
    domainAware: boolean,
  ): SimNode[] => {
    const degree = new Array<number>(n).fill(0)
    for (const [a, b] of edges) {
      degree[a]!++
      degree[b]!++
    }
    const nodes: SimNode[] = Array.from({ length: n }, (_, index) => ({ index, degree: degree[index]! }))
    const links = edges.map(([source, target]) => ({ source, target }))
    const centerPull = (d: SimNode): number =>
      domainAware && (groups[d.index] ?? -1) >= 0 ? 0.02 : d.degree === 0 ? 0.5 : d.degree < 3 ? 0.15 : 0.05
    const sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink(links)
          .distance((l) => (domainAware && crossGroup(groups, l) ? CROSS_GROUP_DISTANCE : LINK_DISTANCE))
          .strength((l) => (domainAware && crossGroup(groups, l) ? CROSS_GROUP_STRENGTH : LINK_STRENGTH)),
      )
      .force('charge', forceManyBody().strength(-120).distanceMax(600))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide<SimNode>().radius((d) => 6 + Math.sqrt(d.degree) * 2))
      .stop()
    if (domainAware) {
      sim.force(
        'group',
        forceGroupCentroid<SimNode>(groups, (d) => (d.degree === 0 ? 0.5 : d.degree < 3 ? 0.2 : 0.08)),
      )
    }
    sim.tick(300)
    return nodes
  }

  const centroid = (nodes: SimNode[], groups: Int32Array, g: number): { x: number; y: number } => {
    let x = 0
    let y = 0
    let c = 0
    for (const d of nodes) {
      if (groups[d.index] !== g) continue
      x += d.x!
      y += d.y!
      c++
    }
    return { x: x / c, y: y / c }
  }

  it('separates a small domain that links heavily into a big one', () => {
    // The reported failure shape: domain B's clique is wired into domain A's blob by many
    // cross links (each B node touches two A nodes) — the domain-blind layout pulls B
    // inside A, the domain-aware one must keep the two centroids clearly apart.
    const nA = 8
    const nB = 5
    const n = nA + nB
    const edges: Array<[number, number]> = [...clique(0, nA), ...clique(nA, nB)]
    for (let i = 0; i < nB; i++) edges.push([nA + i, i % nA], [nA + i, (i + 3) % nA])
    const groups = domainGroups([...Array.from({ length: nA }, () => 'A'), ...Array.from({ length: nB }, () => 'B')])

    const dist = (nodes: SimNode[]): number => {
      const a = centroid(nodes, groups, 0)
      const b = centroid(nodes, groups, 1)
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const blind = dist(settle(n, edges, groups, false))
    const aware = dist(settle(n, edges, groups, true))
    expect(aware).toBeGreaterThan(blind)
    // And not just marginally: the B blob must sit OUTSIDE A, i.e. beyond a link length.
    expect(aware).toBeGreaterThan(LINK_DISTANCE)
  })

  it('keeps each domain compact around its own centroid', () => {
    const nA = 8
    const nB = 5
    const edges: Array<[number, number]> = [...clique(0, nA), ...clique(nA, nB)]
    for (let i = 0; i < nB; i++) edges.push([nA + i, i % nA])
    const groups = domainGroups([...Array.from({ length: nA }, () => 'A'), ...Array.from({ length: nB }, () => 'B')])
    const nodes = settle(nA + nB, edges, groups, true)
    const cB = centroid(nodes, groups, 1)
    const cA = centroid(nodes, groups, 0)
    for (const d of nodes) {
      if (groups[d.index] !== 1) continue
      const toOwn = Math.hypot(d.x! - cB.x, d.y! - cB.y)
      const toOther = Math.hypot(d.x! - cA.x, d.y! - cA.y)
      expect(toOwn).toBeLessThan(toOther)
    }
  })
})
