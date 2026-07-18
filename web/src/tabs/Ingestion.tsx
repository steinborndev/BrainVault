/**
 * Ingestion (SPEC.md §6.2) — the heart of M3. Dropzone on top, then three live sections:
 *  - Aktiv: jobs being preprocessed/ingested, each with its live agent log (DoD live log).
 *  - Warteschlange: queued jobs, cancellable.
 *  - Verlauf: finished jobs, filterable by status/type, with created-page obsidian:// links
 *             and a retry for failed/deferred jobs.
 *
 * All three come from one `['jobs']` query that the SSE `job` events invalidate live, so a
 * job visibly moves Aktiv → Verlauf on completion with no refresh (DoD).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { Job, JobStatus } from '../api/types.ts'
import { Dropzone } from '../components/Dropzone.tsx'
import { JobCard } from '../components/JobCard.tsx'

const ACTIVE: JobStatus[] = ['preprocessing', 'ingesting']
const HISTORY_FILTERS: Array<{ id: 'all' | JobStatus; label: string }> = [
  { id: 'all', label: 'Alle' },
  { id: 'done', label: 'Fertig' },
  { id: 'failed', label: 'Fehler' },
  { id: 'deferred', label: 'Zurückgestellt' },
  { id: 'duplicate', label: 'Duplikate' },
  { id: 'cancelled', label: 'Abgebrochen' },
]

export function Ingestion(): React.ReactElement {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | JobStatus>('all')
  // The vault name for obsidian:// links comes from /stats; cheap and already cached.
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  // Until stats load, assume the subscription default — marking a real cost as an estimate is
  // a harmless caption, whereas showing an estimate as a real charge would be misleading.
  const authMode = stats.data?.authMode ?? 'oauth'

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.jobs({ limit: 300 }),
  })

  const { active, queued, history } = useMemo(() => {
    const jobs = data?.jobs ?? []
    return {
      active: jobs.filter((j) => ACTIVE.includes(j.status)),
      queued: jobs.filter((j) => j.status === 'queued'),
      history: jobs.filter((j) => !ACTIVE.includes(j.status) && j.status !== 'queued'),
    }
  }, [data])

  const filteredHistory = useMemo(
    () => (filter === 'all' ? history : history.filter((j) => j.status === filter)),
    [history, filter],
  )

  const clear = useMutation({
    // Clears per the active filter: a specific status clears only that, "Alle" clears all at-rest jobs.
    mutationFn: () => api.clearHistory(filter === 'all' ? undefined : filter),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  // Two-step confirm on the button itself (no `window.confirm` — blocked/ugly in installed
  // PWAs). First click arms it for 4 s, second click clears. The vault stays untouched.
  const [confirmClear, setConfirmClear] = useState(false)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (clearTimer.current) clearTimeout(clearTimer.current)
  }, [])
  const onClear = (): void => {
    if (!confirmClear) {
      setConfirmClear(true)
      clearTimer.current = setTimeout(() => setConfirmClear(false), 4000)
      return
    }
    if (clearTimer.current) clearTimeout(clearTimer.current)
    setConfirmClear(false)
    clear.mutate()
  }

  if (isLoading) return <div className="empty">Lade Jobs…</div>
  if (isError) return <div className="empty">Jobs konnten nicht geladen werden: {(error as Error)?.message}</div>

  return (
    <div>
      <Dropzone />

      <Section title={`Aktiv${active.length ? ` (${active.length})` : ''}`}>
        {active.length === 0 ? (
          <div className="empty">Momentan läuft kein Ingest.</div>
        ) : (
          <div className="joblist">
            {active.map((j) => (
              <JobCard key={j.id} job={j} variant="active" vaultName={vaultName} authMode={authMode} />
            ))}
          </div>
        )}
      </Section>

      {queued.length > 0 && (
        <Section title={`Warteschlange (${queued.length})`}>
          <div className="joblist">
            {queued.map((j) => (
              <JobCard key={j.id} job={j} variant="queue" vaultName={vaultName} authMode={authMode} />
            ))}
          </div>
        </Section>
      )}

      <Section
        title="Verlauf"
        action={
          filteredHistory.length > 0 ? (
            <button
              className="btn ghost danger"
              disabled={clear.isPending}
              onClick={onClear}
              title="Nur der Job-Verlauf wird gelöscht — Vault und erzeugte Seiten bleiben unberührt."
            >
              {confirmClear
                ? `Wirklich ${filteredHistory.length} Einträge löschen?`
                : filter === 'all'
                  ? 'Verlauf leeren'
                  : 'Auswahl leeren'}
            </button>
          ) : undefined
        }
      >
        <div className="filters">
          {HISTORY_FILTERS.map((f) => (
            <button key={f.id} className={`chip${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label}
              {f.id !== 'all' ? ` (${history.filter((j: Job) => j.status === f.id).length})` : ''}
            </button>
          ))}
        </div>
        {filteredHistory.length === 0 ? (
          <div className="empty">Noch keine abgeschlossenen Jobs.</div>
        ) : (
          <div className="joblist">
            {filteredHistory.map((j) => (
              <JobCard key={j.id} job={j} variant="history" vaultName={vaultName} authMode={authMode} />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function Section({
  title,
  children,
  action,
}: {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="section">
      <div className="section-head">
        <h3 className="section-title">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}
