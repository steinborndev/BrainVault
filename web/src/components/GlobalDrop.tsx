/**
 * Window-level drop target (redesign 2026-08): dropping files anywhere in the app queues
 * them as one batch — before, the only drop target was one div on the Ingestion tab and a
 * miss navigated the browser away from the app. File drags only; text drags stay with the
 * Inbox intake card, which knows how to title notes.
 */

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { navigate } from '../lib/router.ts'
import { Icon } from './Icon.tsx'

type DropState =
  | { kind: 'idle' }
  | { kind: 'over' }
  | { kind: 'uploading'; count: number }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer !== null && Array.from(e.dataTransfer.types).includes('Files')
}

export function GlobalDrop(): React.ReactElement | null {
  const [state, setState] = useState<DropState>({ kind: 'idle' })
  // dragenter/dragleave fire per element crossed; the depth counter tells "left the window"
  // apart from "moved between children".
  const depth = useRef(0)
  const qc = useQueryClient()

  useEffect(() => {
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setState((s) => (s.kind === 'idle' || s.kind === 'over' ? { kind: 'over' } : s))
    }
    const onOver = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onLeave = (): void => {
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setState((s) => (s.kind === 'over' ? { kind: 'idle' } : s))
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) {
        setState({ kind: 'idle' })
        return
      }
      setState({ kind: 'uploading', count: files.length })
      api
        .uploadFiles(files)
        .then((res) => {
          void qc.invalidateQueries({ queryKey: ['jobs'] })
          void qc.invalidateQueries({ queryKey: ['stats'] })
          const dupes = res.jobs.filter((j) => j.status === 'duplicate').length
          const queued = res.jobs.length - dupes
          setState({
            kind: 'done',
            message: `${queued} queued${dupes > 0 ? ` · ${dupes} duplicate${dupes > 1 ? 's' : ''} skipped` : ''}${res.batchId !== undefined ? ' · as a batch' : ''}`,
          })
          navigate('/inbox')
          window.setTimeout(() => setState({ kind: 'idle' }), 2200)
        })
        .catch((err: Error) => {
          setState({ kind: 'error', message: err.message })
          window.setTimeout(() => setState({ kind: 'idle' }), 5000)
        })
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [qc])

  if (state.kind === 'idle') return null

  return (
    <div className={`dropveil${state.kind === 'over' ? ' over' : ''}`} role="status">
      <div className="dropveil-msg">
        <Icon name="upload" />
        {state.kind === 'over' && (
          <>
            <div className="big">Drop to ingest</div>
            <div className="small">Files land in the queue as one batch, from any screen.</div>
          </>
        )}
        {state.kind === 'uploading' && <div className="big">Uploading {state.count} file{state.count > 1 ? 's' : ''}…</div>}
        {state.kind === 'done' && <div className="big">{state.message}</div>}
        {state.kind === 'error' && (
          <>
            <div className="big">Upload failed</div>
            <div className="small">{state.message}</div>
          </>
        )}
      </div>
    </div>
  )
}
