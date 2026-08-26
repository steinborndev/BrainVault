/**
 * The shape of the wiki, derived from one `/graph` payload: how many real pages, how densely
 * they link, how many are unfiled, and where the graph frays. Home's vault zone and System's
 * vault statistics both read these numbers, and they must agree - the same figure computed
 * twice is a figure that eventually disagrees with itself.
 *
 * "Knowledge" is the only population any of this counts (`kind`, server-side): index hubs,
 * the domain registry and lint reports are scaffolding the vault carries, not things the
 * vault knows. Ghost nodes (link targets with no page) carry no `kind` and are excluded by
 * the same test - they are counted as gaps instead, which is what they are.
 *
 * Unfiled means "carries no real domain", which is two states, not one: no `domain:` field
 * at all, and the vault's own catch-all value. A page parked in the catch-all is exactly as
 * unfiled as a page with no field - counting it as a domain of its own inflated the domain
 * count and reported zero unfiled pages on a vault that had eleven.
 */

/** The domain value the vault parks a page in when no real domain fits. */
export const UNFILED_DOMAIN = 'unassigned'

/** True when a page carries no real domain (no field, or the catch-all). */
export function isUnfiled(node: GraphNode): boolean {
  return node.domain === null || node.domain === UNFILED_DOMAIN
}

import type { GraphNode, VaultGraph } from '../api/types.ts'
import { STUB_BYTES } from './domains.ts'

export interface VaultShape {
  /** Real pages: the graph minus scaffolding, artifacts and ghost link targets. */
  pages: number
  /** Wikilinks between pages, counting each direction once (the graph's edge list). */
  links: number
  /** Median in+out degree over knowledge pages - the honest middle, not the mean a hub skews. */
  medianDegree: number
  /** Distinct `domain:` values actually carried by pages. */
  domains: number
  undomained: number
  orphans: number
  stubs: number
  /** Links pointing at pages that do not exist. */
  unresolved: number
  /** Distinct missing link targets behind those unresolved links. */
  gaps: number
}

export function knowledgePages(nodes: readonly GraphNode[]): GraphNode[] {
  return nodes.filter((n) => (n.kind ?? 'knowledge') === 'knowledge')
}

/**
 * The knowledge graph with its edges remapped onto it: what a picture of the vault should
 * draw. Keeping the scaffolding in makes one shape of the whole thing, because `index.md`
 * links to every page there is - a hub with 800 edges pulls every cluster into a star and
 * the domains stop being visible at all.
 */
export function knowledgeSubgraph(graph: VaultGraph): {
  nodes: GraphNode[]
  edges: Array<[number, number]>
} {
  const keep = new Int32Array(graph.nodes.length).fill(-1)
  const nodes: GraphNode[] = []
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i]
    if (n === undefined || (n.kind ?? 'knowledge') !== 'knowledge') continue
    keep[i] = nodes.length
    nodes.push(n)
  }
  const edges: Array<[number, number]> = []
  for (const [a, b] of graph.edges) {
    const from = keep[a] ?? -1
    const to = keep[b] ?? -1
    if (from >= 0 && to >= 0) edges.push([from, to])
  }
  return { nodes, edges }
}

export function vaultShape(graph: VaultGraph | undefined): VaultShape | null {
  if (graph === undefined) return null
  const knowledge = knowledgePages(graph.nodes)
  const degrees = knowledge.map((n) => n.in + n.out).sort((a, b) => a - b)
  const mid = Math.floor(degrees.length / 2)
  const medianDegree =
    degrees.length === 0
      ? 0
      : degrees.length % 2 === 1
        ? (degrees[mid] ?? 0)
        : Math.round(((degrees[mid - 1] ?? 0) + (degrees[mid] ?? 0)) / 2)
  const domains = new Set<string>()
  for (const n of knowledge) if (!isUnfiled(n)) domains.add(n.domain as string)
  return {
    pages: knowledge.length,
    links: graph.edges.length,
    medianDegree,
    domains: domains.size,
    undomained: knowledge.filter(isUnfiled).length,
    orphans: knowledge.filter((n) => n.in === 0 && n.out === 0).length,
    stubs: knowledge.filter((n) => (n.size ?? Infinity) < STUB_BYTES).length,
    unresolved: graph.unresolved,
    gaps: graph.gaps.length,
  }
}
