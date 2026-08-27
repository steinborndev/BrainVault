import { describe, it, expect } from 'vitest'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force'
import {
  domainGroups,
  crossGroup,
  groupRadius,
  computeGroupSlots,
  forceGroupSlot,
  seedGroupPositions,
  LINK_DISTANCE,
  LINK_STRENGTH,
  CROSS_GROUP_DISTANCE,
  CROSS_GROUP_STRENGTH,
  GROUP_MIN_RADIUS,
  GROUP_PADDING,
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

describe('groupRadius', () => {
  it('scales the AREA with the member count (r ∝ √n)', () => {
    // 4x the members must be 2x the radius, or a 322-page domain and a 13-page one would be
    // fighting for the same amount of space.
    expect(groupRadius(400) / groupRadius(100)).toBeCloseTo(2, 5)
  })

  it('never drops below the floor, so a 1-page domain still owns a patch', () => {
    expect(groupRadius(0)).toBe(GROUP_MIN_RADIUS)
    expect(groupRadius(1)).toBeGreaterThanOrEqual(GROUP_MIN_RADIUS)
  })
})

describe('computeGroupSlots', () => {
  /** n members of group g, laid out as one flat groups array. */
  const build = (sizes: number[]): Int32Array => {
    const out: number[] = []
    sizes.forEach((n, g) => {
      for (let i = 0; i < n; i++) out.push(g)
    })
    return new Int32Array(out)
  }

  it('packs every group into a DISJOINT disc - the guarantee the two-level layout exists for', () => {
    const groups = build([322, 94, 44, 43, 42, 40, 39, 15, 13, 11, 11, 8, 7, 7, 6, 5]) // the real vault's shape
    const slots = computeGroupSlots(groups, [])
    expect(slots).toHaveLength(16)
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i]!
        const b = slots[j]!
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r)
        expect(gap).toBeGreaterThan(0)
      }
    }
  })

  it('sizes each slot to its own membership and reports the count', () => {
    const slots = computeGroupSlots(build([100, 25]), [])
    expect(slots[0]!.count).toBe(100)
    expect(slots[1]!.count).toBe(25)
    expect(slots[0]!.r / slots[1]!.r).toBeCloseTo(2, 5)
  })

  it('seats heavily bridged groups next to each other', () => {
    // Six equal groups: with no bridges the ring order is 0,1,…,5, so 0 and 3 land on
    // opposite sides. Bridging them must reorder the ring, not merely tug at a packing that
    // is already tangent - once the discs touch, a spring cannot pull them any closer.
    const groups = build([20, 20, 20, 20, 20, 20])
    const edges: Array<[number, number]> = []
    for (let i = 0; i < 15; i++) edges.push([i, 60 + i]) // group 0 <-> group 3
    const apart = computeGroupSlots(groups, [])
    const wired = computeGroupSlots(groups, edges)
    const d = (s: ReturnType<typeof computeGroupSlots>, a: number, b: number): number =>
      Math.hypot(s[a]!.x - s[b]!.x, s[a]!.y - s[b]!.y)
    expect(d(wired, 0, 3)).toBeLessThan(d(apart, 0, 3) * 0.75)
    // …and adjacent means tangent, i.e. as close as the collide constraint allows.
    expect(d(wired, 0, 3)).toBeLessThanOrEqual(wired[0]!.r + wired[3]!.r + GROUP_PADDING * 1.2)
  })

  it('is deterministic - a reheat must not reshuffle the vault', () => {
    const groups = build([30, 12, 7])
    const edges: Array<[number, number]> = [[0, 30], [1, 31]]
    expect(computeGroupSlots(groups, edges)).toEqual(computeGroupSlots(groups, edges))
  })

  it('returns nothing when no node carries a domain', () => {
    expect(computeGroupSlots(new Int32Array([-1, -1]), [])).toEqual([])
  })
})

describe('forceGroupSlot', () => {
  interface N extends SimulationNodeDatum {
    index: number
  }
  const node = (index: number, x: number, y: number): N => ({ index, x, y, vx: 0, vy: 0 })
  const slot = (x: number, y: number, r: number, count = 10): { x: number; y: number; r: number; count: number } => ({
    x,
    y,
    r,
    count,
  })

  it('pulls members toward their own slot, leaves ungrouped nodes alone', () => {
    const nodes = [node(0, 0, 0), node(1, 100, 0), node(2, 50, 50)]
    const groups = new Int32Array([0, 1, -1])
    const slots = [slot(10, 0, 200), slot(90, 0, 200)]
    const force = forceGroupSlot<N>(groups, slots, () => 0.1)
    force.initialize(nodes)
    force(1)
    expect(nodes[0]!.vx).toBeCloseTo(1) // toward x = 10
    expect(nodes[1]!.vx).toBeCloseTo(-1) // toward x = 90
    expect(nodes[2]!.vx).toBe(0)
    expect(nodes[2]!.vy).toBe(0)
  })

  it('adds no containment while the node is inside its slot', () => {
    const nodes = [node(0, 50, 0)]
    const force = forceGroupSlot<N>(new Int32Array([0]), [slot(0, 0, 100)], () => 0.1)
    force.initialize(nodes)
    force(1)
    expect(nodes[0]!.vx).toBeCloseTo(-5) // exactly the base pull, nothing more
  })

  it('pushes a node that left its slot back much harder - the containment wall', () => {
    // The measured failure: cross-domain springs dragged small domains far off their slot.
    const inside = [node(0, 90, 0)]
    const outside = [node(0, 300, 0)]
    const mk = (ns: N[]): number => {
      const f = forceGroupSlot<N>(new Int32Array([0]), [slot(0, 0, 100)], () => 0.1)
      f.initialize(ns)
      f(1)
      // Velocity per unit of offset: how hard this node is pulled home.
      return Math.abs(ns[0]!.vx!) / Math.abs(ns[0]!.x!)
    }
    expect(mk(outside)).toBeGreaterThan(mk(inside) * 2)
  })
})

describe('seedGroupPositions', () => {
  it('places unseeded nodes inside their own slot', () => {
    const groups = new Int32Array([0, 0, 0, 1, 1])
    const slots = [
      { x: 500, y: 0, r: 80, count: 3 },
      { x: -500, y: 0, r: 60, count: 2 },
    ]
    const seed = new Float32Array(10).fill(NaN)
    seedGroupPositions(groups, slots, seed)
    for (let i = 0; i < 5; i++) {
      const s = slots[groups[i]!]!
      expect(Math.hypot(seed[i * 2]! - s.x, seed[i * 2 + 1]! - s.y)).toBeLessThanOrEqual(s.r + 1e-6)
    }
  })

  it('leaves already-placed nodes where they are (live updates keep their positions)', () => {
    const seed = new Float32Array([7, 9, NaN, NaN])
    seedGroupPositions(new Int32Array([0, 0]), [{ x: 500, y: 0, r: 50, count: 2 }], seed)
    expect(seed[0]).toBe(7)
    expect(seed[1]).toBe(9)
    expect(Number.isNaN(seed[2]!)).toBe(false)
  })

  it('ignores ungrouped nodes', () => {
    const seed = new Float32Array([NaN, NaN])
    seedGroupPositions(new Int32Array([-1]), [], seed)
    expect(Number.isNaN(seed[0]!)).toBe(true)
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

  /** Mirror of the worker's simulation setup, with the domain layout toggleable. */
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
    const slots = domainAware ? computeGroupSlots(groups, edges) : []
    const seed = new Float32Array(n * 2).fill(NaN)
    if (domainAware) seedGroupPositions(groups, slots, seed)
    const nodes: SimNode[] = Array.from({ length: n }, (_, index) => {
      const node: SimNode = { index, degree: degree[index]! }
      if (!Number.isNaN(seed[index * 2])) {
        node.x = seed[index * 2]
        node.y = seed[index * 2 + 1]
      }
      return node
    })
    const links = edges.map(([source, target]) => ({ source, target }))
    const centerPull = (d: SimNode): number =>
      domainAware && (groups[d.index] ?? -1) >= 0 ? 0 : d.degree === 0 ? 0.5 : d.degree < 3 ? 0.15 : 0.05
    const sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink(links)
          .distance((l) => (domainAware && crossGroup(groups, l) ? CROSS_GROUP_DISTANCE : LINK_DISTANCE))
          .strength((l) => (domainAware && crossGroup(groups, l) ? CROSS_GROUP_STRENGTH : LINK_STRENGTH)),
      )
      .force('charge', forceManyBody().strength(-120).distanceMax(600))
      .force('collide', forceCollide<SimNode>().radius((d) => 6 + Math.sqrt(d.degree) * 2))
      .force('x', forceX<SimNode>(0).strength(centerPull))
      .force('y', forceY<SimNode>(0).strength(centerPull))
      .stop()
    if (domainAware) {
      sim.force(
        'group',
        forceGroupSlot<SimNode>(groups, slots, (d) => (d.degree === 0 ? 0.5 : d.degree < 3 ? 0.2 : 0.1)),
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
    // cross links (each B node touches two A nodes) - the domain-blind layout pulls B
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

  it("leaves no page inside another domain's territory", () => {
    // The whole point of level 1: after settling, every node must sit nearer to its own
    // slot than inside a foreign one. Three unequal domains, sparsely bridged.
    const sizes = [40, 14, 6]
    const domains: string[] = []
    sizes.forEach((n, g) => {
      for (let i = 0; i < n; i++) domains.push(`d${g}`)
    })
    const groups = domainGroups(domains)
    const edges: Array<[number, number]> = [...clique(0, 12), ...clique(40, 8), ...clique(54, 6)]
    edges.push([0, 41], [1, 55], [42, 56]) // a few bridges
    const nodes = settle(domains.length, edges, groups, true)
    const slots = computeGroupSlots(groups, edges)
    for (const d of nodes) {
      const own = groups[d.index]!
      for (let g = 0; g < slots.length; g++) {
        if (g === own) continue
        const s = slots[g]!
        expect(Math.hypot(d.x! - s.x, d.y! - s.y)).toBeGreaterThan(s.r * 0.9)
      }
    }
  })
})
