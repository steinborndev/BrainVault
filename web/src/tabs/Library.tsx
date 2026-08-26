/**
 * Library - the browse path the vault never had (redesign 2026-08). A filterable, sortable
 * table over every page, fed by the same `['graph']` query the canvas uses (no new
 * endpoint). The graph stays the spatial view; this is the retrieval view: find by type,
 * domain, recency - and surface health problems (orphans, stubs) as filters instead of
 * leaving them to a lucky node click.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { navigate, pageRoute } from '../lib/router.ts'
import { openableRow } from '../lib/tableRow.ts'
import { timeAgo } from '../lib/format.ts'
import { obsidianUri } from '../lib/obsidian.ts'
import { domainColor, STUB_BYTES } from '../lib/domains.ts'
import { sourceLink } from '../lib/sources.ts'
import { Icon } from '../components/Icon.tsx'
import { queryState } from '../components/QueryState.tsx'
import type { GraphNode, SourceRef } from '../api/types.ts'

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

type SortKey = 'changed' | 'title' | 'backlinks' | 'domain'
/**
 * The four subsets of the page index, as ONE choice. System used to be a separate
 * toggle sitting apart from the three it belongs with - but it is a subset like the
 * others, not a second axis, so the other three now never show system pages.
 */
type Subset = 'all' | 'orphans' | 'stubs' | 'system'

const SUBSETS: Array<{ key: Subset; label: string; desc: string }> = [
  { key: 'all', label: 'All pages', desc: 'every page except the system ones' },
  { key: 'orphans', label: 'Orphans', desc: 'nothing links to these' },
  { key: 'stubs', label: 'Stubs', desc: 'thin pages, under 1 KB' },
  { key: 'system', label: 'System', desc: 'index hubs, MOCs, reports' },
]
const SORTS: Array<{ key: SortKey; label: string; desc: string }> = [
  { key: 'changed', label: 'Changed', desc: 'most recently edited first' },
  { key: 'title', label: 'Title', desc: 'alphabetical, A to Z' },
  { key: 'backlinks', label: 'Backlinks', desc: 'most linked pages first' },
  { key: 'domain', label: 'Domain', desc: 'grouped by domain, unfiled pages last' },
]

const PAGE_SIZE = 50

function isOrphan(n: GraphNode): boolean {
  return n.in === 0 && n.out === 0 && (n.kind ?? 'knowledge') === 'knowledge'
}
function isStub(n: GraphNode): boolean {
  return (n.size ?? Infinity) < STUB_BYTES && (n.kind ?? 'knowledge') === 'knowledge'
}

export function Library({ vaultName }: { vaultName: string }): React.ReactElement {
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  // Provenance rides its OWN query, not the graph payload: the canvas, Home and the Library
  // all fetch ['graph'], and only one of them has a Source column. A failure here costs the
  // column, never the table.
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources })

  const [query, setQuery] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [domain, setDomain] = useState<string | null | 'none'>(null)
  const [subset, setSubset] = useState<Subset>('all')
  const [sort, setSort] = useState<SortKey>('changed')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [domFilter, setDomFilter] = useState('')
  /** Hover previews an option's meaning; leaving falls back to the one in force. */
  const [subsetHover, setSubsetHover] = useState<Subset | null>(null)
  const [sortHover, setSortHover] = useState<SortKey | null>(null)

  const nodes = graph.data?.nodes

  // System pages (index hubs, reports) are scaffolding - hidden unless asked for, same
  // default the graph uses.
  const knowledge = useMemo(
    () => (nodes ?? []).filter((n) => (subset === 'system' ? (n.kind ?? 'knowledge') !== 'knowledge' : (n.kind ?? 'knowledge') === 'knowledge')),
    [nodes, subset],
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
      if (subset === 'orphans' && !isOrphan(n)) return false
      if (subset === 'stubs' && !isStub(n)) return false
      if (terms.length > 0) {
        // `names` carries the page's own title and aliases where they differ from the file
        // name - the same reason the graph search reads them.
        const hay = `${n.title} ${(n.names ?? []).join(' ')} ${n.tags.join(' ')} ${n.domain ?? ''}`.toLowerCase()
        if (!terms.every((t) => hay.includes(t))) return false
      }
      return true
    })
    list = [...list]
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title))
    else if (sort === 'backlinks') list.sort((a, b) => b.in - a.in || a.title.localeCompare(b.title))
    else if (sort === 'domain') {
      // Unfiled pages last rather than first: an empty string would sort to the top and
      // bury the domains the sort exists to group.
      list.sort(
        (a, b) =>
          (a.domain ?? '\uffff').localeCompare(b.domain ?? '\uffff') || a.title.localeCompare(b.title),
      )
    } else list.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    return list
  }, [knowledge, query, type, domain, subset, sort])

  const shown = filtered.slice(0, limit)
  const more = filtered.length > limit

  // Load the next page when the end of the list comes into view. Sorting by domain made the
  // page cap read as a bug: the first 50 rows are all one domain, so the list looked like it
  // only held that domain - the rest was one "Show more" away, which is not where a reader
  // looks. The button stays for keyboards and for anyone who wants it explicitly.
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (el === null || !more) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE_SIZE)
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [more, shown.length])

  const state = queryState(graph, 'the page index')
  // Deliberately NOT an early return any more: the panel and the table box stay on screen
  // while the index loads or fails, so a retry does not make the whole workspace jump.
  // Only the table's own area changes.

  const domainRows = [
    ...domainCounts.domains.map(([d, c]) => [d, c] as [string, number]),
    ...(domainCounts.none > 0 ? [['', domainCounts.none] as [string, number]] : []),
  ]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .filter(([d]) => {
      const f = domFilter.trim().toLowerCase()
      return f === '' || (d === '' ? 'no domain' : d).toLowerCase().includes(f)
    })
  /** Whether anything is narrowing the list - the reset only appears when it would do something. */
  const dirty = query !== '' || type !== null || domain !== null || subset !== 'all' || sort !== 'changed'
  const subsetHint = SUBSETS.find((x) => x.key === (subsetHover ?? subset))!.desc
  const sortHint = SORTS.find((x) => x.key === (sortHover ?? sort))!.desc
  const reset = (): void => {
    setQuery('')
    setType(null)
    setDomain(null)
    setSubset('all')
    setSort('changed')
    setDomFilter('')
    setLimit(PAGE_SIZE)
  }

  return (
    <div className="workspace">
      {/* The same standing panel as the graph, and the ONLY chrome this screen has
          (2026-08-26): the bar that used to sit above both columns held a search box and a
          sentence restating what the panel and the table foot already say, so the screen
          started one row lower than the graph and switching between them jumped. The
          search moved in here, at the top, above what it narrows.

          Order follows how the list is read: find it, then say what kind of page it is,
          which subset and in what order - and domains last, because that is the section
          that grows with the vault and it takes the leftover height. */}
      <aside className="gpanel" aria-label="Library filters">
        {/* Same place as Home: the reset belongs to the head of the panel's first section. */}
        <div className="gp-sec gp-find">
          <div className="gp-head">
            <span className="gp-eyebrow">Find</span>
            <span className="spacer" />
            {dirty && (
              <button className="btn ghost" onClick={reset} title="Back to every page, newest first">
                Reset
              </button>
            )}
          </div>
          <div className="gp-search">
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
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Page types</span>
            <span className="spacer" />
            <span className="gp-state">{type === null ? 'all' : bucketLabel(type)}</span>
          </div>
          <div className="typechips">
            {/* "All" is a chip like the others rather than the absence of a choice - the
                selected state was invisible while every type chip sat unselected. */}
            <button
              className={`chip${type === null ? ' active' : ''}`}
              aria-pressed={type === null}
              onClick={() => setType(null)}
            >
              All <span className="chip-n">{knowledge.length}</span>
            </button>
            {typeCounts.map(([t, count]) => {
              const active = type === t
              return (
                <button
                  key={t}
                  className={`chip${active ? ' active' : ''}${type !== null && !active ? ' dimmed' : ''}`}
                  aria-pressed={active}
                  onClick={() => setType(active ? null : t)}
                >
                  {bucketLabel(t)} <span className="chip-n">{count}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Show</span>
          </div>
          <div className="pillrow" role="radiogroup" aria-label="Subset">
            {SUBSETS.map((x) => (
              <button
                key={x.key}
                className="viewpill"
                role="radio"
                aria-checked={subset === x.key}
                onClick={() => {
                  setSubset(x.key)
                  setLimit(PAGE_SIZE)
                }}
                onMouseEnter={() => setSubsetHover(x.key)}
                onMouseLeave={() => setSubsetHover(null)}
                onFocus={() => setSubsetHover(x.key)}
                onBlur={() => setSubsetHover(null)}
              >
                {x.label}
              </button>
            ))}
          </div>
          <div className="pillhint">{subsetHint}</div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Sort by</span>
          </div>
          <div className="pillrow" role="radiogroup" aria-label="Sort by">
            {SORTS.map((x) => (
              <button
                key={x.key}
                className="viewpill"
                role="radio"
                aria-checked={sort === x.key}
                onClick={() => setSort(x.key)}
                onMouseEnter={() => setSortHover(x.key)}
                onMouseLeave={() => setSortHover(null)}
                onFocus={() => setSortHover(x.key)}
                onBlur={() => setSortHover(null)}
              >
                {x.label}
              </button>
            ))}
          </div>
          <div className="pillhint">{sortHint}</div>
        </div>

        <div className="gp-sec grow">
          <div className="gp-head">
            <span className="gp-eyebrow">Domains</span>
            <span className="spacer" />
            {domain !== null ? (
              <button className="btn ghost" onClick={() => setDomain(null)} title="Show all domains">
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
              const key = d === '' ? 'none' : d
              const active = domain === key
              return (
                <button
                  key={key}
                  className={`domrow${active ? ' active' : ''}${domain !== null && !active ? ' dimmed' : ''}`}
                  aria-pressed={active}
                  onClick={() => setDomain(active ? null : key)}
                >
                  <span className="dot" style={{ background: d === '' ? 'var(--muted)' : domainColor(d) }} aria-hidden />
                  <span className="nm">{d === '' ? 'no domain' : d}</span>
                  <span className="n">{count}</span>
                </button>
              )
            })}
            {domainRows.length === 0 && <div className="gp-none">No domain matches that.</div>}
          </div>
        </div>
      </aside>

      <div className="box">
        {/* The scroll box is a DIV, not the table: a table set to `display: block` (the old
            way of making it scroll) shrinks to its content, so the columns moved every time
            a domain filter changed the longest title on screen. */}
        <div className="box-body">
        {state !== null ? (
          <div className="library-empty">{state}</div>
        ) : shown.length === 0 ? (
          <div className="library-empty">
            <div className="empty">Nothing matches the current filters.</div>
          </div>
        ) : (
          <table className="dtable lib-table">
            <thead>
              <tr>
                <th>Page</th>
                <th>Domain</th>
                <th className="num">In / out</th>
                <th>Changed</th>
                <th>Source</th>
                <th aria-hidden />
              </tr>
            </thead>
            <tbody>
              {shown.map((n) => (
                <tr key={n.path} {...openableRow(() => navigate(pageRoute(n.path)), `Open ${n.title}`)}>
                  <td className="lt-title" title={n.title}>
                    {/* The flex row is a span inside the cell: a `td` set to `display: flex`
                        leaves the table layout, and its baseline then drifts against the
                        cells beside it, a little further with every row. */}
                    <span className="lt-cell">
                      {/* The chip sits in a fixed slot, not just next to the title: its width
                          follows the label ("Meta" 48px, "Comparisons" 97px), which started
                          every title at a different x - five distinct ones down one screen. */}
                      <span className="lt-kind">
                        <span className="badge type">{bucketLabel(n.type)}</span>
                      </span>
                      <strong className="lt-name">{n.title}</strong>
                      {isOrphan(n) && <span className="lt-flag err">orphan</span>}
                      {isStub(n) && <span className="lt-flag warn">stub</span>}
                    </span>
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
                  {/* The document this page came from. The click must not also open the
                      page - the whole row is a link to it. */}
                  <td className="lt-source" onClick={(e) => e.stopPropagation()}>
                    <SourceCell node={n} refs={sources.data?.pages} />
                  </td>
                  {/* Zero-width cell: the buttons float out of it on hover instead of
                      reserving 78px in every row for something that is invisible most of
                      the time. They land over "Changed", never over Source - covering the
                      link the column exists for would be a poor trade. */}
                  <td className="lt-acts" onClick={(e) => e.stopPropagation()}>
                    <span className="lt-actgroup">
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
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Watched by the observer above; 200px of root margin means the next page is in
            place before the reader reaches the bottom. */}
        <div ref={sentinel} className="lib-sentinel" aria-hidden />
        </div>
        <div className="box-foot" hidden={state !== null}>
          <span>
            Showing {shown.length} of {filtered.length} pages
            {filtered.length !== knowledge.length ? ` (${knowledge.length} in this subset)` : ''}
          </span>
          <span className="spacer" />
          {more && (
            <button className="btn" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
              Show more
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * One row's provenance: the type of the document the page came from, as an inline link to
 * the document itself. Pages with nothing behind them - written by hand, or filed by a
 * research run that never ingested a file - show a dash rather than a guess.
 */
function SourceCell({
  node,
  refs,
}: {
  node: GraphNode
  refs: Record<string, SourceRef> | undefined
}): React.ReactElement {
  // Still loading: nothing at all, not a dash. A dash is a statement ("no source"), and
  // making it before the index arrives would be a lie that flickers.
  if (refs === undefined) return <span className="src-none" />
  const link = sourceLink(refs[node.path])
  if (link === null) return <span className="src-none">-</span>
  return (
    <a
      className="src-link"
      href={link.href}
      title={link.title}
      target="_blank"
      rel={link.external ? 'noreferrer noopener' : undefined}
    >
      <Icon name={link.icon} />
      {link.label}
    </a>
  )
}
