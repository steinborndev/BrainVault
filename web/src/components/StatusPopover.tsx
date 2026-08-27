/**
 * The topbar's service-status chip. The old "Live" dot only reported the SSE connection;
 * this one makes the chip the home of the whole service state - watcher, queue (incl. pause
 * reason), daily budget and vault - reachable from every tab, so warnings like "queue paused
 * (budget)" don't hide at the bottom of the Overview.
 *
 * It reads as one of the ambient status texts beside it (2026-08-26): no border, no raised
 * ground, no chevron - a bordered control among bare labels was the only thing in that row
 * claiming to be a button, and what it opens is a status panel, not a menu. The detail comes
 * on HOVER now. Click still toggles, because hover is not a gesture a keyboard or a touch
 * screen has, and Escape closes either way.
 */

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { timeAgo, usd } from '../lib/format.ts'

/**
 * How long the panel survives the pointer leaving. The chip and the panel do not touch -
 * there is a gap between them - so a strict pointerleave would close it while the pointer
 * is still travelling towards it.
 */
const CLOSE_GRACE_MS = 140

export function StatusPopover({ connected }: { connected: boolean }): React.ReactElement {
  // Two ways in, one panel: the pointer opens it while it rests here, a click pins it so it
  // survives the pointer leaving. Keyboard focus counts as hovering - same intent, no mouse.
  const [pinned, setPinned] = useState(false)
  const [hovering, setHovering] = useState(false)
  const open = pinned || hovering
  const ref = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<number | null>(null)
  // Same cached ['stats'] query the Overview uses; SSE keeps it fresh.
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: api.stats, enabled: open })

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  useEffect(() => cancelClose, [])

  useEffect(() => {
    if (!pinned) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPinned(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [pinned])

  const queue = stats?.queue
  const budget = stats?.budget
  const lastCommit = stats?.commits[0]
  const pausedLabel =
    queue?.pauseReason === 'budget'
      ? 'paused - daily budget'
      : queue?.pauseReason === 'rate-limit'
        ? 'paused - usage limit'
        : 'paused'

  return (
    <span
      className="statuswrap"
      ref={ref}
      onPointerEnter={() => {
        cancelClose()
        setHovering(true)
      }}
      onPointerLeave={() => {
        cancelClose()
        closeTimer.current = window.setTimeout(() => setHovering(false), CLOSE_GRACE_MS)
      }}
      onFocus={() => {
        cancelClose()
        setHovering(true)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovering(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setPinned(false)
          setHovering(false)
        }
      }}
    >
      <button
        type="button"
        className={`status-pill${connected ? ' live' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setPinned((v) => !v)}
      >
        <span className="dot" />
        {connected ? 'Live' : 'Offline'}
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
