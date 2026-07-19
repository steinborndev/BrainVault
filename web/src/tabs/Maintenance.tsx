/**
 * Wartung tab (SPEC.md §6.4): Lint (structured report), Autoresearch (web-enabled), and a
 * Hot-Cache refresh. Each triggers a vault-mutating agent run on the backend. Runs are
 * async/job-style (TASKS-M5 §0): the POST returns a run id at once, we poll its result via
 * `GET /maintenance/runs/:id`, and the live log streams over the `maintenance:<kind>` SSE
 * channel (rendered via JobLog with seeding off), plus the settings editor.
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type {
  LintReport,
  MaintenanceResult,
  DomainCandidate,
  DomainReviewEntry,
  CandidatesResponse,
} from '../api/types.ts'
import { JobLog } from '../components/JobLog.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { PageLink, PageLinks } from '../components/PageLink.tsx'
import { SettingsEditor } from '../components/SettingsEditor.tsx'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'
import { Icon } from '../components/Icon.tsx'
import { timeAgo } from '../lib/format.ts'

export function Maintenance(): React.ReactElement {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'

  const [topic, setTopic] = useState('')
  const lint = useMaintenanceRun(() => api.lint())
  const hot = useMaintenanceRun(() => api.hotCache())
  const research = useMaintenanceRun(() => api.research(topic.trim()))
  const backfill = useMaintenanceRun(() => api.domainBackfill())
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  // How much of the vault is still unfiled — the number that says whether a backfill is due.
  const undomained = graph.data?.nodes.filter((n) => n.domain === null).length ?? 0

  return (
    <div>
      {/* Lint */}
      <div className="card card-pad section">
        <div className="section-head">
          <h3 className="section-title">Lint — wiki health</h3>
          <button className="btn primary" disabled={lint.running} onClick={lint.start}>
            {lint.running ? 'Running…' : 'Start lint'}
          </button>
        </div>
        <p className="tab-hint">
          Finds orphans, dead links, stale claims and missing cross-links; writes a report into the vault.
        </p>
        {lint.running && <JobLog jobId="maintenance:lint" seed={false} />}
        {lint.error && <div className="toast err">{lint.error}</div>}
        {lint.result?.ok && lint.result.lint && (
          <LintView report={lint.result.lint} reportPath={lint.result.reportPath} vaultName={vaultName} />
        )}
        {lint.result?.ok && !lint.result.lint && lint.result.answer && (
          <div className="md-fallback">
            <Markdown source={lint.result.answer} />
          </div>
        )}
      </div>

      {/* Autoresearch */}
      <div className="card card-pad section">
        <div className="section-head">
          <h3 className="section-title">Autoresearch</h3>
        </div>
        <p className="tab-hint">Researches a topic with web access and creates new source/concept pages.</p>
        <div className="url-row">
          <input
            type="text"
            placeholder="Topic, e.g. “Sourdough fermentation chemistry”…"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && topic.trim() && !research.running) research.start()
            }}
          />
          <button className="btn primary" disabled={!topic.trim() || research.running} onClick={research.start}>
            {research.running ? 'Running…' : 'Research'}
          </button>
        </div>
        {research.running && <JobLog jobId="maintenance:research" seed={false} />}
        {research.error && <div className="toast err">{research.error}</div>}
        {research.result && <RunResult result={research.result} vaultName={vaultName} label="New/updated pages" />}
      </div>

      {/* Hot cache */}
      <div className="card card-pad section">
        <div className="section-head">
          <h3 className="section-title">Hot cache</h3>
          <button className="btn" disabled={hot.running} onClick={hot.start}>
            {hot.running ? 'Running…' : 'Refresh'}
          </button>
        </div>
        <p className="tab-hint">
          Refreshes <code>wiki/hot.md</code> (faster context for future runs).
          {' '}
          {/* "Anzeige des letzten Refresh-Zeitpunkts" (SPEC.md §6.4) — the file's mtime. */}
          {stats.data?.hotCacheUpdatedAt ? (
            <>Last refresh: <strong title={new Date(stats.data.hotCacheUpdatedAt).toLocaleString('en-US')}>{timeAgo(stats.data.hotCacheUpdatedAt)}</strong>.</>
          ) : (
            <>Never refreshed.</>
          )}
        </p>
        {hot.running && <JobLog jobId="maintenance:hot-cache" seed={false} />}
        {hot.error && <div className="toast err">{hot.error}</div>}
        {hot.result && <RunResult result={hot.result} vaultName={vaultName} label="Refreshed" />}
      </div>

      {/* Domain registry + backfill (SPEC §12.4 Stufe 2) */}
      <div className="card card-pad section">
        <div className="section-head">
          <h3 className="section-title">Domains</h3>
          <button
            className="btn"
            disabled={backfill.running || !domains.data?.installed}
            onClick={backfill.start}
            title={domains.data?.installed ? 'File existing pages into domains' : 'No registry installed'}
          >
            {backfill.running ? 'Running…' : 'Start backfill'}
          </button>
        </div>
        {domains.data?.installed === false ? (
          <p className="tab-hint">
            No domain registry in the vault. Create it with{' '}
            <code>scripts/install-domain-registry.sh</code> — afterwards it's editable as{' '}
            <PageLink path={domains.data.path} vaultName={vaultName} />.
          </p>
        ) : (
          <>
            <p className="tab-hint">
              The meta-categories pages are filed under — maintained in{' '}
              {domains.data && <PageLink path={domains.data.path} vaultName={vaultName} />}. Every ingest gets
              this list as a closed set; when nothing fits, <code>unassigned</code> is used. The backfill files
              existing pages without touching page content.
              {undomained > 0 && (
                <>
                  {' '}Currently <strong>{undomained}</strong> page{undomained === 1 ? '' : 's'} without a domain.
                </>
              )}
            </p>
            <div className="filters">
              {domains.data?.domains.map((d) => (
                <span key={d.key} className="chip" title={d.description}>
                  {d.key}
                </span>
              ))}
            </div>
          </>
        )}
        {backfill.running && <JobLog jobId="maintenance:domain-backfill" seed={false} />}
        {backfill.error && <div className="toast err">{backfill.error}</div>}
        {backfill.result && <RunResult result={backfill.result} vaultName={vaultName} label="Filed" />}
        {domains.data?.installed && <DomainCandidates vaultName={vaultName} />}
      </div>

      <div className="card card-pad section">
        <h3 className="section-title">Settings</h3>
        <SettingsEditor />
      </div>
    </div>
  )
}

/**
 * The governance loop's UI (SPEC §12.4 Stufe 3). The candidate list itself is deterministic and
 * free, so it simply renders — no "start analysis" needed. The agent pass is opt-in via the
 * toggle: it only JUDGES what the finder already surfaced, and costs a real agent run.
 *
 * Creating a domain is deliberately a user action here; agents may never coin a key.
 */
function DomainCandidates({ vaultName }: { vaultName: string }): React.ReactElement | null {
  const qc = useQueryClient()
  const candidates = useQuery({ queryKey: ['domain-candidates'], queryFn: api.domainCandidates })
  const [withAgent, setWithAgent] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const review = useMaintenanceRun(() => api.domainReview())

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['domain-candidates'] })
    void qc.invalidateQueries({ queryKey: ['domains'] })
    void qc.invalidateQueries({ queryKey: ['graph'] })
  }

  const data: CandidatesResponse | undefined = candidates.data
  if (!data) return null

  // Verdicts from the optional agent pass, keyed by candidate.
  const verdicts = new Map<string, DomainReviewEntry>(
    (review.result?.domainReview?.entries ?? []).map((e) => [e.candidate, e]),
  )

  const start = (): void => {
    if (withAgent) review.start()
    else refresh()
  }

  return (
    <div className="domain-candidates">
      <div className="section-head">
        <h4 className="section-title">Candidates for new domains</h4>
        <div className="candidate-actions">
          <label className="toggle" title="Additionally have an agent judge the candidates (costs one run)">
            <input type="checkbox" checked={withAgent} onChange={(e) => setWithAgent(e.target.checked)} />
            With agent review
          </label>
          <button className="btn" disabled={review.running || (withAgent && data.candidates.length === 0)} onClick={start}>
            {review.running ? 'Running…' : 'Check candidates'}
          </button>
        </div>
      </div>

      <p className="tab-hint">
        Topics among the <code>unassigned</code> pages large enough for a domain of their own ({data.threshold}+
        pages). {data.unassignedCount} page{data.unassignedCount === 1 ? '' : 's'} without a fitting domain.
        {data.undomainedCount > 0 && (
          <>
            {' '}
            <strong>{data.undomainedCount}</strong> page{data.undomainedCount === 1 ? '' : 's'} carry no domain
            field at all — that's what the backfill is for; until then this analysis is incomplete.
          </>
        )}
      </p>

      {review.running && <JobLog jobId="maintenance:domain-review" seed={false} />}
      {review.error && <div className="toast err">{review.error}</div>}
      {review.result && !review.result.domainReview && review.result.answer && (
        <div className="md-fallback">
          <Markdown source={review.result.answer} />
        </div>
      )}

      {data.candidates.length === 0 ? (
        <p className="empty-inline">
          No candidates. New domains emerge once enough thematically related pages accumulate that no existing
          domain fits.
        </p>
      ) : (
        <div className="candidate-list">
          {data.candidates.map((c) => (
            <CandidateCard
              key={c.key}
              candidate={c}
              verdict={verdicts.get(c.key)}
              vaultName={vaultName}
              editing={editing === c.key}
              onEdit={() => setEditing(editing === c.key ? null : c.key)}
              onDone={() => {
                setEditing(null)
                refresh()
              }}
            />
          ))}
        </div>
      )}

      {data.dismissed.length > 0 && (
        <p className="tab-hint">
          Dismissed:{' '}
          {data.dismissed.map((d, i) => (
            <span key={d.key}>
              {i > 0 && ', '}
              <button
                className="linkish"
                title="Propose again"
                onClick={() => void api.restoreCandidate(d.key).then(refresh)}
              >
                {d.key}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

const VERDICT_LABEL: Record<string, string> = {
  'new-domain': 'Agent: own domain',
  existing: 'Agent: belongs to an existing domain',
  'not-a-domain': 'Agent: not a domain',
}

function CandidateCard({
  candidate,
  verdict,
  vaultName,
  editing,
  onEdit,
  onDone,
}: {
  candidate: DomainCandidate
  verdict: DomainReviewEntry | undefined
  vaultName: string
  editing: boolean
  onEdit: () => void
  onDone: () => void
}): React.ReactElement {
  // The agent's proposal pre-fills the form when it has one; otherwise the candidate tag does.
  const [key, setKey] = useState(verdict?.key ?? candidate.key)
  const [description, setDescription] = useState(verdict?.description ?? '')
  const [tags, setTags] = useState((verdict?.tags ?? candidate.tags).join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = (): void => {
    setBusy(true)
    setError(null)
    void api
      .createDomain({
        key: key.trim().toLowerCase(),
        description: description.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        dismissCandidate: candidate.key,
      })
      .then(onDone)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  return (
    <div className="candidate card card-pad">
      <div className="candidate-head">
        <strong>{candidate.key}</strong>
        <span className="candidate-meta">
          {candidate.pageCount} pages · {Math.round(candidate.cohesion * 100)}% linked
        </span>
        {verdict && <span className={`chip verdict-${verdict.verdict}`}>{VERDICT_LABEL[verdict.verdict]}</span>}
      </div>

      {candidate.tags.length > 1 && <p className="tab-hint">Tags: {candidate.tags.join(', ')}</p>}
      {verdict?.reason && <p className="tab-hint">{verdict.reason}</p>}
      {verdict?.verdict === 'existing' && verdict.existing && (
        <p className="tab-hint">
          Suggestion: file these pages under <code>{verdict.existing}</code> — edit the pages or run a
          backfill to do so.
        </p>
      )}

      <PageLinks paths={candidate.pages.map((p) => p.path)} vaultName={vaultName} />

      {editing ? (
        <div className="candidate-form">
          <label>
            Key
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. history" />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this domain cover?"
            />
          </label>
          <label>
            Tags (comma-separated)
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          {error && <div className="toast err">{error}</div>}
          <div className="candidate-actions">
            <button className="btn primary" disabled={busy || !key.trim() || !description.trim()} onClick={create}>
              {busy ? 'Creating…' : 'Create domain'}
            </button>
            <button className="btn ghost" onClick={onEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="candidate-actions">
          <button className="btn" onClick={onEdit}>
            Create as domain
          </button>
          <button
            className="btn ghost"
            title="Stop proposing this"
            onClick={() => void api.dismissCandidate(candidate.key).then(onDone)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

function LintView({ report, reportPath, vaultName }: { report: LintReport; reportPath: string | undefined; vaultName: string }): React.ReactElement {
  return (
    <div>
      <div className="grid kpis" style={{ marginBottom: 14 }}>
        {Object.entries(report.summary).map(([k, v]) => (
          <div key={k} className="stat card">
            <div className="value">{v}</div>
            <div className="sub">{k}</div>
          </div>
        ))}
      </div>
      {report.totalFindings === 0 ? (
        <div className="empty">
          <Icon name="check" /> No findings — the wiki is clean.
        </div>
      ) : (
        report.sections.map((s) => (
          <div key={s.title} className="lint-section">
            <h4>
              {s.title} <span className="count">{s.findings.length}</span>
            </h4>
            <ul className="lint-findings">
              {s.findings.map((f, i) => (
                <li key={i}>
                  {f.page?.path ? <PageLink vaultName={vaultName} path={f.page.path} /> : f.page ? <strong>{f.page.label}</strong> : null}
                  <span className="lint-text">{f.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {reportPath && (
        <div className="job-meta" style={{ marginTop: 8 }}>
          <span>Report: <code>{reportPath}</code></span>
        </div>
      )}
    </div>
  )
}

function RunResult({ result, vaultName, label }: { result: MaintenanceResult; vaultName: string; label: string }): React.ReactElement {
  if (!result.ok) return <div className="toast err">{result.error ?? 'Failed'}</div>
  return (
    <div className="toast ok">
      {label}
      {result.pages.length > 0 ? <PageLinks vaultName={vaultName} paths={result.pages} /> : <> — no changes.</>}
    </div>
  )
}
