/**
 * The SSE client hook (TASKS-M3 §2) — subscribes once to `/api/v1/events` and turns the
 * live bus into React-Query invalidations + live log appends:
 *
 *  - `job`   → invalidate the jobs list and this job's detail; a terminal status also
 *              refreshes stats (counts changed).
 *  - `log`   → merge the line into the live log store (the DoD's streaming agent log).
 *  - `stats` → invalidate stats (a commit landed; page counts/history changed).
 *
 * EventSource reconnects on its own (the server sends `retry:`), so there's no manual
 * backoff here. `connected` is surfaced so the shell can show a live/offline indicator.
 */

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { logStore } from '../lib/logStore.ts'
import type { BusEvent } from '../api/types.ts'

const TERMINAL = new Set(['done', 'failed', 'deferred', 'duplicate', 'cancelled'])

export function useEvents(): { connected: boolean } {
  const qc = useQueryClient()
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const es = new EventSource('/api/v1/events')

    // Events emitted while the stream was down are gone for good (no server-side replay), so a
    // reconnect — laptop sleep, Wi-Fi blip, server restart — must resync by refetch or the UI
    // silently diverges until the user reloads. Same for a mobile PWA resumed from background.
    const resync = (): void => {
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['sessions'] })
    }
    let hadGap = false
    es.onopen = () => {
      setConnected(true)
      if (hadGap) {
        hadGap = false
        resync()
      }
    }
    es.onerror = () => {
      hadGap = true
      setConnected(false) // EventSource will retry automatically
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') resync()
    }
    document.addEventListener('visibilitychange', onVisible)

    const onJob = (ev: MessageEvent): void => {
      const { job } = JSON.parse(ev.data) as Extract<BusEvent, { kind: 'job' }>
      qc.invalidateQueries({ queryKey: ['jobs'] })
      qc.invalidateQueries({ queryKey: ['job', job.id] })
      if (TERMINAL.has(job.status)) qc.invalidateQueries({ queryKey: ['stats'] })
    }

    const onLog = (ev: MessageEvent): void => {
      const { log } = JSON.parse(ev.data) as Extract<BusEvent, { kind: 'log' }>
      logStore.merge(log.jobId, [{ ts: log.ts, level: log.level, message: log.message }])
    }

    const onStats = (): void => {
      qc.invalidateQueries({ queryKey: ['stats'] })
    }

    es.addEventListener('job', onJob)
    es.addEventListener('log', onLog)
    es.addEventListener('stats', onStats)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      es.removeEventListener('job', onJob)
      es.removeEventListener('log', onLog)
      es.removeEventListener('stats', onStats)
      es.close()
    }
  }, [qc])

  return { connected }
}
