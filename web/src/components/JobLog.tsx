/**
 * The live agent log for one job (the DoD's "live log"): seeds from the job's persisted
 * lines and appends SSE `log` events in real time (useJobLog). Auto-scrolls to the newest
 * line while the user is at the bottom; leaves scroll alone if they've scrolled up to read.
 */

import { useEffect, useRef } from 'react'
import { useJobLog } from '../hooks/useJobLog.ts'

export function JobLog({ jobId, seed = true }: { jobId: string; seed?: boolean }): React.ReactElement {
  const lines = useJobLog(jobId, { seed })
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const onScroll = (): void => {
    const el = ref.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div className="log" ref={ref} onScroll={onScroll}>
      {lines.length === 0 ? (
        <div className="log-empty">Warte auf Log-Ausgabe…</div>
      ) : (
        lines.map((l, i) => (
          <div key={`${l.ts}-${i}`} className={`log-line ${l.level}`}>
            <span className="lt">{l.ts.slice(11, 19)}</span>
            <span className="lm">{l.message}</span>
          </div>
        ))
      )}
    </div>
  )
}
