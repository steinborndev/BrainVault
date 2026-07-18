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

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { GraphNode, VaultGraph } from '../api/types.ts'
import { GraphCanvas } from '../components/GraphCanvas.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { Icon } from '../components/Icon.tsx'
import { navigate, pageRoute, pageFromPath } from '../lib/router.ts'
import { obsidianUri } from '../lib/obsidian.ts'
import { timeAgo } from '../lib/format.ts'

/** German labels for the wiki buckets (fallback: the raw directory name). */
const TYPE_LABELS: Record<string, string> = {
  concepts: 'Konzepte',
  entities: 'Entitäten',
  sources: 'Quellen',
  meta: 'Meta',
  root: 'Wurzel',
  questions: 'Fragen',
  references: 'Referenzen',
  comparisons: 'Vergleiche',
  folds: 'Folds',
}

export function Vault({ path }: { path: string }): React.ReactElement {
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: api.graph, staleTime: 30_000 })

  const [pathname, search] = path.split('?') as [string, string | undefined]
  const page = pageFromPath(pathname)
  const focus = new URLSearchParams(search ?? '').get('focus')

  if (graphQ.isLoading) return <div className="empty">Lade Graph…</div>
  if (graphQ.isError || !graphQ.data) {
    return (
      <div className="empty">
        Graph konnte nicht geladen werden: {(graphQ.error as Error)?.message ?? 'unbekannt'}{' '}
        <button className="btn" onClick={() => void graphQ.refetch()}>
          Erneut versuchen
        </button>
      </div>
    )
  }

  if (page !== null) return <PageView graph={graphQ.data} path={page} />
  return <GraphView graph={graphQ.data} focusPath={focus} />
}

// ---------------------------------------------------------------------------- graph view

function GraphView({ graph, focusPath }: { graph: VaultGraph; focusPath: string | null }): React.ReactElement {
  const [query, setQuery] = useState('')
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set())
  const [localDepth, setLocalDepth] = useState<1 | 2 | 0>(focusPath ? 2 : 0) // 0 = whole graph

  const focusIndexFull = useMemo(
    () => (focusPath ? graph.nodes.findIndex((n) => n.path === focusPath) : -1),
    [graph, focusPath],
  )

  const types = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of graph.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [graph])

  // Displayed subgraph: type filter first, then (optionally) the BFS neighborhood of the
  // focused page. Indices are remapped so the canvas gets a dense, self-contained graph —
  // that is also what keeps the force layout small in local mode on a huge vault.
  const { nodes, edges, focusIndex } = useMemo(() => {
    let keep: boolean[] = graph.nodes.map((n) => !hiddenTypes.has(n.type))

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
      keep[focusIndexFull] = true // the focus survives its own type filter
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
    return { nodes, edges, focusIndex: remap.get(focusIndexFull) ?? null }
  }, [graph, hiddenTypes, localDepth, focusIndexFull])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return new Set<number>()
    return new Set(nodes.map((n, i) => (n.title.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0))
  }, [nodes, query])

  const toggleType = (t: string): void => {
    const next = new Set(hiddenTypes)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    setHiddenTypes(next)
  }

  const focusNode = focusIndexFull >= 0 ? graph.nodes[focusIndexFull] : undefined

  return (
    <div className="vault-graph">
      <div className="graph-toolbar">
        <div className="graph-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Seite suchen…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter on an unambiguous match opens the page.
              if (e.key === 'Enter' && matches.size === 1) {
                const only = nodes[[...matches][0]!]
                if (only) navigate(pageRoute(only.path))
              }
            }}
            aria-label="Seite im Graph suchen"
          />
          {query && <span className="graph-matches">{matches.size} Treffer</span>}
        </div>
        <div className="filters">
          {types.map(([t, count]) => (
            <button
              key={t}
              className={`chip${hiddenTypes.has(t) ? '' : ' active'}`}
              onClick={() => toggleType(t)}
              title={hiddenTypes.has(t) ? 'Einblenden' : 'Ausblenden'}
            >
              {TYPE_LABELS[t] ?? t} ({count})
            </button>
          ))}
        </div>
        {focusNode && (
          <div className="graph-focus">
            <span>
              Fokus: <strong>{focusNode.title}</strong>
            </span>
            {([1, 2] as const).map((d) => (
              <button key={d} className={`chip${localDepth === d ? ' active' : ''}`} onClick={() => setLocalDepth(d)}>
                Tiefe {d}
              </button>
            ))}
            <button className={`chip${localDepth === 0 ? ' active' : ''}`} onClick={() => setLocalDepth(0)}>
              Ganzer Graph
            </button>
            <button className="chip" onClick={() => navigate('/vault')} title="Fokus aufheben">
              <Icon name="x" />
            </button>
          </div>
        )}
      </div>

      <GraphCanvas
        nodes={nodes}
        edges={edges}
        focusIndex={focusIndex}
        matches={matches}
        onSelect={(n) => navigate(pageRoute(n.path))}
      />

      <div className="graph-footer">
        {nodes.length} von {graph.nodes.length} Seiten · {edges.length} Links
        {graph.unresolved > 0 ? ` · ${graph.unresolved} offene Links` : ''}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------- page view

function PageView({ graph, path }: { graph: VaultGraph; path: string }): React.ReactElement {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  const pageQ = useQuery({ queryKey: ['page-full', path], queryFn: () => api.pageFull(path), staleTime: 30_000 })

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

  return (
    <div className="vault-page">
      <div className="page-head">
        <button className="btn ghost" onClick={() => window.history.back()} title="Zurück">
          <Icon name="back" />
        </button>
        <h1>{pageQ.data?.title ?? node?.title ?? path.split('/').pop()?.replace(/\.md$/, '')}</h1>
        {node && <span className="bucket">{TYPE_LABELS[node.type] ?? node.type}</span>}
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => navigate(`/vault?focus=${encodeURIComponent(path)}`)}
          title="Diese Seite im Graph fokussieren"
        >
          <Icon name="graph" /> Im Graph
        </button>
        <a className="btn" href={obsidianUri(vaultName, path)} title="In Obsidian öffnen">
          <Icon name="link" /> Obsidian
        </a>
      </div>

      <div className="page-columns">
        <article className="page-body">
          {pageQ.isLoading && <div className="empty">Lade Seite…</div>}
          {pageQ.isError && (
            <div className="empty">Seite konnte nicht geladen werden: {(pageQ.error as Error)?.message}</div>
          )}
          {pageQ.data && (
            <Markdown
              source={pageQ.data.markdown}
              renderWikilink={(target, label, key) => {
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
                  <span key={key} className="wikilink unresolved" title="Seite existiert (noch) nicht">
                    {label}
                  </span>
                )
              }}
            />
          )}
          {pageQ.data?.mtime && <div className="page-mtime">Zuletzt geändert {timeAgo(pageQ.data.mtime)}</div>}
        </article>

        <aside className="page-side">
          <h3>Backlinks ({backlinks.length})</h3>
          {backlinks.length === 0 ? (
            <p className="dim">Keine Seite verlinkt hierher.</p>
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
          <h3>Ausgehend ({outgoing.length})</h3>
          {outgoing.length === 0 ? (
            <p className="dim">Keine ausgehenden Links.</p>
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
    </div>
  )
}
