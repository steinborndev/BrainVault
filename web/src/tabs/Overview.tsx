/**
 * Übersicht (SPEC.md §6.1): KPIs with week-over-week trends, a status strip for the states
 * that can go wrong (watcher, paused queue, budget), wiki growth, page-type distribution as
 * bars, recently changed pages, commits, and the hot cache (age + refresh inline). Everything
 * refreshes live — the SSE `stats`/`job` events invalidate this query (useEvents), so a
 * finished ingest updates the counts here with no manual refresh (DoD).
 */

import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { Stats } from '../api/types.ts'
import { GrowthChart } from '../components/GrowthChart.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { PageLink } from '../components/PageLink.tsx'
import { Sparkline } from '../components/Sparkline.tsx'
import { Tip } from '../components/Tip.tsx'
import { timeAgo, tokens } from '../lib/format.ts'
import { Cost, ESTIMATE_LABEL, isEstimate } from '../components/Cost.tsx'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'

const DIR_LABELS: Record<string, string> = {
  concepts: 'Concepts',
  entities: 'Entities',
  sources: 'Sources',
  references: 'References',
  comparisons: 'Comparisons',
  questions: 'Questions',
  folds: 'Folds',
  meta: 'Meta',
}

/** The last `days` days of a sparse per-day series as a dense array (UTC dates, zero-filled). */
function dense(daily: Stats['kpisDaily'], key: 'done' | 'failed', days: number): number[] {
  const map = new Map(daily.map((d) => [d.date, d[key]]))
  const out: number[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    out.push(map.get(date) ?? 0)
  }
  return out
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

export function Overview({ onGoto }: { onGoto: () => void }): React.ReactElement {
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['stats'], queryFn: api.stats })

  if (isLoading) return <LoadingSkeleton />
  if (isError || !data) {
    // refetchOnWindowFocus is off (SSE drives invalidation), so without this button a
    // transient failure would blank the dashboard until something else invalidates stats.
    return (
      <div className="empty">
        Failed to load stats: {(error as Error)?.message ?? 'unknown'}{' '}
        <button className="btn" onClick={() => void refetch()}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div>
      <Kpis stats={data} />
      <StatusStrip stats={data} />

      <div className="ov-grid section">
        <div className="card card-pad col-7">
          <h3 className="section-title">Growth (30 days)</h3>
          <GrowthChart points={data.growth} />
        </div>

        <div className="card card-pad col-5">
          <h3 className="section-title">Pages by type</h3>
          <TypeBars byDir={data.pages.byDir} />
        </div>

        <div className="card card-pad col-6">
          <h3 className="section-title">Recently changed</h3>
          {data.recentPages.length === 0 ? (
            <div className="empty">
              No pages yet. <button className="btn ghost" onClick={onGoto}>Ingest your first file →</button>
            </div>
          ) : (
            <div className="pages">
              {data.recentPages.slice(0, 10).map((p) => (
                <PageLink key={p.path} vaultName={data.vaultName} path={p.path} />
              ))}
            </div>
          )}
        </div>

        <div className="card card-pad col-6">
          <h3 className="section-title">Recent commits</h3>
          <div className="rows">
            {data.commits.length === 0 ? (
              <div className="empty">No commits.</div>
            ) : (
              data.commits.slice(0, 6).map((c) => (
                <div key={c.hash} className="row slim">
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

      {data.hotCache && <HotCache stats={data} />}
    </div>
  )
}

/** Week-over-week delta as a small colored arrow. `invert` = a rise is bad (failures). */
function Delta({ now, prev, invert = false }: { now: number; prev: number; invert?: boolean }): React.ReactElement | null {
  const d = now - prev
  if (d === 0) return null
  const up = d > 0
  const good = invert ? !up : up
  return (
    <span className={`delta ${good ? 'good' : 'bad'}`} title="vs. previous 7 days">
      {up ? '▲' : '▼'} {Math.abs(d)}
    </span>
  )
}

function Kpis({ stats }: { stats: Stats }): React.ReactElement {
  const queueLen = stats.queue.queued + stats.queue.active
  const doneDaily = dense(stats.kpisDaily, 'done', 14)
  const failedDaily = dense(stats.kpisDaily, 'failed', 14)
  const prevIngests = sum(doneDaily.slice(0, 7))
  const prevFailures = sum(failedDaily.slice(0, 7))

  // Pages delta: growth is a daily cumulative series, so "7 days ago" is the 8th-last point.
  const growth = stats.growth
  const pagesNow = growth[growth.length - 1]?.total ?? stats.pages.total
  const pagesThen = growth[growth.length - 8]?.total ?? growth[0]?.total ?? pagesNow

  return (
    <div className="grid kpis section">
      <div className="stat card">
        <div className="label">Total pages</div>
        <div className="value">
          {stats.pages.total}
          <Delta now={pagesNow} prev={pagesThen} />
        </div>
        <div className="sub">vs. last week</div>
        <Sparkline values={growth.slice(-14).map((p) => p.total)} />
      </div>
      <div className="stat card">
        <div className="label">Ingests (7 d)</div>
        <div className="value ok">
          {stats.kpis7d.ingests}
          <Delta now={stats.kpis7d.ingests} prev={prevIngests} />
        </div>
        <div className="sub">vs. previous 7 d</div>
        <Sparkline values={doneDaily.slice(7)} />
      </div>
      <div className="stat card">
        <div className="label">Failures (7 d)</div>
        <div className={`value${stats.kpis7d.failures > 0 ? ' err' : ''}`}>
          {stats.kpis7d.failures}
          <Delta now={stats.kpis7d.failures} prev={prevFailures} invert />
        </div>
        {stats.kpis7d.failures > 0 && <div className="sub">retry available in Ingestion</div>}
      </div>
      <div className="stat card">
        <div className="label">Queue</div>
        <div className={`value${queueLen > 0 ? ' busy' : ''}`}>{queueLen}</div>
        <div className="sub">{stats.queue.active} active · {stats.queue.queued} waiting</div>
      </div>
      <div className="stat card">
        <div className="label">
          Cost (7 d)
          {isEstimate(stats.authMode) && (
            <Tip text="API-price equivalent computed from token counts. On a subscription nothing is charged per run — treat this as an estimate of what the usage would cost via API." />
          )}
        </div>
        <div className="value">
          <Cost value={stats.usage.last7d.costUsd} authMode={stats.authMode} />
        </div>
        <div className="sub">
          {tokens(stats.usage.last7d.tokensIn + stats.usage.last7d.tokensOut)} tokens
          {isEstimate(stats.authMode) && <> · {ESTIMATE_LABEL}</>}
        </div>
      </div>
    </div>
  )
}

/**
 * The states that can go wrong, as pills right under the KPIs (SPEC.md §6.1) — replaces the
 * "Service status" card that hid this at the bottom, and the budget card (the popover in the
 * topbar carries the details; this strip is the at-a-glance layer).
 */
function StatusStrip({ stats }: { stats: Stats }): React.ReactElement {
  const { budget, queue, watcher } = stats
  const last = stats.commits[0]
  const pct = budget.limit !== null ? Math.min(100, Math.round((budget.spent / budget.limit) * 100)) : 0
  const pausedLabel =
    queue.pauseReason === 'budget'
      ? 'daily budget reached'
      : queue.pauseReason === 'rate-limit'
        ? 'usage limit'
        : 'paused'

  return (
    <div className="status-strip section">
      <span className={`spill${watcher.active ? '' : ' warn'}`} title={watcher.folder}>
        <span className={`d ${watcher.active ? 'ok' : 'warn'}`} />
        Watcher <strong>{watcher.active ? 'active' : 'inactive'}</strong>
      </span>
      {queue.paused && (
        <span className="spill warn">
          <span className="d warn" />
          Queue <strong>paused — {pausedLabel}</strong>
        </span>
      )}
      {budget.limit !== null && (
        <span className={`spill${budget.exceeded ? ' warn' : ''}`}>
          <span className={`d ${budget.exceeded ? 'warn' : 'ok'}`} />
          Budget <strong>{pct} %</strong> used today
          <span className="minibar" aria-hidden>
            <i className={budget.exceeded ? 'over' : ''} style={{ width: `${pct}%` }} />
          </span>
        </span>
      )}
      {last && (
        <span className="spill">
          <span className="d dim" />
          Last commit <strong>{timeAgo(last.date)}</strong>
        </span>
      )}
      <span className="spill">
        <span className="d dim" />
        Vault <strong>{stats.vaultName}</strong>
      </span>
    </div>
  )
}

/** Page counts as horizontal bars — proportions read at a glance, direct labels right. */
function TypeBars({ byDir }: { byDir: Record<string, number> }): React.ReactElement {
  const entries = Object.entries(byDir)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  const maxN = entries[0]?.[1] ?? 1
  if (entries.length === 0) return <div className="empty">No pages yet.</div>
  return (
    <div className="tbars">
      {entries.map(([dir, n]) => (
        <div key={dir} className="tbar">
          <span className="tl">{DIR_LABELS[dir] ?? dir}</span>
          <span className="track">
            <span className="fill" style={{ width: `${Math.max(2, Math.round((n / maxN) * 100))}%` }} />
          </span>
          <span className="tv">{n}</span>
        </div>
      ))}
    </div>
  )
}

/** Hot cache, collapsed — with its age and the refresh action right here in the summary. */
function HotCache({ stats }: { stats: Stats }): React.ReactElement {
  const hot = useMaintenanceRun(() => api.hotCache())
  return (
    <details className="card card-pad section hot-cache">
      <summary className="hc-summary">
        <h3 className="section-title">Hot cache</h3>
        <span className="hc-meta">
          {hot.running
            ? 'refreshing…'
            : stats.hotCacheUpdatedAt
              ? `refreshed ${timeAgo(stats.hotCacheUpdatedAt)}`
              : 'never refreshed'}
          <button
            className="btn"
            disabled={hot.running}
            onClick={(e) => {
              // The button lives inside <summary> — don't let the click also toggle the panel.
              e.preventDefault()
              e.stopPropagation()
              hot.start()
            }}
          >
            {hot.running ? 'Refreshing…' : 'Refresh'}
          </button>
        </span>
      </summary>
      {hot.error && <div className="toast err">{hot.error}</div>}
      <Markdown source={stats.hotCache ?? ''} />
    </details>
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
