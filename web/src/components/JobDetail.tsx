/**
 * One settled job, read in place (2026-08-27).
 *
 * This replaces the slide-over drawer. The drawer was a 460px overlay pinned to the right
 * edge with a veil behind it, so opening a row covered the graph and the stream it came
 * from - and it opened on the job RECORD: timestamps, token counts, the log. Those answer
 * "did it work", which the row you just clicked already told you.
 *
 * So: the same five bands the Research tab reads a run in - bar, facts, chips, content,
 * foot - in the stream's own slot, opening on the ARTICLE the job produced
 * (lib/homeArticle.ts). The log is a click away and stays complete; for a job that wrote no
 * article (an index rebuild, a lint pass) it is the only view and the switch does not appear.
 *
 * Escape leaves, the way it did from the drawer.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AuthMode } from '../api/types.ts'
import type { ActivityEvent } from '../lib/activity.ts'
import { Icon } from './Icon.tsx'
import { Cost } from './Cost.tsx'
import { Fact, Facts } from './Fact.tsx'
import { PageLink } from './PageLink.tsx'
import { Markdown } from './Markdown.tsx'
import { JobLog } from './JobLog.tsx'
import { StatusBadge } from './StatusBadge.tsx'
import { mainArticle, readerPages } from '../lib/homeArticle.ts'
import { frontmatter } from '../lib/frontmatter.ts'
import { duration, timeAgo, tokens } from '../lib/format.ts'

/** Exact wall-clock timestamp; relative time is the table's job. */
const exact = (iso: string | null | undefined): string =>
  iso === null || iso === undefined ? '-' : new Date(iso).toLocaleString('en-US')

export function JobDetail({
  event,
  vaultName,
  authMode,
  onBack,
}: {
  event: ActivityEvent
  vaultName: string
  authMode: AuthMode
  onBack: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const jobId = event.job?.id ?? null
  // Only a job has a record to fetch; a run or a bare commit carries everything it has in
  // the event itself.
  const detail = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.job(jobId as string),
    enabled: jobId !== null,
  })
  const job = detail.data?.job

  const pages = readerPages(event.pages)
  const articlePath = mainArticle(event.pages)
  const [tab, setTab] = useState<'article' | 'log'>(articlePath === null ? 'log' : 'article')

  const article = useQuery({
    queryKey: ['page-full', articlePath],
    queryFn: () => api.pageFull(articlePath as string),
    enabled: articlePath !== null && tab === 'article',
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Not while a field has focus: Escape there means "abandon what I am typing".
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['jobs'] })
    void qc.invalidateQueries({ queryKey: ['job', jobId] })
    void qc.invalidateQueries({ queryKey: ['stats'] })
    void qc.invalidateQueries({ queryKey: ['graph'] })
  }
  const retry = useMutation({ mutationFn: () => api.retry(jobId as string), onSuccess: invalidate })
  const [armedRevert, setArmedRevert] = useState(false)
  const [revertNote, setRevertNote] = useState<string | null>(null)
  const revert = useMutation({
    mutationFn: () => api.revertJob(jobId as string),
    onSuccess: (res) => {
      setArmedRevert(false)
      setRevertNote(
        res.reverted
          ? `Reverted as ${res.revertCommit ?? 'a new commit'}${res.affectedJobs > 1 ? ` · ${res.affectedJobs} jobs in the shared batch commit` : ''}`
          : 'Nothing to revert.',
      )
      invalidate()
    },
  })

  const canRetry = job !== undefined && (job.status === 'failed' || job.status === 'deferred')
  const canRevert = job !== undefined && !!job.commit_hash && job.reverted_at == null && job.status === 'done'
  const usage =
    job?.tokens_in != null || job?.tokens_out != null
      ? `${tokens((job.tokens_in ?? 0) + (job.tokens_out ?? 0))} tok`
      : null
  const body = article.data ? frontmatter(article.data.markdown).body : ''

  return (
    <>
      <div className={`detail-bar ${event.kind === 'research' ? 'research' : 'ingest'}`}>
        <button className="backlink" onClick={onBack}>
          <Icon name="back" />
          All activity
        </button>
        <Icon name={event.kind === 'research' ? 'flask' : 'file'} />
        <h3 className="detail-title" title={event.title}>
          {event.title}
        </h3>
        <span className="lens-tag">{event.channel}</span>
        {job !== undefined ? (
          <StatusBadge status={job.status} />
        ) : (
          <span className={`badge ${event.state === 'failed' ? 'failed' : 'ok'}`}>{event.state}</span>
        )}
        <span className="spacer" />
        {articlePath !== null && (
          <div className="seg sm" role="radiogroup" aria-label="What to show">
            <button role="radio" aria-checked={tab === 'article'} onClick={() => setTab('article')}>
              Article
            </button>
            <button role="radio" aria-checked={tab === 'log'} onClick={() => setTab('log')}>
              Log
            </button>
          </div>
        )}
        {canRetry && (
          <button className="btn sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {retry.isPending ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>

      <Facts size="lead">
        <Fact k="Source" v={job !== undefined ? `${job.source} · ${job.type}` : event.channel} />
        <Fact k="Started" v={<span className="mono-meta">{exact(job?.started_at ?? event.startedIso ?? null)}</span>} />
        <Fact k="Took" v={duration(job?.started_at ?? event.startedIso ?? null, job?.finished_at ?? event.whenIso)} />
        <Fact
          k="Usage"
          v={
            <>
              {usage !== null && <>{usage} · </>}
              {event.costUsd !== null ? <Cost value={event.costUsd} authMode={authMode} /> : 'not kept'}
            </>
          }
        />
        <Fact k="Pages written" v={pages.length > 0 ? `+${pages.length}` : '-'} />
      </Facts>

      <div className="chipband">
        <span className="bandkey">Wrote</span>
        <div className="chips">
          {pages.length > 0 ? (
            pages.map((p) => <PageLink key={p} vaultName={vaultName} path={p} />)
          ) : (
            <span className="dim">No page of its own - this run touched derived artifacts only.</span>
          )}
        </div>
      </div>

      <div className="detail-content">
        {event.note !== undefined && <div className="toast err">{event.note}</div>}
        {job?.error != null && <div className="toast err">{job.error}</div>}
        {revertNote !== null && <div className="toast ok">{revertNote}</div>}
        {revert.error != null && <div className="toast err">Revert failed: {(revert.error as Error).message}</div>}

        {tab === 'log' || articlePath === null ? (
          jobId !== null ? (
            <JobLog jobId={jobId} seed />
          ) : (
            <div className="empty">This record keeps no log - it was reconstructed from the vault's history.</div>
          )
        ) : article.isPending ? (
          <div className="empty">Loading the page…</div>
        ) : article.isError ? (
          <div className="empty">That page could not be read: {(article.error as Error).message}</div>
        ) : (
          <Markdown source={body} />
        )}
      </div>

      <div className="detail-foot">
        <span className="prov">
          {event.commit !== null ? (
            <>
              Commit <span className="mono-meta">{event.commit.slice(0, 10)}</span> · finished {timeAgo(event.whenIso)}
            </>
          ) : (
            <>Finished {timeAgo(event.whenIso)} · nothing was committed</>
          )}
        </span>
        <span className="spacer" />
        {articlePath !== null && <PageLink vaultName={vaultName} path={articlePath} />}
        {canRevert && (
          <button
            className={`btn sm${armedRevert ? ' danger' : ''}`}
            disabled={revert.isPending}
            onClick={() => (armedRevert ? revert.mutate() : setArmedRevert(true))}
            title={job?.batch_id != null ? 'This undoes the whole batch it was part of.' : undefined}
          >
            {revert.isPending
              ? 'Reverting…'
              : armedRevert
                ? `Really revert?${job?.batch_id != null ? ' (whole batch)' : ''}`
                : 'Revert ingest'}
          </button>
        )}
      </div>
    </>
  )
}
