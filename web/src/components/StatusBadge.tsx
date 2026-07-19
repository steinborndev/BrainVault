import type { JobStatus, JobType } from '../api/types.ts'

const LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  preprocessing: 'Preprocessing',
  ingesting: 'Ingesting',
  done: 'Done',
  failed: 'Failed',
  deferred: 'Deferred',
  duplicate: 'Duplicate',
  cancelled: 'Cancelled',
}

export function StatusBadge({ status }: { status: JobStatus }): React.ReactElement {
  return <span className={`badge ${status}`}>{LABELS[status]}</span>
}

export function TypeBadge({ type }: { type: JobType }): React.ReactElement {
  return <span className="badge type">{type}</span>
}
