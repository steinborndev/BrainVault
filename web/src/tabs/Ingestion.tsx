/**
 * Inbox (SPEC.md §6.2, redesign 2026-08-25) - the RECORD of everything that entered the
 * vault, as one workspace rather than a stack of sections.
 *
 * What changed and why:
 *
 *  - ONE TABLE. Active, Queue and History used to be three lists of the same thing, stacked;
 *    the history table began about 600px down the page and a job visibly jumped between
 *    sections as it settled. In-flight rows now ride at the TOP of the same table, tinted,
 *    with their phase inline - a job moves down into history instead of teleporting.
 *
 *  - THE PANEL IS THE FILTER. State (with all-time counts), channel and time range stand in
 *    the same left panel the Graph and Library screens use, so a filter learned on one screen
 *    behaves the same here. The wrapping chip row is gone, and the queue's state and the
 *    reason it is paused sit next to the work they explain instead of on another screen.
 *
 *  - NO SECOND INTAKE. Home owns intake; repeating a drop hero here cost ~190px on a screen
 *    whose job is the record. "Add" goes to the composer that already exists.
 *
 *  - MAINTENANCE RUNS ARE VISIBLE. A research or lint run writes the vault exactly like an
 *    ingest does. They appear among the in-flight rows, in the lens colour, so this screen
 *    answers "what is the service doing" rather than "what is the ingest queue doing".
 *
 * Counts stay honest: the panel uses the all-time per-status totals from `/stats`
 * (`stats.jobs`), while the table shows the stored window (limit-capped) - the footer says
 * both. Clearing deletes by status across the whole store and says exactly that. Depth
 * (commit, hashes, exact times, full log, retry, revert) lives in the job drawer.
 *
 * All of it comes from one `['jobs']` query that the SSE `job` events invalidate live, so a
 * job visibly moves in-flight → history on completion with no refresh (DoD).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AuthMode, Job, JobStatus, MaintenanceRun } from '../api/types.ts'
import { JobDrawer } from '../components/JobDrawer.tsx'
import { Icon } from '../components/Icon.tsx'
import { Cost } from '../components/Cost.tsx'
import { useActiveRuns } from '../hooks/useActiveRuns.ts'
import { useRunProgressLine } from '../components/RunProgress.tsx'
import { RUN_RUNNING_TITLES } from '../lib/runLabels.ts'
import { navigate } from '../lib/router.ts'
import { timeAgo, duration, parsePages } from '../lib/format.ts'

const ACTIVE: JobStatus[] = ['preprocessing', 'ingesting']
/** Statuses a job rests in - what "clear history" is allowed to delete. */
const AT_REST: JobStatus[] = ['done', 'failed', 'deferred', 'duplicate', 'cancelled']

/** The state filter, in pipeline order: what is happening, then how it ended. */
const STATE_FILTERS: Array<{ id: JobStatus; label: string }> = [
  { id: 'ingesting', label: 'Running' },
  { id: 'queued', label: 'Queued' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
  { id: 'deferred', label: 'Deferred' },
  { id: 'duplicate', label: 'Duplicates' },
  { id: 'cancelled', label: 'Cancelled' },
]

const STATE_DOT: Record<string, string> = {
  ingesting: 'running',
  queued: 'queued',
  done: 'done',
  failed: 'failed',
  deferred: 'deferred',
  duplicate: 'duplicate',
  cancelled: 'cancelled',
}

type Range = 'today' | '7d' | '30d' | 'all'
const RANGES: Array<{ id: Range; label: string; days: number | null }> = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: 'all', label: 'All', days: null },
]

/** The server caps GET /jobs at 500; start smaller, one "Load older" step to the cap. */
const WINDOW_STEP = 300
const WINDOW_MAX = 500

const DAY_MS = 24 * 60 * 60 * 1000

export function Ingestion({ statusFilter = '' }: { statusFilter?: string }): React.ReactElement {
  const qc = useQueryClient()
  const [state, setState] = useState<JobStatus | null>(null)
  const [channel, setChannel] = useState<string | null>(null)
  const [range, setRange] = useState<Range>('30d')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(WINDOW_STEP)
  const [drawerJob, setDrawerJob] = useState<string | null>(null)

  // `?filter=` from elsewhere (the Home failures tile) pre-applies a status filter - the
  // screen stays mounted, so this must react to navigation, not just the first mount.
  useEffect(() => {
    if (statusFilter === '') return
    if (STATE_FILTERS.some((f) => f.id === statusFilter)) {
      setState(statusFilter as JobStatus)
      // A pre-applied status is meant to SHOW something; a narrow window could hide it all.
      setRange('all')
    }
  }, [statusFilter])

  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  // Until stats load, assume the subscription default - marking a real cost as an estimate is
  // a harmless caption, whereas showing an estimate as a real charge would be misleading.
  const authMode = stats.data?.authMode ?? 'oauth'
  const totals = stats.data?.jobs ?? {}
  const queue = stats.data?.queue

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['jobs', limit],
    queryFn: () => api.jobs({ limit }),
  })
  const runs = useActiveRuns()

  const { live, history } = useMemo(() => {
    const jobs = data?.jobs ?? []
    return {
      live: jobs.filter((j) => ACTIVE.includes(j.status) || j.status === 'queued'),
      history: jobs.filter((j) => !ACTIVE.includes(j.status) && j.status !== 'queued'),
    }
  }, [data])

  // Files from ONE drop stay a unit: the old screen grouped them in a card with a
  // cancel-all button, and a table row per file would otherwise make cancelling a 10-file
  // drop ten clicks. A batch of one is just a row.
  const batches = useMemo(() => {
    const m = new Map<string, Job[]>()
    for (const j of data?.jobs ?? []) {
      if (j.status !== 'queued' || j.batch_id === null) continue
      m.set(j.batch_id, [...(m.get(j.batch_id) ?? []), j])
    }
    return new Map([...m].filter(([, jobs]) => jobs.length > 1))
  }, [data])

  const channelCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const j of data?.jobs ?? []) m.set(j.source, (m.get(j.source) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [data])

  const cutoff = RANGES.find((r) => r.id === range)?.days ?? null
  const q = search.trim().toLowerCase()
  const matches = (j: Job): boolean => {
    if (channel !== null && j.source !== channel) return false
    if (q !== '' && !(j.original_name ?? j.url ?? j.id).toLowerCase().includes(q)) return false
    return true
  }

  // In-flight rows ignore the time range - something running right now is never "older than
  // 30 days", and hiding it because of a date filter would be a lie about the current state.
  const shownLive = live.filter((j) => {
    if (!matches(j)) return false
    if (state === null) return true
    return state === 'ingesting' ? ACTIVE.includes(j.status) : j.status === state
  })
  const shownRuns =
    channel !== null || q !== '' || (state !== null && state !== 'ingesting')
      ? []
      : runs.running

  const shownHistory = history.filter((j) => {
    if (!matches(j)) return false
    if (state !== null && j.status !== state) return false
    if (cutoff !== null) {
      const when = j.finished_at ?? j.started_at ?? j.created_at
      if (Date.now() - Date.parse(when) > cutoff * DAY_MS) return false
    }
    return true
  })

  // The number the clear action actually deletes: the all-time DB count for the filter -
  // NOT the searched/visible slice (an old bug promised the filtered count but deleted more).
  const clearable = state !== null && AT_REST.includes(state) ? state : null
  const clearCount =
    state === null
      ? AT_REST.reduce((sum, st) => sum + (totals[st] ?? 0), 0)
      : (totals[state] ?? 0)

  const clear = useMutation({
    mutationFn: () => api.clearHistory(clearable ?? undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  // Two-step confirm on the button itself (no `window.confirm` - blocked/ugly in installed
  // PWAs). First click arms it for 4 s - red fill, visible countdown - second click clears.
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

  const reset = (): void => {
    setState(null)
    setChannel(null)
    setRange('30d')
    setSearch('')
  }

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

  const stateCount = (id: JobStatus): number => {
    if (id === 'ingesting') return live.filter((j) => ACTIVE.includes(j.status)).length + runs.running.length
    if (id === 'queued') return live.filter((j) => j.status === 'queued').length
    return totals[id] ?? history.filter((j) => j.status === id).length
  }
  const allTime = AT_REST.reduce((sum, st) => sum + (totals[st] ?? 0), 0)
  const shownTotal = shownRuns.length + shownLive.length + shownHistory.length
  const filtered = state !== null || channel !== null || q !== '' || range !== '30d'

  return (
    <div className="inbox">
      <div className="ws-bar">
        <div className="hist-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Search by file name or URL…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search the inbox by file name or URL"
          />
        </div>
        <span className="scopeline">
          Showing{' '}
          <strong>
            {shownTotal} of {allTime + live.length}
          </strong>{' '}
          jobs{filtered ? ' - filtered' : ''}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => navigate('/')} title="Intake lives on Home - drop files or paste a link there">
          <Icon name="upload" /> Add
        </button>
        {clearCount > 0 && (
          <button
            className={`btn ${armedLeft !== null ? 'armed' : 'ghost danger'}`}
            disabled={clear.isPending}
            onClick={onClear}
            title={
              clearable === null
                ? 'Deletes every stored history entry (all statuses, including ones not shown). The vault and created pages stay untouched.'
                : `Deletes every stored "${clearable}" entry, including ones the search hides. The vault and created pages stay untouched.`
            }
          >
            {armedLeft !== null
              ? `Really delete ${clearCount} ${clearable === null ? 'entries' : `${clearable} entries`}? (${armedLeft})`
              : clearable === null
                ? 'Clear history'
                : `Clear ${clearable}`}
          </button>
        )}
      </div>

      <aside className="gpanel" aria-label="Inbox filters">
        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">State</span>
            <span className="spacer" />
            {filtered && (
              <button className="btn ghost" onClick={reset} title="Back to every job, last 30 days">
                Reset
              </button>
            )}
          </div>
          <div className="domlist static">
            {STATE_FILTERS.map((f) => {
              const count = stateCount(f.id)
              const active = state === f.id
              return (
                <button
                  key={f.id}
                  className={`domrow${active ? ' active' : ''}`}
                  aria-pressed={active}
                  onClick={() => setState(active ? null : f.id)}
                >
                  <span className={`hrow-dot ${STATE_DOT[f.id]}`} aria-hidden />
                  <span className="nm">{f.label}</span>
                  <span className="n">{count}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="gp-sec grow">
          <div className="gp-head">
            <span className="gp-eyebrow">Channel</span>
            <span className="spacer" />
            {channel !== null && (
              <button className="btn ghost" onClick={() => setChannel(null)}>
                <Icon name="x" /> Clear
              </button>
            )}
          </div>
          <div className="domlist">
            {channelCounts.map(([src, count]) => {
              const active = channel === src
              return (
                <button
                  key={src}
                  className={`domrow${active ? ' active' : ''}`}
                  aria-pressed={active}
                  onClick={() => setChannel(active ? null : src)}
                >
                  <span className="dot" style={{ background: channelColor(src) }} aria-hidden />
                  <span className="nm">{src}</span>
                  <span className="n">{count}</span>
                </button>
              )
            })}
            {channelCounts.length === 0 && <div className="gp-none">No jobs stored yet.</div>}
          </div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">When</span>
          </div>
          <div className="pillrow" role="radiogroup" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.id}
                className="viewpill"
                role="radio"
                aria-checked={range === r.id}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="pillhint wrap">
            Applies to finished jobs. The store keeps the newest {WINDOW_MAX}; older ones are
            counted, not listed.
          </div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Queue</span>
          </div>
          <QueueState paused={queue?.paused === true} reason={queue?.pauseReason ?? null} />
        </div>
      </aside>

      <div className="inbox-main">
        {clear.error != null && <div className="toast err">Clearing failed: {(clear.error as Error).message}</div>}
        <div className="tscroll">
          <table className="dtable inbox-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Channel</th>
                <th className="num">Pages</th>
                <th className="num">Took</th>
                <th className="num">Cost</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {shownRuns.length + shownLive.length > 0 && (
                <tr className="livehead">
                  <td colSpan={6}>In flight - {shownRuns.length + shownLive.length}</td>
                </tr>
              )}
              {shownRuns.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
              {groupRows(shownLive, batches).map((row) =>
                row.kind === 'batch' ? (
                  <BatchHead key={`batch:${row.batchId}`} jobs={row.jobs} />
                ) : (
                  <LiveRow key={row.job.id} job={row.job} onOpen={() => setDrawerJob(row.job.id)} />
                ),
              )}
              {shownHistory.map((j) => (
                <HistoryRow key={j.id} job={j} authMode={authMode} onOpen={() => setDrawerJob(j.id)} />
              ))}
              {shownTotal === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">
                      {filtered ? 'Nothing matches those filters.' : 'No jobs yet - drop something on Home.'}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="dtable-foot">
          <span>
            {shownHistory.length} of {history.length} stored
            {allTime > history.length ? ` · ${allTime} all-time` : ''}
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
          <span className="dim">Click a row for the full record: log, commit, pages, retry, revert.</span>
        </div>
      </div>

      {drawerJob !== null && (
        <JobDrawer jobId={drawerJob} vaultName={vaultName} authMode={authMode} onClose={() => setDrawerJob(null)} onOpenJob={setDrawerJob} />
      )}
    </div>
  )
}

type LiveRowItem =
  | { kind: 'batch'; batchId: string; jobs: Job[] }
  | { kind: 'job'; job: Job }

/**
 * Live rows in display order, with a batch header inserted before the first member of each
 * multi-file drop. Members keep their own rows underneath - the header is a handle for the
 * group, not a replacement for seeing what is in it.
 */
function groupRows(jobs: Job[], batches: ReadonlyMap<string, Job[]>): LiveRowItem[] {
  const emitted = new Set<string>()
  const out: LiveRowItem[] = []
  for (const job of jobs) {
    const id = job.batch_id
    if (id !== null && batches.has(id) && !emitted.has(id)) {
      emitted.add(id)
      out.push({ kind: 'batch', batchId: id, jobs: batches.get(id)! })
    }
    out.push({ kind: 'job', job })
  }
  return out
}

/** The handle for one multi-file drop: how many, how long ago, and cancel them together. */
function BatchHead({ jobs }: { jobs: Job[] }): React.ReactElement {
  const qc = useQueryClient()
  const cancelAll = useMutation({
    // No batch endpoint - cancel each member; the queue treats them independently anyway.
    mutationFn: () => Promise.all(jobs.map((j) => api.cancel(j.id))),
    // One failed member must not abort silently - refresh either way and let the rows say so.
    onSettled: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  })
  const oldest = jobs[jobs.length - 1]!
  return (
    <tr className="batchhead">
      <td colSpan={6}>
        <strong>Batch</strong> · {jobs.length} files · {timeAgo(oldest.created_at)}
        <span className="spacer" />
        <button className="btn ghost danger sm" disabled={cancelAll.isPending} onClick={() => cancelAll.mutate()}>
          <Icon name="x" /> Cancel batch
        </button>
      </td>
    </tr>
  )
}

/** Stable per-channel colour, so a row's origin reads without parsing the word. */
function channelColor(source: string): string {
  const map: Record<string, string> = {
    drop: 'var(--accent)',
    watch: 'var(--type-source)',
    telegram: 'var(--type-entity)',
    api: 'var(--type-meta)',
    url: 'var(--type-question)',
  }
  return map[source] ?? 'var(--muted)'
}

/**
 * The queue's state, next to the queue. Finding out WHY nothing is moving used to mean a
 * trip to another screen; the reason belongs where the work is listed.
 *
 * Read-only on purpose: the queue pauses itself on a spent budget or an exhausted usage
 * limit and resumes on its own, and there is no manual pause in the API. A button here
 * would either do nothing or promise a feature that does not exist.
 */
function QueueState({ paused, reason }: { paused: boolean; reason: string | null }): React.ReactElement {
  return (
    <>
      <div className="queue-row">
        <span className={`badge ${paused ? 'deferred' : 'ok'}`}>{paused ? 'paused' : 'running'}</span>
      </div>
      <div className="pillhint wrap">
        {paused
          ? reason === 'budget'
            ? 'Daily budget reached - resumes at midnight.'
            : reason === 'rate-limit'
              ? 'The Anthropic usage limit is exhausted - resumes when the window resets.'
              : 'Queued jobs wait; nothing is lost.'
          : 'Jobs start as they arrive.'}
      </div>
    </>
  )
}

/** A running maintenance run, in the same table as the ingests it runs alongside. */
function RunRow({ run }: { run: MaintenanceRun }): React.ReactElement {
  const profiles = useQuery({ queryKey: ['research-profiles'], queryFn: api.researchProfiles })
  const profile = profiles.data?.profiles.find((p) => p.key === run.profileKey)
  const { text, ratio } = useRunProgressLine(run.channel, profile)
  const isResearch = run.kind === 'research'
  return (
    <tr
      className={`live${isResearch ? ' research' : ''}`}
      onClick={() => navigate(isResearch ? '/research' : '/health')}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(isResearch ? '/research' : '/health')
      }}
      tabIndex={0}
      aria-label={`Open the ${run.kind} run`}
    >
      <td>
        <span className="hrow-name">
          <span className="hrow-dot running" aria-hidden />
          <span className="nm">{run.label ?? RUN_RUNNING_TITLES[run.kind] ?? run.kind}</span>
          {profile !== undefined && run.profileKey !== 'broad' && <span className="lens-tag">{profile.label}</span>}
        </span>
        <span className="live-phase">{text}</span>
      </td>
      <td className="dimc">{run.kind}</td>
      <td colSpan={2}>
        <span className={`minibar${isResearch ? ' research' : ''}`}>
          <i style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
      </td>
      <td className="num">-</td>
      <td className="faintc">{timeAgo(run.startedAt)}</td>
    </tr>
  )
}

/** The pipeline as three ticks - enough to see movement, not enough to need a legend. */
const PHASES: JobStatus[] = ['queued', 'preprocessing', 'ingesting']

/** A running or queued ingest, cancellable while it still waits. */
function LiveRow({ job, onOpen }: { job: Job; onOpen: () => void }): React.ReactElement {
  const qc = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => api.cancel(job.id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  })
  const phase = PHASES.indexOf(job.status)
  const name = job.original_name ?? job.url ?? job.id
  return (
    <tr
      className="live"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
      tabIndex={0}
      aria-label={`Open job detail: ${name}`}
    >
      <td>
        <span className="hrow-name">
          <span className={`hrow-dot ${job.status === 'queued' ? 'queued' : 'running'}`} aria-hidden />
          <span className="nm" title={name}>
            {name}
          </span>
          <span className="badge type">{job.type}</span>
        </span>
        <span className="live-phase">{job.status}</span>
      </td>
      <td className="dimc">{job.source}</td>
      <td colSpan={2}>
        <span className="fsteps" aria-hidden>
          {PHASES.map((p, i) => (
            <span key={p} className={`st${i < phase ? ' on' : i === phase ? ' now' : ''}`} />
          ))}
        </span>
      </td>
      <td className="num">
        {job.status === 'queued' && (
          <button
            className="btn ghost danger sm"
            disabled={cancel.isPending}
            onClick={(e) => {
              e.stopPropagation()
              cancel.mutate()
            }}
          >
            Cancel
          </button>
        )}
      </td>
      <td className="faintc">{timeAgo(job.started_at ?? job.created_at)}</td>
    </tr>
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
