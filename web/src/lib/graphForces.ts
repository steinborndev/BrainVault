/**
 * Domain-aware layout forces for the vault graph, shared between the layout worker and its
 * unit tests (the worker itself has no exports - `self.onmessage` is its whole surface).
 *
 * The force layout used to be domain-blind: clusters emerged purely from link attraction vs
 * charge repulsion, so a domain that links heavily into a neighboring one was pulled INTO
 * that neighbor's blob instead of settling beside it. These helpers carry the same idea the
 * Louvain community detection already applies (communities.ts, CROSS_DOMAIN_WEIGHT): an edge
 * crossing a `domain:` boundary is a weak tie. Here that becomes (1) a weaker, longer spring
 * for cross-domain links and (2) a gentle per-domain centroid pull, so each domain reads as
 * one coherent blob held NEAR its neighbors by its bridges, not inside them.
 *
 * Grouping is by the pages' `domain:` frontmatter, NOT by the detected Louvain communities:
 * domains are stable metadata available on every layout (communities are only computed while
 * a community overlay is on, and feeding them in would re-settle the graph on a view toggle).
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force'

/** Same-group springs keep the original tuning… */
export const LINK_DISTANCE = 60
export const LINK_STRENGTH = 0.4
/**
 * …while a cross-domain spring is longer and much weaker, mirroring Louvain's 0.25 edge
 * down-weight: enough attraction that bridged domains stay adjacent, not enough to pull one
 * inside the other against its own centroid force.
 */
export const CROSS_GROUP_DISTANCE = 120
export const CROSS_GROUP_STRENGTH = 0.02

/**
 * Compact group id per node from its `domain:` value; null (uncategorized) → -1, which every
 * force here treats as "no group": full-weight links and no centroid pull - we don't penalize
 * what we can't classify, exactly like the community detection.
 */
export function domainGroups(domains: ReadonlyArray<string | null>): Int32Array {
  const ids = new Map<string, number>()
  const groups = new Int32Array(domains.length)
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i]
    if (d === null || d === undefined) {
      groups[i] = -1
    } else {
      let id = ids.get(d)
      if (id === undefined) {
        id = ids.size
        ids.set(d, id)
      }
      groups[i] = id
    }
  }
  return groups
}

/** A link endpoint as d3-force hands it to accessors: raw index before init, node after. */
type LinkEnd = number | { index?: number }

const endIndex = (e: LinkEnd): number => (typeof e === 'number' ? e : e.index ?? -1)

/** True when the link spans two DIFFERENT known groups; any -1 endpoint keeps full weight. */
export function crossGroup(groups: Int32Array, link: { source: LinkEnd; target: LinkEnd }): boolean {
  const a = groups[endIndex(link.source)] ?? -1
  const b = groups[endIndex(link.target)] ?? -1
  return a >= 0 && b >= 0 && a !== b
}

/* ── Level 1: the meta-layout that hands every domain its own territory ─────────────────
 *
 * The previous layout compacted each domain toward its OWN moving centroid and left the
 * separation between blobs to charge repulsion. That never worked on this graph: 97% of the
 * visible edges are domain-internal, so the graph is ~17 near-disconnected components with
 * no link forces between them, and `forceManyBody.distanceMax` truncates repulsion at a
 * range smaller than the largest blob is wide. Nothing forbade two domains from occupying
 * the same space, and a force layout that starts interleaved stays interleaved.
 *
 * So the layout is two-level now. Level 1 (here) treats each domain as ONE disc whose radius
 * follows its member count and packs those discs without overlap; level 2 (the node
 * simulation) pulls every page toward its domain's assigned slot instead of a floating
 * centroid. Disjointness becomes a property of the arrangement rather than a hoped-for
 * side effect.
 */

/**
 * Blob radius per √members. Hexagonal packing at the ~50px spacing this simulation settles
 * into (link distance 60, collide 6-15) covers 0.866·s² per node, so r ≈ 0.525·s·√n ≈ 26·√n.
 * Area therefore scales with the member count: a 322-page domain gets ~5x the radius of a
 * 13-page one instead of both being pulled equally hard toward a point.
 */
export const GROUP_RADIUS_K = 26
/**
 * Clear space kept between two domain discs. Generous on purpose: it is the slack that
 * absorbs pages a cross-domain link tugs toward the border, and it keeps the region labels
 * from colliding. Measured on the real vault, 110 is what takes the system-pages view (where
 * the meta hub makes half the edges cross-domain) from 7 overlapping domain pairs to 1.
 */
export const GROUP_PADDING = 110
/** Floor so a 1-2 page domain still owns a real patch instead of a dot. */
export const GROUP_MIN_RADIUS = 40

export interface GroupSlot {
  /** Slot centre in layout coordinates. */
  readonly x: number
  readonly y: number
  /** Radius the domain's members are expected to fill. */
  readonly r: number
  readonly count: number
}

export function groupRadius(count: number): number {
  return Math.max(GROUP_MIN_RADIUS, GROUP_RADIUS_K * Math.sqrt(count))
}

interface SlotNode extends SimulationNodeDatum {
  index: number
  r: number
}

/**
 * Packs one disc per group into non-overlapping slots. Ordering: the discs are seeded on a
 * ring, largest first, each taking arc proportional to its own diameter, and a collide force
 * (the hard constraint) resolves the rest; cross-group edge counts become springs, so
 * heavily bridged domains end up adjacent rather than on opposite sides.
 *
 * Deterministic - no randomness, and the seed order depends only on member counts and group
 * ids - so a reheat after a live update reproduces essentially the same arrangement instead
 * of reshuffling the vault under the user.
 */
export function computeGroupSlots(
  groups: Int32Array,
  edges: ReadonlyArray<readonly [number, number]>,
): GroupSlot[] {
  const count = groups.reduce((m, g) => Math.max(m, g + 1), 0)
  if (count === 0) return []

  const members = new Int32Array(count)
  for (const g of groups) if (g >= 0) members[g]!++

  const radii = Array.from({ length: count }, (_, g) => groupRadius(members[g] ?? 0))

  // Cross-group edge weights: how strongly two domains are bridged.
  const bridge = new Map<string, number>()
  for (const [a, b] of edges) {
    const ga = groups[a] ?? -1
    const gb = groups[b] ?? -1
    if (ga < 0 || gb < 0 || ga === gb) continue
    const key = ga < gb ? `${ga}:${gb}` : `${gb}:${ga}`
    bridge.set(key, (bridge.get(key) ?? 0) + 1)
  }
  const maxBridge = Math.max(1, ...bridge.values())

  // Seed on a ring, each disc claiming arc proportional to its diameter. Starting
  // packed-but-ordered beats d3's phyllotaxis here: collide then only has to refine, never
  // to untangle an interleaved start.
  //
  // The ORDER is where bridging gets to matter. Once the packing is tight the discs sit
  // tangent to their neighbours and the bridge springs can no longer pull anything closer,
  // so adjacency has to be decided before the simulation: start at the largest domain and
  // walk greedily along the strongest remaining bridge, falling back to the next largest
  // when a domain bridges nothing. Deterministic, and ties break on group id.
  const bridgeWeight = (a: number, b: number): number =>
    bridge.get(a < b ? `${a}:${b}` : `${b}:${a}`) ?? 0
  const bySize = Array.from({ length: count }, (_, g) => g).sort(
    (a, b) => (members[b] ?? 0) - (members[a] ?? 0) || a - b,
  )
  const order: number[] = []
  const placed = new Set<number>()
  let current = bySize[0]!
  while (order.length < count) {
    order.push(current)
    placed.add(current)
    let next = -1
    let bestWeight = 0
    for (const g of bySize) {
      if (placed.has(g)) continue
      const w = bridgeWeight(current, g)
      if (w > bestWeight) {
        bestWeight = w
        next = g
      }
    }
    if (next < 0) next = bySize.find((g) => !placed.has(g)) ?? -1
    if (next < 0) break
    current = next
  }
  const circumference = order.reduce((s, g) => s + 2 * radii[g]! + GROUP_PADDING, 0)
  const ringR = circumference / (2 * Math.PI)
  const nodes: SlotNode[] = Array.from({ length: count }, (_, g) => ({ index: g, r: radii[g]! }))
  let angle = 0
  for (const g of order) {
    const share = ((2 * radii[g]! + GROUP_PADDING) / circumference) * 2 * Math.PI
    angle += share / 2
    nodes[g]!.x = ringR * Math.cos(angle)
    nodes[g]!.y = ringR * Math.sin(angle)
    angle += share / 2
  }

  // d3 swaps link endpoints from ids to nodes during initialize; the accessors below run
  // after that, but the type stays the union - resolve either shape.
  const radiusOf = (end: number | SlotNode): number =>
    (typeof end === 'number' ? radii[end] : radii[end.index]) ?? GROUP_MIN_RADIUS

  const links = [...bridge.entries()].map(([key, weight]) => {
    const [a, b] = key.split(':').map(Number) as [number, number]
    return { source: a, target: b, weight }
  })

  const sim = forceSimulation(nodes)
    .force(
      'bridge',
      forceLink<SlotNode, (typeof links)[number]>(links)
        .id((d) => d.index)
        // Never shorter than tangency: a spring must pull domains ADJACENT, never through
        // each other (collide would fight it and the layout would jitter).
        .distance((l) => radiusOf(l.source) + radiusOf(l.target) + GROUP_PADDING)
        .strength((l) => 0.05 + 0.35 * (l.weight / maxBridge)),
    )
    // The hard constraint: discs may touch, never overlap. High strength + iterations
    // because this is the guarantee the whole two-level layout exists to provide.
    .force('collide', forceCollide<SlotNode>((d) => d.r + GROUP_PADDING / 2).strength(1).iterations(6))
    .force('charge', forceManyBody<SlotNode>().strength((d) => -d.r * 2))
    // A real inward pull, not just re-centering: forceCenter only translates the system, so
    // the ring seed would stay a ring with a hole in the middle. Pull-in plus collide is
    // circle packing - the discs settle into a compact cluster with no wasted canvas.
    .force('packX', forceX<SlotNode>(0).strength(0.05))
    .force('packY', forceY<SlotNode>(0).strength(0.05))
    .force('center', forceCenter(0, 0))
    .stop()
  // ~17 discs: running to convergence synchronously costs microseconds.
  sim.tick(400)

  return nodes.map((d, g) => ({ x: d.x ?? 0, y: d.y ?? 0, r: radii[g]!, count: members[g] ?? 0 }))
}

/* ── Level 2: pull every page toward its domain's slot ─────────────────────────────────── */

/**
 * How hard a node is pushed back once it leaves its slot. The gentle base pull alone is no
 * match for a cross-domain spring: measured on the real vault, a 5-page domain with 9
 * outbound links drifted 380px off its slot and a 7-page one spread to 4x its radius, which
 * is where the residual cluster overlap came from. Inside the slot this term is zero - the
 * territory is a boundary, not a second compaction force.
 */
export const GROUP_CONTAINMENT = 0.35

/**
 * Positioning force toward the node's group slot (velocity += delta · strength · alpha, the
 * standard d3 shape), plus a containment term outside the slot radius. Replaces the old
 * moving-centroid force: the target is a FIXED point that level 1 already proved is free of
 * other domains, so compaction and separation stop being the same tug-of-war. Ungrouped
 * nodes (-1) are untouched, exactly as before.
 */
export function forceGroupSlot<N extends SimulationNodeDatum>(
  groups: Int32Array,
  slots: readonly GroupSlot[],
  strength: (node: N) => number,
): ((alpha: number) => void) & { initialize: (nodes: N[]) => void } {
  let nodes: N[] = []

  const force = (alpha: number): void => {
    for (const d of nodes) {
      const g = groups[d.index!] ?? -1
      const slot = g >= 0 ? slots[g] : undefined
      if (slot === undefined) continue
      const dx = slot.x - d.x!
      const dy = slot.y - d.y!
      const k = strength(d) * alpha
      d.vx! += dx * k
      d.vy! += dy * k
      // Soft wall at the slot edge: only the part of the offset that exceeds the radius,
      // so the interior stays free to arrange itself by link topology.
      const dist = Math.hypot(dx, dy)
      const over = dist - slot.r
      if (over > 0 && dist > 0) {
        const wall = (over / dist) * GROUP_CONTAINMENT * alpha
        d.vx! += dx * wall
        d.vy! += dy * wall
      }
    }
  }
  force.initialize = (n: N[]): void => {
    nodes = n
  }
  return force
}

/**
 * Places still-unpositioned nodes inside their group's slot, on a golden-angle spiral so
 * members spread evenly instead of stacking on the slot centre. This is what actually stops
 * the interleaving: a force layout is a local minimizer, so where a domain STARTS decides
 * whether it ever becomes one blob. Mutates `seed` in place ([x0,y0,x1,y1,…], NaN = unplaced)
 * and leaves already-seeded nodes (live updates, filter toggles) exactly where they were.
 */
export function seedGroupPositions(
  groups: Int32Array,
  slots: readonly GroupSlot[],
  seed: Float32Array,
): void {
  const GOLDEN = Math.PI * (3 - Math.sqrt(5))
  const placed = new Int32Array(slots.length)
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i] ?? -1
    const slot = g >= 0 ? slots[g] : undefined
    if (slot === undefined) continue
    const hasSeed = !Number.isNaN(seed[i * 2]) && !Number.isNaN(seed[i * 2 + 1])
    const ordinal = placed[g]!++
    if (hasSeed) continue
    // Sunflower packing: radius ∝ √ordinal keeps the density even out to the slot edge.
    const t = slot.count > 1 ? Math.sqrt(ordinal / slot.count) : 0
    const a = ordinal * GOLDEN
    seed[i * 2] = slot.x + Math.cos(a) * slot.r * t
    seed[i * 2 + 1] = slot.y + Math.sin(a) * slot.r * t
  }
}
