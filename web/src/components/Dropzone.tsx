/**
 * The ingestion entry point (SPEC.md §6.2, TASKS-M3 §4): drag-and-drop files, browse, or
 * paste a URL / text. Multiple files in one drop go up as a batch (the server groups them).
 * Shows accepted/duplicate/error feedback. The size cap is enforced server-side (a 413
 * surfaces here as an error toast), so the UI doesn't hardcode the limit.
 */

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type EnqueueResult } from '../api/client.ts'
import { Icon } from './Icon.tsx'

type Toast = { kind: 'ok' | 'err'; text: string } | null

function summarize(res: EnqueueResult): string {
  const dupes = res.jobs.filter((j) => j.status === 'duplicate' || j.duplicateOf).length
  const fresh = res.jobs.length - dupes
  const parts: string[] = []
  if (fresh > 0) parts.push(`${fresh} in Warteschlange`)
  if (dupes > 0) parts.push(`${dupes} Duplikat${dupes > 1 ? 'e' : ''} übersprungen`)
  if (res.batchId) parts.push('als Batch')
  return parts.join(' · ') || 'Angenommen'
}

export function Dropzone(): React.ReactElement {
  const qc = useQueryClient()
  const [over, setOver] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [url, setUrl] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: ['jobs'] })
  }

  const upload = useMutation({
    mutationFn: (files: File[]) => api.uploadFiles(files),
    onSuccess: (res) => {
      setToast({ kind: 'ok', text: summarize(res) })
      invalidate()
    },
    onError: (e: Error) => setToast({ kind: 'err', text: e.message }),
  })

  const submit = useMutation({
    mutationFn: (value: string) =>
      /^https?:\/\//i.test(value.trim()) ? api.submitUrl(value.trim()) : api.submitText(value),
    onSuccess: (res) => {
      setToast({ kind: 'ok', text: summarize(res) })
      setUrl('')
      invalidate()
    },
    onError: (e: Error) => setToast({ kind: 'err', text: e.message }),
  })

  // The server's per-file cap, for a pre-check: warning before the upload beats decoding a
  // 413 after streaming 200 MB. The server still enforces the limit either way.
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const maxBytes = health.data?.limits?.maxUploadBytes

  const takeFiles = (files: File[]): void => {
    if (files.length === 0) return
    if (maxBytes !== undefined) {
      const oversized = files.filter((f) => f.size > maxBytes)
      if (oversized.length > 0) {
        const mb = Math.round(maxBytes / 1024 / 1024)
        setToast({
          kind: 'err',
          text: `${oversized.map((f) => f.name).join(', ')}: über dem Limit von ${mb} MB — nicht hochgeladen`,
        })
        files = files.filter((f) => f.size <= maxBytes)
        if (files.length === 0) return
      }
    }
    upload.mutate(files)
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      takeFiles(files)
      return
    }
    // A dragged link/text (no files) — treat as a URL/text submission.
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (text.trim()) submit.mutate(text.trim())
  }

  const busy = upload.isPending || submit.isPending

  return (
    <div className="section">
      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => {
          // role="button" promises keyboard activation — deliver it (Enter/Space open the picker).
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            fileInput.current?.click()
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Dateien auswählen oder hierher ziehen"
      >
        <div className="icon">
          <Icon name="upload" />
        </div>
        <h3>{busy ? 'Wird hochgeladen…' : 'Dateien hierher ziehen oder klicken'}</h3>
        <p>PDF, Office, Bilder, Text — mehrere Dateien werden als Batch verarbeitet.</p>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            takeFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </div>

      <div className="url-row" onClick={(e) => e.stopPropagation()}>
        <input
          type="text"
          placeholder="URL einfügen oder Notiztext eingeben…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim()) submit.mutate(url.trim())
          }}
        />
        <button className="btn primary" disabled={!url.trim() || busy} onClick={() => submit.mutate(url.trim())}>
          Hinzufügen
        </button>
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
