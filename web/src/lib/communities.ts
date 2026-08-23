/**
 * Community detection for the vault graph (SPEC.md §12.4): deterministic multi-level Louvain
 * plus the cluster labelling/tinting metadata the canvas draws. Lives outside the Vault tab
 * because it is pure graph algorithmics - no React, no view state - and is unit-tested on
 * its own (web/test/detectClusters.test.ts).
 */

import type { GraphNode } from '../api/types.ts'

/** Clusters below this many members aren't tinted - a hull needs a body to be worth drawing. */
const MIN_CLUSTER = 4

/**
 * Weight of an edge whose two endpoints carry different `domain:` values, relative to a
 * same-domain edge (1). Below 1 so a cross-domain link (typically a shared person/org entity
 * bridging two fields) is a weak tie the modularity gain rarely rewards merging across - a
 * lone bridge no longer drags a whole foreign domain into a community. Not 0: a genuinely
 * dense cross-domain seam (two topics that really do interleave) can still merge if the links
 * are many. Edges touching an uncategorized page (no `domain:`) keep full weight - we don't
 * penalize what we can't classify.
 */
const CROSS_DOMAIN_WEIGHT = 0.25

/** A cluster is "domain-mixed" when its dominant domain holds less than this share of members. */
const DOMAIN_PURITY = 0.7

/**
 * One Louvain level: greedily move each node into the neighbouring community that most
 * raises modularity, until no move helps. Deterministic - nodes are visited in index order
 * and equal gains break toward the lowest community id, so there is no run-to-run jitter.
 * `self[i]` is a node's self-loop weight (super-nodes accrue it during aggregation).
 */
function louvainLevel(
  n: number,
  adj: Array<Map<number, number>>,
  self: number[],
  twoM: number,
): number[] {
  const comm = Array.from({ length: n }, (_, i) => i)
  const deg = Array.from({ length: n }, (_, i) => self[i]! * 2 + [...adj[i]!.values()].reduce((s, x) => s + x, 0))
  const sigTot = deg.slice()
  let improved = true
  for (let pass = 0; improved && pass < 100; pass++) {
    improved = false
    for (let i = 0; i < n; i++) {
      const ci = comm[i]!
      sigTot[ci]! -= deg[i]!
      // Weight from i into each neighbouring community.
      const wc = new Map<number, number>()
      for (const [j, wij] of adj[i]!) {
        if (j === i) continue
        wc.set(comm[j]!, (wc.get(comm[j]!) ?? 0) + wij)
      }
      let best = ci
      let bestGain = (wc.get(ci) ?? 0) - (deg[i]! * sigTot[ci]!) / twoM
      for (const [c, wic] of wc) {
        const gain = wic - (deg[i]! * sigTot[c]!) / twoM
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) < 1e-12 && c < best)) {
          best = c
          bestGain = gain
        }
      }
      sigTot[best]! += deg[i]!
      if (best !== ci) {
        comm[i] = best
        improved = true
      }
    }
  }
  return comm
}

/**
 * Deterministic multi-level Louvain community detection over `n` nodes. Returns a community
 * id per node (stable, not necessarily contiguous). Modularity resolution γ = 1.
 *
 * This replaced label propagation, which collapsed a dense vault into a single giant
 * cross-domain "community": the meta hub pages (index/log/hot/overview) link into every
 * domain, and LP floods one label across those bridges - the biomedical hull swallowed
 * cooking, finance, … Modularity resists it: merging weakly-linked domains lowers the score,
 * so Louvain keeps them apart while still finding real sub-communities inside a domain.
 *
 * `weightOf(a, b)` is the weight of the edge; the topology is otherwise link-only. It lets the
 * caller down-weight cross-`domain:` edges so a single bridge node (e.g. a person who authored
 * papers in two unrelated fields) can no longer glue two domains into one community - the
 * authoritative `domain:` metadata nudges the purely link-based detection without overriding it.
 */
export function louvainCommunities(
  n: number,
  edges: Array<[number, number]>,
  weightOf: (a: number, b: number) => number = () => 1,
): number[] {
  let size = n
  let adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map())
  let self = new Array<number>(n).fill(0)
  let twoM = 0
  for (const [a, b] of edges) {
    if (a >= n || b >= n) continue
    const w = weightOf(a, b)
    if (w <= 0) continue
    twoM += 2 * w
    if (a === b) {
      self[a]! += w
      continue
    }
    adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + w)
    adj[b]!.set(a, (adj[b]!.get(a) ?? 0) + w)
  }
  const mapping = Array.from({ length: n }, (_, i) => i)
  if (twoM === 0) return mapping

  for (let level = 0; level < 10; level++) {
    const comm = louvainLevel(size, adj, self, twoM)
    const uniq = [...new Set(comm)].sort((x, y) => x - y)
    if (uniq.length === size) break // converged: this level merged nothing
    const relabel = new Map(uniq.map((c, i) => [c, i]))
    for (let i = 0; i < n; i++) mapping[i] = relabel.get(comm[mapping[i]!]!)!
    // Aggregate each community into one super-node for the next, coarser level.
    const K = uniq.length
    const nadj: Array<Map<number, number>> = Array.from({ length: K }, () => new Map())
    const nself = new Array<number>(K).fill(0)
    for (let i = 0; i < size; i++) {
      const ci = relabel.get(comm[i]!)!
      nself[ci]! += self[i]!
      for (const [j, wij] of adj[i]!) {
        const cj = relabel.get(comm[j]!)!
        if (ci === cj) {
          if (i <= j) nself[ci]! += wij // count each intra-community edge once
        } else {
          nadj[ci]!.set(cj, (nadj[ci]!.get(cj) ?? 0) + wij)
        }
      }
    }
    size = K
    adj = nadj
    self = nself
  }
  return mapping
}

/**
 * Community detection for the cluster hulls, over the first `realCount` nodes (ghosts, at
 * the tail, are excluded and get id -1). Uses multi-level Louvain (see louvainCommunities)
 * so a dense vault yields coherent, domain-respecting communities instead of one giant blob.
 * Returns a per-node id array (compacted, clusters < MIN_CLUSTER folded to -1) and each
 * cluster's label from its most DISTINCTIVE shared tags (see topDistinct - plain frequency
 * let one ubiquitous tag label every sub-community of a domain identically).
 */
export function detectClusters(
  nodes: GraphNode[],
  edges: Array<[number, number]>,
  realCount: number,
): { clusterIds: number[]; clusterLabels: Map<number, string>; clusterDomains: Map<number, string> } {
  // Down-weight edges that cross a domain boundary (both endpoints categorized, differently).
  const domOf = (i: number): string | null => nodes[i]?.domain ?? null
  const weightOf = (a: number, b: number): number => {
    const da = domOf(a)
    const db = domOf(b)
    return da !== null && db !== null && da !== db ? CROSS_DOMAIN_WEIGHT : 1
  }
  const label = louvainCommunities(realCount, edges, weightOf)

  // Count members, keep only clusters ≥ MIN_CLUSTER, and compact the surviving ids to 0..k.
  const size = new Map<number, number>()
  for (let i = 0; i < realCount; i++) size.set(label[i]!, (size.get(label[i]!) ?? 0) + 1)
  const remap = new Map<number, number>()
  for (const [lab, n] of size) if (n >= MIN_CLUSTER) remap.set(lab, remap.size)

  const clusterIds = nodes.map((_, i) => (i < realCount ? remap.get(label[i]!) ?? -1 : -1))

  // Tally shared tags and domains per surviving cluster.
  const tagCounts = new Map<number, Map<string, number>>()
  const domCounts = new Map<number, Map<string, number>>()
  const clusterSize = new Map<number, number>()
  for (let i = 0; i < realCount; i++) {
    const cid = clusterIds[i]!
    if (cid < 0) continue
    clusterSize.set(cid, (clusterSize.get(cid) ?? 0) + 1)
    const tc = tagCounts.get(cid) ?? tagCounts.set(cid, new Map()).get(cid)!
    for (const t of nodes[i]!.tags) tc.set(t, (tc.get(t) ?? 0) + 1)
    if (nodes[i]!.domain) {
      const dc = domCounts.get(cid) ?? domCounts.set(cid, new Map()).get(cid)!
      dc.set(nodes[i]!.domain!, (dc.get(nodes[i]!.domain!) ?? 0) + 1)
    }
  }
  const topEntry = (m: Map<string, number> | undefined): [string, number] | undefined =>
    m ? [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] : undefined

  // Global tag frequency over the visible subgraph, for the distinctiveness scoring below.
  const totalTagCounts = new Map<string, number>()
  for (let i = 0; i < realCount; i++)
    for (const t of nodes[i]!.tags) totalTagCounts.set(t, (totalTagCounts.get(t) ?? 0) + 1)

  /**
   * The n most DISTINCTIVE tags of a cluster, not its most frequent ones: score = share of
   * members carrying the tag minus its share outside the cluster. A ubiquitous tag scores
   * ~0 - #biomedical inside a drilled-into biomedical cluster is on every page in AND
   * outside each sub-community, so it can no longer label every sub-cluster identically;
   * the tags that actually tell the clusters apart win. Structural tags (#source, #concept)
   * die the same death without needing a list - they are everywhere. Falls back to raw
   * order when nothing scores clearly positive: a cluster whose members share only
   * ubiquitous tags still deserves its best label. Deterministic: score, count, then name.
   */
  const topDistinct = (cid: number, n: number): string[] => {
    const tc = tagCounts.get(cid)
    if (tc === undefined) return []
    const size = clusterSize.get(cid) ?? 1
    const outN = Math.max(1, realCount - size)
    const scored = [...tc.entries()].map(([t, c]) => ({
      t,
      c,
      score: c / size - ((totalTagCounts.get(t) ?? c) - c) / outN,
    }))
    scored.sort((a, b) => b.score - a.score || b.c - a.c || a.t.localeCompare(b.t))
    const distinct = scored.filter((s) => s.score > 0.05).slice(0, n).map((s) => s.t)
    return distinct.length > 0 ? distinct : scored.slice(0, n).map((s) => s.t)
  }

  // Each cluster's dominant domain (for the hull tint) and its label. A domain-pure cluster
  // keeps the tag label; a domain-MIXED one is labelled by its dominant domain instead - the
  // honest name for a community a bridge node stitched across two domains.
  const clusterDomains = new Map<number, string>()
  const clusterLabels = new Map<number, string>()
  for (const cid of remap.values()) {
    const dom = topEntry(domCounts.get(cid))
    if (dom !== undefined) clusterDomains.set(cid, dom[0])
    const share = dom !== undefined ? dom[1] / (clusterSize.get(cid) ?? 1) : 0
    const mixed = dom !== undefined && share < DOMAIN_PURITY
    const tags = topDistinct(cid, 2)
    clusterLabels.set(
      cid,
      mixed ? dom![0] : tags.length > 0 ? tags.map((t) => `#${t}`).join(' ') : dom?.[0] ?? '',
    )
  }
  return { clusterIds, clusterLabels, clusterDomains }
}
