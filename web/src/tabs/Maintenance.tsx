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
          <h3 className="section-title">Lint — Wiki-Gesundheit</h3>
          <button className="btn primary" disabled={lint.running} onClick={lint.start}>
            {lint.running ? 'Läuft…' : 'Lint starten'}
          </button>
        </div>
        <p className="tab-hint">
          Findet Orphans, tote Links, stale Claims und fehlende Cross-Links; schreibt einen Bericht in den Vault.
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
        <p className="tab-hint">Recherchiert ein Thema mit Web-Zugriff und legt neue Quellen-/Konzeptseiten an.</p>
        <div className="url-row">
          <input
            type="text"
            placeholder="Thema, z. B. „Sourdough fermentation chemistry“…"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && topic.trim() && !research.running) research.start()
            }}
          />
          <button className="btn primary" disabled={!topic.trim() || research.running} onClick={research.start}>
            {research.running ? 'Läuft…' : 'Recherchieren'}
          </button>
        </div>
        {research.running && <JobLog jobId="maintenance:research" seed={false} />}
        {research.error && <div className="toast err">{research.error}</div>}
        {research.result && <RunResult result={research.result} vaultName={vaultName} label="Neue/aktualisierte Seiten" />}
      </div>

      {/* Hot cache */}
      <div className="card card-pad section">
        <div className="section-head">
          <h3 className="section-title">Hot Cache</h3>
          <button className="btn" disabled={hot.running} onClick={hot.start}>
            {hot.running ? 'Läuft…' : 'Aktualisieren'}
          </button>
        </div>
        <p className="tab-hint">
          Frischt <code>wiki/hot.md</code> auf (schnellerer Kontext für künftige Läufe).
          {' '}
          {/* "Anzeige des letzten Refresh-Zeitpunkts" (SPEC.md §6.4) — the file's mtime. */}
          {stats.data?.hotCacheUpdatedAt ? (
            <>Letzter Refresh: <strong title={new Date(stats.data.hotCacheUpdatedAt).toLocaleString('de-DE')}>{timeAgo(stats.data.hotCacheUpdatedAt)}</strong>.</>
          ) : (
            <>Noch nie aktualisiert.</>
          )}
        </p>
        {hot.running && <JobLog jobId="maintenance:hot-cache" seed={false} />}
        {hot.error && <div className="toast err">{hot.error}</div>}
        {hot.result && <RunResult result={hot.result} vaultName={vaultName} label="Aktualisiert" />}
      </div>

      {/* Domain registry + backfill (SPEC §12.4 Stufe 2) */}
      <div className="card card-pad section">
        <div className="section-head">
          <h3 className="section-title">Domänen</h3>
          <button
            className="btn"
            disabled={backfill.running || !domains.data?.installed}
            onClick={backfill.start}
            title={domains.data?.installed ? 'Bestandsseiten einsortieren' : 'Keine Registry installiert'}
          >
            {backfill.running ? 'Läuft…' : 'Backfill starten'}
          </button>
        </div>
        {domains.data?.installed === false ? (
          <p className="tab-hint">
            Keine Domänen-Registry im Vault. Anlegen mit{' '}
            <code>scripts/install-domain-registry.sh</code> — danach steht sie als{' '}
            <PageLink path={domains.data.path} vaultName={vaultName} /> zum Bearbeiten bereit.
          </p>
        ) : (
          <>
            <p className="tab-hint">
              Die Meta-Kategorien, unter denen Seiten abgelegt werden — gepflegt in{' '}
              {domains.data && <PageLink path={domains.data.path} vaultName={vaultName} />}. Jeder Ingest bekommt
              diese Liste als geschlossene Vorgabe; passt nichts, wird <code>unassigned</code> gesetzt. Der Backfill
              sortiert Bestandsseiten nach, ohne Seiteninhalte anzufassen.
              {undomained > 0 && (
                <>
                  {' '}Aktuell <strong>{undomained}</strong> Seite{undomained === 1 ? '' : 'n'} ohne Domäne.
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
        {backfill.result && <RunResult result={backfill.result} vaultName={vaultName} label="Einsortiert" />}
        {domains.data?.installed && <DomainCandidates vaultName={vaultName} />}
      </div>

      <div className="card card-pad section">
        <h3 className="section-title">Einstellungen</h3>
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
        <h4 className="section-title">Kandidaten für neue Domänen</h4>
        <div className="candidate-actions">
          <label className="toggle" title="Kandidaten zusätzlich von einem Agenten bewerten lassen (kostet einen Lauf)">
            <input type="checkbox" checked={withAgent} onChange={(e) => setWithAgent(e.target.checked)} />
            Mit Agent-Bewertung
          </label>
          <button className="btn" disabled={review.running || (withAgent && data.candidates.length === 0)} onClick={start}>
            {review.running ? 'Läuft…' : 'Kandidaten prüfen'}
          </button>
        </div>
      </div>

      <p className="tab-hint">
        Themen unter den <code>unassigned</code>-Seiten, die groß genug für eine eigene Domäne wären (ab{' '}
        {data.threshold} Seiten). {data.unassignedCount} Seite{data.unassignedCount === 1 ? '' : 'n'} ohne
        passende Domäne.
        {data.undomainedCount > 0 && (
          <>
            {' '}
            <strong>{data.undomainedCount}</strong> Seite{data.undomainedCount === 1 ? '' : 'n'} tragen noch gar
            kein Domänen-Feld — dafür ist der Backfill zuständig, bis dahin ist die Analyse unvollständig.
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
          Keine Kandidaten. Neue Domänen entstehen, sobald sich genug thematisch verwandte Seiten sammeln, für
          die keine bestehende Domäne passt.
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
          Verworfen:{' '}
          {data.dismissed.map((d, i) => (
            <span key={d.key}>
              {i > 0 && ', '}
              <button
                className="linkish"
                title="Wieder vorschlagen"
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
  'new-domain': 'Agent: eigene Domäne',
  existing: 'Agent: gehört zu einer bestehenden Domäne',
  'not-a-domain': 'Agent: keine Domäne',
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
          {candidate.pageCount} Seiten · {Math.round(candidate.cohesion * 100)}% verlinkt
        </span>
        {verdict && <span className={`chip verdict-${verdict.verdict}`}>{VERDICT_LABEL[verdict.verdict]}</span>}
      </div>

      {candidate.tags.length > 1 && <p className="tab-hint">Tags: {candidate.tags.join(', ')}</p>}
      {verdict?.reason && <p className="tab-hint">{verdict.reason}</p>}
      {verdict?.verdict === 'existing' && verdict.existing && (
        <p className="tab-hint">
          Vorschlag: diese Seiten unter <code>{verdict.existing}</code> einsortieren — dafür die Seiten
          bearbeiten oder einen Backfill laufen lassen.
        </p>
      )}

      <PageLinks paths={candidate.pages.map((p) => p.path)} vaultName={vaultName} />

      {editing ? (
        <div className="candidate-form">
          <label>
            Schlüssel
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="z. B. history" />
          </label>
          <label>
            Beschreibung
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Was deckt diese Domäne ab?"
            />
          </label>
          <label>
            Tags (kommagetrennt)
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          {error && <div className="toast err">{error}</div>}
          <div className="candidate-actions">
            <button className="btn primary" disabled={busy || !key.trim() || !description.trim()} onClick={create}>
              {busy ? 'Wird angelegt…' : 'Domäne anlegen'}
            </button>
            <button className="btn ghost" onClick={onEdit}>
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        <div className="candidate-actions">
          <button className="btn" onClick={onEdit}>
            Als Domäne anlegen
          </button>
          <button
            className="btn ghost"
            title="Nicht mehr vorschlagen"
            onClick={() => void api.dismissCandidate(candidate.key).then(onDone)}
          >
            Verwerfen
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
          <Icon name="check" /> Keine Befunde — das Wiki ist sauber.
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
          <span>Bericht: <code>{reportPath}</code></span>
        </div>
      )}
    </div>
  )
}

function RunResult({ result, vaultName, label }: { result: MaintenanceResult; vaultName: string; label: string }): React.ReactElement {
  if (!result.ok) return <div className="toast err">{result.error ?? 'Fehlgeschlagen'}</div>
  return (
    <div className="toast ok">
      {label}
      {result.pages.length > 0 ? <PageLinks vaultName={vaultName} paths={result.pages} /> : <> — keine Änderungen.</>}
    </div>
  )
}
