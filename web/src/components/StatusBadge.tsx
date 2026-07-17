import type { JobStatus, JobType } from '../api/types.ts'

const LABELS: Record<JobStatus, string> = {
  queued: 'Warteschlange',
  preprocessing: 'Preprocessing',
  ingesting: 'Ingest läuft',
  done: 'Fertig',
  failed: 'Fehler',
  deferred: 'Zurückgestellt',
  duplicate: 'Duplikat',
  cancelled: 'Abgebrochen',
}

export function StatusBadge({ status }: { status: JobStatus }): React.ReactElement {
  return <span className={`badge ${status}`}>{LABELS[status]}</span>
}

export function TypeBadge({ type }: { type: JobType }): React.ReactElement {
  return <span className="badge type">{type}</span>
}
