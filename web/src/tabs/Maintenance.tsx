/**
 * Wartung tab (SPEC.md §6.4): Lint (structured report), Autoresearch (web-enabled), and a
 * Hot-Cache refresh. Each triggers a vault-mutating agent run on the backend; while it runs,
 * the live log streams over the `maintenance:<kind>` SSE channel (rendered via JobLog with
 * seeding off). Settings are M5 — this tab shows only a read-only note for them.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { LintReport, MaintenanceResult } from '../api/types.ts'
import { JobLog } from '../components/JobLog.tsx'
import { PageLink, PageLinks } from '../components/PageLink.tsx'

export function Maintenance(): React.ReactElement {
  const qc = useQueryClient()
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: ['stats'] })
  }

  const lint = useMutation({ mutationFn: () => api.lint(), onSuccess: invalidate })
  const hot = useMutation({ mutationFn: () => api.hotCache(), onSuccess: invalidate })
  const [topic, setTopic] = useState('')
  const research = useMutation({ mutationFn: (t: string) => api.research(t), onSuccess: invalidate })

  return (
    <div>
      {/* Lint */}
      <div className="card card-pad section">
        <div className="section-head">
          <h3 className="section-title">Lint — Wiki-Gesundheit</h3>
          <button className="btn primary" disabled={lint.isPending} onClick={() => lint.mutate()}>
            {lint.isPending ? 'Läuft…' : 'Lint starten'}
          </button>
        </div>
        <p className="tab-hint">
          Findet Orphans, tote Links, stale Claims und fehlende Cross-Links; schreibt einen Bericht in den Vault.
        </p>
        {lint.isPending && <JobLog jobId="maintenance:lint" seed={false} />}
        {lint.isError && <div className="toast err">{(lint.error as Error).message}</div>}
        {lint.data?.ok && lint.data.lint && <LintView report={lint.data.lint} reportPath={lint.data.reportPath} vaultName={vaultName} />}
        {lint.data && !lint.data.ok && <div className="toast err">{lint.data.error ?? 'Lint fehlgeschlagen'}</div>}
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
              if (e.key === 'Enter' && topic.trim()) research.mutate(topic.trim())
            }}
          />
          <button className="btn primary" disabled={!topic.trim() || research.isPending} onClick={() => research.mutate(topic.trim())}>
            {research.isPending ? 'Läuft…' : 'Recherchieren'}
          </button>
        </div>
        {research.isPending && <JobLog jobId="maintenance:research" seed={false} />}
        {research.isError && <div className="toast err">{(research.error as Error).message}</div>}
        {research.data && <RunResult result={research.data} vaultName={vaultName} label="Neue/aktualisierte Seiten" />}
      </div>

      {/* Hot cache */}
      <div className="card card-pad section">
        <div className="section-head">
          <h3 className="section-title">Hot Cache</h3>
          <button className="btn" disabled={hot.isPending} onClick={() => hot.mutate()}>
            {hot.isPending ? 'Läuft…' : 'Aktualisieren'}
          </button>
        </div>
        <p className="tab-hint">Frischt <code>wiki/hot.md</code> auf (schnellerer Kontext für künftige Läufe).</p>
        {hot.isPending && <JobLog jobId="maintenance:hot-cache" seed={false} />}
        {hot.data && <RunResult result={hot.data} vaultName={vaultName} label="Aktualisiert" />}
      </div>

      <div className="card card-pad section">
        <h3 className="section-title">Einstellungen</h3>
        <p className="tab-hint">
          Watch-Ordner, Parallelität, Datei-Limits und Git-Verhalten werden in Milestone&nbsp;5 als Editor ergänzt.
        </p>
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
        <div className="empty">Keine Befunde — das Wiki ist sauber. 🎉</div>
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
