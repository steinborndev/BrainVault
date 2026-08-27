/**
 * Home (redesign 2026-08-26, third pass) - two questions, two treatments.
 *
 *   ZONE 1  THE VAULT, the stock: one hero number, the countable facts beside it, and the
 *           wikilink graph as a picture. Large type, few words. What you own.
 *   ZONE 2  ACTIVITY, the flow: the operational figures as a strip on top of the table they
 *           belong to, then the stream itself. Dense rows, small type. What is moving.
 *
 * The eye is led by the rhythm between them - quiet-and-large above, dense-and-small below -
 * rather than by two panels of equal weight separated by a rule. The five lead tiles used to
 * mix the two: `Pages` describes the stock, the other four describe the run of the machine.
 *
 *   LEFT    the control column, in the order the work happens: intake first (the reason to
 *           open the app), then the four ways to narrow the stream. The queue used to close
 *           it as a status foot; the lead tiles already say what is in flight and why, so
 *           what it added was a second answer to a question nobody asked twice.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { Job, JobStatus } from '../api/types.ts'
import { Dropzone } from '../components/Dropzone.tsx'
import { VaultConstellation } from '../components/VaultConstellation.tsx'
import { JobDetail } from '../components/JobDetail.tsx'
import { HomePanel } from '../components/HomePanel.tsx'
import { isPanelId, newPagesIn, type PanelId } from '../lib/homePanels.ts'
import { Icon } from '../components/Icon.tsx'
import { queryState, merge } from '../components/QueryState.tsx'
import { Cost } from '../components/Cost.tsx'
import { Fact, Facts } from '../components/Fact.tsx'
import {
  BatchHead,
  CommitRow,
  HistoryJobRow,
  LiveJobRow,
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
import { knowledgeSubgraph, vaultShape } from '../lib/vaultShape.ts'
import { TYPE_VARS } from '../lib/domains.ts'

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

/** Where the second panel's choice is remembered. */
const PANEL_KEY = 'bv.home.panel'

export function Home({ statusFilter = '' }: { statusFilter?: string }): React.ReactElement {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<ActivityFilter>(DEFAULT_FILTER)
  const [limit, setLimit] = useState(WINDOW_STEP)
  /** The activity row being read, by event id. Null = the stream itself. */
  const [detailId, setDetailId] = useState<string | null>(null)
  /**
   * Which of the five second-panel views is on show. Remembered per browser: it is a
   * standing preference about this vault, not a per-visit choice, and re-picking it on every
   * load is the kind of small friction that makes a screen feel unfinished.
   */
  const [panel, setPanel] = useState<PanelId>(() => {
    try {
      const saved = localStorage.getItem(PANEL_KEY)
      return isPanelId(saved) ? saved : 'domains'
    } catch {
      return 'domains'
    }
  })
  const choosePanel = (id: PanelId): void => {
    setPanel(id)
    try {
      localStorage.setItem(PANEL_KEY, id)
    } catch {
      // A browser with storage blocked keeps the choice for this visit; nothing else breaks.
    }
  }

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
  // The vault zone reads the graph. Same query key as the Graph tab, so opening that tab
  // costs nothing extra - and the picture and its numbers come from one payload.
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: api.graph })
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

  /**
   * The row being read. Looked up against the UNFILTERED stream and by either id: a live job
   * row hands over the job's id, a settled one the event's, and a filter the reader changes
   * while a record is open must not close it out from under them.
   */
  const detailEvent =
    detailId === null ? null : (events.find((e) => e.id === detailId || e.job?.id === detailId) ?? null)

  const now = new Date()
  const shown = filterActivity(events, filter, now)
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

  /**
   * What one pill would show. The count is the number of rows you get by clicking it -
   * every OTHER axis of the filter still applies - so the panel answers "is there anything
   * there" before the click rather than after it.
   */
  const facet = (patch: Partial<ActivityFilter>): number => filterActivity(events, { ...filter, ...patch }, now).length

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

  const shape = vaultShape(graphQ.data)
  // The picture draws knowledge pages only. With the scaffolding in, `index.md` links to
  // everything there is, and one 800-edge hub pulls every domain into a single star.
  const constellation = useMemo(
    () => (graphQ.data === undefined ? null : knowledgeSubgraph(graphQ.data)),
    [graphQ.data],
  )
  // What the vault gained, by calendar day rather than by index into a sparse series
  // (lib/homePanels.ts). The hero's delta and the two growth facts under it read the SAME
  // derivation - they used to be computed twice, in two places, from the same array.
  const growth = stats.data?.growth ?? []
  const grew7 = newPagesIn(growth, 7, now.getTime())
  const grew30 = newPagesIn(growth, 30, now.getTime())
  // The legend doubles as the composition read, and it counts the DOTS - deriving it from
  // the page census instead would list kinds the picture does not draw.
  const kinds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of constellation?.nodes ?? []) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [constellation])
  const legend = kinds.slice(0, 4)
  const legendRest = kinds.slice(4).reduce((sum, [, n]) => sum + n, 0)
  const historyCount = jobs.filter((j) => AT_REST.includes(j.status)).length
  const allTime = AT_REST.reduce((sum, st) => sum + (totals[st] ?? 0), 0)

  return (
    <div className="workspace">
      <aside className="gpanel" aria-label="Home controls">
        {/* Intake first: it is the reason to open the app at all, and the two other ways in
            (watch folder, bot) state themselves right under it. Everything below it narrows
            the stream, in the order you reach for: what kind, from when, in what state, over
            which channel. The channel list is last because it is the one that grows with the
            vault - it takes the leftover height and scrolls, and nothing sits under it that
            a long list could push out of sight. */}
        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Add to vault</span>
          </div>
          <Dropzone />
        </div>

        {/* The reset lives in the head of the panel's first FILTERING section - here that is
            this one, on Library the search, on Graph the view lens. It used to sit in
            whichever section happened to come first, which is now intake. */}
        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Filter</span>
            <span className="spacer" />
            {filtered && (
              <button className="btn ghost" onClick={reset} title="Back to everything, last 30 days">
                Reset
              </button>
            )}
          </div>
          {/* One kind per row, with the count it would leave on the table - the same shape
              Research files its lens filter in. As wrapping chips the five labels came out
              as a ragged three-line block, and the column has the height to spare since the
              search field (never used) and the queue foot came out. */}
          <div className="pillrow stacked" role="radiogroup" aria-label="Event kind">
            {KINDS.map((k) => (
              <button
                key={k.id}
                className="viewpill"
                role="radio"
                aria-checked={filter.kind === k.id}
                title={k.hint}
                onClick={() => setFilter({ ...filter, kind: k.id })}
              >
                <span className="pl">{k.label}</span>
                <span className="pn">{facet({ kind: k.id })}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">When</span>
          </div>
          <div className="pillrow stacked two" role="radiogroup" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.id}
                className="viewpill"
                role="radio"
                aria-checked={filter.days === r.days}
                onClick={() => setFilter({ ...filter, days: r.days })}
              >
                <span className="pl">{r.label}</span>
                <span className="pn">{facet({ days: r.days })}</span>
              </button>
            ))}
          </div>
          <div className="pillhint" title={`The range applies to settled rows only - anything still running or queued is listed whatever you pick here - and the newest ${WINDOW_MAX} settled rows are what the screen holds.`}>
            Settled rows only · newest {WINDOW_MAX}
          </div>
        </div>

        {/* Seven states, a closed set: two columns keep them one glance instead of a scroll,
            and the height that buys goes to the channel list, which grows with the vault. */}
        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">State</span>
            <span className="spacer" />
            <span className="gp-state">{filter.state ?? 'all'}</span>
          </div>
          <div className="domlist static stategrid">
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
            {filter.channel !== null ? (
              <button className="btn ghost" onClick={() => setFilter({ ...filter, channel: null })}>
                <Icon name="x" /> Clear
              </button>
            ) : (
              <span className="gp-count">{channels.length}</span>
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


      </aside>

      <div className="home-main">
        {/* ZONE 1 - the stock. No section header: the number IS the header, and a caption
            above it would only say what the number already says. */}
        <section className="vaultzone">
          <div className="vz-hero">
            <div className="vz-n">{stats.data?.pages.total ?? statPlaceholder}</div>
            <div className="vz-k">pages in the wiki</div>
            <div className="vz-facts">
              <button className="vzf" onClick={() => navigate('/graph')}>
                <b>{shape !== null ? shape.links.toLocaleString('en-US') : statPlaceholder}</b>
                <span>links between pages</span>
              </button>
              <button className="vzf" onClick={() => navigate('/graph')}>
                <b>{shape !== null ? shape.medianDegree : statPlaceholder}</b>
                <span>median links per page</span>
              </button>
              <button className="vzf" onClick={() => navigate('/library')}>
                <b>{shape !== null ? shape.domains : statPlaceholder}</b>
                <span>
                  domains
                  {shape !== null && shape.undomained > 0 ? `, ${shape.undomained} pages unfiled` : ''}
                </span>
              </button>
              <button className="vzf" onClick={() => navigate('/graph?gaps=1')}>
                <b>{shape !== null ? shape.unresolved : statPlaceholder}</b>
                <span>links to pages that do not exist</span>
              </button>
              <button className="vzf" onClick={() => navigate('/library')}>
                <b>{stats.data?.pages.total ?? statPlaceholder}</b>
                <span>pages in the wiki</span>
              </button>
              {/* Growth used to be one of the second panel's views. It is a number per
                  window, not a picture, so it belongs in the column of numbers - and the
                  chart it came from is still a click away in System. */}
              <button
                className="vzf"
                onClick={() => navigate('/system?section=vault')}
                title="New wiki pages over the last 7 days, from the vault's own git history."
              >
                <b>{grew7 ?? statPlaceholder}</b>
                <span>new pages (7d)</span>
              </button>
              <button
                className="vzf"
                onClick={() => navigate('/system?section=vault')}
                title="New wiki pages over the last 30 days - as far back as the growth series reaches."
              >
                <b>{grew30 ?? statPlaceholder}</b>
                <span>new pages (30d)</span>
              </button>
            </div>
          </div>

          <div className="vz-panel">
            <div className="vz-phead">
              <span className="gp-eyebrow">Shape</span>
              <span className="box-sub">the wikilink graph, clustered by domain</span>
              <span className="spacer" />
              <button className="btn ghost" onClick={() => navigate('/graph')}>
                Open Graph
              </button>
            </div>
            {/* A force layout is a decorative read - nothing can be counted off it, which is
                why every countable thing is stated as text to the left of it. */}
            <div className="vz-body">
              {constellation !== null ? (
                <VaultConstellation
                  nodes={constellation.nodes}
                  edges={constellation.edges}
                  onOpen={() => navigate('/graph')}
                />
              ) : (
                (queryState(graphQ, 'the vault graph') ?? <div className="empty">No pages yet.</div>)
              )}
            </div>
            <div className="vz-foot">
              {legend.map(([dir, n]) => (
                <span key={dir} className="vzl">
                  <span className="dot" style={{ background: `var(${TYPE_VARS[dir] ?? '--type-meta'})` }} aria-hidden />
                  {dir} <b>{n}</b>
                </span>
              ))}
              {legendRest > 0 && (
                <span className="vzl">
                  <span className="dot" style={{ background: 'var(--type-meta)' }} aria-hidden />
                  other <b>{legendRest}</b>
                </span>
              )}
            </div>
          </div>
          <HomePanel
            panel={panel}
            onPanel={choosePanel}
            nodes={graphQ.data?.nodes ?? []}
            events={events}
            gaps={graphQ.data?.gaps ?? []}
            vaultName={vaultName}
            now={Date.now()}
            onOpenLibrary={() => navigate('/library')}
            onOpenGaps={() => navigate('/graph?gaps=1')}
            onResearch={(topic) => navigate(`/research?topic=${encodeURIComponent(topic)}`)}
          />
        </section>

        {/* ZONE 2 - the flow. The operational figures sit on top of the table they describe. */}
        <div className="box">
          <Facts size="lead">
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
              k="Ingests · 7d"
              v={stats.data?.kpis7d.ingests ?? statPlaceholder}
              sub={`${stats.data?.usage.today.ingests ?? 0} today`}
              size="lead"
              onOpen={() => setFilter({ ...DEFAULT_FILTER, kind: 'ingest', days: 7 })}
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

        {detailEvent === null ? (
          <>
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
                    <LiveJobRow key={row.job.id} job={row.job} onOpen={() => setDetailId(row.job.id)} />
                  ),
                )}
                {settled.map((e) =>
                  e.job !== undefined ? (
                    <HistoryJobRow
                      key={e.id}
                      job={e.job}
                      vaultName={vaultName}
                      authMode={authMode}
                      onOpen={() => setDetailId(e.id)}
                    />
                  ) : e.commit !== null ? (
                    /* A commit no job claims. The test used to be `kind === 'edit'`, which sent
                       an unclaimed `ingest:` commit to SettleRow - and that prefixes the run's
                       name onto a subject that already starts with "ingest: ". Only jobs and
                       commits carry a hash, and jobs are handled above, so this is exact. */
                    <CommitRow key={e.id} event={e} vaultName={vaultName} />
                  ) : (
                    <SettleRow
                      key={e.id}
                      event={e}
                      vaultName={vaultName}
                      authMode={authMode}
                      onOpen={() => setDetailId(e.id)}
                    />
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
          </>
        ) : (
          <JobDetail
            event={detailEvent}
            vaultName={vaultName}
            authMode={authMode}
            onBack={() => setDetailId(null)}
          />
        )}
        </div>
      </div>

    </div>
  )
}
