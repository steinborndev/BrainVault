/**
 * The rows of Home's activity table. One table shows four kinds of event, so the row types
 * live together: they have to agree on the six columns (event, channel, pages, took, cost,
 * when) or the table stops reading as one stream.
 *
 * In-flight rows are tinted and ride at the top; a job moves down into the settled rows when
 * it commits, rather than teleporting between two screens as it did before the Inbox folded
 * into Home.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AuthMode, Job, JobStatus, MaintenanceRun } from '../api/types.ts'
import { Cost } from './Cost.tsx'
import { Icon } from './Icon.tsx'
import { PageLink } from './PageLink.tsx'
import { useRunProgressLine } from './RunProgress.tsx'
import { duration, parsePages, timeAgo } from '../lib/format.ts'
import type { ActivityEvent } from '../lib/activity.ts'
import { RUN_RUNNING_TITLES, runTitle } from '../lib/runLabels.ts'
import { navigate, pageRoute } from '../lib/router.ts'

/** Stable per-channel colour, so a row's origin reads without parsing the word. */
export function channelColor(source: string): string {
  const map: Record<string, string> = {
    drop: 'var(--accent)',
    watch: 'var(--type-source)',
    telegram: 'var(--type-entity)',
    api: 'var(--type-meta)',
    url: 'var(--type-question)',
    research: 'var(--research)',
    manual: 'var(--type-meta)',
    git: 'var(--muted)',
  }
  return map[source] ?? 'var(--ok)'
}

/** Channel labels: the stored source values are terse, the panel is not. */
export function channelLabel(source: string): string {
  const map: Record<string, string> = {
    drop: 'Drop / upload',
    watch: 'Watch folder',
    url: 'Link',
    telegram: 'Telegram',
    manual: 'Manual edits',
    research: 'Research runs',
    git: 'Vault commit',
  }
  return map[source] ?? source
}

/** Up to three page chips under a row's title; the rest is a count. */
function PageChips({ vaultName, paths }: { vaultName: string; paths: readonly string[] }): React.ReactElement | null {
  if (paths.length === 0) return null
  return (
    <span className="rowpages" onClick={(e) => e.stopPropagation()}>
      {paths.slice(0, 3).map((p) => (
        <PageLink key={p} vaultName={vaultName} path={p} />
      ))}
      {paths.length > 3 && <span className="chip-n">+{paths.length - 3} more</span>}
    </span>
  )
}

/** The pipeline as three ticks - enough to see movement, not enough to need a legend. */
const PHASES: JobStatus[] = ['queued', 'preprocessing', 'ingesting']

/** A running agent run (research, lint, hot cache): in the same table as the ingests. */
export function RunRow({ run }: { run: MaintenanceRun }): React.ReactElement {
  const profiles = useQuery({ queryKey: ['research-profiles'], queryFn: api.researchProfiles })
  const profile = profiles.data?.profiles.find((p) => p.key === run.profileKey)
  const { text, ratio } = useRunProgressLine(run.channel, profile)
  const isResearch = run.kind === 'research'
  const open = (): void => navigate(isResearch ? '/research' : '/system')
  return (
    <tr
      className={`live${isResearch ? ' research' : ''}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open()
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
      <td className="dimc">{channelLabel(run.kind)}</td>
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

/** A running or queued ingest, cancellable while it still waits. */
export function LiveJobRow({ job, onOpen }: { job: Job; onOpen: () => void }): React.ReactElement {
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
      <td className="dimc">{channelLabel(job.source)}</td>
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

/** The handle for one multi-file drop: how many, how long ago, and cancel them together. */
export function BatchHead({ jobs }: { jobs: Job[] }): React.ReactElement {
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

/** One finished ingest as a scannable row; every detail lives in the drawer. */
export function HistoryJobRow({
  job,
  vaultName,
  authMode,
  onOpen,
}: {
  job: Job
  vaultName: string
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
        {job.status === 'failed' && job.error !== null && <span className="rowerr">{job.error}</span>}
        <PageChips vaultName={vaultName} paths={pages} />
      </td>
      <td className="dimc">{channelLabel(job.source)}</td>
      <td className="num">{pages.length > 0 ? `+${pages.length}` : '-'}</td>
      <td className="num">
        {job.started_at !== null && job.finished_at !== null ? duration(job.started_at, job.finished_at) : '-'}
      </td>
      <td className="num">{job.cost_usd !== null ? <Cost value={job.cost_usd} authMode={authMode} /> : '-'}</td>
      <td className="faintc">{timeAgo(job.finished_at ?? job.started_at ?? job.created_at)}</td>
    </tr>
  )
}

/**
 * A settled agent run (research or maintenance). The runner keeps no persistent per-run
 * record beyond the last settle per kind, so this row carries what that record has: outcome,
 * page count, time. Research rows open the run list, the rest open System.
 */
export function SettleRow({
  event,
  vaultName,
  authMode,
}: {
  event: ActivityEvent
  vaultName: string
  authMode: AuthMode
}): React.ReactElement {
  const isResearch = event.kind === 'research'
  const open = (): void => navigate(isResearch ? '/research' : '/system')
  // The kind names the run ("Lint report written"); a research topic is appended to it,
  // because "Research run" alone was all the per-kind settle record could ever say.
  const base = runTitle(event.runKind ?? event.kind, event.state !== 'failed')
  const name = event.title === '' ? base : `${base}: ${event.title}`
  return (
    <tr
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open()
      }}
      tabIndex={0}
      aria-label={`Open the ${event.kind} area`}
    >
      <td>
        <span className="hrow-name">
          <span className={`hrow-dot ${event.state === 'failed' ? 'failed' : 'done'}`} aria-hidden />
          <span className="nm" title={name}>
            {name}
          </span>
        </span>
        {event.note !== undefined && <span className="rowerr">{event.note}</span>}
        <PageChips vaultName={vaultName} paths={event.pages} />
      </td>
      <td className="dimc">{channelLabel(event.channel)}</td>
      <td className="num">{event.pages.length > 0 ? `+${event.pages.length}` : '-'}</td>
      <td className="num">{duration(event.startedIso ?? null, event.whenIso)}</td>
      <td className="num">{event.costUsd !== null ? <Cost value={event.costUsd} authMode={authMode} /> : '-'}</td>
      <td className="faintc">{timeAgo(event.whenIso)}</td>
    </tr>
  )
}

/** A commit no job or run explains: a page saved or deleted by hand. */
export function CommitRow({
  event,
  vaultName,
}: {
  event: ActivityEvent
  vaultName: string
}): React.ReactElement {
  const single = event.pages.length === 1 ? event.pages[0]! : null
  const open = single !== null ? () => navigate(pageRoute(single)) : undefined
  return (
    <tr
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && open !== undefined) open()
      }}
      tabIndex={open !== undefined ? 0 : undefined}
      aria-label={single !== null ? `Open ${single}` : undefined}
    >
      <td>
        <span className="hrow-name">
          <span className="hrow-dot edit" aria-hidden />
          <span className="nm" title={event.title}>
            {event.title}
          </span>
          {event.commit !== null && <span className="mono-meta">{event.commit.slice(0, 7)}</span>}
        </span>
        <PageChips vaultName={vaultName} paths={event.pages} />
      </td>
      <td className="dimc">{channelLabel(event.channel)}</td>
      <td className="num">{event.pages.length > 0 ? `+${event.pages.length}` : '-'}</td>
      <td className="num">-</td>
      <td className="num">-</td>
      <td className="faintc">{timeAgo(event.whenIso)}</td>
    </tr>
  )
}

export type LiveRowItem = { kind: 'batch'; batchId: string; jobs: Job[] } | { kind: 'job'; job: Job }

/**
 * Live job rows in display order, with a batch header inserted before the first member of
 * each multi-file drop. Members keep their own rows underneath - the header is a handle for
 * the group, not a replacement for seeing what is in it.
 */
export function groupRows(jobs: readonly Job[], batches: ReadonlyMap<string, Job[]>): LiveRowItem[] {
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

/**
 * The queue's state, next to the queue. Finding out WHY nothing is moving used to mean a
 * trip to another screen; the reason belongs where the work is listed.
 *
 * Read-only on purpose: the queue pauses itself on a spent budget or an exhausted usage
 * limit and resumes on its own, and there is no manual pause in the API. A button here
 * would either do nothing or promise a feature that does not exist.
 */
export function QueueState({
  paused,
  reason,
  concurrency,
  active,
  queued,
}: {
  paused: boolean
  reason: string | null
  concurrency: number | undefined
  active: number
  queued: number
}): React.ReactElement {
  // The old badge read "running" whenever the queue was merely WILLING to run, which is
  // what it says for an idle service too - so the panel claimed work that was not
  // happening. Three states now, and they describe the queue's actual occupation.
  const state = paused ? 'paused' : active > 0 ? 'working' : 'idle'
  return (
    <>
      <div className="queue-row">
        <span className={`badge ${state === 'paused' ? 'deferred' : state === 'working' ? 'ingesting' : ''}`}>
          {state === 'paused' ? 'paused' : state === 'working' ? `${active} running` : 'idle'}
        </span>
        {queued > 0 && <span className="badge queued-badge">{queued} waiting</span>}
        {concurrency !== undefined && state !== 'paused' && (
          <span className="faintc">up to {concurrency} at a time</span>
        )}
      </div>
      <div className="pillhint wrap">
        {paused
          ? reason === 'budget'
            ? 'Daily budget reached - queued jobs resume at midnight.'
            : reason === 'rate-limit'
              ? 'The Anthropic usage limit is exhausted - queued jobs resume when the window resets.'
              : 'Queued jobs wait; nothing is lost.'
          : state === 'working'
            ? 'Working through the queue - rows appear at the top of the stream.'
            : 'Nothing to do. A drop, a watched file or a message starts a job within seconds.'}
      </div>
    </>
  )
}
