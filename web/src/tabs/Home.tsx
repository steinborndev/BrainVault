/**
 * Home (rework 2026-08-24). Reading order follows intent, not data shape:
 *
 *   1 ACT     the intake composer - the reason to open the app at all. It stands down
 *             to one row while the queue is busy (Dropzone `compact`).
 *   2 WATCH   what that started: the running and queued jobs, from every channel. This
 *             is the Inbox folded in - the Inbox screen keeps the full record.
 *   3 READ    one plain-language line of state, then four tiles that are doors.
 *   4 BROWSE  ONE activity stream instead of the old recently-changed / recent-commits /
 *             history triplication - an ingest, a research run, a maintenance run and a
 *             manual edit are all the same event: something changed the vault, each
 *             carrying its commit and its pages.
 *
 * The old NOW band is gone: its three cells said what section 2 now says properly (the
 * running job), what the intake card already shows (channels), and what the state line
 * carries (health). The status strip went earlier - the topbar's live pill owns service
 * status, the sidebar badges own attention. Everything refreshes live via the SSE-driven
 * query invalidation.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AuthMode, Job, JobStatus, Stats } from '../api/types.ts'
import { Dropzone } from '../components/Dropzone.tsx'
import { GrowthChart } from '../components/GrowthChart.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { PageLink } from '../components/PageLink.tsx'
import { Sparkline } from '../components/Sparkline.tsx'
import { Tip } from '../components/Tip.tsx'
import { JobDrawer } from '../components/JobDrawer.tsx'
import { Icon, type IconName } from '../components/Icon.tsx'
import { timeAgo, duration, parsePages } from '../lib/format.ts'
import { Cost } from '../components/Cost.tsx'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'
import { useMaintenanceStatus, type MaintenanceStatusData } from '../hooks/useMaintenanceStatus.ts'
import { navigate, pageRoute } from '../lib/router.ts'
import { RUN_TITLES } from '../lib/runLabels.ts'

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

/**
 * Content pages only, for feed chips: system pages (underscore-prefixed index hubs, the
 * wiki root's hot/index/log/overview) ride along in every ingest commit and would drown
 * the actual knowledge. The job drawer still lists everything.
 */
function contentPages(paths: string[]): string[] {
  return paths.filter((p) => {
    const base = p.split('/').pop() ?? p
    if (base.startsWith('_')) return false
    return !/^wiki\/(hot|index|log|overview)\.md$/.test(p)
  })
}

export function Home(): React.ReactElement {
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const jobs = useQuery({ queryKey: ['jobs', 300], queryFn: () => api.jobs({ limit: 300 }) })
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const maint = useMaintenanceStatus().data
  const [drawerJob, setDrawerJob] = useState<string | null>(null)

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

  const activeJobs = (jobs.data?.jobs ?? []).filter((j) => j.status === 'preprocessing' || j.status === 'ingesting')
  const queuedJobs = (jobs.data?.jobs ?? []).filter((j) => j.status === 'queued')
  const gaps = graph.data?.gaps ?? []

  return (
    <div>
      <Dropzone compact={activeJobs.length + queuedJobs.length > 0} />
      <InFlight active={activeJobs} queued={queuedJobs} paused={data.queue.paused} onOpenJob={setDrawerJob} />
      <StateLine stats={data} maint={maint} />
      <StatBand stats={data} gapCount={graph.data?.unresolved ?? null} />

      <div className="home-grid section">
        <div className="home-act">
        <ActivityFeed
          stats={data}
          jobs={jobs.data?.jobs ?? []}
          authMode={data.authMode}
          vaultName={data.vaultName}
          onOpenJob={setDrawerJob}
        />
        </div>
        <div className="home-side">
          <div className="card card-pad">
            <h3 className="section-title">Growth · 30 days</h3>
            <GrowthChart points={data.growth} />
          </div>
          <div className="card card-pad">
            <h3 className="section-title">Pages by type</h3>
            <TypeBars byDir={data.pages.byDir} />
          </div>
          {gaps.length > 0 && (
            <div className="card card-pad">
              <h3 className="section-title">
                Most wanted pages
                <Tip text="Missing pages other pages already link to - the vault telling you what to write next. Research starts with the page name as a clean topic." />
              </h3>
              <div className="wanted">
                {gaps.slice(0, 3).map((g, i) => (
                  <div key={g.title} className="wrow">
                    <span className="wn">{i + 1}</span>
                    <span className="wt" title={g.title}>
                      {g.title}
                    </span>
                    <span className="wc">{g.refBy.length} links</span>
                    <button
                      className="btn research-btn"
                      onClick={() => navigate(`/research?prefill=${encodeURIComponent(g.title)}`)}
                      title="Hand this gap to the research composer"
                    >
                      Research
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {data.hotCache && <HotCache stats={data} />}

      {drawerJob !== null && (
        <JobDrawer jobId={drawerJob} vaultName={data.vaultName} authMode={data.authMode} onClose={() => setDrawerJob(null)} onOpenJob={setDrawerJob} />
      )}
    </div>
  )
}

/**
 * In flight: everything the service is working on right now, from every channel - this
 * drop, the watch folder, the bot. Rows leave for the activity stream when they commit.
 * Deliberately lighter than the Inbox's JobCard: no live log, no revert - Home answers
 * "is it moving?", the Inbox answers "what exactly happened".
 */
function InFlight({
  active,
  queued,
  paused,
  onOpenJob,
}: {
  active: Job[]
  queued: Job[]
  paused: boolean
  onOpenJob: (id: string) => void
}): React.ReactElement {
  const busy = active.length + queued.length > 0
  return (
    <div className="card section inflight">
      <div className="feed-head">
        <h3 className="section-title">In flight</h3>
        {active.length > 0 && (
          <span className="badge ingesting">
            <span className="pulse-dot" aria-hidden />
            {active.length} running
          </span>
        )}
        {paused && <span className="badge deferred">queue paused</span>}
        <span className="spacer" />
        <button className="btn ghost" onClick={() => navigate('/inbox')}>
          Full inbox <Icon name="chevron" />
        </button>
      </div>
      {!busy ? (
        <div className="empty">Nothing running. Drop something above and it starts here.</div>
      ) : (
        <div className="flight-rows">
          {active.map((j) => (
            <FlightRow key={j.id} job={j} onOpen={() => onOpenJob(j.id)} />
          ))}
          {queued.map((j) => (
            <FlightRow key={j.id} job={j} onOpen={() => onOpenJob(j.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The pipeline as five ticks - enough to see movement, not enough to need a legend. */
const FLIGHT_PHASES: JobStatus[] = ['queued', 'preprocessing', 'ingesting']

function FlightRow({ job, onOpen }: { job: Job; onOpen: () => void }): React.ReactElement {
  const phase = FLIGHT_PHASES.indexOf(job.status)
  const since = job.started_at ?? job.created_at
  return (
    <button className="frow" onClick={onOpen} title="Open the job">
      <span className={`fico ${job.status === 'queued' ? 'queued' : 'busy'}`}>
        <Icon name={job.status === 'queued' ? 'inbox' : 'bolt'} />
      </span>
      <span className="fbody">
        <span className="fname">{job.original_name ?? job.url ?? job.id}</span>
        <span className="fmeta">
          <span>{job.status}</span>
          <span>{timeAgo(since)}</span>
          <span>{job.source}</span>
        </span>
      </span>
      <span className="fsteps" aria-hidden>
        {FLIGHT_PHASES.map((p, i) => (
          <span key={p} className={`st${i < phase ? ' on' : i === phase ? ' now' : ''}`} />
        ))}
      </span>
    </button>
  )
}

/**
 * One plain-language line of state above the tiles. It carries the health summary the
 * old NOW band had a whole cell for - a sentence says it in less space than a card, and
 * it names the window the tiles are measured over, which the tiles themselves cannot.
 */
function StateLine({ stats, maint }: { stats: Stats; maint: MaintenanceStatusData | null }): React.ReactElement {
  const due = maint?.status.due ?? 0
  const rec = maint?.status.recommended ?? 0
  const last = stats.commits[0]
  return (
    <div className="stateline section">
      Vault health over the <strong>last 7 days</strong> - every number opens the screen it comes
      from.
      {last && <> Last commit {timeAgo(last.date)}.</>}{' '}
      {due + rec > 0 ? (
        <button className="linkish" onClick={() => navigate('/health')}>
          {due > 0 ? `${due} check${due > 1 ? 's' : ''} due` : `${rec} recommended soon`}
        </button>
      ) : maint === null ? (
        <span className="dim">Checking maintenance…</span>
      ) : (
        <span className="ok-strong">All checks healthy.</span>
      )}
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

/** Stat tiles that navigate - every number is a door, not a dead end. */
function StatBand({ stats, gapCount }: { stats: Stats; gapCount: number | null }): React.ReactElement {
  const doneDaily = dense(stats.kpisDaily, 'done', 14)
  const failedDaily = dense(stats.kpisDaily, 'failed', 14)
  const prevIngests = sum(doneDaily.slice(0, 7))
  const prevFailures = sum(failedDaily.slice(0, 7))
  const growth = stats.growth
  const pagesNow = growth[growth.length - 1]?.total ?? stats.pages.total
  const pagesThen = growth[growth.length - 8]?.total ?? growth[0]?.total ?? pagesNow

  return (
    <div className="grid kpis section">
      <button className="stat card statlink" onClick={() => navigate('/library')}>
        <div className="label">Pages</div>
        <div className="value">
          {stats.pages.total}
          <Delta now={pagesNow} prev={pagesThen} />
        </div>
        <div className="sub">vs. last week</div>
        <Sparkline values={growth.slice(-14).map((p) => p.total)} />
        <div className="goto">Browse the library</div>
      </button>
      <button className="stat card statlink" onClick={() => navigate('/inbox')}>
        <div className="label">Ingests · 7d</div>
        <div className="value ok">
          {stats.kpis7d.ingests}
          <Delta now={stats.kpis7d.ingests} prev={prevIngests} />
        </div>
        <div className="sub">
          {stats.kpis7d.duplicates > 0 ? `${stats.kpis7d.duplicates} duplicates skipped` : 'vs. previous 7 d'}
        </div>
        <div className="goto">Open the inbox</div>
      </button>
      <button className="stat card statlink" onClick={() => navigate(stats.kpis7d.failures > 0 ? '/inbox?filter=failed' : '/inbox')}>
        <div className="label">Failures · 7d</div>
        <div className={`value${stats.kpis7d.failures > 0 ? ' err' : ''}`}>
          {stats.kpis7d.failures}
          <Delta now={stats.kpis7d.failures} prev={prevFailures} invert />
        </div>
        <div className="sub">{stats.kpis7d.failures > 0 ? 'retry from the inbox' : 'nothing failed this week'}</div>
        <div className="goto">{stats.kpis7d.failures > 0 ? 'Show failed jobs' : 'Open the inbox'}</div>
      </button>
      <button className="stat card statlink" onClick={() => navigate('/graph')}>
        <div className="label">Gaps</div>
        <div className="value">{gapCount ?? '…'}</div>
        <div className="sub">unresolved link targets</div>
        <div className="goto">See them in the graph</div>
      </button>
    </div>
  )
}

type FeedKind = 'ingest' | 'failed' | 'maintenance' | 'edit'

interface FeedEvent {
  key: string
  kind: FeedKind
  icon: IconName
  title: string
  whenIso: string
  meta: string[]
  commit?: string
  costUsd?: number
  pagePaths?: string[]
  pageNote?: string
  onOpen?: () => void
}

/**
 * One stream of change. Sources: finished jobs (with their commit + pages), the per-kind
 * maintenance state, and commits neither of those explains (manual edits, deletes, saves).
 * Commits within 90s of a maintenance settle are treated as that run's commit - the state
 * record carries no hash, so time proximity is the join.
 */
function ActivityFeed({
  stats,
  jobs,
  authMode,
  vaultName,
  onOpenJob,
}: {
  stats: Stats
  jobs: Job[]
  authMode: AuthMode
  vaultName: string
  onOpenJob: (id: string) => void
}): React.ReactElement {
  const maint = useMaintenanceStatus().data
  const [filter, setFilter] = useState<'all' | FeedKind>('all')

  const events = useMemo(() => {
    const out: FeedEvent[] = []
    const jobCommits = new Set<string>()

    for (const j of jobs) {
      if (j.status !== 'done' && j.status !== 'failed') continue
      const when = j.finished_at ?? j.started_at ?? j.created_at
      const name = j.original_name ?? j.url ?? j.id
      if (j.commit_hash != null) jobCommits.add(j.commit_hash.slice(0, 8))
      const meta: string[] = [j.source]
      if (j.started_at !== null && j.finished_at !== null) meta.push(duration(j.started_at, j.finished_at))
      out.push({
        key: `job:${j.id}`,
        kind: j.status === 'done' ? 'ingest' : 'failed',
        icon: j.status === 'done' ? 'bolt' : 'x',
        title: j.status === 'done' ? `Ingested ${name}` : `Failed: ${name}`,
        whenIso: when,
        meta,
        ...(j.commit_hash != null ? { commit: j.commit_hash.slice(0, 7) } : {}),
        ...(j.cost_usd !== null ? { costUsd: j.cost_usd } : {}),
        pagePaths: contentPages(parsePages(j.created_pages)),
        onOpen: () => onOpenJob(j.id),
      })
    }

    const runTimes: number[] = []
    for (const [kind, a] of maint?.lastRuns ?? new Map<string, never>()) {
      runTimes.push(Date.parse(a.finishedAt))
      out.push({
        key: `run:${kind}:${a.runId}`,
        kind: 'maintenance',
        icon: a.ok ? 'health' : 'x',
        title: `${RUN_TITLES[kind] ?? kind}${a.ok ? '' : ' failed'}`,
        whenIso: a.finishedAt,
        meta: a.error !== null ? [a.error] : [],
        ...(a.pages > 0 ? { pageNote: `${a.pages} page${a.pages > 1 ? 's' : ''}` } : {}),
        onOpen: () => navigate('/health'),
      })
    }

    for (const c of stats.commits) {
      if (jobCommits.has(c.hash.slice(0, 8))) continue
      const t = Date.parse(c.date)
      if (runTimes.some((rt) => Math.abs(rt - t) < 90_000)) continue
      out.push({
        key: `commit:${c.hash}`,
        kind: 'edit',
        icon: 'commit',
        title: c.subject,
        whenIso: c.date,
        meta: [],
        commit: c.hash.slice(0, 7),
        pagePaths: contentPages(c.pages),
        ...(c.pages.length === 1 ? { onOpen: () => navigate(pageRoute(c.pages[0]!)) } : {}),
      })
    }

    out.sort((a, b) => Date.parse(b.whenIso) - Date.parse(a.whenIso))
    return out
  }, [jobs, stats.commits, maint, onOpenJob])

  const shown = events.filter((e) => filter === 'all' || e.kind === filter || (filter === 'ingest' && e.kind === 'failed')).slice(0, 40)

  return (
    <div className="card feed">
      <div className="feed-head">
        <h3 className="section-title">Activity</h3>
        <span className="spacer" />
        {(
          [
            ['all', 'All'],
            ['ingest', 'Ingests'],
            ['maintenance', 'Maintenance'],
            ['edit', 'Vault edits'],
          ] as Array<['all' | FeedKind, string]>
        ).map(([id, label]) => (
          <button key={id} className={`chip${filter === id ? ' active' : ''}`} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="feed-scroll">
      {shown.length === 0 ? (
        <div className="empty">Nothing here yet - ingest something and the stream begins.</div>
      ) : (
        shown.map((e) => (
          <div
            key={e.key}
            className={`feed-item${e.onOpen !== undefined ? ' clickable' : ''}`}
            onClick={e.onOpen}
            role={e.onOpen !== undefined ? 'button' : undefined}
            tabIndex={e.onOpen !== undefined ? 0 : undefined}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && e.onOpen !== undefined) e.onOpen()
            }}
          >
            <span className={`fico ${e.kind}`}>
              <Icon name={e.icon} />
            </span>
            <span className="fbody">
              <span className="fline">
                <span className="ft" title={e.title}>
                  {e.title}
                </span>
                <span className="fwhen">{timeAgo(e.whenIso)}</span>
              </span>
              <span className="fmeta">
                {e.meta.map((m, i) => (
                  <span key={i}>{m}</span>
                ))}
                {e.costUsd !== undefined && (
                  <span>
                    <Cost value={e.costUsd} authMode={authMode} />
                  </span>
                )}
                {e.commit !== undefined && <span className="mono-meta">commit {e.commit}</span>}
                {e.pageNote !== undefined && <span>{e.pageNote}</span>}
              </span>
              {e.pagePaths !== undefined && e.pagePaths.length > 0 && (
                <span className="fpages" onClick={(ev) => ev.stopPropagation()}>
                  {e.pagePaths.slice(0, 4).map((p) => (
                    <PageLink key={p} vaultName={vaultName} path={p} />
                  ))}
                  {e.pagePaths.length > 4 && <span className="chip-n">+{e.pagePaths.length - 4} more</span>}
                </span>
              )}
            </span>
          </div>
        ))
      )}
      </div>
      <div className="feed-foot">
        <button className="linkish" onClick={() => navigate('/inbox')}>
          Full history in the inbox
        </button>
      </div>
    </div>
  )
}

/** Page counts as horizontal bars - proportions read at a glance, direct labels right. */
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

/** Hot cache, collapsed - with its age and the refresh action right here in the summary. */
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
              // The button lives inside <summary> - don't let the click also toggle the panel.
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
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 88 }} />
      ))}
    </div>
  )
}
