/**
 * One job as a card, used in all three Ingestion sections (Aktiv / Warteschlange / Verlauf,
 * SPEC.md §6.2). `variant` decides the affordances:
 *  - active  → the live agent log is shown expanded (the DoD's live stream)
 *  - queue   → a cancel action (DELETE /jobs/:id)
 *  - history → created pages as obsidian:// links, error + retry for failed jobs, a
 *              collapsible log.
 */

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Job } from '../api/types.ts'
import { api } from '../api/client.ts'
import { StatusBadge, TypeBadge } from './StatusBadge.tsx'
import { PageLinks } from './PageLink.tsx'
import { JobLog } from './JobLog.tsx'
import { Icon } from './Icon.tsx'
import { parsePages, timeAgo, duration, tokens, usd } from '../lib/format.ts'

type Variant = 'active' | 'queue' | 'history'

export function JobCard({ job, variant, vaultName }: { job: Job; variant: Variant; vaultName: string }): React.ReactElement {
  const qc = useQueryClient()
  const [showLog, setShowLog] = useState(false)
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
            <button className="btn ghost danger" disabled={cancel.isPending} onClick={() => cancel.mutate()} title="Abbrechen">
              <Icon name="x" /> Abbrechen
            </button>
          )}
          {variant === 'history' && (job.status === 'failed' || job.status === 'deferred') && (
            <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate()} title="Erneut versuchen">
              <Icon name="retry" /> Erneut versuchen
            </button>
          )}
          {variant === 'history' && (
            <button className="btn ghost" onClick={() => setShowLog((v) => !v)}>
              {showLog ? 'Log verbergen' : 'Log'}
            </button>
          )}
        </span>
      </div>

      <div className="job-meta">
        <span>{job.source}</span>
        <span>{timeAgo(job.finished_at ?? job.started_at ?? job.created_at)}</span>
        {job.started_at && job.finished_at && <span>Dauer {duration(job.started_at, job.finished_at)}</span>}
        {job.tokens_out != null && <span>{tokens((job.tokens_in ?? 0) + job.tokens_out)} Tokens</span>}
        {job.cost_usd != null && <span>{usd(job.cost_usd)}</span>}
        {job.attempts > 1 && <span>{job.attempts} Versuche</span>}
      </div>

      {job.error && variant !== 'active' && <div className="job-error">{job.error}</div>}

      {pages.length > 0 && <PageLinks vaultName={vaultName} paths={pages} />}

      {variant === 'active' && <JobLog jobId={job.id} />}
      {variant === 'history' && showLog && <JobLog jobId={job.id} />}
    </div>
  )
}
