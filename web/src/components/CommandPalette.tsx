/**
 * Ctrl+K command palette — the one search that works everywhere (redesign 2026-08).
 * Pages come from the shared `['graph']` query (already cached for the graph/library),
 * actions are navigation plus a research handoff for the typed text. Deliberately no
 * agent-run triggers in here: anything that costs money keeps its consent surface.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { navigate, pageRoute } from '../lib/router.ts'
import { Icon, type IconName } from './Icon.tsx'
import { pageBucket } from '../lib/obsidian.ts'

interface PaletteAction {
  id: string
  label: string
  hint?: string
  icon: IconName
  run: () => void
}

const NAV_ACTIONS: PaletteAction[] = [
  { id: 'home', label: 'Go to Home', icon: 'home', run: () => navigate('/') },
  { id: 'library', label: 'Go to Library', icon: 'book', run: () => navigate('/library') },
  { id: 'graph', label: 'Go to Graph', icon: 'graph', run: () => navigate('/graph') },
  { id: 'research', label: 'Go to Research', icon: 'flask', run: () => navigate('/research') },
  { id: 'inbox', label: 'Go to Inbox', icon: 'inbox', run: () => navigate('/inbox') },
  { id: 'health', label: 'Go to Health', icon: 'health', run: () => navigate('/health') },
  { id: 'settings', label: 'Go to Settings', icon: 'gear', run: () => navigate('/settings') },
]

const PAGE_LIMIT = 9

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement | null {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Fetch lazily: the first open warms the cache, afterwards it is the shared graph query.
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph, enabled: open })

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      // Focus after the dialog renders.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const q = query.trim().toLowerCase()
  const terms = q === '' ? [] : q.split(/\s+/)

  const pageHits = useMemo(() => {
    const nodes = graph.data?.nodes ?? []
    if (terms.length === 0) {
      // Empty query: the most recently changed knowledge pages, as a jump list.
      return nodes
        .filter((n) => (n.kind ?? 'knowledge') === 'knowledge')
        .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
        .slice(0, 5)
    }
    const scored = nodes
      .filter((n) => {
        const hay = `${n.title} ${n.tags.join(' ')} ${n.domain ?? ''}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
      // Title matches beat tag-only matches; then by backlinks (authority).
      .sort((a, b) => {
        const at = a.title.toLowerCase().includes(terms[0]!) ? 1 : 0
        const bt = b.title.toLowerCase().includes(terms[0]!) ? 1 : 0
        return bt - at || b.in - a.in
      })
    return scored.slice(0, PAGE_LIMIT)
  }, [graph.data, q])

  const actionHits = useMemo(() => {
    if (terms.length === 0) return NAV_ACTIONS
    return NAV_ACTIONS.filter((a) => terms.every((t) => a.label.toLowerCase().includes(t)))
  }, [q])

  // The research handoff: whatever was typed becomes a clean topic (no instruction prose,
  // so lens title suffixes stay intact).
  const researchAction: PaletteAction | null =
    q.length >= 3
      ? {
          id: 'research-topic',
          label: `Research "${query.trim()}" on the web`,
          hint: 'writes vault pages',
          icon: 'flask',
          run: () => navigate(`/research?prefill=${encodeURIComponent(query.trim())}`),
        }
      : null

  const rows: Array<{ kind: 'page' | 'action'; key: string; label: string; hint?: string | undefined; icon: IconName; run: () => void }> =
    [
      ...pageHits.map((n) => ({
        kind: 'page' as const,
        key: `p:${n.path}`,
        label: n.title,
        hint: `${pageBucket(n.path)}${n.domain !== null ? ` · ${n.domain}` : ''}`,
        icon: 'file' as IconName,
        run: () => navigate(pageRoute(n.path)),
      })),
      ...actionHits.map((a) => ({ kind: 'action' as const, key: `a:${a.id}`, label: a.label, hint: a.hint, icon: a.icon, run: a.run })),
      ...(researchAction !== null
        ? [{ kind: 'action' as const, key: researchAction.id, label: researchAction.label, hint: researchAction.hint, icon: researchAction.icon, run: researchAction.run }]
        : []),
    ]

  const clampedSelected = Math.min(selected, Math.max(0, rows.length - 1))

  useEffect(() => {
    // Keep the selected row in view while arrowing through a long list.
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelected, q])

  if (!open) return null

  const pick = (row: (typeof rows)[number]): void => {
    onClose()
    row.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[clampedSelected]
      if (row) pick(row)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let lastKind: string | null = null

  return (
    <div className="veil" onPointerDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Search and commands"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="pal-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            placeholder="Search pages, jump anywhere…"
            aria-label="Search pages and commands"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={listRef}>
          {graph.isLoading && <div className="pal-note">Loading the page index…</div>}
          {rows.map((row, i) => {
            const header = row.kind !== lastKind ? (row.kind === 'page' ? 'Pages' : 'Actions') : null
            lastKind = row.kind
            return (
              <div key={row.key}>
                {header !== null && <div className="pal-group">{header}</div>}
                <button
                  className={`pal-item${i === clampedSelected ? ' sel' : ''}`}
                  data-selected={i === clampedSelected}
                  onPointerEnter={() => setSelected(i)}
                  onClick={() => pick(row)}
                >
                  <Icon name={row.icon} />
                  <span className="pal-label">{row.label}</span>
                  {row.hint !== undefined && <span className="pal-hint">{row.hint}</span>}
                </button>
              </div>
            )
          })}
          {!graph.isLoading && rows.length === 0 && <div className="pal-note">No page or action matches "{query}".</div>}
        </div>
      </div>
    </div>
  )
}
