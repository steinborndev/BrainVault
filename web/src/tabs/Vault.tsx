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
import type { GraphNode, VaultGraph } from '../api/types.ts'
import { GraphCanvas, domainColor } from '../components/GraphCanvas.tsx'
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

function GraphView({ graph, focusPath }: { graph: VaultGraph; focusPath: string | null }): React.ReactElement {
  const [query, setQuery] = useState('')
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set())
  const [hiddenDomains, setHiddenDomains] = useState<ReadonlySet<string>>(new Set())
  const [colorBy, setColorBy] = useState<'type' | 'domain'>('type')
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
  const { nodes, edges, focusIndex } = useMemo(() => {
    let keep: boolean[] = graph.nodes.map((n) => !hiddenTypes.has(n.type) && !hiddenDomains.has(n.domain ?? NO_DOMAIN))

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
  }, [graph, hiddenTypes, hiddenDomains, localDepth, focusIndexFull])

  // Search matches titles AND frontmatter tags — "finance" finds every page tagged
  // german-finance even though no title contains the word.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return new Set<number>()
    const hit = (n: GraphNode): boolean =>
      n.title.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q))
    return new Set(nodes.map((n, i) => (hit(n) ? i : -1)).filter((i) => i >= 0))
  }, [nodes, query])

  // The clickable result list under the search box — the rings in the graph show WHERE the
  // matches are, this shows WHAT they are. Title matches first (they read as more direct
  // than tag-only hits), capped so the dropdown stays a shortcut rather than a browser.
  const RESULT_CAP = 8
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = [...matches].map((i) => nodes[i]!)
    if (q !== '') list.sort((a, b) => Number(b.title.toLowerCase().includes(q)) - Number(a.title.toLowerCase().includes(q)))
    return list.slice(0, RESULT_CAP)
  }, [matches, nodes, query])

  const toggleType = (t: string): void => {
    const next = new Set(hiddenTypes)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    setHiddenTypes(next)
  }

  const toggleDomain = (d: string): void => {
    const next = new Set(hiddenDomains)
    if (next.has(d)) next.delete(d)
    else next.add(d)
    setHiddenDomains(next)
  }

  const focusNode = focusIndexFull >= 0 ? graph.nodes[focusIndexFull] : undefined

  return (
    <div className="vault-graph">
      <StaleLinksBanner />
      <div className="graph-toolbar">
        <div className="graph-search">
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
        <div className="filters">
          {types.map(([t, count]) => (
            <button
              key={t}
              className={`chip${hiddenTypes.has(t) ? '' : ' active'}`}
              onClick={() => toggleType(t)}
              title={hiddenTypes.has(t) ? 'Show' : 'Hide'}
            >
              {TYPE_LABELS[t] ?? t} ({count})
            </button>
          ))}
        </div>
        {hasDomains && (
          <div className="filters">
            <button
              className={`chip${colorBy === 'domain' ? ' active' : ''}`}
              onClick={() => setColorBy(colorBy === 'domain' ? 'type' : 'domain')}
              title="Color nodes by domain instead of page type"
            >
              <Icon name="palette" /> color by domain
            </button>
            {domains.map(([d, count]) => (
              <button
                key={d || '∅'}
                className={`chip${hiddenDomains.has(d) ? '' : ' active'}`}
                onClick={() => toggleDomain(d)}
                title={hiddenDomains.has(d) ? 'Show' : 'Hide'}
              >
                <span
                  className="chip-dot"
                  style={{ background: d === NO_DOMAIN ? 'var(--muted)' : domainColor(d) }}
                  aria-hidden
                />
                {d === NO_DOMAIN ? 'no domain' : d} ({count})
              </button>
            ))}
          </div>
        )}
        {focusNode && (
          <div className="graph-focus">
            <span>
              Focus: <strong>{focusNode.title}</strong>
            </span>
            {([1, 2] as const).map((d) => (
              <button key={d} className={`chip${localDepth === d ? ' active' : ''}`} onClick={() => setLocalDepth(d)}>
                Depth {d}
              </button>
            ))}
            <button className={`chip${localDepth === 0 ? ' active' : ''}`} onClick={() => setLocalDepth(0)}>
              Whole graph
            </button>
            <button className="chip" onClick={() => navigate('/vault')} title="Clear focus">
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
        colorBy={colorBy}
        onSelect={(n) => navigate(pageRoute(n.path))}
      />

      <div className="graph-footer">
        {nodes.length} of {graph.nodes.length} pages · {edges.length} links
        {graph.unresolved > 0 ? ` · ${graph.unresolved} unresolved links` : ''}
      </div>
    </div>
  )
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

  const save = useMutation({
    mutationFn: () => api.savePage(path, draft, pageQ.data?.mtime),
    onSuccess: () => {
      setEditing(false)
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
    del.mutate()
  }

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
        {!editing && pageQ.data && (
          <button
            className={`btn${confirmDelete ? ' danger' : ''}`}
            onClick={requestDelete}
            disabled={del.isPending}
            title={confirmDelete ? 'Really delete? (as a git commit — recoverable)' : 'Delete page'}
          >
            {del.isPending ? 'Deleting…' : confirmDelete ? 'Really delete?' : <Icon name="x" />}
          </button>
        )}
        <a className="btn" href={obsidianUri(vaultName, path)} title="Open in Obsidian">
          <Icon name="link" /> Obsidian
        </a>
      </div>

      <StaleLinksBanner />
      {del.isError && <div className="toast err">Delete failed: {(del.error as Error).message}</div>}

      {editing ? (
        <div className="page-editor">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label="Page content (markdown)"
          />
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

/**
 * Banner shown after manual deletions: N backlinks now point at nothing, and the vault's own
 * cleanup mechanism for that is a lint run — guide the user there instead of leaving the
 * dangling references to be discovered weeks later.
 */
function StaleLinksBanner(): React.ReactElement | null {
  const state = useStaleLinks()
  if (state.count === 0) return null
  const pages = state.pages.join(', ')
  return (
    <div className="stale-banner" role="status">
      <Icon name="graph" />
      <span>
        Deleting <strong>{pages}</strong> left <strong>{state.count}</strong> link
        {state.count === 1 ? '' : 's'} dangling. A lint run finds and cleans up the references.
      </span>
      <span className="spacer" />
      <button
        className="btn primary"
        onClick={() => {
          staleLinks.clear()
          navigate('/maintenance')
        }}
      >
        Go to maintenance
      </button>
      <button className="btn ghost" onClick={() => staleLinks.clear()} title="Dismiss" aria-label="Dismiss banner">
        <Icon name="x" />
      </button>
    </div>
  )
}
