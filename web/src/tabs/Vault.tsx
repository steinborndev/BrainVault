/**
 * The in-dashboard vault viewer (SPEC.md §12.4) - the tab that makes the Obsidian app
 * optional for everyday use. Two deep-linkable routes:
 *
 *   /vault                → the wikilink graph (search, type filters, local-neighborhood mode)
 *   /vault/page/<path>    → one rendered page: markdown with clickable [[wikilinks]],
 *                           a backlinks panel, and the obsidian:// bridge link
 *
 * Strictly read-only - everything here is derived from GET /graph and GET /pages
 * (hard rule 1: the vault is only ever written by agent runs).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { staleLinks, useStaleLinks } from '../lib/staleLinks.ts'
import type { GraphNode, VaultGraph, ValidationFinding, RepairTask } from '../api/types.ts'
import { GraphCanvas, domainColor, TYPE_VARS, type Lens } from '../components/GraphCanvas.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { Icon } from '../components/Icon.tsx'
import { queryState } from '../components/QueryState.tsx'
import { frontmatter } from '../lib/frontmatter.ts'
import { Shortcuts } from '../components/Shortcuts.tsx'
import { linkifyText } from '../lib/linkify.tsx'
import { navigate, pageRoute, pageFromPath, originPath } from '../lib/router.ts'
import { detectClusters } from '../lib/communities.ts'
import { obsidianUri } from '../lib/obsidian.ts'
import { timeAgo } from '../lib/format.ts'

/**
 * Renders a frontmatter value: wikilinks become in-app navigation, and the plain text around
 * them gets bare URLs and patent numbers auto-linked (so a `url:` or patent field is clickable).
 */
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
    if (m.index > last) parts.push(...linkifyText(value.slice(last, m.index), `meta-t${i}`))
    const body = m[1]!
    const target = body.split('|')[0]!.split('#')[0]!.trim()
    const label = (body.split('|')[1] ?? body.split('#')[0])!.trim()
    parts.push(linkTo(target, label || target, `meta-${i++}`))
    last = m.index + m[0].length
  }
  if (last < value.length) parts.push(...linkifyText(value.slice(last), `meta-t${i}`))
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

/** The graph's key bindings, in the order someone learning the view meets them. */
const GRAPH_SHORTCUTS = [
  { keys: ['2x click'], what: 'open a page from the graph' },
  { keys: ['click'], what: 'with Spotlight on: a cluster area drills in, a node opens it' },
  { keys: ['Enter'], what: 'open the selected page' },
  { keys: ['Esc'], what: 'leave fullscreen, clear search, close panel, leave cluster or focus' },
  { keys: ['Esc', 'Esc'], what: 'reset all filters - show the whole vault' },
  { keys: ['/'], what: 'search the graph' },
  { keys: ['f'], what: 'fit the view' },
  { keys: ['Ctrl', 'wheel'], what: 'zoom in and out' },
  { keys: ['+', '-'], what: 'zoom' },
  { keys: ['drag'], what: 'pan the canvas' },
]

export function Vault({ path }: { path: string }): React.ReactElement {
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: api.graph, staleTime: 30_000 })

  const [pathname, search] = path.split('?') as [string, string | undefined]
  const page = pageFromPath(pathname)
  const params = new URLSearchParams(search ?? '')
  const focus = params.get('focus')
  // `?gaps=1` arrives from Home's Gaps card: open the graph with the gaps overlay already on.
  const openGaps = params.get('gaps') === '1'

  const state = queryState(graphQ, 'the graph')
  if (state !== null) return state
  // Neither loading nor failed, but nothing came back: the query settled empty. Rare, and
  // the retry is still the only useful thing to offer.
  if (!graphQ.data) {
    return (
      <div className="empty">
        <p className="qs-line">The graph came back empty.</p>
        <button className="btn" onClick={() => void graphQ.refetch()}>
          Try again
        </button>
      </div>
    )
  }

  if (page !== null) return <PageView graph={graphQ.data} path={page} />
  return <GraphView graph={graphQ.data} focusPath={focus} openGaps={openGaps} />
}

// ---------------------------------------------------------------------------- graph view

/** Key under which "page has no domain" appears in the domain filter (SPEC §12.4 Stufe 1). */
const NO_DOMAIN = ''

/** Synthetic path prefix marking a ghost (gap) node in the canvas node list. */
const GAP_PATH_PREFIX = '#gap:'

/** Two Escape presses within this window are a "double Esc" - reset the whole graph view. */
const DOUBLE_ESC_MS = 400

/** The explorer selection: a real page (by path) or a knowledge gap (by title). */
type Selection = { kind: 'page'; path: string } | { kind: 'gap'; title: string } | null

/**
 * One level of isolated community (spotlight click, SPEC §12.4): the graph shows only these
 * pages until Esc. Levels stack - Louvain re-runs on the isolated subgraph and usually finds
 * sub-communities, so a spotlight click inside a focused cluster drills one level deeper;
 * Esc pops one level. Each level is a snapshot by PATH, not by subgraph index - indices churn
 * on every filter change and SSE live update (same reasoning as `Selection`) - and a proper
 * SUBSET of the level above, so the keep-filter only ever needs the top of the stack.
 * `anchor` is the clicked page, keying the camera re-fit; label/domain feed the clusterbar.
 * A cluster is NOT a domain: one domain typically splits into several Louvain communities,
 * and this isolates exactly one of them.
 */
interface ClusterFocus {
  paths: ReadonlySet<string>
  label: string
  domain: string | null
  anchor: string
}


/** Missing `kind` (ghost nodes, old cached responses) counts as knowledge - never hide it. */
const isKnowledge = (n: GraphNode): boolean => (n.kind ?? 'knowledge') === 'knowledge'

/**
 * Tags that mirror a page's `type:`/kind rather than its subject - they say WHAT a page is,
 * not what it's ABOUT, so they carry no thematic signal for "Related by tag". Every source
 * page shares `#source`, so matching on it drags in the whole source corpus. Mirrors the
 * server's KNOWLEDGE_TYPES/ARTIFACT_TYPES plus structural markers (server/src/pipeline/graph.ts).
 */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  'concept', 'entity', 'source', 'reference', 'comparison', 'question', 'synthesis', 'decision',
  'session', 'fold', 'report', 'release', 'index', 'log', 'meta', 'moc',
])
const isThematicTag = (t: string): boolean => !STRUCTURAL_TAGS.has(t.toLowerCase())

/** localStorage key of the RETIRED standalone System toggle - read once as a migration
 *  fallback when the combined prefs key below doesn't exist yet. */
const SHOW_SYSTEM_KEY = 'vault.showSystem'

/**
 * localStorage key for the graph view preferences - the how-it's-drawn choices (lens, type
 * visibility, domain filter, overlay toggles, System). Persisted so an F5 keeps the graph
 * the user set up; System used to be the only survivor, which read as random amnesia.
 * Exploration state (search, selection, trail, cluster drill-down) stays session-only on
 * purpose - it describes where the user currently IS, not how they like the graph shown.
 * The payload carries a `v` field: bump it on shape changes and stale prefs fall back to
 * defaults instead of half-applying.
 */
const VIEW_PREFS_KEY = 'vault.graphPrefs'

const LENS_VALUES: ReadonlySet<string> = new Set(['domain', 'type', 'authority', 'orphans', 'stubs', 'recency'])

interface ViewPrefs {
  // v2: the type filter flipped from hide-set (`hiddenTypes`) to solo-select (`selectedTypes`),
  // mirroring the domain filter. The two carry OPPOSITE meaning, so a v1 payload must be
  // discarded, not read as the new field - the version bump is what makes the loader do that.
  v: 2
  lens: Lens
  selectedTypes: string[]
  selectedDomains: string[]
  showClusters: boolean
  showGaps: boolean
  showNetwork: boolean
  spotlight: boolean
  showSystem: boolean
}

/** loadViewPrefs result: every field optional AND possibly explicitly undefined (validation
 *  emits undefined for unusable fields; exactOptionalPropertyTypes makes that distinction). */
type LoadedPrefs = { [K in keyof Omit<ViewPrefs, 'v'>]?: ViewPrefs[K] | undefined }

/** Field-by-field validated load: a foreign or stale payload degrades to defaults, never
 *  throws. Exported for its unit tests only. */
export function loadViewPrefs(): LoadedPrefs {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY)
    if (raw === null) return { showSystem: localStorage.getItem(SHOW_SYSTEM_KEY) === '1' }
    const p: unknown = JSON.parse(raw)
    if (p === null || typeof p !== 'object' || (p as { v?: unknown }).v !== 2) return {}
    const o = p as Record<string, unknown>
    const strings = (x: unknown): string[] | undefined =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : undefined
    const bool = (x: unknown): boolean | undefined => (typeof x === 'boolean' ? x : undefined)
    return {
      lens: typeof o.lens === 'string' && LENS_VALUES.has(o.lens) ? (o.lens as Lens) : undefined,
      selectedTypes: strings(o.selectedTypes),
      selectedDomains: strings(o.selectedDomains),
      showClusters: bool(o.showClusters),
      showGaps: bool(o.showGaps),
      showNetwork: bool(o.showNetwork),
      spotlight: bool(o.spotlight),
      showSystem: bool(o.showSystem),
    }
  } catch {
    return {} // storage unavailable (private mode) or corrupt JSON - defaults win
  }
}

const savedPrefs = loadViewPrefs()

/**
 * GraphView state that OUTLIVES the component: graph and page view are mutually exclusive
 * routes, so opening an article unmounts the graph - without this, a double-click →
 * article → Escape round trip would come back to reset filters, lens, search, selection
 * and trail. Same module-scope pattern (and rationale) as the canvas's camera memory in
 * GraphCanvas.tsx; safe because the app has exactly one graph view. The ViewPrefs subset
 * additionally survives reloads via localStorage (seeded here, written by saveViewPrefs).
 */
const viewMemory = {
  query: '',
  selectedTypes: new Set(savedPrefs.selectedTypes ?? []) as ReadonlySet<string>,
  selectedDomains: new Set(savedPrefs.selectedDomains ?? []) as ReadonlySet<string>,
  lens: savedPrefs.lens ?? ('domain' as Lens),
  showClusters: savedPrefs.showClusters ?? false,
  showGaps: savedPrefs.showGaps ?? false,
  showNetwork: savedPrefs.showNetwork ?? false,
  spotlight: savedPrefs.spotlight ?? false,
  clusterStack: [] as readonly ClusterFocus[],
  showSystem: savedPrefs.showSystem ?? false,
  selection: null as Selection,
  trail: [] as string[],
}

/** Last-written prefs JSON - the snapshot effect runs on every commit, writes only on change. */
let lastSavedPrefs: string | null = null

function saveViewPrefs(): void {
  const prefs: ViewPrefs = {
    v: 2,
    lens: viewMemory.lens,
    selectedTypes: [...viewMemory.selectedTypes].sort(),
    selectedDomains: [...viewMemory.selectedDomains].sort(),
    showClusters: viewMemory.showClusters,
    showGaps: viewMemory.showGaps,
    showNetwork: viewMemory.showNetwork,
    spotlight: viewMemory.spotlight,
    showSystem: viewMemory.showSystem,
  }
  const json = JSON.stringify(prefs)
  if (json === lastSavedPrefs) return
  lastSavedPrefs = json
  try {
    localStorage.setItem(VIEW_PREFS_KEY, json)
  } catch {
    // Storage unavailable (private mode) - the prefs still hold for this session.
  }
}

/** An existing wikilink flagged as possibly incidental (see the graph-health memo). */
interface SuspiciousEdge {
  from: GraphNode
  to: GraphNode
}

/**
 * Deterministic connectivity findings over the FULL graph (filters don't change whether a
 * page is isolated). Feeds the explorer panel's "Repair" action:
 *  - isolated: knowledge pages with no edge to another knowledge page - invisible to graph
 *    exploration (their only neighbors, if any, are system pages like lint reports).
 *  - suspicious: the SINGLE edge between two domains that share no other link. One lone
 *    wire between e.g. cooking and finance is almost always an incidental aside, not
 *    knowledge (the real case: a recipe source name-dropping an investment PDF as "the
 *    vault's earlier German source").
 */
interface GraphHealth {
  isolated: ReadonlySet<string>
  /** Suspicious edges keyed by BOTH endpoint paths, for per-page lookup in the panel. */
  suspiciousByPage: ReadonlyMap<string, readonly SuspiciousEdge[]>
}

function computeGraphHealth(graph: VaultGraph): GraphHealth {
  const nodes = graph.nodes
  const kn = nodes.map(isKnowledge)
  const knDeg = new Array<number>(nodes.length).fill(0)
  // A domain only counts as a "side" when it is a real subject: meta/unassigned/absent
  // domains produce no meaningful cross-domain signal.
  const realDomain = (d: string | null): string | null => (d !== null && d !== 'meta' && d !== 'unassigned' ? d : null)
  const pairCount = new Map<string, number>()
  const cross: Array<[number, number, string]> = []
  for (const [a, b] of graph.edges) {
    if (!kn[a] || !kn[b]) continue
    knDeg[a]!++
    knDeg[b]!++
    const da = realDomain(nodes[a]!.domain)
    const db = realDomain(nodes[b]!.domain)
    if (da !== null && db !== null && da !== db) {
      const key = da < db ? `${da}|${db}` : `${db}|${da}`
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      cross.push([a, b, key])
    }
  }
  const isolated = new Set<string>()
  nodes.forEach((n, i) => {
    if (kn[i] && knDeg[i] === 0) isolated.add(n.path)
  })
  const suspiciousByPage = new Map<string, SuspiciousEdge[]>()
  for (const [a, b, key] of cross) {
    if (pairCount.get(key) !== 1) continue
    const edge: SuspiciousEdge = { from: nodes[a]!, to: nodes[b]! }
    for (const p of [edge.from.path, edge.to.path]) {
      const list = suspiciousByPage.get(p) ?? suspiciousByPage.set(p, []).get(p)!
      list.push(edge)
    }
  }
  return { isolated, suspiciousByPage }
}

/** Search settle delay: long enough to swallow a burst of keystrokes, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 220

/** `value`, but only after it has stopped changing for `delay` ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return settled
}

function GraphView({
  graph,
  focusPath,
  openGaps,
}: {
  graph: VaultGraph
  focusPath: string | null
  openGaps: boolean
}): React.ReactElement {
  // `input` is what the field shows; `query` is what the graph reacts to. Without the delay
  // every keystroke re-filtered the subgraph, re-ran Louvain and refit the camera - typing a
  // six-letter word moved the view six times.
  const [input, setInput] = useState(viewMemory.query)
  const query = useDebounced(input, SEARCH_DEBOUNCE_MS)
  /**
   * Type filter, SOLO-select like the domains (was a hide-set): clicking "concepts" means
   * "show me concepts", so an empty set = every type visible and a non-empty set = only those
   * types. Same inclusion semantics on both axes - a checked box now means "shown", not "not
   * hidden" (the old double negative).
   */
  const [selectedTypes, setSelectedTypes] = useState<ReadonlySet<string>>(viewMemory.selectedTypes)
  /**
   * Domain chips are SOLO-selects, not hide-toggles: clicking "finance" means "show me
   * finance", so an empty set = everything visible and a non-empty set = only those
   * domains. (The old hide-semantics did the exact opposite of what a click intends.)
   */
  const [selectedDomains, setSelectedDomains] = useState<ReadonlySet<string>>(viewMemory.selectedDomains)
  // The color lens. Domain is the default - the meta-categories are the axis the user
  // actually thinks in; type + the metric lenses (authority/orphans/stubs/recency) live in
  // the lens dropdown.
  const [lens, setLens] = useState<Lens>(viewMemory.lens)
  const [localDepth, setLocalDepth] = useState<1 | 2 | 0>(focusPath ? 2 : 0) // 0 = whole graph
  // Cluster hulls: auto-detected communities as tinted, tag-labelled blobs. Off by default.
  const [showClusters, setShowClusters] = useState(viewMemory.showClusters)
  // Gaps view: overlays the unresolved link targets as ghost nodes (SPEC §12.4). Off by
  // default - it is an exploration mode, not the resting state of the graph.
  const [showGaps, setShowGaps] = useState(viewMemory.showGaps)
  // Network lens: lift the connection lines out of the point-cloud read (intra-cluster edges
  // brighten, cross-cluster bridges get a directional gradient). Off by default. Reuses the
  // community detection, so turning it on computes clusters even when the hull tint is off.
  const [showNetwork, setShowNetwork] = useState(viewMemory.showNetwork)
  // Spotlight: hovering a node highlights its whole community (falling back to direct
  // neighbors when it has none) and dims the rest; clicking isolates the community. Off by
  // default (easier to click). Lives in the viewbar overlays; passed down to the canvas.
  const [spotlight, setSpotlight] = useState(viewMemory.spotlight)
  // The stack of isolated communities: each spotlight click pushes one level (the clicked
  // node's community, re-detected on the isolated subgraph), Esc pops one, the clusterbar
  // jumps to any level. Empty = the full graph. The spotlight stays live inside a focus -
  // it highlights the SUB-communities of the current level; when a level doesn't subdivide
  // any further, the canvas falls back to the 1-hop neighborhood and clicks select normally
  // (the drill-down ends exactly where there is nothing left to subdivide).
  const [clusterStack, setClusterStack] = useState<readonly ClusterFocus[]>(viewMemory.clusterStack)
  const clusterFocus = clusterStack.length > 0 ? clusterStack[clusterStack.length - 1]! : null
  /**
   * System pages (structural hubs + maintenance artifacts, node `kind` ≠ knowledge) are
   * hidden by default: the heavily-linked index/hot/log hubs are cross-domain bridges that
   * visually dominate the graph and distort clustering, and reports/session logs aren't
   * knowledge at all. The toggle brings them back; the choice persists across sessions.
   */
  const [showSystem, setShowSystem] = useState(viewMemory.showSystem)
  /**
   * The explorer selection, keyed stably (path for a page, title for a gap) so it survives
   * the index churn a filter change causes. Clicking a node opens the panel instead of
   * navigating; "Open page" inside the panel is the explicit navigation - or a double-click
   * right on the node.
   */
  const [selection, setSelection] = useState<Selection>(viewMemory.selection)
  /** Breadcrumb of visited PAGES (not gaps) - every hop is a chip you can jump back to. */
  const [trail, setTrail] = useState<string[]>(viewMemory.trail)
  /**
   * Fullscreen: the graph on its own, with only the controls that belong to the drawing.
   * Deliberately NOT persisted - it is a posture for one look, not a preference, and
   * restoring a session into a chromeless screen is disorienting.
   */
  const [fullscreen, setFullscreen] = useState(false)

  /**
   * `?gaps=1` (Home's Gaps card) lands here with the gaps overlay on. It is a one-shot
   * COMMAND, not view state, so the param is consumed and dropped from the URL right away.
   * That matters twice: the screens stay mounted behind [hidden], so seeding useState would
   * only ever fire on the app's first visit to the graph - and without dropping the param,
   * a second click from Home would pass the identical path string, this effect would not
   * re-run, and the toggle would stay wherever the user last left it.
   */
  useEffect(() => {
    if (!openGaps) return
    setShowGaps(true)
    navigate(focusPath === null ? '/graph' : `/graph?focus=${encodeURIComponent(focusPath)}`, {
      replace: true,
    })
  }, [openGaps, focusPath])

  // Write-through into the module-scope memory: every committed render snapshots the view
  // state, so the next mount (returning from an article) restores exactly this view.
  useEffect(() => {
    Object.assign(viewMemory, {
      // The raw input, not the debounced value: a view round trip must restore what the
      // field showed, including a query the user had not finished typing.
      query: input,
      selectedTypes,
      selectedDomains,
      lens,
      showClusters,
      showGaps,
      showNetwork,
      spotlight,
      clusterStack,
      showSystem,
      selection,
      trail,
    })
    saveViewPrefs()
  })

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

  // Type/domain lists reflect the system filter: with system pages hidden, the meta/root
  // buckets and the `meta` domain would be dead entries - chips that filter nothing.
  const types = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of graph.nodes) {
      if (!showSystem && !isKnowledge(n)) continue
      counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [graph, showSystem])

  // Meta-categories from frontmatter `domain:`. Pages without one gather under NO_DOMAIN -
  // deliberately a visible bucket, not a blind spot: it shows how much of the vault is still
  // uncategorized (the evidence base for the domain-registry backfill, SPEC §12.4).
  const domains = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of graph.nodes) {
      if (!showSystem && !isKnowledge(n)) continue
      const d = n.domain ?? NO_DOMAIN
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => (a[0] === NO_DOMAIN ? 1 : b[0] === NO_DOMAIN ? -1 : b[1] - a[1]))
  }, [graph, showSystem])
  const hasDomains = domains.some(([d]) => d !== NO_DOMAIN)
  // With no domains assigned, the domain lens falls back to type-coloring; the legend must
  // follow the SAME resolution so it explains what's actually drawn.
  const effectiveLens: Lens = hasDomains ? lens : lens === 'domain' ? 'type' : lens

  // Displayed subgraph: type + domain filters first, then (optionally) the BFS neighborhood
  // of the focused page. Indices are remapped so the canvas gets a dense, self-contained
  // graph - that is also what keeps the force layout small in local mode on a huge vault.
  // When the gaps view is on, the unresolved targets are appended as synthetic ghost nodes.
  const { nodes, edges, focusIndex, ghostIndices, realCount, realEdgeCount, matches } = useMemo(() => {
    let keep: boolean[] = graph.nodes.map(
      (n) =>
        (showSystem || isKnowledge(n)) &&
        (selectedTypes.size === 0 || selectedTypes.has(n.type)) &&
        (selectedDomains.size === 0 || selectedDomains.has(n.domain ?? NO_DOMAIN)) &&
        (clusterFocus === null || clusterFocus.paths.has(n.path)),
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
    // query present, keep only the pages related to it - the ones that match, plus their
    // direct neighbours so a match keeps its context - intersected with the filters already
    // applied above. Emptying the query restores the full (filtered) graph. Multi-word
    // queries are AND: every term must hit the title, a tag, or the domain.
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (n: GraphNode): boolean =>
      terms.every(
        (t) =>
          n.title.toLowerCase().includes(t) ||
          // The page's own title and aliases, not just its file name. The two differ
          // whenever the filesystem refused a character, so typing the title the dashboard
          // shows elsewhere used to find nothing.
          (n.names?.some((name) => name.toLowerCase().includes(t)) ?? false) ||
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
    // Neighbours pulled in for context are deliberately NOT matches - they render as plain
    // context around the ringed hits.
    const matches = new Set<number>()
    for (const f of matchFull) {
      const r = remap.get(f)
      if (r !== undefined) matches.add(r)
    }

    return { nodes, edges, focusIndex: remap.get(focusIndexFull) ?? null, ghostIndices, realCount, realEdgeCount, matches }
  }, [graph, selectedTypes, selectedDomains, clusterFocus, showSystem, localDepth, focusIndexFull, showGaps, query])

  // Subgraph index of the explorer selection, for the canvas ring + spotlight. Null when the
  // selected page/gap is currently filtered out of view (the panel still shows regardless).
  const selectedIndex = useMemo(() => {
    if (selection === null) return null
    const wantPath = selection.kind === 'page' ? selection.path : `${GAP_PATH_PREFIX}${selection.title}`
    const i = nodes.findIndex((n) => n.path === wantPath)
    return i >= 0 ? i : null
  }, [nodes, selection])

  // Community detection (Louvain) over the currently-visible page graph. Computed when the
  // hulls OR the network lens OR the spotlight are on - the network lens classifies edges as
  // intra-cluster vs bridge and so needs the ids even when no hull is drawn, and the spotlight
  // highlights (and isolates on click) whole communities. Ghost nodes are excluded (id -1) - a
  // missing page has no community. Small clusters (< MIN_CLUSTER) are dropped so the canvas
  // isn't peppered with singleton blobs. Each surviving cluster is labelled by its tags.
  const { clusterIds, clusterLabels, clusterDomains } = useMemo(() => {
    if (!showClusters && !showNetwork && !spotlight)
      return { clusterIds: null as number[] | null, clusterLabels: new Map<number, string>(), clusterDomains: new Map<number, string>() }
    return detectClusters(nodes, edges, realCount)
  }, [showClusters, showNetwork, spotlight, nodes, edges, realCount])

  // The clickable result list under the search box - the rings in the graph show WHERE the
  // matches are, this shows WHAT they are. Every match is listed (the dropdown scrolls);
  // capping it forced the user to hunt the rest in the graph, which is the exact friction
  // a result list should remove. Title matches first (they read as more direct than
  // tag-only hits), then alphabetical so the order is stable as you scroll.
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const list = [...matches].map((i) => nodes[i]!)
    list.sort((a, b) => {
      if (terms.length > 0) {
        const ta = terms.some((t) => a.title.toLowerCase().includes(t)) ? 0 : 1
        const tb = terms.some((t) => b.title.toLowerCase().includes(t)) ? 0 : 1
        if (ta !== tb) return ta - tb
      }
      return a.title.localeCompare(b.title)
    })
    return list
  }, [matches, nodes, query])

  // Known domains matching the query - surfaced ABOVE the page hits so "carbon" offers the
  // carbon-fiber domain as its first result; picking one solo-selects that domain filter.
  const domainResults = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return [] as Array<[string, number]>
    return domains.filter(([d]) => d !== NO_DOMAIN && terms.every((t) => d.toLowerCase().includes(t)))
  }, [domains, query])

  // Solo-select, mirroring toggleDomain: empty = all types; a click adds/removes a type, and
  // deselecting the last one falls back to "all".
  const toggleType = (t: string): void => {
    const next = new Set(selectedTypes)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    setSelectedTypes(next)
  }

  // Persisted with the rest of the view prefs by the snapshot effect - no standalone key.
  const toggleSystem = (): void => setShowSystem((v) => !v)

  // Solo-select semantics: empty = all; a click adds/removes a domain from the selection,
  // and deselecting the last one falls back to "all".
  const toggleDomain = (d: string): void => {
    const next = new Set(selectedDomains)
    if (next.has(d)) next.delete(d)
    else next.add(d)
    setSelectedDomains(next)
  }

  /**
   * The tail of the scope sentence - what the current filters narrowed to, in words. A
   * shrinking count alone cannot tell a domain filter from a type filter from a search.
   */
  const scopeTail = useMemo(() => {
    const parts: string[] = []
    if (selectedDomains.size === 1) {
      const only = [...selectedDomains][0]!
      parts.push(only === NO_DOMAIN ? 'pages with no domain' : `the ${only} domain`)
    } else if (selectedDomains.size > 1) parts.push(`${selectedDomains.size} domains`)
    if (selectedTypes.size > 0) parts.push([...selectedTypes].map((t) => TYPE_LABELS[t] ?? t).join(' + '))
    if (query.trim() !== '') parts.push(`matching “${query.trim()}”`)
    return parts.length === 0 ? ' - the whole vault' : ` - ${parts.join(', ')}`
  }, [selectedDomains, selectedTypes, query])

  /** What the "System pages" toggle would add - the number it shows has to be that. */
  const systemCount = useMemo(() => graph.nodes.filter((n) => !isKnowledge(n)).length, [graph])

  const focusNode = focusIndexFull >= 0 ? graph.nodes[focusIndexFull] : undefined

  const health = useMemo(() => computeGraphHealth(graph), [graph])

  /**
   * Reset every VIEW control to its default so the whole vault is shown again (the double-Esc
   * escape hatch out of a deep filter/drill state). Clears filters, lens, overlays, cluster
   * drill-down, focus depth, search and selection. `showSystem` is deliberately kept - it is a
   * persistent preference (localStorage), not a filter the user is trying to escape.
   */
  const resetView = (): void => {
    setFullscreen(false)
    setInput('')
    setSelectedTypes(new Set())
    setSelectedDomains(new Set())
    setLens('domain')
    setShowClusters(false)
    setShowGaps(false)
    setShowNetwork(false)
    setSpotlight(false)
    setClusterStack([])
    setLocalDepth(0)
    closeExplorer() // selection + trail
    if (focusPath !== null) navigate('/graph')
  }

  // ---- keyboard layer. Window-level (the canvas isn't focusable), via the same stable-
  // listener ref pattern the canvas uses for wheel/zoom keys; gated on this view being the
  // VISIBLE tab - tabs stay mounted but hidden (App.tsx), and hidden = no offsetParent.
  // Escape peels back one UI layer per press: search → explorer panel → cluster focus →
  // gaps list → focus; a DOUBLE Escape (two presses within DOUBLE_ESC_MS) resets the whole
  // view at once.
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const lastEscRef = useRef(0)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // "Is this screen actually on screen?" - the shell keeps every screen mounted and
    // hides it with [hidden], so a key must not act on a graph nobody can see. Measured
    // by box size, NOT by offsetParent: a position:fixed element (which is exactly what
    // fullscreen makes this) reports offsetParent === null, and that swallowed Escape in
    // the one state where it is the only way out.
    const root = rootRef.current
    if (root === null || (root.offsetWidth === 0 && root.offsetHeight === 0)) return
    const el = e.target as HTMLElement
    const typing =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable
    if (e.key === 'Escape') {
      if (typing) return // inputs own their Escape (the search clears/blurs itself)
      e.preventDefault()
      const now = performance.now()
      const doublePress = now - lastEscRef.current < DOUBLE_ESC_MS
      lastEscRef.current = now
      if (doublePress) {
        resetView() // second quick press: back to the full vault in one go
        return
      }
      // Fullscreen is the outermost posture: leave it first, and only it - a press that
      // also cleared a filter underneath would undo two things at once.
      if (fullscreen) {
        setFullscreen(false)
        return
      }
      if (input !== '') setInput('')
      else if (selection !== null) closeExplorer()
      else if (clusterStack.length > 0) setClusterStack((prev) => prev.slice(0, -1)) // pop one level
      else if (showGaps) setShowGaps(false)
      else if (focusPath !== null) navigate('/graph')
      return
    }
    if (typing) return
    if (e.key === 'Enter' && selection?.kind === 'page') {
      navigate(pageRoute(selection.path))
    } else if (e.key === '/') {
      e.preventDefault()
      searchRef.current?.focus()
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // The search sits in the canvas bar with Fit and the view actions: it acts on the
  // canvas, and a second floating box was claiming the same corner as the bar.
  const searchOverlay = (
    <div className="graph-search graph-search-inbar">
      <Icon name="search" />
      <input
        ref={searchRef}
        type="search"
        placeholder="Search pages or tags…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          // Enter on an unambiguous match opens the page.
          if (e.key === 'Enter' && matches.size === 1) {
            const only = nodes[[...matches][0]!]
            if (only) navigate(pageRoute(only.path))
          }
          // Escape: first press restores the full graph, on an empty box it leaves the
          // field - so the next press reaches the window-level Escape ladder.
          if (e.key === 'Escape') {
            e.preventDefault()
            if (input !== '') setInput('')
            else e.currentTarget.blur()
          }
        }}
        aria-label="Search the graph for a page or tag"
      />
      {input && <span className="graph-matches">{matches.size} match{matches.size === 1 ? '' : 'es'}</span>}
      {query.trim() !== '' && (results.length > 0 || domainResults.length > 0) && (
        <ul className="graph-search-results">
          {domainResults.map(([d, count]) => (
            <li key={`dom-${d}`}>
              <button
                className="dom-hit"
                // REPLACES the domain selection, deliberately diverging from the accumulating
                // chips/panel: search is a refocus - whoever had cooking soloed and then
                // searches carbon fiber has moved on; the old selection lost its relevance
                // the moment they typed. The tooltip says so.
                onClick={() => {
                  setSelectedDomains(new Set([d]))
                  setInput('')
                }}
                title={`Show only the ${d} domain (replaces the current domain filter)`}
              >
                <span className="bucket">Domain</span>
                <span className="dom-dot" style={{ background: domainColor(d) }} aria-hidden />
                {d}
                <span className="dom-count">{count}</span>
              </button>
            </li>
          ))}
          {results.map((n) => (
            <li key={n.path}>
              <button
                onClick={() => {
                  setInput('')
                  navigate(pageRoute(n.path))
                }}
              >
                <span className="bucket">{TYPE_LABELS[n.type] ?? n.type}</span>
                {n.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <div className={`vault-graph${fullscreen ? ' fullscreen' : ''}`} ref={rootRef}>
      <StaleLinksBanner />
      <div className="workspace graph-workspace">
        {(clusterFocus !== null || focusNode) && (
          <div className="ws-bar">
      {/* The isolated community as its own row (the spotlight-click result), mirroring the
          focusbar: what is isolated, how big it is, and the one way back. The domain dot and
          the "· domain" suffix make the cluster ≠ domain distinction visible - one domain
          usually splits into several communities, and this row names exactly one of them. */}
      {clusterFocus !== null && (
        <div className="clusterbar" role="status">
          {clusterFocus.domain !== null && (
            <span className="cb-dot" style={{ background: domainColor(clusterFocus.domain) }} aria-hidden />
          )}
          <span>Cluster:</span>
          {/* One crumb per drill-down level; clicking an earlier level pops back to it. */}
          {clusterStack.map((cf, i) => {
            const label = cf.label !== '' ? cf.label : 'unlabeled community'
            const isTop = i === clusterStack.length - 1
            return (
              <span key={`${i}-${cf.anchor}`} className="cb-level">
                {i > 0 && <span className="cb-arrow" aria-hidden>→</span>}
                {isTop ? (
                  <strong>{label}</strong>
                ) : (
                  <button
                    className="linkish"
                    onClick={() => setClusterStack((prev) => prev.slice(0, i + 1))}
                    title={`Back to this level (${cf.paths.size} pages)`}
                  >
                    {label}
                  </button>
                )}
              </span>
            )
          })}
          <span className="cb-meta">
            {clusterFocus.paths.size} pages
            {clusterFocus.domain !== null ? ` · ${clusterFocus.domain}` : ''}
          </span>
          <button
            className="btn ghost cb-exit"
            onClick={() => setClusterStack([])}
            title="Back to the full graph (Esc backs out one level at a time)"
          >
            <Icon name="x" /> Full graph
          </button>
        </div>
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
          <button className="btn ghost" onClick={() => navigate('/graph')} title="Clear focus">
            <Icon name="x" /> Clear
          </button>
        </div>
      )}

          </div>
        )}
        <GraphPanel
          lens={lens}
          onLens={setLens}
          hasDomains={hasDomains}
          types={types}
          selectedTypes={selectedTypes}
          onToggleType={toggleType}
          domains={domains}
          selectedDomains={selectedDomains}
          onToggleDomain={toggleDomain}
          onClearDomains={() => setSelectedDomains(new Set())}
          showClusters={showClusters}
          onClusters={() => setShowClusters((v) => !v)}
          showNetwork={showNetwork}
          onNetwork={() => setShowNetwork((v) => !v)}
          spotlight={spotlight}
          onSpotlight={() => setSpotlight((v) => !v)}
          showSystem={showSystem}
          onSystem={toggleSystem}
          systemCount={systemCount}
          showGaps={showGaps}
          onGaps={() => {
            const next = !showGaps
            setShowGaps(next)
            if (!next && selection?.kind === 'gap') closeExplorer()
          }}
          gapCount={graph.gaps.length}
          onReset={resetView}
        />
        <div className="graph-main">
      <div className="graph-stage">
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          focusIndex={focusIndex}
          selectedIndex={selectedIndex}
          ghostIndices={ghostIndices}
          matches={matches}
          lens={effectiveLens}
          clusters={clusterIds}
          clusterLabels={clusterLabels}
          clusterDomains={clusterDomains}
          showHulls={showClusters}
          network={showNetwork}
          spotlight={spotlight}
          // Every filter/depth/gaps change re-frames the graph; SSE live updates don't touch this key.
          // Fullscreen rides along: entering or leaving changes the canvas width by ~40%,
          // and re-fitting through the fitKey also clears `userMoved` - so a graph the user
          // had panned is re-framed too, instead of staying parked off-screen.
          fitKey={`${[...selectedDomains].sort().join(',')}|${[...selectedTypes].sort().join(',')}|${localDepth}|${focusPath ?? ''}|${showGaps}|${showSystem}|${query.trim()}|${clusterStack.length}:${clusterFocus?.anchor ?? ''}|${fullscreen}`}
          barExtra={
            <>
              <span className="scopeline">
                Showing{' '}
                <strong>
                  {realCount} of {graph.nodes.length}
                </strong>{' '}
                pages and <strong>{realEdgeCount}</strong> links
                {scopeTail}
                {graph.gaps.length > 0 && !showGaps && (
                  <>
                    {' · '}
                    <button
                      className="linkish"
                      // Same landing as the Gaps toggle in the panel: the gaps view with the
                      // explorer's ranked list. The two entry points used to diverge.
                      onClick={() => setShowGaps(true)}
                      // The GAP count, not `graph.unresolved`: this button opens the gap list,
                      // and that list is shorter. `unresolved` counts every dangling wikilink,
                      // most of which nominate nothing to write - `.raw/…` staging references,
                      // links a lint report or a session log quotes while reporting on them,
                      // and the plugin's own doc pages pointing into upstream docs. It said
                      // "54 gaps" over a list of ten.
                      title="Explore the links that point at pages nobody has written yet"
                    >
                      {graph.gaps.length} gaps
                    </button>
                  </>
                )}
              </span>
              <span className="spacer" />
              <Shortcuts rows={GRAPH_SHORTCUTS} />
              <button
                className="btn ghost"
                onClick={() => setFullscreen((v) => !v)}
                title={fullscreen ? 'Back to the full view (Esc)' : 'Show the graph on its own - Esc returns'}
              >
                <Icon name={fullscreen ? 'shrink' : 'expand'} /> {fullscreen ? 'Exit' : 'Fullscreen'}
              </button>
              {/* Last in the row: search is the control you come back to, and its result
                  list drops out of the field - at the end of the bar it has room to. */}
              {searchOverlay}
            </>
          }
          onSelect={(n) =>
            n.path.startsWith(GAP_PATH_PREFIX) ? selectGap(n.title) : selectPage(n.path)
          }
          // The spotlight click, on a member node or anywhere in the community's hull: it
          // isolates the community (the hover previews exactly this set) - recursively:
          // inside a focus the ids come from re-detection on the isolated subgraph, so the
          // click drills into a sub-community. It deliberately does NOT open the explorer
          // panel - the click means "zoom in", not "inspect". The canvas only fires this
          // for isolatable communities (spotlight on, proper subset of the visible real
          // nodes) - a level that doesn't subdivide, and any unclustered node, falls back
          // to the plain select above; the subset guard here is belt-and-braces.
          onClusterClick={(cid) => {
            if (clusterIds === null) return
            const paths = new Set<string>()
            let anchor = ''
            nodes.forEach((m, j) => {
              if (clusterIds[j] === cid) {
                if (anchor === '') anchor = m.path
                paths.add(m.path)
              }
            })
            if (paths.size === 0 || paths.size >= realCount) return
            const level: ClusterFocus = {
              paths,
              label: clusterLabels.get(cid) ?? '',
              domain: clusterDomains.get(cid) ?? null,
              anchor,
            }
            setClusterStack((prev) => [...prev, level])
          }}
          // Double-click goes straight to the article; a gap has no page to open, but
          // its explorer panel is already up from the first click of the pair.
          onOpen={(n) => {
            if (!n.path.startsWith(GAP_PATH_PREFIX)) navigate(pageRoute(n.path))
          }}
          // Click on empty canvas: drop the selection (an accidental node tap is undone
          // with one click). Deliberately keeps the trail - only the panel's ✕ resets it.
          onClear={() => setSelection(null)}
          overlay={
            <>
              {query.trim() !== '' && realCount === 0 && (
                <div className="graph-empty" role="status">
                  No pages match “{query.trim()}”.
                  <button className="linkish" onClick={() => setInput('')}>
                    Clear search
                  </button>
                </div>
              )}
              <LensLegend lens={effectiveLens} types={types} />
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
          health={health}
          onSelectPage={selectPage}
          onSelectGap={selectGap}
          onClose={closeExplorer}
        />
          </div>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------- explorer side panel

/**
 * The node explorer: click a page or a knowledge gap in the graph and browse it as lists.
 * Backlinks, outgoing links and tag-siblings are computed from the FULL graph (not the
 * filtered subgraph), so the panel is complete even when filters hide neighbors. Clicking a
 * link re-selects that page in place - you browse without leaving the graph; "Open page"
 * is the explicit navigation.
 */
function GraphExplorer({
  graph,
  selection,
  gaps,
  health,
  onSelectPage,
  onSelectGap,
  onClose,
}: {
  graph: VaultGraph
  selection: Selection
  gaps: VaultGraph['gaps']
  health: GraphHealth
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
        <PageExplorer graph={graph} path={selection.path} health={health} onSelectPage={onSelectPage} />
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
  health,
  onSelectPage,
}: {
  graph: VaultGraph
  path: string
  health: GraphHealth
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
  // Tag rarity across the vault: a tag on half the pages is near-worthless as a "related"
  // signal, one on three pages is a strong one. IDF weight = log(N / df); a tag on every page
  // scores 0 and drops out on its own, so no fixed denylist has to keep pace with the vault.
  const tagIdf = useMemo(() => {
    const df = new Map<string, number>()
    let n = 0
    for (const nd of graph.nodes) {
      if (!isKnowledge(nd)) continue
      n++
      for (const t of new Set(nd.tags.filter(isThematicTag))) df.set(t, (df.get(t) ?? 0) + 1)
    }
    const idf = new Map<string, number>()
    for (const [t, count] of df) idf.set(t, Math.log(n / count))
    return idf
  }, [graph])

  // Related by shared tag, excluding pages already linked either way - the tag axis surfaces
  // neighbors the wikilinks don't. Structural tags (`#source`, …) carry no subject and are
  // dropped; candidates are ranked by summed IDF of the shared thematic tags so the closest
  // neighbors win, not the alphabetically-first ones. Capped so the panel stays a summary.
  const related = useMemo(() => {
    if (!node) return []
    const own = node.tags.filter(isThematicTag)
    if (own.length === 0) return []
    const weight = new Map(own.map((t) => [t, tagIdf.get(t) ?? 0]))
    const linked = new Set([path, ...backlinks.map((n) => n.path), ...outgoing.map((n) => n.path)])
    return graph.nodes
      .filter((n) => !linked.has(n.path))
      .map((n) => {
        let score = 0
        for (const t of new Set(n.tags)) score += weight.get(t) ?? 0
        return { node: n, score }
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || byTitle(a.node, b.node))
      .slice(0, 6)
      .map((c) => c.node)
  }, [graph, node, path, backlinks, outgoing, tagIdf])

  // ---- graph repair (deterministic findings for THIS page → one bounded agent run) ----
  const qc = useQueryClient()
  const isolated = health.isolated.has(path)
  const suspicious = health.suspiciousByPage.get(path) ?? []
  const [repairId, setRepairId] = useState<string | null>(null)
  useEffect(() => setRepairId(null), [path])
  const startRepair = useMutation({
    mutationFn: (tasks: RepairTask[]) => api.graphRepair(tasks),
    onSuccess: (run) => setRepairId(run.id),
  })
  const repairQ = useQuery({
    queryKey: ['maintenance-run', repairId],
    queryFn: () => api.maintenanceRun(repairId!),
    enabled: repairId !== null,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'running' ? false : 2000),
  })
  const repairRun = repairQ.data
  const repairRunning = repairId !== null && (repairRun === undefined || repairRun.status === 'running')
  useEffect(() => {
    if (repairRun?.status === 'done') {
      // The run edited pages and committed - refresh everything derived from the vault.
      qc.invalidateQueries({ queryKey: ['graph'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    }
  }, [repairRun?.status, qc])
  const repairTasks = (): RepairTask[] => {
    const tasks: RepairTask[] = []
    if (isolated) {
      tasks.push({ kind: 'connect', path, reason: 'isolated: no links to or from any knowledge page' })
    }
    for (const e of suspicious) {
      tasks.push({
        kind: 'edge',
        from: e.from.path,
        to: e.to.path,
        reason: `the only link between the domains "${e.from.domain ?? '?'}" and "${e.to.domain ?? '?'}"`,
      })
    }
    return tasks.slice(0, 10)
  }

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
      {(isolated || suspicious.length > 0) && (
        <div className="gx-health" role="status">
          <div className="gx-health-head">Graph health</div>
          {isolated && (
            <p>
              Isolated: no knowledge page links here or is linked from here - the page is
              invisible to graph exploration.
            </p>
          )}
          {suspicious.map((e) => (
            <p key={`${e.from.path}→${e.to.path}`}>
              <button className="gx-link inline" onClick={() => onSelectPage(e.from.path)}>{e.from.title}</button>
              {' → '}
              <button className="gx-link inline" onClick={() => onSelectPage(e.to.path)}>{e.to.title}</button>
              {' is the only link between '}
              <strong>{e.from.domain}</strong> and <strong>{e.to.domain}</strong> - possibly an
              incidental aside rather than knowledge.
            </p>
          ))}
          {repairId === null && (
            <div className="gx-health-act">
              <button
                className="btn"
                disabled={startRepair.isPending}
                onClick={() => startRepair.mutate(repairTasks())}
                title="A bounded agent run: weaves an isolated page into the graph and/or reviews the flagged link. Edits only the pages involved - one revertable commit."
              >
                {startRepair.isPending ? 'Starting…' : 'Repair (agent run)'}
              </button>
              {startRepair.isError && (
                <span className="gx-health-err">{(startRepair.error as Error).message}</span>
              )}
            </div>
          )}
          {repairRunning && <p className="dim">Repair is running - the agent edits only the pages involved…</p>}
          {repairRun?.status === 'done' && (
            <p>
              Repair finished: {repairRun.result?.pages.length ?? 0} page
              {(repairRun.result?.pages.length ?? 0) === 1 ? '' : 's'} changed (one revertable commit).
            </p>
          )}
          {repairRun?.status === 'error' && (
            <div className="gx-health-act">
              <span className="gx-health-err">Repair failed: {repairRun.error ?? 'unknown error'}</span>
              <button className="btn" onClick={() => setRepairId(null)}>Retry</button>
            </div>
          )}
        </div>
      )}
      <div className="gx-body">
        <LinkSection title="Backlinks" list={backlinks} onSelect={onSelectPage} />
        <LinkSection title="Links to" list={outgoing} onSelect={onSelectPage} />
        <LinkSection title="Related by tag" list={related} onSelect={onSelectPage} />
      </div>
      <div className="gx-actions">
        <button className="btn primary" onClick={() => navigate(pageRoute(node.path))}>
          Open page <Icon name="link" />
        </button>
        <button className="btn" onClick={() => navigate(`/graph?focus=${encodeURIComponent(node.path)}`)}>
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
  // A CLEAN topic (just the page name): the research pipeline pins its synthesis-page title
  // to `Research: <topic><lens suffix>`, so instruction prose here would end up IN the title.
  const prefill = gap.title
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
        {gap.refBy.length === 1 ? '' : 's'} already link to it - the vault telling you what to write next.
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
  // Server ranks by knowledge referrers first, so the top row need not have the most links.
  const max = gaps.reduce((m, g) => Math.max(m, g.refBy.length), 1)
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
        Every dashed node is a page other pages link to but that doesn’t exist yet - ranked by how
        many content pages are waiting. A ready-made research backlog.
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
 * The graph's VIEW PANEL - the structural half of the graph rework (2026-08-24).
 *
 * It replaces four stacked control rows above the canvas (the view bar, the domain band,
 * and the two dropdowns inside them) with one standing column beside it. Three reasons:
 *
 *  1 The canvas gets its height back. Four rows of chrome, plus the cluster and focus bars
 *    when they appear, pushed the drawing into the lower half of the screen.
 *  2 Every parameter is visible at once. The colour lens - the control that decides which
 *    question the graph answers - used to sit inside a dropdown, while the four overlay
 *    toggles sat permanently open. That is the priority upside down.
 *  3 A column grows downward, so the domain list (the one control that grows with the
 *    vault) can take the leftover height and scroll on its own, instead of forcing the
 *    whole toolbar to reflow.
 *
 * What still folds: the diagnostic lenses and the two include-toggles. Both say what is on
 * inside them when collapsed - a fold that hides the state in force is worse than no fold.
 */
function GraphPanel({
  lens,
  onLens,
  hasDomains,
  types,
  selectedTypes,
  onToggleType,
  domains,
  selectedDomains,
  onToggleDomain,
  onClearDomains,
  showClusters,
  onClusters,
  showNetwork,
  onNetwork,
  spotlight,
  onSpotlight,
  showSystem,
  onSystem,
  systemCount,
  showGaps,
  onGaps,
  gapCount,
  onReset,
}: {
  lens: Lens
  onLens: (l: Lens) => void
  hasDomains: boolean
  types: Array<[string, number]>
  selectedTypes: ReadonlySet<string>
  onToggleType: (t: string) => void
  domains: Array<[string, number]>
  selectedDomains: ReadonlySet<string>
  onToggleDomain: (d: string) => void
  onClearDomains: () => void
  showClusters: boolean
  onClusters: () => void
  showNetwork: boolean
  onNetwork: () => void
  spotlight: boolean
  onSpotlight: () => void
  showSystem: boolean
  onSystem: () => void
  systemCount: number
  showGaps: boolean
  onGaps: () => void
  gapCount: number
  onReset: () => void
}): React.ReactElement {
  const [domFilter, setDomFilter] = useState('')
  const includeOn = (showSystem ? 1 : 0) + (showGaps ? 1 : 0)
  /** Hovering a pill previews its meaning; leaving falls back to the one in force. */
  const [lensPreview, setLensPreview] = useState<Lens | null>(null)
  const shownLens = LENSES.find((l) => l.key === (lensPreview ?? lens)) ?? LENSES[0]!

  const label = (d: string): string => (d === NO_DOMAIN ? 'no domain' : d)
  const q = domFilter.trim().toLowerCase()
  // The list is for FINDING a domain, so it orders alphabetically (the old band ordered by
  // size, which is right for a legend and wrong for a lookup). The no-domain bucket is last.
  const domainRows = [...domains]
    .sort(([a], [b]) => (a === NO_DOMAIN ? 1 : b === NO_DOMAIN ? -1 : a.localeCompare(b)))
    .filter(([d]) => q === '' || label(d).toLowerCase().includes(q))

  return (
    <aside className="gpanel" aria-label="Graph view controls">
      <div className="gp-sec">
        <div className="gp-head">
          <span className="gp-eyebrow">View</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={onReset} title="Back to the whole vault, coloured by domain">
            Reset
          </button>
        </div>
        <div className="pillrow" role="radiogroup" aria-label="Colour by">
          {LENSES.map((l) => {
            const disabled = l.key === 'domain' && !hasDomains
            return (
              <button
                key={l.key}
                className="viewpill"
                role="radio"
                aria-checked={lens === l.key}
                disabled={disabled}
                onClick={() => onLens(l.key)}
                onMouseEnter={() => setLensPreview(l.key)}
                onMouseLeave={() => setLensPreview(null)}
                onFocus={() => setLensPreview(l.key)}
                onBlur={() => setLensPreview(null)}
              >
                <span className="pd" aria-hidden />
                {l.label}
              </button>
            )
          })}
        </div>
        <div className="pillhint">{shownLens.desc}</div>
      </div>

      <div className="gp-sec">
        <div className="gp-head">
          <span className="gp-eyebrow">Overlays</span>
        </div>
        <div className="gp-toggles">
          <RowToggle
            on={showClusters}
            onToggle={onClusters}
            name="Areas"
            desc="tinted hull per community"
            title="Outline each auto-detected community as a tinted, tag-labelled hull - which pages group together."
          />
          <RowToggle
            on={showNetwork}
            onToggle={onNetwork}
            name="Bridges"
            desc="brighten links between communities"
            title="Brighten the connections. Intra-community links lift into view; cross-community bridges show link direction as a colour gradient with an arrowhead."
          />
          <RowToggle
            on={spotlight}
            onToggle={onSpotlight}
            name="Spotlight"
            desc="hover isolates one community"
            title="Hovering highlights a whole community and dims the rest. Click inside a cluster's area to isolate it (and keep drilling into sub-communities); click a node to open its page. Esc backs out one level."
          />
        </div>
        <Fold label="Include" state={includeOn === 0 ? 'none' : `${includeOn} on`} lit={includeOn > 0} openWhen={includeOn > 0}>
          <div className="gp-toggles">
            <RowToggle
              on={showSystem}
              onToggle={onSystem}
              name="System pages"
              desc="index hubs, MOCs, reports"
              count={systemCount}
              title="Index hubs, MOCs and the domain registry, plus maintenance artifacts (lint/release reports, session logs). Hidden by default - they organize or document the vault rather than hold knowledge."
            />
            <RowToggle
              on={showGaps}
              onToggle={onGaps}
              name="Gaps"
              desc="unwritten link targets, as ghosts"
              count={gapCount}
              title="Show unresolved links as ghost nodes - the pages your vault still wants written."
            />
          </div>
        </Fold>
      </div>

      <div className="gp-sec">
        <div className="gp-head">
          <span className="gp-eyebrow">Page types</span>
          <span className="spacer" />
          <span className="gp-state">{selectedTypes.size === 0 ? 'all' : `${selectedTypes.size} of ${types.length}`}</span>
        </div>
        <div className="typechips">
          {types.map(([t, count]) => {
            const active = selectedTypes.has(t)
            return (
              <button
                key={t}
                className={`chip${active ? ' active' : ''}${selectedTypes.size > 0 && !active ? ' dimmed' : ''}`}
                aria-pressed={active}
                onClick={() => onToggleType(t)}
                title={active ? `Remove ${TYPE_LABELS[t] ?? t}` : selectedTypes.size === 0 ? 'Show only this type' : `Add ${TYPE_LABELS[t] ?? t}`}
              >
                <span className="chip-dot" style={{ background: `var(${TYPE_VARS[t] ?? '--type-meta'})` }} aria-hidden />
                {TYPE_LABELS[t] ?? t} <span className="chip-n">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {hasDomains && (
        <div className="gp-sec grow">
          <div className="gp-head">
            <span className="gp-eyebrow">Domains</span>
            <span className="spacer" />
            {selectedDomains.size > 0 ? (
              <button className="btn ghost" onClick={onClearDomains} title="Show all domains">
                <Icon name="x" /> Clear
              </button>
            ) : (
              <span className="gp-state">showing all</span>
            )}
          </div>
          <div className="gp-search">
            <Icon name="search" />
            <input
              type="search"
              value={domFilter}
              placeholder="Filter domains…"
              onChange={(e) => setDomFilter(e.target.value)}
              aria-label="Filter the domain list"
            />
          </div>
          <div className="domlist">
            {domainRows.map(([d, count]) => {
              const active = selectedDomains.has(d)
              return (
                <button
                  key={d || '∅'}
                  className={`domrow${active ? ' active' : ''}${selectedDomains.size > 0 && !active ? ' dimmed' : ''}`}
                  aria-pressed={active}
                  onClick={() => onToggleDomain(d)}
                  title={
                    active
                      ? selectedDomains.size === 1
                        ? 'Deselect - back to all domains'
                        : `Remove ${label(d)} from the filter`
                      : selectedDomains.size === 0
                        ? 'Show only this domain'
                        : `Add ${label(d)} to the current selection`
                  }
                >
                  <span className="dot" style={{ background: d === NO_DOMAIN ? 'var(--muted)' : domainColor(d) }} aria-hidden />
                  <span className="nm">{label(d)}</span>
                  <span className="n">{count}</span>
                </button>
              )
            })}
            {domainRows.length === 0 && <div className="gp-none">No domain matches “{domFilter.trim()}”.</div>}
          </div>
        </div>
      )}
    </aside>
  )
}

/** A binary view option as a switch row: name, one line of why, optional count. */
function RowToggle({
  on,
  onToggle,
  name,
  desc,
  count,
  title,
}: {
  on: boolean
  onToggle: () => void
  name: string
  desc: string
  count?: number
  title: string
}): React.ReactElement {
  return (
    <button className="rowtoggle" aria-pressed={on} onClick={onToggle} title={title}>
      <span className="sw" aria-hidden />
      <span className="rt-text">
        <span className="tname">{name}</span>
        <span className="tdesc">{desc}</span>
      </span>
      {count !== undefined && <span className="tn">{count}</span>}
    </button>
  )
}

/**
 * A disclosure for controls that are reached for rather than browsed. `state` is shown on
 * the closed summary and `lit` colours it, so a collapsed fold can never hide the fact that
 * something inside it is switched on. `openWhen` forces it open when that happens.
 */
function Fold({
  label,
  state,
  lit,
  openWhen,
  children,
}: {
  label: string
  state: string
  lit: boolean
  openWhen: boolean
  children: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(openWhen)
  // Something inside became active (via reset, restore or a keyboard path) - show it.
  useEffect(() => {
    if (openWhen) setOpen(true)
  }, [openWhen])
  return (
    <div className={`fold${open ? ' open' : ''}`}>
      <button className="fold-summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="caret" aria-hidden />
        {label}
        <span className={`fold-state${lit ? ' lit' : ''}`}>{state}</span>
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  )
}

/**
 * The colour lenses, as pills. Each description says what the COLOUR means, in the same
 * grammar and - load-bearing - on ONE line: the hint sits above the rest of the panel, so
 * a description that wraps for some lenses and not others makes everything below it jump
 * as the pointer crosses the row. The pill carries the name, so the hint never repeats it.
 */
const LENSES: Array<{ key: Lens; label: string; desc: string }> = [
  { key: 'domain', label: 'Domain', desc: 'one colour per field of knowledge' },
  { key: 'authority', label: 'Authority', desc: 'brighter = more pages link here' },
  { key: 'recency', label: 'Recency', desc: 'green = edited recently' },
  { key: 'type', label: 'Page type', desc: 'a colour per wiki bucket' },
  { key: 'orphans', label: 'Orphans', desc: 'red = nothing links here' },
  { key: 'stubs', label: 'Stubs', desc: 'amber = thin page, under 1 KB' },
]

/**
 * A small canvas-corner legend (bottom-right). The metric lenses each get a one-line key; the
 * `type` lens gets a swatch per page-type color present. The `domain` lens has no legend here -
 * the domain filter chips at the top ARE its legend. `types` is the [type, count] list of what
 * is currently visible, so the legend lists only colors actually on screen.
 */
function LensLegend({
  lens,
  types,
}: {
  lens: Lens
  types: Array<[string, number]>
}): React.ReactElement | null {
  let body: React.ReactNode = null
  if (lens === 'type') {
    // Distinct color buckets present, in a stable order; everything without its own color
    // (meta, references, comparisons, folds, …) collapses to one muted "Meta / other" row -
    // mirroring colorFor(), which paints exactly those buckets muted.
    const present = new Set(types.map(([t]) => t))
    const colored = Object.entries(TYPE_VARS).filter(([, v]) => v !== '--muted')
    const rows = colored
      .filter(([t]) => present.has(t))
      .map(([t, cssVar]) => ({ label: TYPE_LABELS[t] ?? t, cssVar }))
    const coloredKeys = new Set(colored.map(([t]) => t))
    if (types.some(([t]) => !coloredKeys.has(t))) rows.push({ label: 'Meta / other', cssVar: '--muted' })
    body =
      rows.length > 0 ? (
        <>
          <span className="ll-title">Page type</span>
          {rows.map((r) => (
            <span className="ll-row" key={r.label}>
              <i className="ll-sw" style={{ background: `var(${r.cssVar})` }} /> {r.label}
            </span>
          ))}
        </>
      ) : null
  } else if (lens === 'authority')
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
      navigate('/graph')
    },
  })

  const startEdit = (): void => {
    setDraft(pageQ.data?.markdown ?? '')
    save.reset()
    setEditing(true)
  }

  /**
   * Unsaved-draft guard. Every way out of the editor used to drop the draft silently: the
   * back button, "In graph", the sidebar, browser back, Cancel. `dirty` drives a visible
   * badge, an armed Cancel and a beforeunload prompt; `leaveEditor` is what every in-app
   * exit path asks first.
   */
  const dirty = editing && draft !== (pageQ.data?.markdown ?? '')
  const [confirmLeave, setConfirmLeave] = useState(false)
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
  useEffect(() => {
    if (!confirmLeave) return
    const t = setTimeout(() => setConfirmLeave(false), 4000)
    return () => clearTimeout(t)
  }, [confirmLeave])
  /** Returns true when the caller may proceed; otherwise it armed the confirm. */
  const leaveEditor = (): boolean => {
    if (!dirty) {
      setEditing(false)
      return true
    }
    if (!confirmLeave) {
      setConfirmLeave(true)
      return false
    }
    setConfirmLeave(false)
    setEditing(false)
    return true
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

  // Escape leaves the page for the screen it was opened from (library, graph, wherever) -
  // `originPath()` tracks the last non-page route. After a chain of wikilink hops one press
  // still means "out to that screen", not one step back per hop. The back BUTTON does
  // exactly the same thing, so the two gestures can't disagree (they used to: the button
  // ran history.back and could leave the screen entirely). Inert while editing - Escape
  // must never cost a draft - and while typing or a menu is open; gated on this screen
  // being visible (screens stay mounted, hidden via [hidden]).
  const rootRef = useRef<HTMLDivElement>(null)
  const escRef = useRef<(e: KeyboardEvent) => void>(() => {})
  escRef.current = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (rootRef.current === null || rootRef.current.offsetParent === null) return
    if (editing) return
    const el = e.target as HTMLElement
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) return
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    e.preventDefault()
    navigate(originPath())
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => escRef.current(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Title → path map for resolving clicked wikilinks - same first-wins, case-insensitive
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

  // What the back gesture is called: it names the screen this page was opened from, so the
  // hint can never promise a destination the key does not go to.
  const origin = originPath().split('?')[0]!
  const backLabel = origin.startsWith('/library')
    ? 'library'
    : origin.startsWith('/research')
      ? 'research'
      : origin.startsWith('/system')
        ? 'system'
        : origin === '/'
          ? 'home'
          : 'graph'

  return (
    <div className="vault-page" ref={rootRef}>
      <div className="page-head">
        <button
          className="btn ghost"
          onClick={() => {
            if (editing && !leaveEditor()) return
            navigate(originPath())
          }}
          title={`Back to the ${backLabel} (same as Esc)`}
        >
          <Icon name="back" />
        </button>
        <h1>{pageQ.data?.title ?? node?.title ?? path.split('/').pop()?.replace(/\.md$/, '')}</h1>
        {node && <span className="bucket">{TYPE_LABELS[node.type] ?? node.type}</span>}
        {dirty ? (
          <span className="dirty-badge" role="status">
            <Icon name="edit" /> Unsaved changes
          </span>
        ) : (
          <span className="key-hint" aria-hidden>
            <kbd>Esc</kbd> {backLabel}
          </span>
        )}
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => {
            if (editing && !leaveEditor()) return
            navigate(`/graph?focus=${encodeURIComponent(path)}`)
          }}
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
                    {backlinks.length > 3 ? ', …' : ''}) - deleting leaves dangling links.
                  </div>
                )}
                <button
                  role="menuitem"
                  className="danger"
                  disabled={del.isPending}
                  onClick={requestDelete}
                  title="Deleted as a git commit - recoverable"
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
          {/* Markdown left, live rendering right - wikilinks and frontmatter are visible
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
            <button
              className={`btn${confirmLeave ? ' armed' : ''}`}
              onClick={() => leaveEditor()}
              disabled={save.isPending}
              title={dirty ? 'Discard the unsaved draft' : 'Close the editor'}
            >
              {confirmLeave ? 'Discard draft?' : 'Cancel'}
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
                  {/* Frontmatter carries wikilinks too (`related: [[index]]`) - make them
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

/** Live rendering of the editor draft - frontmatter as properties, wikilinks clickable. */
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
 * the bounded reference-cleanup agent run (maintenance kind `cleanup`) - one click instead
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
      // The run edited pages and committed - refresh everything derived from the vault.
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
        Reference cleanup is running - removing dangling links to <strong>{pages}</strong>…
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
