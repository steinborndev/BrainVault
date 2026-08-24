/**
 * Agent runs that are in flight RIGHT NOW, from the server's own registry rather than from
 * whichever component happened to start them.
 *
 * Why this exists: a maintenance run (research, lint, hot cache, tag fix) used to be visible
 * only inside the screen that launched it, because its state lived in that screen's
 * `useMaintenanceRun` hook. A research run was therefore invisible from Home, invisible in
 * the sidebar, and gone entirely after a reload - even though the server was still running
 * it. `GET /maintenance/runs` has always known; nothing asked.
 *
 * Polling, not SSE: run *log lines* stream, but run *lifecycle* does not have its own event,
 * and a 4 s poll of a small in-memory list is cheaper than adding one. The interval drops to
 * nothing while the tab is hidden (TanStack pauses background refetches by default).
 */

import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { MaintenanceKind, MaintenanceRun } from '../api/types.ts'

/** How often the run list is re-read while something is running. */
const POLL_MS = 4000
/** Kept slower when nothing is in flight - this is a liveness check, not a data source. */
const IDLE_POLL_MS = 15000

export interface ActiveRuns {
  /** Every run whose status is still `running`, newest first. */
  readonly running: MaintenanceRun[]
  /** Running runs of one kind - the sidebar badge asks this. */
  readonly countOf: (kind: MaintenanceKind) => number
  /** True while the list has never loaded (badges stay off rather than flicker to 0). */
  readonly loading: boolean
}

export function useActiveRuns(): ActiveRuns {
  const q = useQuery({
    queryKey: ['maintenance-runs'],
    queryFn: api.maintenanceRuns,
    refetchInterval: (query) => {
      const runs = query.state.data?.runs ?? []
      return runs.some((r) => r.status === 'running') ? POLL_MS : IDLE_POLL_MS
    },
  })
  const running = (q.data?.runs ?? []).filter((r) => r.status === 'running')
  return {
    running,
    countOf: (kind) => running.filter((r) => r.kind === kind).length,
    loading: q.data === undefined,
  }
}
