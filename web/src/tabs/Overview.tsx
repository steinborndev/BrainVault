/**
 * Übersicht (SPEC.md §6.1): page counts per type, wiki growth, recently changed pages as
 * obsidian:// deep-links, the hot cache, 7-day KPIs and live service status. Everything
 * refreshes live — the SSE `stats`/`job` events invalidate this query (useEvents), so a
 * finished ingest updates the counts here with no manual refresh (DoD).
 */

import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { Stats } from '../api/types.ts'
import { GrowthChart } from '../components/GrowthChart.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { PageLink } from '../components/PageLink.tsx'
import { timeAgo } from '../lib/format.ts'

const DIR_LABELS: Record<string, string> = {
  concepts: 'Konzepte',
  entities: 'Entities',
  sources: 'Quellen',
  references: 'Referenzen',
  comparisons: 'Vergleiche',
  questions: 'Fragen',
  folds: 'Folds',
  meta: 'Meta',
}

export function Overview({ onGoto }: { onGoto: () => void }): React.ReactElement {
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['stats'], queryFn: api.stats })

  if (isLoading) return <LoadingSkeleton />
  if (isError || !data) {
    return <div className="empty">Statistik konnte nicht geladen werden: {(error as Error)?.message ?? 'unbekannt'}</div>
  }

  return (
    <div>
      <Kpis stats={data} />

      <div className="grid two section">
        <div className="card card-pad">
          <h3 className="section-title">Seiten nach Typ</h3>
          <div className="grid kpis">
            {Object.entries(data.pages.byDir)
              .filter(([, n]) => n > 0)
              .map(([dir, n]) => (
                <div key={dir} className="stat card">
                  <div className="value">{n}</div>
                  <div className="sub">{DIR_LABELS[dir] ?? dir}</div>
                </div>
              ))}
          </div>
        </div>

        <div className="card card-pad">
          <h3 className="section-title">Wachstum (30 Tage)</h3>
          <GrowthChart points={data.growth} />
        </div>
      </div>

      <div className="grid two section">
        <div className="card card-pad">
          <h3 className="section-title">Zuletzt geändert</h3>
          {data.recentPages.length === 0 ? (
            <div className="empty">
              Noch keine Seiten. <button className="btn ghost" onClick={onGoto}>Erste Datei ingesten →</button>
            </div>
          ) : (
            <div className="pages">
              {data.recentPages.map((p) => (
                <PageLink key={p.path} vaultName={data.vaultName} path={p.path} />
              ))}
            </div>
          )}
        </div>

        <div className="card card-pad">
          <h3 className="section-title">Letzte Commits</h3>
          <div className="rows">
            {data.commits.length === 0 ? (
              <div className="empty">Keine Commits.</div>
            ) : (
              data.commits.map((c) => (
                <div key={c.hash} className="row">
                  <span className="hash">{c.hash}</span>
                  <span title={c.subject} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.subject}
                  </span>
                  <span className="when">{timeAgo(c.date)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <ServiceStatus stats={data} />

      {data.hotCache && (
        <div className="card card-pad section">
          <h3 className="section-title">Hot Cache</h3>
          <Markdown source={data.hotCache} />
        </div>
      )}
    </div>
  )
}

function Kpis({ stats }: { stats: Stats }): React.ReactElement {
  const queueLen = stats.queue.queued + stats.queue.active
  return (
    <div className="grid kpis section">
      <div className="stat card">
        <div className="label">Seiten gesamt</div>
        <div className="value">{stats.pages.total}</div>
      </div>
      <div className="stat card">
        <div className="label">Ingests (7 T.)</div>
        <div className="value ok">{stats.kpis7d.ingests}</div>
      </div>
      <div className="stat card">
        <div className="label">Fehler (7 T.)</div>
        <div className={`value${stats.kpis7d.failures > 0 ? ' err' : ''}`}>{stats.kpis7d.failures}</div>
      </div>
      <div className="stat card">
        <div className="label">Warteschlange</div>
        <div className={`value${queueLen > 0 ? ' busy' : ''}`}>{queueLen}</div>
        <div className="sub">{stats.queue.active} aktiv · {stats.queue.queued} wartend</div>
      </div>
    </div>
  )
}

function ServiceStatus({ stats }: { stats: Stats }): React.ReactElement {
  const last = stats.commits[0]
  return (
    <div className="card card-pad section">
      <h3 className="section-title">Dienststatus</h3>
      <div className="job-meta" style={{ fontSize: 13 }}>
        <span>
          Watcher{' '}
          <strong style={{ color: stats.watcher.active ? 'var(--ok)' : 'var(--muted)' }}>
            {stats.watcher.active ? 'aktiv' : 'inaktiv'}
          </strong>
        </span>
        <span title={stats.watcher.folder}>Ordner: <code>{stats.watcher.folder}</code></span>
        <span>Queue: {stats.queue.queued + stats.queue.active}{stats.queue.paused ? ' (pausiert)' : ''}</span>
        {last && <span>Letzter Commit {timeAgo(last.date)}</span>}
        <span>Vault: <code>{stats.vaultName}</code></span>
      </div>
    </div>
  )
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div className="grid kpis section">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 88 }} />
      ))}
    </div>
  )
}
