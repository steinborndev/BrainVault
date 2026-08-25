/**
 * Home (redesign 2026-08-25, second pass) - the Inbox folded in, so the two screens that
 * described the same events with two different vocabularies became one workspace of the same
 * shape as Graph and Library: controls in the left column, one content box beside it.
 *
 *   LEFT    intake (the reason to open the app at all), then the filters that shape the
 *           stream - kind, state, channel, time - and the queue's own state, which is the
 *           answer to "why is nothing moving".
 *   RIGHT   five numbers that are doors, then ONE table: in-flight rows tinted at the top,
 *           settled rows below. A job moves down the list when it commits instead of
 *           teleporting from Home's feed to the Inbox's history.
 *
 * What Home gave up: the growth chart, the pages-by-type bars, the hot-cache line and the
 * most-wanted list. Growth and page types are vault statistics and live under System → Vault
 * stats; the most-wanted list is a research backlog and lives on Research, where the button
 * next to it starts the run.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { Job, JobStatus } from '../api/types.ts'
import { Dropzone } from '../components/Dropzone.tsx'
import { JobDrawer } from '../components/JobDrawer.tsx'
import { Icon } from '../components/Icon.tsx'
import { queryState, merge } from '../components/QueryState.tsx'
import { Cost } from '../components/Cost.tsx'
import { Fact, Facts } from '../components/Fact.tsx'
import {
  BatchHead,
  CommitRow,
  HistoryJobRow,
  LiveJobRow,
  QueueState,
  RunRow,
  SettleRow,
  channelColor,
  channelLabel,
  groupRows,
} from '../components/ActivityRows.tsx'
import { useActiveRuns } from '../hooks/useActiveRuns.ts'
import { useMaintenanceStatus } from '../hooks/useMaintenanceStatus.ts'
import {
  buildActivity,
  channelCounts,
  filterActivity,
  type ActivityFilter,
  type ActivityKind,
  type ActivityState,
} from '../lib/activity.ts'
import { navigate } from '../lib/router.ts'

/** The event kinds as one choice - the same four the model distinguishes, plus "all". */
const KINDS: Array<{ id: ActivityKind | 'all'; label: string; hint: string }> = [
  { id: 'all', label: 'Everything', hint: 'Every change to the vault, whoever made it.' },
  { id: 'ingest', label: 'Ingests', hint: 'Files, links and messages that became pages.' },
  { id: 'research', label: 'Research', hint: 'Web-enabled runs you started on purpose.' },
  { id: 'maintenance', label: 'Maintenance', hint: 'What the vault does to itself: lint, cache, domains.' },
  { id: 'edit', label: 'Vault edits', hint: 'Pages you edited or deleted by hand.' },
]

/** The state filter, in pipeline order: what is happening, then how it ended. */
const STATES: Array<{ id: ActivityState; label: string }> = [
  { id: 'running', label: 'Running' },
  { id: 'queued', label: 'Queued' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
  { id: 'deferred', label: 'Deferred' },
  { id: 'duplicate', label: 'Duplicates' },
  { id: 'cancelled', label: 'Cancelled' },
]

const STATE_DOT: Record<ActivityState, string> = {
  running: 'running',
  queued: 'queued',
  done: 'done',
  failed: 'failed',
  deferred: 'deferred',
  duplicate: 'duplicate',
  cancelled: 'cancelled',
}

const RANGES: Array<{ id: string; label: string; days: number | null }> = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: 'all', label: 'All', days: null },
]

/** Statuses a job rests in - what "clear history" is allowed to delete. */
const AT_REST: JobStatus[] = ['done', 'failed', 'deferred', 'duplicate', 'cancelled']

/** The server caps GET /jobs at 500; start smaller, one "Load older" step to the cap. */
const WINDOW_STEP = 300
const WINDOW_MAX = 500

const DEFAULT_FILTER: ActivityFilter = { kind: 'all', state: null, channel: null, days: 30, query: '' }

export function Home({ statusFilter = '' }: { statusFilter?: string }): React.ReactElement {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<ActivityFilter>(DEFAULT_FILTER)
  const [limit, setLimit] = useState(WINDOW_STEP)
  const [drawerJob, setDrawerJob] = useState<string | null>(null)

  // `?filter=` from elsewhere (a failure count, a notification) pre-applies a state - the
  // screen stays mounted, so this must react to navigation, not just the first mount.
  useEffect(() => {
    if (statusFilter === '') return
    const state = STATES.find((s) => s.id === statusFilter)
    // A pre-applied state is meant to SHOW something; a narrow window could hide it all.
    if (state !== undefined) setFilter((f) => ({ ...f, state: state.id, days: null }))
  }, [statusFilter])

  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const jobsQ = useQuery({ queryKey: ['jobs', limit], queryFn: () => api.jobs({ limit }) })
  // The persistent run log (schema v12): every settled agent run, not just the newest per
  // kind - so a research run keeps its topic and its cost in the stream.
  const historyQ = useQuery({
    queryKey: ['maintenance-history', 'all'],
    queryFn: () => api.maintenanceHistory({ limit: 200 }),
  })
  const runs = useActiveRuns()
  const maint = useMaintenanceStatus()

  const vaultName = stats.data?.vaultName ?? 'vault'
  // Until stats load, assume the subscription default - marking a real cost as an estimate is
  // a harmless caption, whereas showing an estimate as a real charge would be misleading.
  const authMode = stats.data?.authMode ?? 'oauth'
  const totals = stats.data?.jobs ?? {}
  const jobs = useMemo(() => jobsQ.data?.jobs ?? [], [jobsQ.data])

  const events = useMemo(
    () =>
      buildActivity({
        jobs,
        activeRuns: runs.running,
        runHistory: historyQ.data?.runs ?? [],
        lastRuns: [...(maint.data?.lastRuns.values() ?? [])],
        commits: stats.data?.commits ?? [],
      }),
    [jobs, runs.running, historyQ.data, maint.data, stats.data],
  )

  const shown = filterActivity(events, filter, new Date())
  const live = shown.filter((e) => e.live)
  const settled = shown.filter((e) => !e.live)
  const liveJobs = live.filter((e) => e.job !== undefined).map((e) => e.job!)
  const liveRuns = live.filter((e) => e.run !== undefined).map((e) => e.run!)

  // Files from ONE drop stay a unit: a table row per file would otherwise make cancelling a
  // ten-file drop ten clicks. A batch of one is just a row.
  const batches = useMemo(() => {
    const m = new Map<string, Job[]>()
    for (const j of jobs) {
      if (j.status !== 'queued' || j.batch_id === null) continue
      m.set(j.batch_id, [...(m.get(j.batch_id) ?? []), j])
    }
    return new Map([...m].filter(([, group]) => group.length > 1))
  }, [jobs])

  const channels = useMemo(() => channelCounts(events), [events])

  /** Counts for the state list: live states from the stream, settled ones all-time from the DB. */
  const stateCount = (id: ActivityState): number => {
    if (id === 'running' || id === 'queued') return events.filter((e) => e.live && e.state === id).length
    return totals[id] ?? events.filter((e) => e.state === id).length
  }

  const filtered =
    filter.kind !== 'all' || filter.state !== null || filter.channel !== null || filter.days !== 30 || filter.query !== ''
  const reset = (): void => setFilter(DEFAULT_FILTER)

  // The number the clear action actually deletes: the all-time DB count for the filter -
  // NOT the visible slice (an old bug promised the filtered count but deleted more).
  const clearable = filter.state !== null && AT_REST.includes(filter.state as JobStatus) ? (filter.state as JobStatus) : null
  const clearCount =
    clearable === null ? AT_REST.reduce((sum, st) => sum + (totals[st] ?? 0), 0) : (totals[clearable] ?? 0)

  const clear = useMutation({
    mutationFn: () => api.clearHistory(clearable ?? undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  // Two-step confirm on the button itself (no `window.confirm` - blocked/ugly in installed
  // PWAs). First click arms it for 4 s, second click clears.
  const [armedLeft, setArmedLeft] = useState<number | null>(null)
  const armTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const disarm = (): void => {
    if (armTimer.current) clearInterval(armTimer.current)
    armTimer.current = null
    setArmedLeft(null)
  }
  useEffect(
    () => () => {
      if (armTimer.current) clearInterval(armTimer.current)
    },
    [],
  )
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

  // The stream needs both queries: the jobs are the rows, the stats are the all-time counts
  // the rows are read against. Either failing means the table cannot be trusted.
  const streamState = queryState(merge(jobsQ, stats), 'the activity stream')
  // Stats missing is not "still loading" once the query has failed - the tiles say so
  // instead of sitting on their placeholder forever.
  const statPlaceholder = stats.isError ? '-' : '…'

  const kindHint = KINDS.find((k) => k.id === filter.kind)!.hint
  const historyCount = jobs.filter((j) => AT_REST.includes(j.status)).length
  const allTime = AT_REST.reduce((sum, st) => sum + (totals[st] ?? 0), 0)

  return (
    <div className="workspace">
      <aside className="gpanel" aria-label="Home controls">
        {/* The reset lives in the head of the panel's FIRST section on every screen that has
            one - here and on Library that is the search, on Graph it is the view lens. It
            used to sit in whichever section happened to come third, so it moved between
            screens. */}
        <div className="gp-sec gp-find">
          <div className="gp-head">
            <span className="gp-eyebrow">Find</span>
            <span className="spacer" />
            {filtered && (
              <button className="btn ghost" onClick={reset} title="Back to everything, last 30 days">
                Reset
              </button>
            )}
          </div>
          <div className="gp-search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="Search this stream…"
              aria-label="Search the activity stream"
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            />
          </div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Add to vault</span>
          </div>
          <Dropzone />
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Show</span>
          </div>
          <div className="pillrow" role="radiogroup" aria-label="Event kind">
            {KINDS.map((k) => (
              <button
                key={k.id}
                className="viewpill"
                role="radio"
                aria-checked={filter.kind === k.id}
                onClick={() => setFilter({ ...filter, kind: k.id })}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="pillhint wrap">{kindHint}</div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">State</span>
            <span className="spacer" />
            <span className="gp-state">{filter.state ?? 'all'}</span>
          </div>
          <div className="domlist static">
            {STATES.map((s) => {
              const active = filter.state === s.id
              return (
                <button
                  key={s.id}
                  className={`domrow${active ? ' active' : ''}`}
                  aria-pressed={active}
                  onClick={() => setFilter({ ...filter, state: active ? null : s.id })}
                >
                  <span className={`hrow-dot ${STATE_DOT[s.id]}`} aria-hidden />
                  <span className="nm">{s.label}</span>
                  <span className="n">{stateCount(s.id)}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="gp-sec grow">
          <div className="gp-head">
            <span className="gp-eyebrow">Channel</span>
            <span className="spacer" />
            {filter.channel !== null && (
              <button className="btn ghost" onClick={() => setFilter({ ...filter, channel: null })}>
                <Icon name="x" /> Clear
              </button>
            )}
          </div>
          <div className="domlist">
            {channels.map(([src, count]) => {
              const active = filter.channel === src
              return (
                <button
                  key={src}
                  className={`domrow${active ? ' active' : ''}`}
                  aria-pressed={active}
                  onClick={() => setFilter({ ...filter, channel: active ? null : src })}
                >
                  <span className="dot" style={{ background: channelColor(src) }} aria-hidden />
                  <span className="nm">{channelLabel(src)}</span>
                  <span className="n">{count}</span>
                </button>
              )
            })}
            {channels.length === 0 && <div className="gp-none">Nothing has happened yet.</div>}
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
                aria-checked={filter.days === r.days}
                onClick={() => setFilter({ ...filter, days: r.days })}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="pillhint wrap">
            Applies to settled rows. The store keeps the newest {WINDOW_MAX}; older ones are counted, not
            listed.
          </div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Queue</span>
          </div>
          <QueueState
            paused={stats.data?.queue.paused === true}
            reason={stats.data?.queue.pauseReason ?? null}
            concurrency={stats.data?.queue.concurrency}
            active={stats.data?.queue.active ?? 0}
            queued={stats.data?.queue.queued ?? 0}
          />
        </div>
      </aside>

      <div className="box">
        <Facts size="lead">
          <Fact
            k="Pages"
            v={stats.data?.pages.total ?? statPlaceholder}
            sub="Browse the library"
            size="lead"
            onOpen={() => navigate('/library')}
          />
          <Fact
            k="In flight"
            v={events.filter((e) => e.live).length}
            sub={`${events.filter((e) => e.live && e.state === 'running').length} running, ${events.filter((e) => e.state === 'queued').length} queued`}
            size="lead"
            onOpen={() => setFilter({ ...DEFAULT_FILTER, state: 'running', days: null })}
          />
          <Fact
            k="Failures · 7d"
            v={stats.data?.kpis7d.failures ?? statPlaceholder}
            tone={(stats.data?.kpis7d.failures ?? 0) > 0 ? 'err' : undefined}
            sub={(stats.data?.kpis7d.failures ?? 0) > 0 ? 'retry from the row' : 'nothing failed this week'}
            size="lead"
            onOpen={() => setFilter({ ...DEFAULT_FILTER, state: 'failed', days: null })}
          />
          <Fact
            k="Spend today"
            v={
              stats.data !== undefined ? (
                <Cost value={stats.data.usage.today.costUsd} authMode={authMode} />
              ) : (
                statPlaceholder
              )
            }
            sub={
              stats.data?.budget.limit != null
                ? `${Math.min(100, Math.round((stats.data.budget.spent / stats.data.budget.limit) * 100))}% of the daily budget`
                : 'no daily budget set'
            }
            size="lead"
            onOpen={() => navigate('/system?section=usage')}
          />
          <Fact
            k="Checks due"
            v={maint.data?.status.due ?? statPlaceholder}
            tone={(maint.data?.status.due ?? 0) > 0 ? 'warn' : undefined}
            sub={
              maint.data === null
                ? 'checking…'
                : (maint.data?.status.recommended ?? 0) > 0
                  ? `${maint.data?.status.recommended} recommended soon`
                  : 'nothing else pending'
            }
            size="lead"
            onOpen={() => navigate('/system')}
          />
        </Facts>

        <div className="box-head">
          <h2 className="box-title">Activity</h2>
          <span className="box-sub">
            {filter.kind === 'all' ? 'everything' : KINDS.find((k) => k.id === filter.kind)!.label.toLowerCase()}
            {filter.state !== null ? `, ${filter.state}` : ''}
            {filter.channel !== null ? `, via ${channelLabel(filter.channel).toLowerCase()}` : ''}
            {filter.days === null ? ', all time' : filter.days === 1 ? ', today' : `, last ${filter.days} days`}
          </span>
          <span className="spacer" />
          {clearCount > 0 && (
            <button
              className={`btn ${armedLeft !== null ? 'armed' : 'ghost danger'}`}
              disabled={clear.isPending}
              onClick={onClear}
              title={
                clearable === null
                  ? 'Deletes every stored history entry (all statuses, including ones not shown), and with it the token and cost history those entries carry - System → Usage & cost counts from them, and so does the daily budget. The vault and created pages stay untouched.'
                  : `Deletes every stored "${clearable}" entry, including ones the filters hide, and with it the token and cost history those entries carry. The vault and created pages stay untouched.`
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

        {clear.error != null && <div className="toast err">Clearing failed: {(clear.error as Error).message}</div>}

        <div className="box-body">
          <table className="dtable inbox-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Channel</th>
                <th className="num">Pages</th>
                <th className="num">Took</th>
                <th className="num">Cost</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {live.length > 0 && (
                <tr className="livehead">
                  <td colSpan={6}>In flight - {live.length}</td>
                </tr>
              )}
              {liveRuns.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
              {groupRows(liveJobs, batches).map((row) =>
                row.kind === 'batch' ? (
                  <BatchHead key={`batch:${row.batchId}`} jobs={row.jobs} />
                ) : (
                  <LiveJobRow key={row.job.id} job={row.job} onOpen={() => setDrawerJob(row.job.id)} />
                ),
              )}
              {settled.map((e) =>
                e.job !== undefined ? (
                  <HistoryJobRow
                    key={e.id}
                    job={e.job}
                    vaultName={vaultName}
                    authMode={authMode}
                    onOpen={() => setDrawerJob(e.job!.id)}
                  />
                ) : e.kind === 'edit' ? (
                  <CommitRow key={e.id} event={e} vaultName={vaultName} />
                ) : (
                  <SettleRow key={e.id} event={e} vaultName={vaultName} authMode={authMode} />
                ),
              )}
              {shown.length === 0 && (
                <tr className="staterow">
                  <td colSpan={6}>
                    {/* A failed query must not render as an empty vault. `streamState` is
                        null once the data is there, and only then does "nothing here" mean
                        what it says. */}
                    {streamState ?? (
                      <div className="empty">
                        {filtered
                          ? 'Nothing matches these filters.'
                          : 'Nothing yet - drop a file on the left and it starts here.'}
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="box-foot">
          <span>
            {shown.length} shown · {historyCount} stored
            {allTime > historyCount ? ` · ${allTime} all-time` : ''}
          </span>
          <span className="spacer" />
          {historyCount >= limit && limit < WINDOW_MAX && (
            <button className="btn sm" onClick={() => setLimit(WINDOW_MAX)}>
              Load older
            </button>
          )}
          <span className="dim">Click a row for the full record: log, commit, pages, retry, revert.</span>
        </div>
      </div>

      {drawerJob !== null && (
        <JobDrawer
          jobId={drawerJob}
          vaultName={vaultName}
          authMode={authMode}
          onClose={() => setDrawerJob(null)}
          onOpenJob={setDrawerJob}
        />
      )}
    </div>
  )
}
