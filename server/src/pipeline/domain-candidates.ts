/**
 * Domain candidate detection (SPEC.md §12.4, Meta-Kategorien Stufe 3) — the "evidence" half of
 * the governance loop: which themes have accumulated among the pages no existing domain fits?
 *
 * Deliberately deterministic and free. It runs on data the graph builder already produced
 * (tags + domain per node, wikilink edges), costs no tokens, and returns the same answer for
 * the same vault — so the dashboard can surface candidates on every page load without anyone
 * deciding to "start an analysis". The optional agent pass (domain-review) only JUDGES what
 * this finds; it never does the finding.
 *
 * Tag-centric rather than generic community detection, for one decisive reason: the result has
 * to become a registry entry, and a registry entry is exactly `key + description + tags`. A tag
 * shared by N unassigned pages IS the proposal, and "5 pages carry `design`, no domain covers
 * it" is a reason a human can check in one glance. The wikilink graph is used as a QUALITY
 * measure on top (do these pages actually relate?), not as the clustering engine.
 */

import type { VaultGraph } from './graph.js'
import type { DomainRegistry } from './domains.js'
import { UNASSIGNED } from './domains.js'

/** A theme needs at least this many unassigned pages before it counts as a candidate. */
export const MIN_CANDIDATE_PAGES = 5

/** Two tags merge into one candidate when their page sets overlap at least this much (Jaccard). */
const MERGE_JACCARD = 0.6

/**
 * Tags that describe what a page IS, not what it is ABOUT. They cut across every subject
 * (`person` appears in biomedicine and ai-tooling alike), so they can never justify a domain.
 * The registry page states the same rule for the agent; this is its machine-side counterpart.
 */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  'concept',
  'entity',
  'source',
  'meta',
  'index',
  'session',
  'reference',
  'comparison',
  'question',
  'fold',
  'synthesis',
  'decision',
  'overview',
  'hot-cache',
  'release',
  'person',
  'organization',
  'product',
  'researcher',
])

export interface CandidatePage {
  readonly path: string
  readonly title: string
}

export interface DomainCandidate {
  /** Suggested registry key — the tag carrying the most pages in this candidate. */
  readonly key: string
  /** Every tag that formed this candidate (the merged set), most-pages-first. */
  readonly tags: readonly string[]
  readonly pages: readonly CandidatePage[]
  readonly pageCount: number
  /**
   * Share of the candidate's pages that link to (or from) another page in the SAME candidate,
   * 0–1. High means a genuinely connected theme; low means pages that merely share a label.
   */
  readonly cohesion: number
}

export interface CandidateReport {
  readonly candidates: readonly DomainCandidate[]
  /** Pages explicitly filed as `unassigned` — the pool candidates are drawn from. */
  readonly unassignedCount: number
  /**
   * Pages carrying NO `domain:` field at all. After a backfill this should be 0; anything else
   * means the pool is incomplete and the analysis is running on partial evidence.
   */
  readonly undomainedCount: number
  readonly threshold: number
}

export interface FindCandidatesOptions {
  readonly graph: VaultGraph
  readonly registry: DomainRegistry | null
  /** Candidate keys the user has rejected; suppressed so the loop stops re-proposing them. */
  readonly dismissed?: ReadonlySet<string>
  readonly minPages?: number
}

/**
 * Finds themes among the `unassigned` pages that are big enough to justify a new domain.
 *
 * Only EXPLICIT `unassigned` counts, never a missing `domain:` field: after a backfill the
 * absence of the field means "never classified", not "nothing fits", and mixing the two would
 * make the loop propose domains the registry already has. `undomainedCount` reports that case
 * separately so the UI can tell the user a backfill is due instead of silently guessing.
 */
export function findDomainCandidates(opts: FindCandidatesOptions): CandidateReport {
  const { graph, registry } = opts
  const minPages = opts.minPages ?? MIN_CANDIDATE_PAGES
  const dismissed = opts.dismissed ?? new Set<string>()
  const threshold = minPages

  const undomainedCount = graph.nodes.filter((n) => n.domain === null).length
  const unassignedIdx = graph.nodes
    .map((n, i) => (n.domain === UNASSIGNED ? i : -1))
    .filter((i) => i >= 0)

  const empty: CandidateReport = {
    candidates: [],
    unassignedCount: unassignedIdx.length,
    undomainedCount,
    threshold,
  }
  if (unassignedIdx.length < minPages) return empty

  // Tags already claimed by a registry domain can't be evidence for a NEW one — an unassigned
  // page carrying such a tag is a misfiling for the backfill to fix, not a missing category.
  const claimed = new Set<string>()
  for (const d of registry?.domains ?? []) {
    claimed.add(d.key.toLowerCase())
    for (const t of d.tags) claimed.add(t.toLowerCase())
  }

  // tag → set of node indices (within the unassigned pool)
  const byTag = new Map<string, Set<number>>()
  for (const i of unassignedIdx) {
    for (const raw of graph.nodes[i]!.tags) {
      const tag = raw.toLowerCase()
      if (STRUCTURAL_TAGS.has(tag) || claimed.has(tag)) continue
      let set = byTag.get(tag)
      if (!set) {
        set = new Set()
        byTag.set(tag, set)
      }
      set.add(i)
    }
  }

  const viable = [...byTag.entries()].filter(([, pages]) => pages.size >= minPages)
  if (viable.length === 0) return empty

  // Merge tags that describe the same set of pages (`llm-wiki` and `llm-wiki-pattern` are one
  // theme, not two). Union-find over pairwise Jaccard overlap.
  const parent = new Map<string, string>(viable.map(([tag]) => [tag, tag]))
  const find = (t: string): string => {
    let root = t
    while (parent.get(root) !== root) root = parent.get(root)!
    // Path compression keeps repeated lookups cheap on a long merge chain.
    let cur = t
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  for (let a = 0; a < viable.length; a++) {
    for (let b = a + 1; b < viable.length; b++) {
      const [tagA, pagesA] = viable[a]!
      const [tagB, pagesB] = viable[b]!
      let shared = 0
      for (const i of pagesA) if (pagesB.has(i)) shared++
      const union = pagesA.size + pagesB.size - shared
      if (union > 0 && shared / union >= MERGE_JACCARD) parent.set(find(tagA), find(tagB))
    }
  }

  const groups = new Map<string, { tags: string[]; pages: Set<number> }>()
  for (const [tag, pages] of viable) {
    const root = find(tag)
    let group = groups.get(root)
    if (!group) {
      group = { tags: [], pages: new Set() }
      groups.set(root, group)
    }
    group.tags.push(tag)
    for (const i of pages) group.pages.add(i)
  }

  const candidates: DomainCandidate[] = []
  for (const group of groups.values()) {
    // The dominant tag names the candidate; ties break alphabetically so the key is stable
    // across rebuilds (an unstable key would break dismissals).
    const tags = group.tags.sort((x, y) => {
      const d = byTag.get(y)!.size - byTag.get(x)!.size
      return d !== 0 ? d : x.localeCompare(y)
    })
    const key = tags[0]!
    if (dismissed.has(key)) continue

    const members = [...group.pages]
    const memberSet = new Set(members)
    const linked = new Set<number>()
    for (const [from, to] of graph.edges) {
      if (memberSet.has(from) && memberSet.has(to)) {
        linked.add(from)
        linked.add(to)
      }
    }
    candidates.push({
      key,
      tags,
      pages: members
        .map((i) => ({ path: graph.nodes[i]!.path, title: graph.nodes[i]!.title }))
        .sort((x, y) => x.title.localeCompare(y.title)),
      pageCount: members.length,
      cohesion: members.length > 0 ? linked.size / members.length : 0,
    })
  }

  candidates.sort((x, y) => y.pageCount - x.pageCount || x.key.localeCompare(y.key))
  return { candidates, unassignedCount: unassignedIdx.length, undomainedCount, threshold }
}
