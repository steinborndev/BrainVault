/**
 * Job drawer (redesign 2026-08): everything the DB knows about one job, on demand. The
 * history table stays scannable because commit hash, content hash, batch, exact timestamps,
 * the full log and the retry/revert actions live here instead of stretching every row.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AuthMode } from '../api/types.ts'
import { StatusBadge, TypeBadge } from './StatusBadge.tsx'
import { PageLinks } from './PageLink.tsx'
import { JobLog } from './JobLog.tsx'
import { Icon } from './Icon.tsx'
import { Cost } from './Cost.tsx'
import { parsePages, duration, tokens } from '../lib/format.ts'

/** Exact wall-clock timestamp; relative time is the table's job. */
function exact(iso: string | null): string {
  return iso === null ? '' : new Date(iso).toLocaleString('en-US')
}

export function JobDrawer({
  jobId,
  vaultName,
  authMode,
  onClose,
  onOpenJob,
}: {
  jobId: string
  vaultName: string
  authMode: AuthMode
  onClose: () => void
  /** Follow a duplicate to the job it repeats (schema v11 persists the link). */
  onOpenJob?: (id: string) => void
}): React.ReactElement {
  const qc = useQueryClient()
  // Shares the `['job', id]` key the SSE bus invalidates on status transitions.
  const detail = useQuery({ queryKey: ['job', jobId], queryFn: () => api.job(jobId) })
  const job = detail.data?.job

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const retry = useMutation({
    mutationFn: () => api.retry(jobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['job', jobId] })
    },
  })
  const [armedRevert, setArmedRevert] = useState(false)
  const [revertNote, setRevertNote] = useState<string | null>(null)
  const revert = useMutation({
    mutationFn: () => api.revertJob(jobId),
    onSuccess: (res) => {
      setArmedRevert(false)
      // The response says what actually happened - surface it instead of discarding it.
      setRevertNote(
        res.reverted
          ? `Reverted as ${res.revertCommit ?? 'a new commit'}${res.affectedJobs > 1 ? ` · ${res.affectedJobs} jobs in the shared batch commit` : ''}`
          : 'Nothing to revert.',
      )
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['job', jobId] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['graph'] })
    },
  })

  const pages = job !== undefined ? parsePages(job.created_pages) : []
  const name = job?.original_name ?? job?.url ?? jobId
  const canRetry = job !== undefined && (job.status === 'failed' || job.status === 'deferred')
  const canRevert = job !== undefined && !!job.commit_hash && !job.reverted_at && job.status === 'done'
  const batchWarning = job?.batch_id != null ? ' This undoes the whole batch it was part of.' : ''

  return (
    <>
      <div className="drawer-veil" onPointerDown={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Job detail: ${name}`}>
        <div className="drawer-head">
          <span className="ttl" title={name}>
            {name}
          </span>
          {job !== undefined && <TypeBadge type={job.type} />}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose} aria-label="Close job detail">
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">
          {detail.isLoading && <div className="empty">Loading job…</div>}
          {detail.isError && <div className="empty">Failed to load the job: {(detail.error as Error).message}</div>}
          {job !== undefined && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <StatusBadge status={job.status} />
                {job.reverted_at != null && (
                  <span className="chip" title={`Vault commit reverted ${exact(job.reverted_at)}`}>
                    reverted
                  </span>
                )}
                {job.attempts > 1 && <span className="chip">{job.attempts} attempts</span>}
              </div>
              <dl className="kv">
                <dt>Source</dt>
                <dd>
                  {job.source} · {exact(job.created_at)}
                </dd>
                {job.url !== null && (
                  <>
                    <dt>URL</dt>
                    <dd>
                      <code>{job.url}</code>
                    </dd>
                  </>
                )}
                {job.started_at !== null && (
                  <>
                    <dt>Started</dt>
                    <dd>{exact(job.started_at)}</dd>
                  </>
                )}
                {job.finished_at !== null && (
                  <>
                    <dt>Finished</dt>
                    <dd>
                      {exact(job.finished_at)} · took {duration(job.started_at, job.finished_at)}
                    </dd>
                  </>
                )}
                {job.tokens_out !== null && (
                  <>
                    <dt>Usage</dt>
                    <dd>
                      {tokens((job.tokens_in ?? 0) + job.tokens_out)} tokens
                      {job.cost_usd !== null && (
                        <>
                          {' · '}
                          <Cost value={job.cost_usd} authMode={authMode} />
                        </>
                      )}
                    </dd>
                  </>
                )}
                <dt>Commit</dt>
                <dd>
                  {job.commit_hash != null ? (
                    <code title="The vault commit this ingest produced - the revert anchor">
                      {job.commit_hash.slice(0, 10)}
                    </code>
                  ) : (
                    <span className="dim">none</span>
                  )}
                </dd>
                {job.batch_id !== null && (
                  <>
                    <dt>Batch</dt>
                    <dd>
                      <code title={job.batch_id}>{job.batch_id.slice(0, 10)}</code>
                      <span className="dim"> · one commit for all members</span>
                    </dd>
                  </>
                )}
                {job.duplicate_of != null && (
                  <>
                    <dt>Duplicate of</dt>
                    <dd>
                      {onOpenJob !== undefined ? (
                        <button className="linkish" onClick={() => onOpenJob(job.duplicate_of!)}>
                          the earlier job with the same content
                        </button>
                      ) : (
                        <code>{job.duplicate_of}</code>
                      )}
                    </dd>
                  </>
                )}
                {job.sha256 !== null && (
                  <>
                    <dt>SHA-256</dt>
                    <dd>
                      <code title={job.sha256}>{job.sha256.slice(0, 16)}…</code>
                    </dd>
                  </>
                )}
              </dl>
              {job.error !== null && <div className="job-error">{job.error}</div>}
              {retry.error != null && <div className="job-error">Retry failed: {(retry.error as Error).message}</div>}
              {revert.error != null && <div className="job-error">Revert failed: {(revert.error as Error).message}</div>}
              {revertNote !== null && <div className="toast ok">{revertNote}</div>}
              {pages.length > 0 && (
                <>
                  <h3 className="section-title" style={{ marginTop: 14 }}>
                    Created / updated · {pages.length}
                  </h3>
                  <PageLinks vaultName={vaultName} paths={pages} />
                </>
              )}
              <h3 className="section-title" style={{ marginTop: 14 }}>
                Log
              </h3>
              <JobLog jobId={jobId} />
            </>
          )}
        </div>
        <div className="drawer-foot">
          {canRetry && (
            <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate()}>
              <Icon name="retry" /> {retry.isPending ? 'Retrying…' : 'Retry'}
            </button>
          )}
          {canRevert && (
            <button
              className={`btn ${armedRevert ? 'armed' : 'danger'}`}
              disabled={revert.isPending}
              onClick={() => (armedRevert ? revert.mutate() : setArmedRevert(true))}
              onBlur={() => setArmedRevert(false)}
              title={`Undo this ingest: reverts its vault commit as a new commit.${batchWarning}`}
            >
              {revert.isPending ? 'Reverting…' : armedRevert ? 'Confirm revert' : 'Revert ingest'}
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </aside>
    </>
  )
}
