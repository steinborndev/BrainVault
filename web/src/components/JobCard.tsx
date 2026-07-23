/**
 * One job as a card, used in all three Ingestion sections (Aktiv / Warteschlange / Verlauf,
 * SPEC.md §6.2). `variant` decides the affordances:
 *  - active  → a phase stepper (queued → preprocess → ingest) with running elapsed time,
 *              plus the live agent log (the DoD's live stream), collapsible.
 *  - queue   → a cancel action (DELETE /jobs/:id)
 *  - history → created pages as obsidian:// links, error + retry for failed jobs, a
 *              collapsible log.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AuthMode, Job, JobStatus } from '../api/types.ts'
import { api } from '../api/client.ts'
import { StatusBadge, TypeBadge } from './StatusBadge.tsx'
import { PageLinks } from './PageLink.tsx'
import { JobLog } from './JobLog.tsx'
import { Icon } from './Icon.tsx'
import { Cost } from './Cost.tsx'
import { parsePages, timeAgo, duration, tokens } from '../lib/format.ts'

type Variant = 'active' | 'queue' | 'history'

/** The pipeline phases in order, as the stepper shows them. */
const PHASES: Array<{ status: JobStatus; label: string }> = [
  { status: 'queued', label: 'Queued' },
  { status: 'preprocessing', label: 'Preprocess' },
  { status: 'ingesting', label: 'Ingest' },
]

/** Ticking elapsed time since `since` — re-renders once a second while mounted. */
function Elapsed({ since }: { since: string }): React.ReactElement {
  const [now, setNow] = useState(() => new Date().toISOString())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toISOString()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="elapsed">{duration(since, now)}</span>
}

/** Where the job is in the pipeline, as steps — overview before the log detail. */
function Stepper({ job }: { job: Job }): React.ReactElement {
  const current = PHASES.findIndex((p) => p.status === job.status)
  return (
    <div className="stepper">
      {PHASES.map((p, i) => (
        <span key={p.status} style={{ display: 'contents' }}>
          {i > 0 && <span className={`stepline${i <= current ? ' done' : ''}`} />}
          <span className={`step${i < current ? ' done' : i === current ? ' now' : ''}`}>
            <span className="sdot">{i < current ? <Icon name="check" /> : i === current ? <i /> : null}</span>
            {p.label}
          </span>
        </span>
      ))}
      <span className="stepline" />
      <span className="step">
        <span className="sdot" />
        Done
      </span>
      <Elapsed since={job.started_at ?? job.created_at} />
    </div>
  )
}

export function JobCard({
  job,
  variant,
  vaultName,
  authMode,
}: {
  job: Job
  variant: Variant
  vaultName: string
  /** Decides whether the per-job cost is marked as an estimate (SPEC.md §7.1). */
  authMode: AuthMode
}): React.ReactElement {
  const qc = useQueryClient()
  // Active jobs show their live log by default (the DoD's live stream) but can tuck it away;
  // history logs start collapsed.
  const [showLog, setShowLog] = useState(variant === 'active')
  const pages = parsePages(job.created_pages)
  const name = job.original_name ?? job.url ?? job.id

  const cancel = useMutation({
    mutationFn: () => api.cancel(job.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  })
  const retry = useMutation({
    mutationFn: () => api.retry(job.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  })
  // Undo of one ingest (SPEC §9). Two-step arm rather than window.confirm, matching the other
  // destructive actions — it writes the vault, so it must not be a single stray click.
  const [armedRevert, setArmedRevert] = useState(false)
  const revert = useMutation({
    mutationFn: () => api.revertJob(job.id),
    onSuccess: () => {
      setArmedRevert(false)
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['graph'] })
    },
  })
  // A batch commits ONCE for all its members, so undoing through any member undoes the batch.
  const batchWarning = job.batch_id !== null ? ' This undoes the whole batch it was part of.' : ''
  const canRevert =
    variant === 'history' && !!job.commit_hash && !job.reverted_at && job.status === 'done'

  return (
    <div className="job card">
      <div className="job-head">
        <span className="job-name" title={name}>
          {name}
        </span>
        <TypeBadge type={job.type} />
        <StatusBadge status={job.status} />

        <span className="job-actions">
          {variant === 'queue' && (
            <button className="btn ghost danger" disabled={cancel.isPending} onClick={() => cancel.mutate()} title="Cancel">
              <Icon name="x" /> Cancel
            </button>
          )}
          {variant === 'history' && (job.status === 'failed' || job.status === 'deferred') && (
            <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate()} title="Retry">
              <Icon name="retry" /> Retry
            </button>
          )}
          {canRevert && (
            <button
              className={`btn ${armedRevert ? 'armed' : 'ghost danger'}`}
              disabled={revert.isPending}
              onClick={() => (armedRevert ? revert.mutate() : setArmedRevert(true))}
              onBlur={() => setArmedRevert(false)}
              title={`Undo this ingest: reverts its vault commit as a new commit.${batchWarning}`}
            >
              <Icon name="retry" />{' '}
              {revert.isPending ? 'Reverting…' : armedRevert ? 'Confirm revert' : 'Revert'}
            </button>
          )}
          {variant === 'history' && job.reverted_at && (
            <span className="chip" title={`Vault commit reverted ${new Date(job.reverted_at).toLocaleString('en-US')}`}>
              reverted
            </span>
          )}
          {variant !== 'queue' && (
            <button className="btn ghost" onClick={() => setShowLog((v) => !v)}>
              {showLog ? 'Hide log' : 'Log'}
            </button>
          )}
        </span>
      </div>

      {variant === 'active' ? (
        <Stepper job={job} />
      ) : (
        <div className="job-meta">
          <span>{job.source}</span>
          <span>{timeAgo(job.finished_at ?? job.started_at ?? job.created_at)}</span>
          {job.started_at && job.finished_at && <span>Took {duration(job.started_at, job.finished_at)}</span>}
          {job.tokens_out != null && <span>{tokens((job.tokens_in ?? 0) + job.tokens_out)} tokens</span>}
          {job.cost_usd != null && (
            <span>
              <Cost value={job.cost_usd} authMode={authMode} />
            </span>
          )}
          {job.attempts > 1 && <span>{job.attempts} attempts</span>}
        </div>
      )}

      {job.error && variant !== 'active' && <div className="job-error">{job.error}</div>}
      {revert.error && <div className="job-error">{(revert.error as Error).message}</div>}
      {armedRevert && !revert.isPending && (
        <div className="tab-hint">
          Reverts this ingest&apos;s vault commit as a new commit — the pages it created go away, the
          history stays.{batchWarning} Click again to confirm.
        </div>
      )}

      {pages.length > 0 && <PageLinks vaultName={vaultName} paths={pages} />}

      {showLog && variant !== 'queue' && <JobLog jobId={job.id} />}
    </div>
  )
}
