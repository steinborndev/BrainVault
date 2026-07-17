/**
 * Live view of one job's log: seeds the store once with the job's persisted lines, then
 * re-renders as SSE `log` events merge in. Seeding is cheap (one fetch) and idempotent with
 * the live stream (dedup in logStore), so this works both for a running job (mostly live)
 * and a finished one in the history (mostly seeded).
 */

import { useEffect, useSyncExternalStore } from 'react'
import { logStore } from '../lib/logStore.ts'
import { api } from '../api/client.ts'
import type { JobLogLine } from '../api/types.ts'

export function useJobLog(jobId: string, opts: { seed?: boolean } = {}): JobLogLine[] {
  const lines = useSyncExternalStore(
    (cb) => logStore.subscribe(jobId, cb),
    () => logStore.snapshot(jobId),
  )

  const seed = opts.seed ?? true
  useEffect(() => {
    if (!seed) return
    let cancelled = false
    api
      .job(jobId)
      .then((detail) => {
        if (!cancelled) logStore.merge(jobId, detail.logs)
      })
      .catch(() => {
        /* the live stream still works even if the seed fetch fails */
      })
    return () => {
      cancelled = true
    }
  }, [jobId, seed])

  return lines
}
