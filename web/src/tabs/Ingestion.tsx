/**
 * Inbox (SPEC.md §6.2, redesign 2026-08) — intake on top (files, link/note, channels line),
 * then the live sections:
 *  - Active: jobs being preprocessed/ingested — phase stepper + elapsed time, live agent log.
 *  - Queue: queued jobs, cancellable; files from one drop appear as a batch group.
 *  - History: compact table rows — depth (commit, hashes, exact times, full log, retry,
 *    revert) lives in the job drawer, so 78 jobs no longer render as an 18,000px scroll.
 *
 * Counts are honest: the filter chips use the all-time per-status totals from /stats
 * (`stats.jobs`), while the table shows the stored window (limit-capped) — the footer says
 * both. Clearing deletes by status across the whole store and says exactly that.
 *
 * All sections come from one `['jobs']` query that the SSE `job` events invalidate live, so
 * a job visibly moves Active → History on completion with no refresh (DoD).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AuthMode, Job, JobStatus } from '../api/types.ts'
import { Dropzone } from '../components/Dropzone.tsx'
import { JobCard } from '../components/JobCard.tsx'
import { JobDrawer } from '../components/JobDrawer.tsx'
import { Icon } from '../components/Icon.tsx'
import { Cost } from '../components/Cost.tsx'
import { timeAgo, duration, parsePages } from '../lib/format.ts'

const ACTIVE: JobStatus[] = ['preprocessing', 'ingesting']
const HISTORY_FILTERS: Array<{ id: 'all' | JobStatus; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
  { id: 'deferred', label: 'Deferred' },
  { id: 'duplicate', label: 'Duplicates' },
  { id: 'cancelled', label: 'Cancelled' },
]
/** The server caps GET /jobs at 500; start smaller, one "Load older" step to the cap. */
const WINDOW_STEP = 300
const WINDOW_MAX = 500

export function Ingestion(): React.ReactElement {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | JobStatus>('all')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(WINDOW_STEP)
  const [drawerJob, setDrawerJob] = useState<string | null>(null)
  // The vault name for obsidian:// links comes from /stats; cheap and already cached.
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  // Until stats load, assume the subscription default — marking a real cost as an estimate is
  // a harmless caption, whereas showing an estimate as a real charge would be misleading.
  const authMode = stats.data?.authMode ?? 'oauth'
  // All-time per-status totals — the DB truth the chips and the clear action speak about.
  const totals = stats.data?.jobs ?? {}

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['jobs', limit],
    queryFn: () => api.jobs({ limit }),
  })

  const { active, queued, history } = useMemo(() => {
    const jobs = data?.jobs ?? []
    return {
      active: jobs.filter((j) => ACTIVE.includes(j.status)),
      queued: jobs.filter((j) => j.status === 'queued'),
      history: jobs.filter((j) => !ACTIVE.includes(j.status) && j.status !== 'queued'),
    }
  }, [data])

  const filteredHistory = useMemo(() => {
    const byStatus = filter === 'all' ? history : history.filter((j) => j.status === filter)
    const q = search.trim().toLowerCase()
    if (q === '') return byStatus
    return byStatus.filter((j) => (j.original_name ?? j.url ?? j.id).toLowerCase().includes(q))
  }, [history, filter, search])

  // The number the clear action actually deletes: the all-time DB count for the filter —
  // NOT the searched/visible slice (an old bug promised the filtered count but deleted more).
  const atRest: JobStatus[] = ['done', 'failed', 'deferred', 'duplicate', 'cancelled']
  const clearCount =
    filter === 'all'
      ? atRest.reduce((sum, s) => sum + (totals[s] ?? 0), 0)
      : (totals[filter] ?? 0)

  const clear = useMutation({
    // Clears per the active filter: a specific status clears only that, "All" clears all at-rest jobs.
    mutationFn: () => api.clearHistory(filter === 'all' ? undefined : filter),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  // Two-step confirm on the button itself (no `window.confirm` — blocked/ugly in installed
  // PWAs). First click arms it for 4 s — red fill, visible countdown — second click clears.
  const [armedLeft, setArmedLeft] = useState<number | null>(null)
  const armTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const disarm = (): void => {
    if (armTimer.current) clearInterval(armTimer.current)
    armTimer.current = null
    setArmedLeft(null)
  }
  useEffect(() => () => {
    if (armTimer.current) clearInterval(armTimer.current)
  }, [])
  const onClear = (): void => {
    if (armedLeft === null) {
      setArmedLeft(4)
      armTimer.current = setInterval(() => {
        setArmedLeft((s) => {
          if (s === null || s <= 1) {
            disarm()
            return null
          }
          return s - 1
        })
      }, 1000)
      return
    }
    disarm()
    clear.mutate()
  }

  // Queued jobs from one drop appear as a group: batches with 2+ members get a batch
  // container, everything else renders as a plain card.
  const queueGroups = useMemo(() => {
    const byBatch = new Map<string, Job[]>()
    const singles: Job[] = []
    for (const j of queued) {
      if (j.batch_id === null) {
        singles.push(j)
        continue
      }
      const list = byBatch.get(j.batch_id) ?? []
      list.push(j)
      byBatch.set(j.batch_id, list)
    }
    const groups: Array<{ batchId: string; jobs: Job[] }> = []
    for (const [batchId, jobs] of byBatch) {
      if (jobs.length > 1) groups.push({ batchId, jobs })
      else singles.push(...jobs)
    }
    return { groups, singles }
  }, [queued])

  if (isLoading) return <div className="empty">Loading jobs…</div>
  if (isError)
    return (
      <div className="empty">
        Failed to load jobs: {(error as Error)?.message}{' '}
        <button className="btn" onClick={() => void qc.invalidateQueries({ queryKey: ['jobs'] })}>
          Retry
        </button>
      </div>
    )

  const storedCount = (id: JobStatus): number => history.filter((j) => j.status === id).length
  const chipCount = (id: 'all' | JobStatus): number => {
    if (id === 'all') return atRest.reduce((sum, s) => sum + (totals[s] ?? 0), 0)
    return totals[id] ?? storedCount(id)
  }
  const queue = stats.data?.queue

  return (
    <div>
      <Dropzone />

      {/* The pause reason belongs where the queue is displayed, not on another screen. */}
      {queue?.paused === true && (
        <div className="paused-banner" role="status">
          <Icon name="clock" />
          Queue paused
          {queue.pauseReason === 'budget'
            ? ' - daily budget reached; resumes at midnight.'
            : queue.pauseReason === 'rate-limit'
              ? ' - the Anthropic usage limit is exhausted; resumes when the window resets.'
              : '.'}
        </div>
      )}

      <Section title={`Active${active.length ? ` (${active.length})` : ''}`}>
        {active.length === 0 ? (
          <div className="empty">No ingest is running right now.</div>
        ) : (
          <div className="joblist">
            {active.map((j) => (
              <JobCard key={j.id} job={j} variant="active" vaultName={vaultName} authMode={authMode} />
            ))}
          </div>
        )}
      </Section>

      {queued.length > 0 && (
        <Section title={`Queue (${queued.length})`}>
          <div className="joblist">
            {queueGroups.groups.map((g) => (
              <BatchGroup key={g.batchId} jobs={g.jobs} vaultName={vaultName} authMode={authMode} />
            ))}
            {queueGroups.singles.map((j) => (
              <JobCard key={j.id} job={j} variant="queue" vaultName={vaultName} authMode={authMode} />
            ))}
          </div>
        </Section>
      )}

      <Section
        title="History"
        action={
          clearCount > 0 ? (
            <button
              className={`btn ${armedLeft !== null ? 'armed' : 'ghost danger'}`}
              disabled={clear.isPending}
              onClick={onClear}
              title={
                filter === 'all'
                  ? 'Deletes every stored history entry (all statuses, including ones not shown). The vault and created pages stay untouched.'
                  : `Deletes every stored "${filter}" entry, including ones the search hides. The vault and created pages stay untouched.`
              }
            >
              {armedLeft !== null
                ? `Really delete ${clearCount} ${filter === 'all' ? 'entries' : `${filter} entries`}? (${armedLeft})`
                : filter === 'all'
                  ? 'Clear history'
                  : `Clear ${filter}`}
            </button>
          ) : undefined
        }
      >
        {clear.error != null && <div className="toast err">Clearing failed: {(clear.error as Error).message}</div>}
        <div className="hist-toolbar">
          <span className="hist-search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="Search history…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search the job history by file name or URL"
            />
          </span>
          {HISTORY_FILTERS.map((f) => {
            const count = chipCount(f.id)
            // Zero-count filters are noise — hide them unless currently selected.
            if (count === 0 && f.id !== 'all' && filter !== f.id) return null
            return (
              <button key={f.id} className={`chip${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
                {f.label}
                <span className="chip-n">{count}</span>
              </button>
            )
          })}
        </div>
        {filteredHistory.length === 0 ? (
          <div className="empty">
            {search.trim() !== '' ? 'Nothing in the history matches the search.' : 'No finished jobs yet.'}
          </div>
        ) : (
          <div className="card dtable-card">
            <table className="dtable">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Source</th>
                  <th className="num">Pages</th>
                  <th className="num">Took</th>
                  <th className="num">Cost</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.map((j) => (
                  <HistoryRow key={j.id} job={j} authMode={authMode} onOpen={() => setDrawerJob(j.id)} />
                ))}
              </tbody>
            </table>
            <div className="dtable-foot">
              <span>
                Showing {filteredHistory.length} of {history.length} stored
                {chipCount('all') > history.length ? ` · ${chipCount('all')} all-time` : ''}
              </span>
              <span className="spacer" />
              {history.length >= limit && limit < WINDOW_MAX && (
                <button className="btn" onClick={() => setLimit(WINDOW_MAX)}>
                  Load older
                </button>
              )}
              {history.length >= WINDOW_MAX && (
                <span className="dim">entries beyond the newest {WINDOW_MAX} are not shown</span>
              )}
            </div>
          </div>
        )}
      </Section>

      {drawerJob !== null && (
        <JobDrawer jobId={drawerJob} vaultName={vaultName} authMode={authMode} onClose={() => setDrawerJob(null)} />
      )}
    </div>
  )
}

/** One finished job as a scannable row; every detail lives in the drawer. */
function HistoryRow({
  job,
  authMode,
  onOpen,
}: {
  job: Job
  authMode: AuthMode
  onOpen: () => void
}): React.ReactElement {
  const name = job.original_name ?? job.url ?? job.id
  const pages = parsePages(job.created_pages)
  const showState = job.status !== 'done'
  return (
    <tr
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
      tabIndex={0}
      aria-label={`Open job detail: ${name}`}
    >
      <td>
        <span className="hrow-name">
          <span className={`hrow-dot ${job.status}`} aria-hidden />
          <span className="nm" title={name}>
            {name}
          </span>
          <span className="badge type">{job.type}</span>
          {showState && <span className={`hrow-state ${job.status}`}>{job.status}</span>}
          {job.reverted_at != null && <span className="hrow-state reverted">reverted</span>}
        </span>
      </td>
      <td className="dimc">{job.source}</td>
      <td className="num">{pages.length > 0 ? `+${pages.length}` : '-'}</td>
      <td className="num">{job.started_at !== null && job.finished_at !== null ? duration(job.started_at, job.finished_at) : '-'}</td>
      <td className="num">{job.cost_usd !== null ? <Cost value={job.cost_usd} authMode={authMode} /> : '-'}</td>
      <td className="faintc">{timeAgo(job.finished_at ?? job.started_at ?? job.created_at)}</td>
    </tr>
  )
}

/** Queued files from one drop as one group — visibly related, cancellable as a whole. */
function BatchGroup({
  jobs,
  vaultName,
  authMode,
}: {
  jobs: Job[]
  vaultName: string
  authMode: AuthMode
}): React.ReactElement {
  const qc = useQueryClient()
  const cancelAll = useMutation({
    // No batch endpoint — cancel each member; the queue treats them independently anyway.
    mutationFn: () => Promise.all(jobs.map((j) => api.cancel(j.id))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
    // One failed member must not abort silently — say so, and refresh what did change.
    onError: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  })
  const oldest = jobs[jobs.length - 1]!
  return (
    <div className="batch">
      <div className="batch-head">
        <strong>Batch</strong> · {jobs.length} files · {timeAgo(oldest.created_at)}
        <span className="spacer" />
        <button className="btn ghost danger" disabled={cancelAll.isPending} onClick={() => cancelAll.mutate()}>
          <Icon name="x" /> Cancel batch
        </button>
      </div>
      {cancelAll.error != null && (
        <div className="toast err">Batch cancel failed: {(cancelAll.error as Error).message}</div>
      )}
      {jobs.map((j) => (
        <JobCard key={j.id} job={j} variant="queue" vaultName={vaultName} authMode={authMode} />
      ))}
    </div>
  )
}

function Section({
  title,
  children,
  action,
}: {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="section">
      <div className="section-head">
        <h3 className="section-title">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}
