/**
 * Library - the browse path the vault never had (redesign 2026-08). A filterable, sortable
 * table over every page, fed by the same `['graph']` query the canvas uses (no new
 * endpoint). The graph stays the spatial view; this is the retrieval view: find by type,
 * domain, recency - and surface health problems (orphans, stubs) as filters instead of
 * leaving them to a lucky node click.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { navigate, pageRoute } from '../lib/router.ts'
import { timeAgo } from '../lib/format.ts'
import { obsidianUri } from '../lib/obsidian.ts'
import { domainColor, STUB_BYTES } from '../lib/domains.ts'
import { Icon } from '../components/Icon.tsx'
import type { GraphNode } from '../api/types.ts'

/** Bucket display labels, shared vocabulary with the graph's type filter. */
const BUCKET_LABELS: Record<string, string> = {
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
const bucketLabel = (type: string): string => BUCKET_LABELS[type] ?? type

type SortKey = 'changed' | 'title' | 'backlinks'
type HealthFilter = 'any' | 'orphans' | 'stubs'

const PAGE_SIZE = 50

function isOrphan(n: GraphNode): boolean {
  return n.in === 0 && n.out === 0 && (n.kind ?? 'knowledge') === 'knowledge'
}
function isStub(n: GraphNode): boolean {
  return (n.size ?? Infinity) < STUB_BYTES && (n.kind ?? 'knowledge') === 'knowledge'
}

export function Library({ vaultName }: { vaultName: string }): React.ReactElement {
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })

  const [query, setQuery] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [domain, setDomain] = useState<string | null | 'none'>(null)
  const [health, setHealth] = useState<HealthFilter>('any')
  const [sort, setSort] = useState<SortKey>('changed')
  const [showSystem, setShowSystem] = useState(false)
  const [limit, setLimit] = useState(PAGE_SIZE)

  const nodes = graph.data?.nodes

  // System pages (index hubs, reports) are scaffolding - hidden unless asked for, same
  // default the graph uses.
  const knowledge = useMemo(
    () => (nodes ?? []).filter((n) => showSystem || (n.kind ?? 'knowledge') === 'knowledge'),
    [nodes, showSystem],
  )

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of knowledge) m.set(n.type, (m.get(n.type) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [knowledge])

  const domainCounts = useMemo(() => {
    const m = new Map<string, number>()
    let none = 0
    for (const n of knowledge) {
      if (n.domain === null) none++
      else m.set(n.domain, (m.get(n.domain) ?? 0) + 1)
    }
    return { domains: [...m.entries()].sort((a, b) => b[1] - a[1]), none }
  }, [knowledge])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const terms = q === '' ? [] : q.split(/\s+/)
    let list = knowledge.filter((n) => {
      if (type !== null && n.type !== type) return false
      if (domain === 'none' && n.domain !== null) return false
      if (domain !== null && domain !== 'none' && n.domain !== domain) return false
      if (health === 'orphans' && !isOrphan(n)) return false
      if (health === 'stubs' && !isStub(n)) return false
      if (terms.length > 0) {
        const hay = `${n.title} ${n.tags.join(' ')} ${n.domain ?? ''}`.toLowerCase()
        if (!terms.every((t) => hay.includes(t))) return false
      }
      return true
    })
    list = [...list]
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title))
    else if (sort === 'backlinks') list.sort((a, b) => b.in - a.in || a.title.localeCompare(b.title))
    else list.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    return list
  }, [knowledge, query, type, domain, health, sort])

  const shown = filtered.slice(0, limit)
  const [domainOpen, setDomainOpen] = useState(false)

  if (graph.isLoading) return <div className="empty">Loading the page index…</div>
  if (graph.isError)
    return (
      <div className="empty">
        Failed to load the page index: {(graph.error as Error).message}{' '}
        <button className="btn" onClick={() => void graph.refetch()}>
          Retry
        </button>
      </div>
    )

  return (
    <div className="library">
      <div className="lib-bar">
        <div className="hist-search lib-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Filter by title, tag or domain…"
            aria-label="Filter pages by title, tag or domain"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(PAGE_SIZE)
            }}
          />
        </div>
        <div className="seg lib-types" role="group" aria-label="Page type">
          <button className={type === null ? 'active' : ''} onClick={() => setType(null)}>
            All <span className="chip-n">{knowledge.length}</span>
          </button>
          {typeCounts.slice(0, 4).map(([t, count]) => (
            <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(type === t ? null : t)}>
              {bucketLabel(t)} <span className="chip-n">{count}</span>
            </button>
          ))}
        </div>
        <div className="dropdown">
          <button
            className={`chip${domain !== null ? ' active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={domainOpen}
            onClick={() => setDomainOpen((o) => !o)}
          >
            {domain === null ? 'All domains' : domain === 'none' ? 'no domain' : domain} <Icon name="chevron" />
          </button>
          {domainOpen && (
            <div className="dropdown-menu" role="menu">
              <button
                className="dropdown-item"
                onClick={() => {
                  setDomain(null)
                  setDomainOpen(false)
                }}
              >
                All domains
              </button>
              <div className="dropdown-sep" />
              {domainCounts.domains.map(([d, count]) => (
                <button
                  key={d}
                  className="dropdown-item"
                  onClick={() => {
                    setDomain(d)
                    setDomainOpen(false)
                  }}
                >
                  <span className="chip-dot" style={{ background: domainColor(d) }} />
                  {d}
                  <span className="count">{count}</span>
                </button>
              ))}
              {domainCounts.none > 0 && (
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setDomain('none')
                    setDomainOpen(false)
                  }}
                >
                  <em>no domain</em>
                  <span className="count">{domainCounts.none}</span>
                </button>
              )}
            </div>
          )}
        </div>
        <div className="seg" role="group" aria-label="Health filter">
          <button className={health === 'any' ? 'active' : ''} onClick={() => setHealth('any')}>
            All pages
          </button>
          <button
            className={health === 'orphans' ? 'active' : ''}
            onClick={() => setHealth(health === 'orphans' ? 'any' : 'orphans')}
            title="Knowledge pages with no links in either direction"
          >
            Orphans
          </button>
          <button
            className={health === 'stubs' ? 'active' : ''}
            onClick={() => setHealth(health === 'stubs' ? 'any' : 'stubs')}
            title="Thin pages (under 1 KB)"
          >
            Stubs
          </button>
        </div>
        <span className="spacer" />
        <button
          className={`chip${showSystem ? ' active' : ''}`}
          onClick={() => setShowSystem((s) => !s)}
          title="Include structural pages (index hubs, registry) and reports"
        >
          System
        </button>
        <div className="seg" role="group" aria-label="Sort order">
          <button className={sort === 'changed' ? 'active' : ''} onClick={() => setSort('changed')}>
            Changed
          </button>
          <button className={sort === 'title' ? 'active' : ''} onClick={() => setSort('title')}>
            Title
          </button>
          <button className={sort === 'backlinks' ? 'active' : ''} onClick={() => setSort('backlinks')}>
            Backlinks
          </button>
        </div>
      </div>

      <div className="card dtable-card">
        {shown.length === 0 ? (
          <div className="empty">Nothing matches the current filters.</div>
        ) : (
          <table className="dtable">
            <thead>
              <tr>
                <th>Page</th>
                <th>Domain</th>
                <th className="num">In / out</th>
                <th>Changed</th>
                <th aria-hidden />
              </tr>
            </thead>
            <tbody>
              {shown.map((n) => (
                <tr key={n.path} onClick={() => navigate(pageRoute(n.path))}>
                  <td className="lt-title">
                    <span className="lt-bucket">{bucketLabel(n.type)}</span> <strong>{n.title}</strong>
                    {isOrphan(n) && <span className="lt-flag err">orphan</span>}
                    {isStub(n) && <span className="lt-flag warn">stub</span>}
                  </td>
                  <td className="lt-domain">
                    {n.domain !== null ? (
                      <>
                        <span className="chip-dot" style={{ background: domainColor(n.domain) }} />
                        {n.domain}
                      </>
                    ) : (
                      <span className="dim">-</span>
                    )}
                  </td>
                  <td className="num lt-links">
                    {n.in} / {n.out}
                  </td>
                  <td className="lt-when">{n.mtimeMs !== undefined ? timeAgo(new Date(n.mtimeMs).toISOString()) : ''}</td>
                  <td className="lt-acts" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn ghost"
                      aria-label={`Focus ${n.title} in the graph`}
                      title="Focus in graph"
                      onClick={() => navigate(`/graph?focus=${encodeURIComponent(n.path)}`)}
                    >
                      <Icon name="spotlight" />
                    </button>
                    <button
                      className="btn ghost"
                      aria-label={`Open ${n.title} in Obsidian`}
                      title="Open in Obsidian"
                      onClick={() => {
                        window.location.href = obsidianUri(vaultName, n.path)
                      }}
                    >
                      <Icon name="link" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="dtable-foot">
          <span>
            Showing {shown.length} of {filtered.length} pages
            {filtered.length !== knowledge.length ? ` (${knowledge.length} total)` : ''}
          </span>
          <span className="spacer" />
          {filtered.length > limit && (
            <button className="btn" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
              Show more
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
