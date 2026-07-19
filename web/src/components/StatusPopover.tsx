/**
 * The topbar's service-status popover. The old "Live" dot only reported the SSE connection;
 * this one makes the pill the home of the whole service state — watcher, queue (incl. pause
 * reason), daily budget and vault — reachable from every tab, so warnings like "queue paused
 * (budget)" don't hide at the bottom of the Overview.
 */

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { timeAgo, usd } from '../lib/format.ts'

export function StatusPopover({ connected }: { connected: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  // Same cached ['stats'] query the Overview uses; SSE keeps it fresh.
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: api.stats, enabled: open })

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const queue = stats?.queue
  const budget = stats?.budget
  const lastCommit = stats?.commits[0]
  const pausedLabel =
    queue?.pauseReason === 'budget'
      ? 'paused — daily budget'
      : queue?.pauseReason === 'rate-limit'
        ? 'paused — usage limit'
        : 'paused'

  return (
    <span
      className="statuswrap"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false)
      }}
    >
      <button
        type="button"
        className={`status-pill${connected ? ' live' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dot" />
        {connected ? 'Live' : 'Offline'}
        <span className="chev" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="status-pop" role="dialog" aria-label="Service status">
          <div className="status-row">
            <span className="k">Connection</span>
            <span className={`v${connected ? ' ok' : ' warn'}`}>{connected ? 'SSE live' : 'disconnected'}</span>
          </div>
          {stats === undefined ? (
            <div className="status-row">
              <span className="k">Loading…</span>
            </div>
          ) : (
            <>
              <div className="status-row">
                <span className="k">Watcher</span>
                <span className={`v${stats.watcher.active ? ' ok' : ''}`}>
                  {stats.watcher.active ? 'active' : 'inactive'}
                </span>
              </div>
              <div className="status-row">
                <span className="k">Watch folder</span>
                <span className="v">
                  <code title={stats.watcher.folder}>{stats.watcher.folder}</code>
                </span>
              </div>
              <div className="status-row">
                <span className="k">Queue</span>
                <span className={`v${queue?.paused ? ' warn' : ''}`}>
                  {queue?.active ?? 0} active · {queue?.queued ?? 0} waiting
                  {queue?.paused ? ` (${pausedLabel})` : ''}
                </span>
              </div>
              {budget && budget.limit !== null && (
                <div className="status-row">
                  <span className="k">Daily budget</span>
                  <span className="v">
                    <span className="minibar" aria-hidden>
                      <i
                        className={budget.exceeded ? 'over' : ''}
                        style={{ width: `${Math.min(100, Math.round((budget.spent / budget.limit) * 100))}%` }}
                      />
                    </span>
                    {budget.unit === 'usd'
                      ? `${usd(budget.spent)} / ${usd(budget.limit)}`
                      : `${budget.spent} / ${budget.limit} ingests`}
                  </span>
                </div>
              )}
              <div className="status-row">
                <span className="k">Vault</span>
                <span className="v">
                  <code>{stats.vaultName}</code>
                </span>
              </div>
              {lastCommit && (
                <div className="status-row">
                  <span className="k">Last commit</span>
                  <span className="v">{timeAgo(lastCommit.date)}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </span>
  )
}
