/**
 * Start + poll for the server's async vault-mutating runs (lint, autoresearch, hot-cache and
 * the chat's "Session in Vault sichern"). The POST returns a run id immediately and the live log
 * streams over SSE; this polls `GET /maintenance/runs/:id` until the run settles, so a long run
 * can never hold an HTTP request open (TASKS-M5 §0).
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { MaintenanceResult, MaintenanceRun } from '../api/types.ts'

export interface MaintenanceRunState {
  start: () => void
  /** True from the POST until the polled run settles to done/error. */
  running: boolean
  /** The settled run (with `result`) once polling completes. */
  run: MaintenanceRun | undefined
  /** The final result, or undefined while running / on a start failure. */
  result: MaintenanceResult | undefined
  /** A start (POST) failure, or the run's own failure reason once settled. */
  error: string | null
  /** Clears the last outcome (e.g. when switching to another chat session). */
  reset: () => void
}

/**
 * `starter` may close over component state (e.g. the research topic or the active session id) -
 * it is read fresh at click time, not captured once.
 */
export function useMaintenanceRun(starter: () => Promise<MaintenanceRun>): MaintenanceRunState {
  const qc = useQueryClient()
  const [runId, setRunId] = useState<string | null>(null)

  const start = useMutation({
    mutationFn: starter,
    onSuccess: (run) => {
      setRunId(run.id)
      // The tab badges read the server's run registry, which polls every 15 s while idle.
      // Without this the badge for a run you just started appeared up to fifteen seconds
      // after the click - long enough to read as "nothing happened".
      qc.invalidateQueries({ queryKey: ['maintenance-runs'] })
    },
  })

  const poll = useQuery({
    queryKey: ['maintenance-run', runId],
    queryFn: () => api.maintenanceRun(runId as string),
    enabled: runId !== null,
    // Poll while the run is in flight; stop once it settles.
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'running' ? false : 1000),
  })

  const settled = poll.data !== undefined && poll.data.status !== 'running'
  useEffect(() => {
    // A settled run may have committed pages / refreshed the hot cache - refresh stats and
    // the per-kind settle state that feeds the status head (SPEC §12.7 Stufe b). The graph
    // and domain queries refresh too: the guided run's later steps derive their decision
    // data from them, and the dependency ordering the wizard exists for only holds when a
    // backfill's result is visible to the domain/tag steps that follow it.
    if (settled) {
      qc.invalidateQueries({ queryKey: ['stats'] })
      qc.invalidateQueries({ queryKey: ['maintenance-state'] })
      // …and the same registry on the way out, so the badge clears on settle rather than
      // on the next poll.
      qc.invalidateQueries({ queryKey: ['maintenance-runs'] })
      // The run just wrote its own row in the persistent log (schema v12) - the research
      // run list reads from there.
      qc.invalidateQueries({ queryKey: ['maintenance-history'] })
      qc.invalidateQueries({ queryKey: ['graph'] })
      qc.invalidateQueries({ queryKey: ['domains'] })
      qc.invalidateQueries({ queryKey: ['domain-candidates'] })
    }
  }, [settled, qc])

  const running =
    start.isPending || (runId !== null && (poll.data === undefined || poll.data.status === 'running'))
  const startError = start.error ? (start.error as Error).message : null
  const runError = settled && poll.data?.status === 'error' ? poll.data.error ?? 'Failed' : null

  return {
    start: () => start.mutate(),
    running,
    run: settled ? poll.data : undefined,
    result: settled ? poll.data?.result : undefined,
    error: startError ?? runError,
    reset: () => {
      setRunId(null)
      start.reset()
    },
  }
}
