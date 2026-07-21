/**
 * The in-dashboard vault viewer (SPEC.md §12.4) — the tab that makes the Obsidian app
 * optional for everyday use. Two deep-linkable routes:
 *
 *   /vault                → the wikilink graph (search, type filters, local-neighborhood mode)
 *   /vault/page/<path>    → one rendered page: markdown with clickable [[wikilinks]],
 *                           a backlinks panel, and the obsidian:// bridge link
 *
 * Strictly read-only — everything here is derived from GET /graph and GET /pages
 * (hard rule 1: the vault is only ever written by agent runs).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { staleLinks, useStaleLinks } from '../lib/staleLinks.ts'
import type { GraphNode, VaultGraph, ValidationFinding } from '../api/types.ts'
import { GraphCanvas, domainColor, type Lens } from '../components/GraphCanvas.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { Icon } from '../components/Icon.tsx'
import { navigate, pageRoute, pageFromPath } from '../lib/router.ts'
import { obsidianUri } from '../lib/obsidian.ts'
import { timeAgo } from '../lib/format.ts'

/**
 * Splits YAML frontmatter off a page. Obsidian renders it as a properties panel rather than
 * body text, and so do we — dumping `type: concept created: …` into the prose is just noise.
 * Deliberately shallow (top-level `key: value` and `- item` lists); anything it can't read
 * stays in the body rather than being silently dropped.
 */
function frontmatter(markdown: string): { fields: Array<[string, string]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (!m) return { fields: [], body: markdown }
  const fields: Array<[string, string]> = []
  let currentKey: string | null = null
  let listItems: string[] = []
  const flush = (): void => {
    if (currentKey !== null && listItems.length > 0) fields.push([currentKey, listItems.join(', ')])
    listItems = []
  }
  for (const line of m[1]!.split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && currentKey !== null) {
      listItems.push(item[1]!.replace(/^["']|["']$/g, '').trim())
      continue
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    flush()
    const key = kv[1]!
    const value = kv[2]!.replace(/^["']|["']$/g, '').trim()
    if (value === '') {
      currentKey = key // a list or block follows
    } else {
      fields.push([key, value])
      currentKey = null
    }
  }
  flush()
  return { fields, body: markdown.slice(m[0].length) }
}

/** Splits a frontmatter value into text and wikilink parts, rendering the links via `linkTo`. */
function renderMetaValue(
  value: string,
  linkTo: (target: string, label: string, key: string) => React.ReactNode,
): React.ReactNode {
  const parts: React.ReactNode[] = []
  const re = /\[\[([^\]]+)\]\]/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) parts.push(value.slice(last, m.index))
    const body = m[1]!
    const target = body.split('|')[0]!.split('#')[0]!.trim()
    const label = (body.split('|')[1] ?? body.split('#')[0])!.trim()
    parts.push(linkTo(target, label || target, `meta-${i++}`))
    last = m.index + m[0].length
  }
  if (parts.length === 0) return value
  if (last < value.length) parts.push(value.slice(last))
  return parts
}

/** Display labels for the wiki buckets (fallback: the raw directory name). */
const TYPE_LABELS: Record<string, string> = {
  concepts: 'Concepts',
  entities: 'Entities',
  sources: 'Sources',
  meta: 'Meta',
  root: 'Root',
  questions: 'Questions',
  references: 'References',
  comparisons: 'Comparisons',
  folds: 'Folds',
}

export function Vault({ path }: { path: string }): React.ReactElement {
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: api.graph, staleTime: 30_000 })

  const [pathname, search] = path.split('?') as [string, string | undefined]
  const page = pageFromPath(pathname)
  const focus = new URLSearchParams(search ?? '').get('focus')

  if (graphQ.isLoading) return <div className="empty">Loading graph…</div>
  if (graphQ.isError || !graphQ.data) {
    return (
      <div className="empty">
        Failed to load the graph: {(graphQ.error as Error)?.message ?? 'unknown'}{' '}
        <button className="btn" onClick={() => void graphQ.refetch()}>
          Retry
        </button>
      </div>
    )
  }

  if (page !== null) return <PageView graph={graphQ.data} path={page} />
  return <GraphView graph={graphQ.data} focusPath={focus} />
}

// ---------------------------------------------------------------------------- graph view

/** Key under which "page has no domain" appears in the domain filter (SPEC §12.4 Stufe 1). */
const NO_DOMAIN = ''

/** Synthetic path prefix marking a ghost (gap) node in the canvas node list. */
const GAP_PATH_PREFIX = '#gap:'

/** The explorer selection: a real page (by path) or a knowledge gap (by title). */
type Selection = { kind: 'page'; path: string } | { kind: 'gap'; title: string } | null

/** Clusters below this many members aren't tinted — a hull needs a body to be worth drawing. */
const MIN_CLUSTER = 4

/**
 * Label-propagation community detection over the first `realCount` nodes (ghosts, at the
 * tail, are excluded and get id -1). Deterministic: nodes are processed in index order and
 * ties are broken toward the lowest label, so the same graph always yields the same
 * communities — no jitter between renders. Returns a per-node id array (compacted, small
 * clusters folded to -1) and each cluster's label from its dominant shared tags.
 */
function detectClusters(
  nodes: GraphNode[],
  edges: Array<[number, number]>,
  realCount: number,
): { clusterIds: number[]; clusterLabels: Map<number, string> } {
  const adj: number[][] = Array.from({ length: realCount }, () => [])
  for (const [a, b] of edges) {
    if (a < realCount && b < realCount) {
      adj[a]!.push(b)
      adj[b]!.push(a)
    }
  }
  const label = Array.from({ length: realCount }, (_, i) => i)
  for (let iter = 0; iter < 12; iter++) {
    let changed = false
    for (let i = 0; i < realCount; i++) {
      const nbrs = adj[i]!
      if (nbrs.length === 0) continue
      const tally = new Map<number, number>()
      for (const j of nbrs) tally.set(label[j]!, (tally.get(label[j]!) ?? 0) + 1)
      let best = label[i]!
      let bestCount = -1
      for (const [lab, count] of tally) {
        if (count > bestCount || (count === bestCount && lab < best)) {
          best = lab
          bestCount = count
        }
      }
      if (best !== label[i]) {
        label[i] = best
        changed = true
      }
    }
    if (!changed) break
  }

  // Count members, keep only clusters ≥ MIN_CLUSTER, and compact the surviving ids to 0..k.
  const size = new Map<number, number>()
  for (let i = 0; i < realCount; i++) size.set(label[i]!, (size.get(label[i]!) ?? 0) + 1)
  const remap = new Map<number, number>()
  for (const [lab, n] of size) if (n >= MIN_CLUSTER) remap.set(lab, remap.size)

  const clusterIds = nodes.map((_, i) => (i < realCount ? remap.get(label[i]!) ?? -1 : -1))

  // Label each cluster by its top shared tags (up to 2), falling back to the dominant domain.
  const tagCounts = new Map<number, Map<string, number>>()
  const domCounts = new Map<number, Map<string, number>>()
  for (let i = 0; i < realCount; i++) {
    const cid = clusterIds[i]!
    if (cid < 0) continue
    const tc = tagCounts.get(cid) ?? tagCounts.set(cid, new Map()).get(cid)!
    for (const t of nodes[i]!.tags) tc.set(t, (tc.get(t) ?? 0) + 1)
    if (nodes[i]!.domain) {
      const dc = domCounts.get(cid) ?? domCounts.set(cid, new Map()).get(cid)!
      dc.set(nodes[i]!.domain!, (dc.get(nodes[i]!.domain!) ?? 0) + 1)
    }
  }
  const topN = (m: Map<string, number> | undefined, n: number): string[] =>
    m ? [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k) : []
  const clusterLabels = new Map<number, string>()
  for (const cid of remap.values()) {
    const tags = topN(tagCounts.get(cid), 2)
    clusterLabels.set(cid, tags.length > 0 ? tags.map((t) => `#${t}`).join(' ') : topN(domCounts.get(cid), 1)[0] ?? '')
  }
  return { clusterIds, clusterLabels }
}

function GraphView({ graph, focusPath }: { graph: VaultGraph; focusPath: string | null }): React.ReactElement {
  const [query, setQuery] = useState('')
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set())
  /**
   * Domain chips are SOLO-selects, not hide-toggles: clicking "finance" means "show me
   * finance", so an empty set = everything visible and a non-empty set = only those
   * domains. (The old hide-semantics did the exact opposite of what a click intends.)
   */
  const [selectedDomains, setSelectedDomains] = useState<ReadonlySet<string>>(new Set())
  // The color lens. Domain is the default — the meta-categories are the axis the user
  // actually thinks in; type + the metric lenses (authority/orphans/stubs/recency) live in
  // the lens dropdown.
  const [lens, setLens] = useState<Lens>('domain')
  const [localDepth, setLocalDepth] = useState<1 | 2 | 0>(focusPath ? 2 : 0) // 0 = whole graph
  // Cluster hulls: auto-detected communities as tinted, tag-labelled blobs. Off by default.
  const [showClusters, setShowClusters] = useState(false)
  // Gaps view: overlays the unresolved link targets as ghost nodes (SPEC §12.4). Off by
  // default — it is an exploration mode, not the resting state of the graph.
  const [showGaps, setShowGaps] = useState(false)
  /**
   * The explorer selection, keyed stably (path for a page, title for a gap) so it survives
   * the index churn a filter change causes. Clicking a node opens the panel instead of
   * navigating; "Open page" inside the panel is the explicit navigation.
   */
  const [selection, setSelection] = useState<Selection>(null)
  /** Breadcrumb of visited PAGES (not gaps) — every hop is a chip you can jump back to. */
  const [trail, setTrail] = useState<string[]>([])

  const selectPage = (path: string): void => {
    setSelection({ kind: 'page', path })
    setTrail((prev) => {
      const at = prev.indexOf(path)
      if (at >= 0) return prev.slice(0, at + 1) // revisiting an earlier hop rewinds the trail
      const next = [...prev, path]
      return next.length > 8 ? next.slice(next.length - 8) : next
    })
  }
  const selectGap = (title: string): void => setSelection({ kind: 'gap', title })
  const closeExplorer = (): void => {
    setSelection(null)
    setTrail([])
  }

  const focusIndexFull = useMemo(
    () => (focusPath ? graph.nodes.findIndex((n) => n.path === focusPath) : -1),
    [graph, focusPath],
  )

  const types = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of graph.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [graph])

  // Meta-categories from frontmatter `domain:`. Pages without one gather under NO_DOMAIN —
  // deliberately a visible bucket, not a blind spot: it shows how much of the vault is still
  // uncategorized (the evidence base for the domain-registry backfill, SPEC §12.4).
  const domains = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of graph.nodes) {
      const d = n.domain ?? NO_DOMAIN
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => (a[0] === NO_DOMAIN ? 1 : b[0] === NO_DOMAIN ? -1 : b[1] - a[1]))
  }, [graph])
  const hasDomains = domains.some(([d]) => d !== NO_DOMAIN)

  // Displayed subgraph: type + domain filters first, then (optionally) the BFS neighborhood
  // of the focused page. Indices are remapped so the canvas gets a dense, self-contained
  // graph — that is also what keeps the force layout small in local mode on a huge vault.
  // When the gaps view is on, the unresolved targets are appended as synthetic ghost nodes.
  const { nodes, edges, focusIndex, ghostIndices, realCount, realEdgeCount, matches } = useMemo(() => {
    let keep: boolean[] = graph.nodes.map(
      (n) =>
        !hiddenTypes.has(n.type) &&
        (selectedDomains.size === 0 || selectedDomains.has(n.domain ?? NO_DOMAIN)),
    )

    if (localDepth > 0 && focusIndexFull >= 0) {
      const adj = new Map<number, number[]>()
      for (const [a, b] of graph.edges) {
        if (!adj.has(a)) adj.set(a, [])
        if (!adj.has(b)) adj.set(b, [])
        adj.get(a)!.push(b)
        adj.get(b)!.push(a)
      }
      const within = new Set<number>([focusIndexFull])
      let frontier = [focusIndexFull]
      for (let d = 0; d < localDepth; d++) {
        const next: number[] = []
        for (const i of frontier) {
          for (const j of adj.get(i) ?? []) {
            if (!within.has(j)) {
              within.add(j)
              next.push(j)
            }
          }
        }
        frontier = next
      }
      keep = keep.map((k, i) => k && within.has(i))
      keep[focusIndexFull] = true // the focus survives its own type/domain filter
    }

    // Search NARROWS the graph, it does not merely highlight (the old behaviour): with a
    // query present, keep only the pages related to it — the ones that match, plus their
    // direct neighbours so a match keeps its context — intersected with the filters already
    // applied above. Emptying the query restores the full (filtered) graph. Multi-word
    // queries are AND: every term must hit the title, a tag, or the domain.
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (n: GraphNode): boolean =>
      terms.every(
        (t) =>
          n.title.toLowerCase().includes(t) ||
          n.tags.some((tag) => tag.toLowerCase().includes(t)) ||
          (n.domain?.toLowerCase().includes(t) ?? false),
      )
    const matchFull = new Set<number>()
    if (terms.length > 0) {
      graph.nodes.forEach((n, i) => {
        if (keep[i] && hit(n)) matchFull.add(i)
      })
      const related = new Set<number>(matchFull)
      for (const [a, b] of graph.edges) {
        if (matchFull.has(a) && keep[b]) related.add(b)
        if (matchFull.has(b) && keep[a]) related.add(a)
      }
      keep = keep.map((k, i) => k && related.has(i))
    }

    const remap = new Map<number, number>()
    const nodes: GraphNode[] = []
    graph.nodes.forEach((n, i) => {
      if (keep[i]) {
        remap.set(i, nodes.length)
        nodes.push(n)
      }
    })
    const edges: Array<[number, number]> = []
    for (const [a, b] of graph.edges) {
      const ra = remap.get(a)
      const rb = remap.get(b)
      if (ra !== undefined && rb !== undefined) edges.push([ra, rb])
    }

    const realCount = nodes.length
    const realEdgeCount = edges.length
    const ghostIndices = new Set<number>()
    if (showGaps) {
      for (const gap of graph.gaps) {
        // Only wire the ghost to referencing pages that survived the current filters; a gap
        // whose referrers are all hidden would otherwise float edgeless and meaningless.
        const visibleRefs = gap.refBy.map((fi) => remap.get(fi)).filter((r): r is number => r !== undefined)
        if (visibleRefs.length === 0) continue
        const ghostIdx = nodes.length
        ghostIndices.add(ghostIdx)
        nodes.push({
          path: `${GAP_PATH_PREFIX}${gap.title}`,
          title: gap.title,
          type: 'gap',
          tags: [],
          domain: null,
          // `in` = true reference count (drives node size); edges only to visible referrers.
          in: gap.refBy.length,
          out: 0,
        })
        for (const r of visibleRefs) edges.push([r, ghostIdx])
      }
    }

    // The exact matches, in SUBGRAPH indices, for the ring highlight and the results list.
    // Neighbours pulled in for context are deliberately NOT matches — they render as plain
    // context around the ringed hits.
    const matches = new Set<number>()
    for (const f of matchFull) {
      const r = remap.get(f)
      if (r !== undefined) matches.add(r)
    }

    return { nodes, edges, focusIndex: remap.get(focusIndexFull) ?? null, ghostIndices, realCount, realEdgeCount, matches }
  }, [graph, hiddenTypes, selectedDomains, localDepth, focusIndexFull, showGaps, query])

  // Subgraph index of the explorer selection, for the canvas ring + spotlight. Null when the
  // selected page/gap is currently filtered out of view (the panel still shows regardless).
  const selectedIndex = useMemo(() => {
    if (selection === null) return null
    const wantPath = selection.kind === 'page' ? selection.path : `${GAP_PATH_PREFIX}${selection.title}`
    const i = nodes.findIndex((n) => n.path === wantPath)
    return i >= 0 ? i : null
  }, [nodes, selection])

  // Community detection (label propagation) over the currently-visible page graph, computed
  // only when the hulls are shown. Ghost nodes are excluded (id -1) — a missing page has no
  // community. Small clusters (< MIN_CLUSTER) are dropped so the canvas isn't peppered with
  // singleton blobs. Each surviving cluster is labelled by its most common shared tags.
  const { clusterIds, clusterLabels } = useMemo(() => {
    if (!showClusters) return { clusterIds: null as number[] | null, clusterLabels: new Map<number, string>() }
    return detectClusters(nodes, edges, realCount)
  }, [showClusters, nodes, edges, realCount])

  // The clickable result list under the search box — the rings in the graph show WHERE the
  // matches are, this shows WHAT they are. Title matches first (they read as more direct
  // than tag-only hits), capped so the dropdown stays a shortcut rather than a browser.
  const RESULT_CAP = 8
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const list = [...matches].map((i) => nodes[i]!)
    // Title hits read as more direct than tag/domain-only hits — surface them first.
    if (terms.length > 0)
      list.sort(
        (a, b) =>
          Number(terms.some((t) => b.title.toLowerCase().includes(t))) -
          Number(terms.some((t) => a.title.toLowerCase().includes(t))),
      )
    return list.slice(0, RESULT_CAP)
  }, [matches, nodes, query])

  const toggleType = (t: string): void => {
    const next = new Set(hiddenTypes)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    setHiddenTypes(next)
  }

  // Solo-select semantics: empty = all; a click adds/removes a domain from the selection,
  // and deselecting the last one falls back to "all".
  const toggleDomain = (d: string): void => {
    const next = new Set(selectedDomains)
    if (next.has(d)) next.delete(d)
    else next.add(d)
    setSelectedDomains(next)
  }

  const focusNode = focusIndexFull >= 0 ? graph.nodes[focusIndexFull] : undefined

  // The search lives INSIDE the drawing area (top-right), like the zoom controls
  // (top-left) — it searches the canvas, so it sits on the canvas.
  const searchOverlay = (
    <div className="graph-search graph-search-overlay">
      <Icon name="search" />
      <input
        type="search"
        placeholder="Search pages or tags…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter on an unambiguous match opens the page.
          if (e.key === 'Enter' && matches.size === 1) {
            const only = nodes[[...matches][0]!]
            if (only) navigate(pageRoute(only.path))
          }
          // Escape restores the full graph without reaching for the mouse.
          if (e.key === 'Escape' && query !== '') {
            e.preventDefault()
            setQuery('')
          }
        }}
        aria-label="Search the graph for a page or tag"
      />
      {query && <span className="graph-matches">{matches.size} match{matches.size === 1 ? '' : 'es'}</span>}
      {query.trim() !== '' && results.length > 0 && (
        <ul className="graph-search-results">
          {results.map((n) => (
            <li key={n.path}>
              <button
                onClick={() => {
                  setQuery('')
                  navigate(pageRoute(n.path))
                }}
              >
                <span className="bucket">{TYPE_LABELS[n.type] ?? n.type}</span>
                {n.title}
              </button>
            </li>
          ))}
          {matches.size > results.length && (
            <li className="more">…{matches.size - results.length} more highlighted in the graph</li>
          )}
        </ul>
      )}
    </div>
  )

  return (
    <div className="vault-graph">
      <StaleLinksBanner />
      {/* ═══ Tier 1 — the VIEW bar: how the graph is drawn (color lens, type visibility,
          overlays, stats). Deliberately stable: nothing in this row grows with the vault,
          so a filter change can never reflow the render controls (mockup 2026-07-21). ═══ */}
      <div className="viewbar">
        <span className="vb-eyebrow">View</span>
        <LensDropdown lens={lens} onSelect={setLens} hasDomains={hasDomains} />
        <TypesDropdown types={types} hidden={hiddenTypes} onToggle={toggleType} />
        <span className="vb-sep" aria-hidden />
        <span className="overlays">
          <span className="grp-label">Overlays</span>
          {graph.gaps.length > 0 && (
            <button
              className={`ctl${showGaps ? ' on' : ''}`}
              onClick={() => {
                const next = !showGaps
                setShowGaps(next)
                if (!next && selection?.kind === 'gap') closeExplorer()
              }}
              title="Show unresolved links as ghost nodes — the pages your vault still wants written"
            >
              <Icon name="graph" /> Gaps
            </button>
          )}
          <button
            className={`ctl${showClusters ? ' on' : ''}`}
            onClick={() => setShowClusters((v) => !v)}
            title="Outline auto-detected communities as tinted, tag-labelled clusters"
          >
            <Icon name="graph" /> Clusters
          </button>
        </span>
        <span className="vb-spacer" />
        <span className="vtool-stats">
          {realCount} of {graph.nodes.length} pages · {realEdgeCount} links
          {graph.unresolved > 0 && (
            <>
              {' · '}
              <button
                className="linklike"
                onClick={() => {
                  setShowGaps(true)
                  if (graph.gaps[0]) selectGap(graph.gaps[0].title)
                }}
                title="Explore the unresolved links as knowledge gaps"
              >
                {graph.unresolved} gaps
              </button>
            </>
          )}
        </span>
      </div>

      {/* ═══ Tier 2 — the DOMAIN filter band: what is in the graph. The one zone that
          grows with the vault, so it owns its own row: the chips (legend + filter + count
          in one control) scroll horizontally, and the full set lives in the searchable
          "All domains" panel. ═══ */}
      {hasDomains && (
        <DomainBand
          domains={domains}
          selected={selectedDomains}
          onToggle={toggleDomain}
          onClear={() => setSelectedDomains(new Set())}
          onSelectAll={() => setSelectedDomains(new Set(domains.map(([d]) => d)))}
        />
      )}

      {/* Focus mode as its own row: the neighborhood depth is ONE state, so it reads as one
          segmented control (1 · 2 · whole graph), not four loose chips. */}
      {focusNode && (
        <div className="focusbar">
          <span>
            Focus: <strong>{focusNode.title}</strong>
          </span>
          <span className="seg" role="group" aria-label="Neighborhood depth">
            {([1, 2] as const).map((d) => (
              <button key={d} className={localDepth === d ? 'active' : ''} onClick={() => setLocalDepth(d)}>
                Depth {d}
              </button>
            ))}
            <button className={localDepth === 0 ? 'active' : ''} onClick={() => setLocalDepth(0)}>
              Whole graph
            </button>
          </span>
          <button className="btn ghost" onClick={() => navigate('/vault')} title="Clear focus">
            <Icon name="x" /> Clear
          </button>
        </div>
      )}

      <div className="graph-stage">
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          focusIndex={focusIndex}
          selectedIndex={selectedIndex}
          ghostIndices={ghostIndices}
          matches={matches}
          lens={hasDomains ? lens : lens === 'domain' ? 'type' : lens}
          clusters={clusterIds}
          clusterLabels={clusterLabels}
          // Every filter/depth/gaps change re-frames the graph; SSE live updates don't touch this key.
          fitKey={`${[...selectedDomains].sort().join(',')}|${[...hiddenTypes].sort().join(',')}|${localDepth}|${focusPath ?? ''}|${showGaps}|${query.trim()}`}
          onSelect={(n) =>
            n.path.startsWith(GAP_PATH_PREFIX) ? selectGap(n.title) : selectPage(n.path)
          }
          overlay={
            <>
              {searchOverlay}
              {query.trim() !== '' && realCount === 0 && (
                <div className="graph-empty" role="status">
                  No pages match “{query.trim()}”.
                  <button className="linklike" onClick={() => setQuery('')}>
                    Clear search
                  </button>
                </div>
              )}
              {hasDomains && <LensLegend lens={lens} />}
              {trail.length > 1 && (
                <div className="graph-trail" role="navigation" aria-label="Exploration trail">
                  {trail.map((p, i) => {
                    const n = graph.nodes.find((g) => g.path === p)
                    if (!n) return null
                    const cur = selection?.kind === 'page' && selection.path === p
                    return (
                      <span key={p}>
                        {i > 0 && <span className="trail-arrow" aria-hidden>→</span>}
                        <button className={`crumb${cur ? ' cur' : ''}`} onClick={() => selectPage(p)} title={n.title}>
                          {n.title.length > 22 ? `${n.title.slice(0, 20)}…` : n.title}
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}
            </>
          }
        />
        <GraphExplorer
          graph={graph}
          selection={selection}
          gaps={showGaps ? graph.gaps : []}
          onSelectPage={selectPage}
          onSelectGap={selectGap}
          onClose={closeExplorer}
        />
      </div>
    </div>
  )
}

// --------------------------------------------------------------------- explorer side panel

/**
 * The node explorer: click a page or a knowledge gap in the graph and browse it as lists.
 * Backlinks, outgoing links and tag-siblings are computed from the FULL graph (not the
 * filtered subgraph), so the panel is complete even when filters hide neighbors. Clicking a
 * link re-selects that page in place — you browse without leaving the graph; "Open page"
 * is the explicit navigation.
 */
function GraphExplorer({
  graph,
  selection,
  gaps,
  onSelectPage,
  onSelectGap,
  onClose,
}: {
  graph: VaultGraph
  selection: Selection
  gaps: VaultGraph['gaps']
  onSelectPage: (path: string) => void
  onSelectGap: (title: string) => void
  onClose: () => void
}): React.ReactElement | null {
  // A ranked gaps list shows when the gaps view is on but nothing specific is selected.
  const showGapList = selection === null && gaps.length > 0
  const open = selection !== null || showGapList
  if (!open) return null

  return (
    <aside className="graph-explorer" role="complementary" aria-label="Graph explorer">
      <button className="gx-close" onClick={onClose} aria-label="Close explorer">
        <Icon name="x" />
      </button>
      {selection?.kind === 'page' ? (
        <PageExplorer graph={graph} path={selection.path} onSelectPage={onSelectPage} />
      ) : selection?.kind === 'gap' ? (
        <GapExplorer graph={graph} title={selection.title} onSelectPage={onSelectPage} />
      ) : (
        <GapList gaps={gaps} onSelectGap={onSelectGap} />
      )}
    </aside>
  )
}

function PageExplorer({
  graph,
  path,
  onSelectPage,
}: {
  graph: VaultGraph
  path: string
  onSelectPage: (path: string) => void
}): React.ReactElement {
  const idx = useMemo(() => graph.nodes.findIndex((n) => n.path === path), [graph, path])
  const node = idx >= 0 ? graph.nodes[idx] : undefined
  const backlinks = useMemo(
    () =>
      idx < 0
        ? []
        : graph.edges.filter(([, to]) => to === idx).map(([from]) => graph.nodes[from]!).sort(byTitle),
    [graph, idx],
  )
  const outgoing = useMemo(
    () =>
      idx < 0
        ? []
        : graph.edges.filter(([from]) => from === idx).map(([, to]) => graph.nodes[to]!).sort(byTitle),
    [graph, idx],
  )
  // Related by shared tag, excluding pages already linked either way — the tag axis surfaces
  // neighbors the wikilinks don't. Capped so the panel stays a summary.
  const related = useMemo(() => {
    if (!node || node.tags.length === 0) return []
    const linked = new Set([path, ...backlinks.map((n) => n.path), ...outgoing.map((n) => n.path)])
    const tags = new Set(node.tags)
    return graph.nodes
      .filter((n) => !linked.has(n.path) && n.tags.some((t) => tags.has(t)))
      .sort(byTitle)
      .slice(0, 6)
  }, [graph, node, path, backlinks, outgoing])

  if (!node) return <div className="gx-empty">This page is no longer in the graph.</div>

  return (
    <>
      <div className="gx-head">
        <div className="gx-kicker">{TYPE_LABELS[node.type] ?? node.type}</div>
        <h2 className="gx-title">{node.title}</h2>
        <div className="gx-tags">
          {node.domain && (
            <span className="gx-tag dom" style={{ borderColor: domainColor(node.domain), color: domainColor(node.domain) }}>
              {node.domain}
            </span>
          )}
          {node.tags.map((t) => (
            <span key={t} className="gx-tag">#{t}</span>
          ))}
        </div>
      </div>
      <div className="gx-metrics">
        <div className="gx-metric"><span className="v">{node.in}</span><span className="l">backlinks</span></div>
        <div className="gx-metric"><span className="v">{node.out}</span><span className="l">links out</span></div>
      </div>
      <div className="gx-body">
        <LinkSection title="Backlinks" list={backlinks} onSelect={onSelectPage} />
        <LinkSection title="Links to" list={outgoing} onSelect={onSelectPage} />
        <LinkSection title="Related by tag" list={related} onSelect={onSelectPage} />
      </div>
      <div className="gx-actions">
        <button className="btn primary" onClick={() => navigate(pageRoute(node.path))}>
          Open page <Icon name="link" />
        </button>
        <button className="btn" onClick={() => navigate(`/vault?focus=${encodeURIComponent(node.path)}`)}>
          Focus neighborhood
        </button>
      </div>
    </>
  )
}

function GapExplorer({
  graph,
  title,
  onSelectPage,
}: {
  graph: VaultGraph
  title: string
  onSelectPage: (path: string) => void
}): React.ReactElement {
  const gap = graph.gaps.find((g) => g.title === title)
  const refPages = useMemo(
    () => (gap ? gap.refBy.map((i) => graph.nodes[i]!).sort(byTitle) : []),
    [graph, gap],
  )
  if (!gap) return <div className="gx-empty">This link is resolved now.</div>
  const prefill = `Research and write a vault page about "${gap.title}". ${gap.refBy.length} existing pages already link to it.`
  return (
    <>
      <div className="gx-head">
        <div className="gx-kicker gap">Knowledge gap · missing page</div>
        <h2 className="gx-title">{gap.title}</h2>
        <div className="gx-tags">
          <span className="gx-tag">
            {gap.refBy.length} unresolved link{gap.refBy.length === 1 ? '' : 's'} point here
          </span>
        </div>
      </div>
      <div className="gx-note">
        No page named <strong>“{gap.title}”</strong> exists yet, but {gap.refBy.length} page
        {gap.refBy.length === 1 ? '' : 's'} already link to it — the vault telling you what to write next.
      </div>
      <div className="gx-body">
        <LinkSection title="Referenced by" list={refPages} onSelect={onSelectPage} />
      </div>
      <div className="gx-actions">
        <button
          className="btn primary"
          onClick={() => navigate(`/research?prefill=${encodeURIComponent(prefill)}`)}
        >
          Start research on this <Icon name="link" />
        </button>
      </div>
    </>
  )
}

function GapList({
  gaps,
  onSelectGap,
}: {
  gaps: VaultGraph['gaps']
  onSelectGap: (title: string) => void
}): React.ReactElement {
  const total = gaps.reduce((s, g) => s + g.refBy.length, 0)
  const max = gaps[0]?.refBy.length ?? 1
  return (
    <>
      <div className="gx-head">
        <div className="gx-kicker gap">Knowledge gaps</div>
        <h2 className="gx-title">Most-wanted missing pages</h2>
        <div className="gx-tags">
          <span className="gx-tag">
            {total} unresolved link{total === 1 ? '' : 's'} · {gaps.length} distinct target{gaps.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="gx-note">
        Every dashed node is a page other pages link to but that doesn’t exist yet — ranked by how
        many links are waiting. A ready-made research backlog.
      </div>
      <div className="gx-body">
        <ol className="gx-gaplist">
          {gaps.map((g, i) => (
            <li key={g.title}>
              <button className="gx-gaprow" onClick={() => onSelectGap(g.title)}>
                <span className="rank">{i + 1}</span>
                <span className="gtitle">{g.title}</span>
                <span className="meter" aria-hidden>
                  <i style={{ width: `${Math.round((g.refBy.length / max) * 100)}%` }} />
                </span>
                <span className="gn">{g.refBy.length}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </>
  )
}

const byTitle = (a: GraphNode, b: GraphNode): number => a.title.localeCompare(b.title)

/** One titled list of pages in the explorer; nothing renders when the list is empty. */
function LinkSection({
  title,
  list,
  onSelect,
}: {
  title: string
  list: GraphNode[]
  onSelect: (path: string) => void
}): React.ReactElement | null {
  if (list.length === 0) return null
  return (
    <div className="gx-sec">
      <h3>
        {title} <span className="c">{list.length}</span>
      </h3>
      <ul>
        {list.map((n) => (
          <li key={n.path}>
            <button className="gx-link" onClick={() => onSelect(n.path)} title={n.path}>
              <span className="bullet" style={{ background: n.domain ? domainColor(n.domain) : 'var(--muted)' }} />
              {n.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The wiki-bucket visibility filters, tucked behind a dropdown: they are an occasional
 * refinement (hide meta noise, isolate sources), not something worth a permanent row of
 * nine chips above the graph. Checkbox = visible.
 */
/**
 * Tier-2 filter band (mockup 2026-07-21): the domain chips — legend + filter + count in one
 * control — in a horizontally scrolling strip with edge fades, plus the searchable
 * "All domains" panel. This is the part of the toolbar that grows as the vault gains
 * domains, isolated in its own row so it can never reflow the view controls above it.
 * Solo-select semantics unchanged: empty selection = everything; clicks accumulate.
 */
function DomainBand({
  domains,
  selected,
  onToggle,
  onClear,
  onSelectAll,
}: {
  domains: Array<[string, number]>
  selected: ReadonlySet<string>
  onToggle: (d: string) => void
  onClear: () => void
  onSelectAll: () => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const moreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const label = (d: string): string => (d === NO_DOMAIN ? 'no domain' : d)
  const dot = (d: string): string => (d === NO_DOMAIN ? 'var(--muted)' : domainColor(d))
  const q = filter.trim().toLowerCase()
  // The band orders by size (biggest domains first); the panel is for FINDING a domain,
  // so it orders alphabetically — the no-domain pseudo-bucket stays last either way.
  const alphabetical = [...domains].sort(([a], [b]) =>
    a === NO_DOMAIN ? 1 : b === NO_DOMAIN ? -1 : a.localeCompare(b),
  )
  const panelRows = q === '' ? alphabetical : alphabetical.filter(([d]) => label(d).toLowerCase().includes(q))

  return (
    <div className="domainband">
      <div className="db-head">
        <span className="lab">Filter · Domain</span>
        <span className="sel">{selected.size === 0 ? 'showing all' : `${selected.size} selected`}</span>
      </div>
      <span className="db-divider" aria-hidden />
      <div className="db-scroll">
        {domains.map(([d, count]) => {
          const active = selected.has(d)
          return (
            <button
              key={d || '∅'}
              className={`chip${active ? ' active' : ''}${selected.size > 0 && !active ? ' dimmed' : ''}`}
              onClick={() => onToggle(d)}
              title={active ? 'Deselect (back to all)' : 'Show only this domain'}
            >
              <span className="chip-dot" style={{ background: dot(d) }} aria-hidden />
              {label(d)} <span className="chip-n">{count}</span>
            </button>
          )
        })}
      </div>
      <div className="db-actions">
        {selected.size > 0 && (
          <button className="db-clear" onClick={onClear} title="Show all domains">
            <Icon name="x" /> Clear
          </button>
        )}
        <div className="db-more" ref={moreRef}>
          <button
            className={`db-more-btn${open ? ' on' : ''}`}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="true"
          >
            All domains ▾
          </button>
          {open && (
            <div className="db-panel">
              <div className="p-search">
                <Icon name="search" />
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter domains…"
                  aria-label="Filter the domain list"
                />
              </div>
              <div className="p-grid">
                {panelRows.map(([d, count]) => {
                  const active = selected.has(d)
                  return (
                    <button key={d || '∅'} className={`p-row${active ? ' active' : ''}`} onClick={() => onToggle(d)}>
                      <span className="chip-dot" style={{ background: dot(d) }} aria-hidden />
                      <span className="nm">{label(d)}</span>
                      <span className="n">{count}</span>
                      <span className="chk" aria-hidden>
                        {active ? '✓' : ''}
                      </span>
                    </button>
                  )
                })}
                {panelRows.length === 0 && <span className="p-none">No domain matches “{filter.trim()}”.</span>}
              </div>
              <div className="p-foot">
                <button className="linklike" onClick={onSelectAll}>
                  Select all
                </button>
                <span className="count">
                  {selected.size || domains.length} of {domains.length}
                </span>
                <button className="linklike" onClick={onClear}>
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TypesDropdown({
  types,
  hidden,
  onToggle,
}: {
  types: Array<[string, number]>
  hidden: ReadonlySet<string>
  onToggle: (t: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="dropdown" ref={ref}>
      <button
        className={`ctl${hidden.size > 0 ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        Types:{' '}
        <span className="ctl-val">{hidden.size === 0 ? 'all' : `${types.length - hidden.size} of ${types.length}`}</span> ▾
      </button>
      {open && (
        <div className="dropdown-menu" role="menu">
          {types.map(([t, count]) => (
            <label key={t} className="dropdown-item">
              <input type="checkbox" checked={!hidden.has(t)} onChange={() => onToggle(t)} />
              {TYPE_LABELS[t] ?? t}
              <span className="count">{count}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/** The color lenses offered in the dropdown, with the one-line description each shows. */
const LENSES: Array<{ key: Lens; label: string; desc: string }> = [
  { key: 'domain', label: 'Domain', desc: 'hash color per meta-category' },
  { key: 'type', label: 'Page type', desc: 'wiki bucket (concept, entity, …)' },
  { key: 'authority', label: 'Authority', desc: 'brighter = more backlinks' },
  { key: 'orphans', label: 'Orphans', desc: 'red = no backlinks' },
  { key: 'stubs', label: 'Stubs', desc: 'amber = thin page (< 1 KB)' },
  { key: 'recency', label: 'Recency', desc: 'green = edited recently' },
]

/**
 * The color-lens picker: one dropdown that re-encodes the graph to answer a different
 * question. Replaces the old two-state "by domain / by type" toggle — same job, four more
 * axes. Domain is disabled when no page carries one.
 */
function LensDropdown({
  lens,
  onSelect,
  hasDomains,
}: {
  lens: Lens
  onSelect: (l: Lens) => void
  hasDomains: boolean
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const current = LENSES.find((l) => l.key === lens) ?? LENSES[0]!
  return (
    <div className="dropdown" ref={ref}>
      <button
        className={`ctl${lens !== 'domain' ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Change how nodes are colored"
      >
        <Icon name="palette" /> Color: <span className="ctl-val">{current.label}</span> ▾
      </button>
      {open && (
        <div className="dropdown-menu lens-menu" role="menu">
          {LENSES.map((l) => {
            const disabled = l.key === 'domain' && !hasDomains
            return (
              <button
                key={l.key}
                role="menuitemradio"
                aria-checked={l.key === lens}
                className={`lens-item${l.key === lens ? ' sel' : ''}`}
                disabled={disabled}
                onClick={() => {
                  onSelect(l.key)
                  setOpen(false)
                }}
              >
                <span className="lens-name">{l.label}</span>
                <span className="lens-desc">{disabled ? 'no domains assigned yet' : l.desc}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** A small canvas-corner legend for the metric lenses (categorical lenses use the chips). */
function LensLegend({ lens }: { lens: Lens }): React.ReactElement | null {
  let body: React.ReactNode = null
  if (lens === 'authority')
    body = (
      <>
        <span className="ll-title">Authority</span>
        <span className="ll-row"><i className="ll-grad ll-authority" /> few → many backlinks</span>
      </>
    )
  else if (lens === 'orphans')
    body = (
      <>
        <span className="ll-title">Orphans</span>
        <span className="ll-row"><i className="ll-sw" style={{ background: 'var(--err)' }} /> no backlinks (unreachable)</span>
      </>
    )
  else if (lens === 'stubs')
    body = (
      <>
        <span className="ll-title">Stubs</span>
        <span className="ll-row"><i className="ll-sw" style={{ background: 'var(--warn)' }} /> thin page (&lt; 1 KB)</span>
      </>
    )
  else if (lens === 'recency')
    body = (
      <>
        <span className="ll-title">Recency</span>
        <span className="ll-row"><i className="ll-grad ll-recency" /> older → edited recently</span>
      </>
    )
  if (body === null) return null
  return <div className="lens-legend">{body}</div>
}

// ---------------------------------------------------------------------------- page view

function PageView({ graph, path }: { graph: VaultGraph; path: string }): React.ReactElement {
  const qc = useQueryClient()
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  const pageQ = useQuery({ queryKey: ['page-full', path], queryFn: () => api.pageFull(path), staleTime: 30_000 })

  // ---- editing (SPEC.md §12.4 as amended: every dashboard mutation is one git commit) ----
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (deleteTimer.current) clearTimeout(deleteTimer.current)
  }, [])

  // Advisory findings the server's post-edit validation returned for THIS page (the edit
  // itself has landed either way). Cleared when navigating to another page.
  const [saveFindings, setSaveFindings] = useState<ValidationFinding[]>([])
  useEffect(() => setSaveFindings([]), [path])

  const save = useMutation({
    mutationFn: () => api.savePage(path, draft, pageQ.data?.mtime),
    onSuccess: (res) => {
      setEditing(false)
      setSaveFindings(res.validation ?? [])
      qc.invalidateQueries({ queryKey: ['page-full', path] })
      qc.invalidateQueries({ queryKey: ['page', path] }) // the citation-preview cache
      qc.invalidateQueries({ queryKey: ['graph'] }) // links may have changed
      qc.invalidateQueries({ queryKey: ['stats'] }) // a commit landed
    },
  })
  const saveConflict = save.isError && (save.error as Error).message.startsWith('409')

  const del = useMutation({
    mutationFn: () => api.deletePage(path),
    onSuccess: (res) => {
      // Feed the lint-guidance banner: these backlinks just went dangling.
      staleLinks.add(res.staleLinks, pageQ.data?.title ?? path)
      qc.invalidateQueries({ queryKey: ['graph'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
      navigate('/vault')
    },
  })

  const startEdit = (): void => {
    setDraft(pageQ.data?.markdown ?? '')
    save.reset()
    setEditing(true)
  }
  const requestDelete = (): void => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      deleteTimer.current = setTimeout(() => setConfirmDelete(false), 4000)
      return
    }
    if (deleteTimer.current) clearTimeout(deleteTimer.current)
    setMenuOpen(false)
    del.mutate()
  }

  // The ⋯ overflow menu: destructive/rare actions live here, not as bare icons in the
  // head row (the old delete-✕ sat directly beside Edit).
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])
  const [copiedPath, setCopiedPath] = useState(false)

  // Title → path map for resolving clicked wikilinks — same first-wins, case-insensitive
  // rule as the server, so the viewer and the graph can never disagree.
  const byTitle = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of graph.nodes) {
      const key = n.title.toLowerCase()
      if (!m.has(key)) m.set(key, n.path)
    }
    return m
  }, [graph])

  const nodeIndex = useMemo(() => graph.nodes.findIndex((n) => n.path === path), [graph, path])
  const backlinks = useMemo(() => {
    if (nodeIndex < 0) return []
    return graph.edges
      .filter(([, to]) => to === nodeIndex)
      .map(([from]) => graph.nodes[from]!)
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [graph, nodeIndex])
  const outgoing = useMemo(() => {
    if (nodeIndex < 0) return []
    return graph.edges
      .filter(([from]) => from === nodeIndex)
      .map(([, to]) => graph.nodes[to]!)
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [graph, nodeIndex])

  const node = nodeIndex >= 0 ? graph.nodes[nodeIndex] : undefined
  /** Renders one wikilink target as an in-app link, or plain text when it resolves to nothing. */
  const linkTo = (target: string, label: string, key: string): React.ReactNode => {
    const resolved = byTitle.get(target.toLowerCase())
    return resolved !== undefined ? (
      <a
        key={key}
        className="wikilink"
        href={pageRoute(resolved)}
        onClick={(e) => {
          e.preventDefault()
          navigate(pageRoute(resolved))
        }}
      >
        {label}
      </a>
    ) : (
      <span key={key} className="wikilink unresolved" title="This page doesn't exist (yet)">
        {label}
      </span>
    )
  }
  const parsed = useMemo(
    () => (pageQ.data ? frontmatter(pageQ.data.markdown) : { fields: [], body: '' }),
    [pageQ.data],
  )

  return (
    <div className="vault-page">
      <div className="page-head">
        <button className="btn ghost" onClick={() => window.history.back()} title="Back">
          <Icon name="back" />
        </button>
        <h1>{pageQ.data?.title ?? node?.title ?? path.split('/').pop()?.replace(/\.md$/, '')}</h1>
        {node && <span className="bucket">{TYPE_LABELS[node.type] ?? node.type}</span>}
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => navigate(`/vault?focus=${encodeURIComponent(path)}`)}
          title="Focus this page in the graph"
        >
          <Icon name="graph" /> In graph
        </button>
        {!editing && pageQ.data && (
          <button className="btn" onClick={startEdit} title="Edit page (every change becomes a git commit)">
            <Icon name="edit" /> Edit
          </button>
        )}
        <a className="btn" href={obsidianUri(vaultName, path)} title="Open in Obsidian">
          <Icon name="link" /> Obsidian
        </a>
        {!editing && pageQ.data && (
          <span className="overflow-wrap" ref={menuRef}>
            <button
              className="btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More actions"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="omenu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    void navigator.clipboard?.writeText(path).then(() => {
                      setCopiedPath(true)
                      setTimeout(() => setCopiedPath(false), 1500)
                    })
                  }}
                >
                  <Icon name="copy" /> {copiedPath ? 'Copied' : 'Copy vault path'}
                </button>
                <div className="omenu-sep" />
                {confirmDelete && backlinks.length > 0 && (
                  <div className="omenu-note" role="note">
                    {backlinks.length} page{backlinks.length === 1 ? '' : 's'} link here (
                    {backlinks
                      .slice(0, 3)
                      .map((b) => b.title)
                      .join(', ')}
                    {backlinks.length > 3 ? ', …' : ''}) — deleting leaves dangling links.
                  </div>
                )}
                <button
                  role="menuitem"
                  className="danger"
                  disabled={del.isPending}
                  onClick={requestDelete}
                  title="Deleted as a git commit — recoverable"
                >
                  <Icon name="x" />{' '}
                  {del.isPending ? 'Deleting…' : confirmDelete ? 'Really delete?' : 'Delete page…'}
                </button>
              </div>
            )}
          </span>
        )}
      </div>

      <StaleLinksBanner />
      {del.isError && <div className="toast err">Delete failed: {(del.error as Error).message}</div>}

      {saveFindings.length > 0 && (
        <div className="stale-banner" role="status">
          <Icon name="graph" />
          <span>
            Saved, but the page checks found {saveFindings.length} issue{saveFindings.length === 1 ? '' : 's'}:{' '}
            {saveFindings.map((f) => `${f.rule}: ${f.message}`).join(' · ')}
          </span>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setSaveFindings([])} title="Dismiss" aria-label="Dismiss findings">
            <Icon name="x" />
          </button>
        </div>
      )}

      {editing ? (
        <div className="page-editor">
          {/* Markdown left, live rendering right — wikilinks and frontmatter are visible
              while typing instead of only after saving. Stacks on small screens. */}
          <div className="editor-split">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              aria-label="Page content (markdown)"
            />
            <EditorPreview draft={draft} linkTo={linkTo} />
          </div>
          <div className="editor-actions">
            <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save (commit)'}
            </button>
            <button className="btn" onClick={() => setEditing(false)} disabled={save.isPending}>
              Cancel
            </button>
            {saveConflict && (
              <span className="toast err">
                The page changed in the meantime (e.g. through an agent run).{' '}
                <button
                  className="btn ghost"
                  onClick={() => {
                    save.reset()
                    setEditing(false)
                    void qc.invalidateQueries({ queryKey: ['page-full', path] })
                  }}
                >
                  Reload
                </button>
              </span>
            )}
            {save.isError && !saveConflict && (
              <span className="toast err">Save failed: {(save.error as Error).message}</span>
            )}
          </div>
        </div>
      ) : (
      <div className="page-columns">
        <article className="page-body">
          {pageQ.isLoading && <div className="empty">Loading page…</div>}
          {pageQ.isError && (
            <div className="empty">Failed to load the page: {(pageQ.error as Error)?.message}</div>
          )}
          {parsed.fields.length > 0 && (
            <dl className="page-meta">
              {parsed.fields.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  {/* Frontmatter carries wikilinks too (`related: [[index]]`) — make them
                      navigable rather than showing the raw brackets. */}
                  <dd>{renderMetaValue(v, linkTo)}</dd>
                </div>
              ))}
            </dl>
          )}
          {pageQ.data && (
            <Markdown source={parsed.body} renderWikilink={linkTo} />
          )}
          {pageQ.data?.mtime && <div className="page-mtime">Last changed {timeAgo(pageQ.data.mtime)}</div>}
        </article>

        <aside className="page-side">
          <h3>Backlinks ({backlinks.length})</h3>
          {backlinks.length === 0 ? (
            <p className="dim">No page links here.</p>
          ) : (
            <ul className="linklist">
              {backlinks.map((n) => (
                <li key={n.path}>
                  <a
                    href={pageRoute(n.path)}
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(pageRoute(n.path))
                    }}
                  >
                    {n.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <h3>Outgoing ({outgoing.length})</h3>
          {outgoing.length === 0 ? (
            <p className="dim">No outgoing links.</p>
          ) : (
            <ul className="linklist">
              {outgoing.map((n) => (
                <li key={n.path}>
                  <a
                    href={pageRoute(n.path)}
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(pageRoute(n.path))
                    }}
                  >
                    {n.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      )}
    </div>
  )
}

/** Live rendering of the editor draft — frontmatter as properties, wikilinks clickable. */
function EditorPreview({
  draft,
  linkTo,
}: {
  draft: string
  linkTo: (target: string, label: string, key: string) => React.ReactNode
}): React.ReactElement {
  const parsed = useMemo(() => frontmatter(draft), [draft])
  return (
    <div className="editor-preview">
      {parsed.fields.length > 0 && (
        <dl className="page-meta">
          {parsed.fields.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{renderMetaValue(v, linkTo)}</dd>
            </div>
          ))}
        </dl>
      )}
      <Markdown source={parsed.body} renderWikilink={linkTo} />
    </div>
  )
}

/**
 * Banner shown after manual deletions: N backlinks now point at nothing. Primary action is
 * the bounded reference-cleanup agent run (maintenance kind `cleanup`) — one click instead
 * of leaving the dangling references to be discovered weeks later by a lint. The banner
 * tracks the run inline (poll every 2 s) so the user never has to leave the tab.
 */
function StaleLinksBanner(): React.ReactElement | null {
  const state = useStaleLinks()
  const qc = useQueryClient()
  const [runId, setRunId] = useState<string | null>(null)
  const start = useMutation({
    mutationFn: () => api.cleanupReferences(state.pages),
    onSuccess: (run) => setRunId(run.id),
  })
  const runQ = useQuery({
    queryKey: ['maintenance-run', runId],
    queryFn: () => api.maintenanceRun(runId!),
    enabled: runId !== null,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'running' ? false : 2000),
  })
  const run = runQ.data
  const settled = run !== undefined && run.status !== 'running'
  useEffect(() => {
    if (run?.status === 'done') {
      // The run edited pages and committed — refresh everything derived from the vault.
      qc.invalidateQueries({ queryKey: ['graph'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    }
  }, [run?.status, qc])

  if (state.count === 0) return null
  const dismiss = (): void => {
    staleLinks.clear()
    setRunId(null)
    start.reset()
  }
  const pages = state.pages.join(', ')

  let body: React.ReactElement
  if (runId !== null && !settled) {
    body = (
      <span>
        Reference cleanup is running — removing dangling links to <strong>{pages}</strong>…
      </span>
    )
  } else if (run?.status === 'done') {
    const touched = run.result?.pages.length ?? 0
    body = (
      <span>
        Reference cleanup finished: {touched} page{touched === 1 ? '' : 's'} updated (one revertable commit).
      </span>
    )
  } else if (run?.status === 'error' || start.isError) {
    body = (
      <span>
        Reference cleanup failed: {run?.error ?? (start.error as Error | undefined)?.message ?? 'unknown error'}
      </span>
    )
  } else {
    body = (
      <span>
        Deleting <strong>{pages}</strong> left <strong>{state.count}</strong> link
        {state.count === 1 ? '' : 's'} dangling.
      </span>
    )
  }

  return (
    <div className="stale-banner" role="status">
      <Icon name="graph" />
      {body}
      <span className="spacer" />
      {runId === null && state.pages.length > 0 && (
        <button className="btn primary" onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? 'Starting…' : 'Clean up references'}
        </button>
      )}
      {run?.status === 'error' && (
        <button className="btn" onClick={() => { setRunId(null); start.reset() }}>
          Retry
        </button>
      )}
      <button
        className="btn ghost"
        onClick={dismiss}
        disabled={runId !== null && !settled}
        title="Dismiss"
        aria-label="Dismiss banner"
      >
        <Icon name="x" />
      </button>
    </div>
  )
}
