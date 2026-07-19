/**
 * Wartung tab (SPEC.md §6.4): Lint (structured report), Autoresearch (web-enabled), and a
 * Hot-Cache refresh. Each triggers a vault-mutating agent run on the backend. Runs are
 * async/job-style (TASKS-M5 §0): the POST returns a run id at once, we poll its result via
 * `GET /maintenance/runs/:id`, and the live log streams over the `maintenance:<kind>` SSE
 * channel (rendered via JobLog with seeding off), plus the settings editor.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { LintReport, MaintenanceResult } from '../api/types.ts'
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
      </div>

      <div className="card card-pad section">
        <h3 className="section-title">Einstellungen</h3>
        <SettingsEditor />
      </div>
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
