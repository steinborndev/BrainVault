/**
 * The ingestion entry point (SPEC.md §6.2, redesign 2026-08): drag-and-drop files, browse,
 * or paste a URL / note (multi-line, with an optional title). Multiple files in one drop go
 * up as a batch (the server groups them). The channels line makes the other two intake
 * paths visible right where intake happens: the watch folder and the Telegram bot used to
 * be discoverable only through a popover hover.
 */

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type EnqueueResult } from '../api/client.ts'
import { Icon } from './Icon.tsx'
import { navigate } from '../lib/router.ts'

type Toast = { kind: 'ok' | 'err'; text: string } | null

function summarize(res: EnqueueResult): string {
  const dupes = res.jobs.filter((j) => j.status === 'duplicate' || j.duplicateOf).length
  const fresh = res.jobs.length - dupes
  const parts: string[] = []
  if (fresh > 0) parts.push(`${fresh} queued`)
  if (dupes > 0) parts.push(`${dupes} duplicate${dupes > 1 ? 's' : ''} skipped`)
  if (res.batchId) parts.push('as a batch')
  return parts.join(' · ') || 'Accepted'
}

/** One line that is a URL = a link job; anything else (or multi-line) = a note. */
function looksLikeUrl(value: string): boolean {
  return !value.includes('\n') && /^https?:\/\/\S+$/i.test(value.trim())
}

export function Dropzone({ compact = false }: { compact?: boolean }): React.ReactElement {
  const qc = useQueryClient()
  const [over, setOver] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  // `compact` = the queue is busy, so the intake surface stands down to one row and
  // the screen's attention goes to the work in flight. Opening it by hand wins until
  // the queue drains, so a deliberate click is never undone by a job finishing.
  const [pinned, setPinned] = useState(false)
  const collapsed = compact && !pinned
  useEffect(() => {
    if (!compact) setPinned(false)
  }, [compact])

  // Success toasts dismiss themselves; errors stay until the next action replaces them.
  useEffect(() => {
    if (toast?.kind !== 'ok') return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

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
    mutationFn: ({ value, noteTitle }: { value: string; noteTitle: string }) =>
      looksLikeUrl(value)
        ? api.submitUrl(value.trim())
        : api.submitText(value, noteTitle.trim() === '' ? undefined : noteTitle.trim()),
    onSuccess: (res) => {
      setToast({ kind: 'ok', text: summarize(res) })
      setText('')
      setTitle('')
      invalidate()
    },
    onError: (e: Error) => setToast({ kind: 'err', text: e.message }),
  })

  // The server's per-file cap, for a pre-check: warning before the upload beats decoding a
  // 413 after streaming 200 MB. The server still enforces the limit either way.
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const maxBytes = health.data?.limits?.maxUploadBytes

  // The other two intake channels, visible where intake happens.
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const telegram = useQuery({ queryKey: ['telegram-status'], queryFn: api.telegramStatus, staleTime: 300_000 })

  const takeFiles = (files: File[]): void => {
    if (files.length === 0) return
    if (maxBytes !== undefined) {
      const oversized = files.filter((f) => f.size > maxBytes)
      if (oversized.length > 0) {
        const mb = Math.round(maxBytes / 1024 / 1024)
        setToast({
          kind: 'err',
          text: `${oversized.map((f) => f.name).join(', ')}: over the ${mb} MB limit - not uploaded`,
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
    // A dragged link/text (no files) - treat as a URL/text submission.
    const dragged = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (dragged.trim()) submit.mutate({ value: dragged.trim(), noteTitle: '' })
  }

  const busy = upload.isPending || submit.isPending
  const maxMb = maxBytes !== undefined ? Math.round(maxBytes / 1024 / 1024) : undefined
  const isNote = text.trim() !== '' && !looksLikeUrl(text)

  // Collapsed: one row. It still takes a drop (that is the point - the fast path must
  // not need a click first), and one click brings the full card back.
  if (collapsed) {
    return (
      <div className="section">
        <div
          className={`card intake-collapsed${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <button className="ic-open" onClick={() => setPinned(true)}>
            <Icon name="upload" />
            <span className="ic-text">{busy ? 'Uploading…' : 'Drop files, paste a link, or write a note'}</span>
            <span className="spacer" />
            <span className="ic-cta">Add to vault</span>
          </button>
        </div>
        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      </div>
    )
  }

  // One compact card, two equal entry paths: files (drop/click) left, link/note right,
  // with the channels line underneath spanning both.
  return (
    <div className="section">
      <div className={`card intake${over ? ' over' : ''}`}>
        {compact && (
          <button className="intake-collapse" onClick={() => setPinned(false)} title="Collapse - the queue is busy anyway">
            <Icon name="x" /> Collapse
          </button>
        )}
        <div
          className="dropzone"
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => {
            // role="button" promises keyboard activation - deliver it (Enter/Space open the picker).
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              fileInput.current?.click()
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Choose files or drag them here"
        >
          <div className="icon">
            <Icon name="upload" />
          </div>
          <h3>{busy ? 'Uploading…' : 'Drop files here, or anywhere'}</h3>
          <p>PDF, Office, images, text - multiple files become one batch.</p>
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

        <div className="intake-side">
          <label className="intake-label" htmlFor="intake-note">
            Or paste a link / note
          </label>
          <textarea
            id="intake-note"
            className="intake-note"
            rows={2}
            placeholder="https://… or a quick note"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits a URL; notes are multi-line, so they submit via the button
              // (or Ctrl+Enter, the common composer convention).
              if (e.key === 'Enter' && (looksLikeUrl(text) || e.ctrlKey) && text.trim()) {
                e.preventDefault()
                submit.mutate({ value: text, noteTitle: title })
              }
            }}
          />
          {isNote && (
            <input
              type="text"
              className="intake-title"
              placeholder="Title (optional)"
              aria-label="Note title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
          <div className="url-row">
            <span className="intake-cap">
              {maxMb !== undefined ? `Max ${maxMb} MB per file · ` : ''}archives are not extracted
            </span>
            <span className="spacer" />
            <button
              className="btn primary"
              disabled={!text.trim() || busy}
              onClick={() => submit.mutate({ value: text, noteTitle: title })}
            >
              {isNote ? 'Add note' : 'Add'}
            </button>
          </div>
        </div>

        <div className="channels">
          <span className="ch">
            <span className={`d ${stats.data?.watcher.active === true ? 'ok' : 'warn'}`} />
            {stats.data?.watcher.active === true ? 'Watching' : 'Watcher off:'}{' '}
            <code title={stats.data?.watcher.folder}>{stats.data?.watcher.folder ?? '…'}</code>
          </span>
          <span className="ch">
            <span className={`d ${telegram.data?.configured === true ? 'ok' : 'dim'}`} />
            Telegram bot {telegram.data?.configured === true ? 'on' : 'off'}
          </span>
          <span className="spacer" />
          <button className="linkish" onClick={() => navigate('/settings')}>
            Channel settings
          </button>
        </div>
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
