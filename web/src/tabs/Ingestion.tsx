/**
 * Ingestion (SPEC.md §6.2) — the heart of M3. Compact intake card on top, then three live
 * sections:
 *  - Aktiv: jobs being preprocessed/ingested — phase stepper + elapsed time, live agent log.
 *  - Warteschlange: queued jobs, cancellable; files from one drop appear as a batch group.
 *  - Verlauf: finished jobs, searchable and filterable by status (zero-count filters hide),
 *             with created-page obsidian:// links and a retry for failed/deferred jobs.
 *
 * All three come from one `['jobs']` query that the SSE `job` events invalidate live, so a
 * job visibly moves Aktiv → Verlauf on completion with no refresh (DoD).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AuthMode, Job, JobStatus } from '../api/types.ts'
import { Dropzone } from '../components/Dropzone.tsx'
import { JobCard } from '../components/JobCard.tsx'
import { Icon } from '../components/Icon.tsx'
import { timeAgo } from '../lib/format.ts'

const ACTIVE: JobStatus[] = ['preprocessing', 'ingesting']
const HISTORY_FILTERS: Array<{ id: 'all' | JobStatus; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
  { id: 'deferred', label: 'Deferred' },
  { id: 'duplicate', label: 'Duplicates' },
  { id: 'cancelled', label: 'Cancelled' },
]

export function Ingestion(): React.ReactElement {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | JobStatus>('all')
  const [search, setSearch] = useState('')
  // The vault name for obsidian:// links comes from /stats; cheap and already cached.
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  // Until stats load, assume the subscription default — marking a real cost as an estimate is
  // a harmless caption, whereas showing an estimate as a real charge would be misleading.
  const authMode = stats.data?.authMode ?? 'oauth'

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.jobs({ limit: 300 }),
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

  const clear = useMutation({
    // Clears per the active filter: a specific status clears only that, "Alle" clears all at-rest jobs.
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
  if (isError) return <div className="empty">Failed to load jobs: {(error as Error)?.message}</div>

  const countFor = (id: JobStatus): number => history.filter((j) => j.status === id).length

  return (
    <div>
      <Dropzone />

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
          filteredHistory.length > 0 ? (
            <button
              className={`btn ${armedLeft !== null ? 'armed' : 'ghost danger'}`}
              disabled={clear.isPending}
              onClick={onClear}
              title="Only the job history is cleared — the vault and created pages stay untouched."
            >
              {armedLeft !== null
                ? `Really delete ${filteredHistory.length} entries? (${armedLeft})`
                : filter === 'all'
                  ? 'Clear history'
                  : 'Clear selection'}
            </button>
          ) : undefined
        }
      >
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
            const count = f.id === 'all' ? history.length : countFor(f.id)
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
          <div className="joblist">
            {filteredHistory.map((j) => (
              <JobCard key={j.id} job={j} variant="history" vaultName={vaultName} authMode={authMode} />
            ))}
          </div>
        )}
      </Section>
    </div>
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
