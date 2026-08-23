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

import type { SimulationNodeDatum } from 'd3-force'

/** Same-group springs keep the original tuning… */
export const LINK_DISTANCE = 60
export const LINK_STRENGTH = 0.4
/**
 * …while a cross-domain spring is longer and much weaker, mirroring Louvain's 0.25 edge
 * down-weight: enough attraction that bridged domains stay adjacent, not enough to pull one
 * inside the other against its own centroid force.
 */
export const CROSS_GROUP_DISTANCE = 120
export const CROSS_GROUP_STRENGTH = 0.1

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

/**
 * Custom force: every tick, pull each grouped node toward its group's current centroid
 * (velocity += delta · strength(node) · alpha - the standard d3 positioning-force shape).
 * The centroid moves WITH the group, so this compacts each domain around wherever the link
 * topology placed it rather than pinning domains to fixed slots; separation between the
 * compacted blobs then comes from charge repulsion and the weakened cross-group springs.
 * Singleton groups are skipped (their centroid is themselves).
 */
export function forceGroupCentroid<N extends SimulationNodeDatum>(
  groups: Int32Array,
  strength: (node: N) => number,
): ((alpha: number) => void) & { initialize: (nodes: N[]) => void } {
  let nodes: N[] = []
  const count = groups.reduce((m, g) => Math.max(m, g + 1), 0)
  const sumX = new Float64Array(count)
  const sumY = new Float64Array(count)
  const members = new Int32Array(count)

  const force = (alpha: number): void => {
    sumX.fill(0)
    sumY.fill(0)
    members.fill(0)
    for (const d of nodes) {
      const g = groups[d.index!] ?? -1
      if (g < 0) continue
      sumX[g]! += d.x!
      sumY[g]! += d.y!
      members[g]!++
    }
    for (const d of nodes) {
      const g = groups[d.index!] ?? -1
      if (g < 0 || members[g]! < 2) continue
      const k = strength(d) * alpha
      d.vx! += (sumX[g]! / members[g]! - d.x!) * k
      d.vy! += (sumY[g]! / members[g]! - d.y!) * k
    }
  }
  force.initialize = (n: N[]): void => {
    nodes = n
  }
  return force
}
