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
import { timeAgo, tokens, usd } from '../lib/format.ts'
import { Cost, ESTIMATE_LABEL, isEstimate } from '../components/Cost.tsx'

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
      <BudgetBar stats={data} />

      <div className="grid two section">
        <div className="card card-pad">
          <h3 className="section-title">Pages by type</h3>
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
          <h3 className="section-title">Growth (30 days)</h3>
          <GrowthChart points={data.growth} />
        </div>
      </div>

      <div className="grid two section">
        <div className="card card-pad">
          <h3 className="section-title">Recently changed</h3>
          {data.recentPages.length === 0 ? (
            <div className="empty">
              No pages yet. <button className="btn ghost" onClick={onGoto}>Ingest your first file →</button>
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
          <h3 className="section-title">Recent commits</h3>
          <div className="rows">
            {data.commits.length === 0 ? (
              <div className="empty">No commits.</div>
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
        <div className="card card-pad section hot-cache">
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
        <div className="label">Total pages</div>
        <div className="value">{stats.pages.total}</div>
      </div>
      <div className="stat card">
        <div className="label">Ingests (7 d)</div>
        <div className="value ok">{stats.kpis7d.ingests}</div>
      </div>
      <div className="stat card">
        <div className="label">Failures (7 d)</div>
        <div className={`value${stats.kpis7d.failures > 0 ? ' err' : ''}`}>{stats.kpis7d.failures}</div>
      </div>
      <div className="stat card">
        <div className="label">Queue</div>
        <div className={`value${queueLen > 0 ? ' busy' : ''}`}>{queueLen}</div>
        <div className="sub">{stats.queue.active} active · {stats.queue.queued} waiting</div>
      </div>
      <div className="stat card">
        <div className="label">Cost (7 d)</div>
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
 * Today's usage against the configured daily budget (SPEC.md §7.1, §11.3). Hidden entirely when
 * no budget is set — an unlimited budget has nothing meaningful to show as progress.
 */
function BudgetBar({ stats }: { stats: Stats }): React.ReactElement | null {
  const { budget, authMode } = stats
  if (budget.limit === null) return null

  const pct = Math.min(100, Math.round((budget.spent / budget.limit) * 100))
  const fmt = (n: number): string => (budget.unit === 'usd' ? usd(n) : String(n))
  const resets = new Date(budget.resetsAt)

  return (
    <div className="card card-pad section">
      <div className="section-head">
        <h3 className="section-title">Daily budget</h3>
        <span className={`setting-tag${budget.exceeded ? ' warn' : ''}`}>
          {budget.exceeded ? 'reached — queue paused' : `${pct} %`}
        </span>
      </div>
      <div className="budget-bar">
        <div className={`budget-fill${budget.exceeded ? ' over' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="job-meta" style={{ fontSize: 13, marginTop: 8 }}>
        <span>
          {fmt(budget.spent)} of {fmt(budget.limit)} {budget.unit === 'jobs' ? 'ingests' : ''} today
        </span>
        <span>
          Resets at {resets.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
        </span>
        {budget.unit === 'usd' && isEstimate(authMode) && <span>{ESTIMATE_LABEL}</span>}
      </div>
    </div>
  )
}

function ServiceStatus({ stats }: { stats: Stats }): React.ReactElement {
  const last = stats.commits[0]
  return (
    <div className="card card-pad section">
      <h3 className="section-title">Service status</h3>
      <div className="job-meta" style={{ fontSize: 13 }}>
        <span>
          Watcher{' '}
          <strong style={{ color: stats.watcher.active ? 'var(--ok)' : 'var(--muted)' }}>
            {stats.watcher.active ? 'active' : 'inactive'}
          </strong>
        </span>
        <span title={stats.watcher.folder}>Folder: <code>{stats.watcher.folder}</code></span>
        <span>
          Queue: {stats.queue.queued + stats.queue.active}
          {stats.queue.paused && (
            <>
              {' '}
              <strong style={{ color: 'var(--warn)' }}>
                {stats.queue.pauseReason === 'budget'
                  ? '(paused — daily budget)'
                  : stats.queue.pauseReason === 'rate-limit'
                    ? '(paused — usage limit)'
                    : '(paused)'}
              </strong>
            </>
          )}
        </span>
        {last && <span>Last commit {timeAgo(last.date)}</span>}
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
