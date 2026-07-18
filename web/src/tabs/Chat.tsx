/**
 * Query/Chat tab (SPEC.md §6.3). A chat against the read-only query runner: answers render
 * as markdown with **clickable citation chips** (obsidian:// deep-link + copy fallback for
 * resolved pages; plain text for unresolved) — the M4 DoD. Multiple named sessions, with
 * context preserved across follow-ups (the backend resumes the SDK session).
 *
 * The backend `/query` is request/response for now (no token streaming), so a pending
 * question shows an optimistic user bubble + a "denkt nach…" indicator until the answer
 * lands, then the persisted thread is refetched.
 */

import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, parseCitations } from '../api/client.ts'
import type { ChatMessage, Session } from '../api/types.ts'
import { Markdown } from '../components/Markdown.tsx'
import { PageLinks } from '../components/PageLink.tsx'
import { CitationChip } from '../components/CitationChip.tsx'
import { JobLog } from '../components/JobLog.tsx'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'
import { Icon } from '../components/Icon.tsx'
import { timeAgo, tokens } from '../lib/format.ts'
import { Cost, CostFootnote } from '../components/Cost.tsx'

export function Chat(): React.ReactElement {
  const qc = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'

  const sessionsQ = useQuery({ queryKey: ['sessions'], queryFn: api.sessions })
  const sessions = sessionsQ.data?.sessions ?? []

  const threadQ = useQuery({
    queryKey: ['session', activeId],
    queryFn: () => api.session(activeId!),
    enabled: activeId !== null,
  })
  const messages = threadQ.data?.messages ?? []

  const ask = useMutation({
    mutationFn: (question: string) => api.query(question, activeId ?? undefined),
    onSuccess: (res) => {
      setActiveId(res.sessionId)
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['session', res.sessionId] })
    },
    onError: (_e, question) => {
      // Give the typed question back instead of forcing a retype — but never clobber
      // something the user already started writing while the query was in flight.
      setDraft((current) => (current.trim() === '' ? question : current))
    },
  })

  const threadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [messages.length, ask.isPending])

  const send = (): void => {
    const q = draft.trim()
    if (q === '' || ask.isPending) return
    setDraft('')
    ask.mutate(q)
  }

  // "Session in Vault sichern" (SPEC.md §6.3): a write-enabled agent run that resumes this
  // chat's SDK session and triggers the vault's /save flow. Async like the maintenance runs.
  const save = useMaintenanceRun(() => api.saveSession(activeId as string))
  // A session must have answered at least once before there is anything to save.
  const canSave = activeId !== null && messages.some((m) => m.role === 'assistant')

  const newSession = (): void => {
    setActiveId(null)
    ask.reset()
    save.reset()
  }

  return (
    <div className="chat">
      <SessionBar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={newSession}
        onRenamed={() => qc.invalidateQueries({ queryKey: ['sessions'] })}
        onDeleted={(id) => {
          if (id === activeId) newSession()
          qc.invalidateQueries({ queryKey: ['sessions'] })
        }}
        canSave={canSave}
        saving={save.running}
        onSave={save.start}
      />

      {save.running && <JobLog jobId="maintenance:save" seed={false} />}
      {save.error && <div className="toast err">{save.error}</div>}
      {save.result?.ok && (
        <div className="toast ok">
          Session gesichert
          {save.result.pages.length > 0 ? (
            <PageLinks vaultName={vaultName} paths={save.result.pages} />
          ) : (
            <> — keine neuen Seiten.</>
          )}
        </div>
      )}

      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 && !ask.isPending && (
          <div className="chat-empty">
            <div className="icon">
              <Icon name="chat" />
            </div>
            <p>Frag den Vault etwas — die Antwort zitiert die zugrunde liegenden Wiki-Seiten als klickbare Chips.</p>
          </div>
        )}

        {messages.map((m) => (
          <Bubble key={m.id} message={m} vaultName={vaultName} />
        ))}

        {ask.isPending && (
          <>
            <div className="bubble user">
              <div className="bubble-body">{ask.variables}</div>
            </div>
            <div className="bubble assistant">
              <div className="bubble-body typing">denkt nach…</div>
            </div>
          </>
        )}
        {ask.isError && (
          <div className="bubble system">
            <div className="bubble-body">Fehler: {(ask.error as Error).message}</div>
          </div>
        )}
        {ask.data && !ask.isPending && (
          // Usage for the last answer — the server has always returned it (SPEC.md §7.1);
          // Cost marks it as an estimate in subscription mode.
          <div className="chat-usage">
            {tokens(ask.data.usage.tokensIn + ask.data.usage.tokensOut)} Tokens ·{' '}
            <Cost value={ask.data.usage.costUsd} authMode={ask.data.authMode} />
            <CostFootnote authMode={ask.data.authMode} />
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Frage an den Vault… (Enter zum Senden, Shift+Enter für neue Zeile)"
          rows={2}
        />
        <button className="btn primary" disabled={draft.trim() === '' || ask.isPending} onClick={send}>
          Senden
        </button>
      </div>
    </div>
  )
}

function SessionBar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onRenamed,
  onDeleted,
  canSave,
  saving,
  onSave,
}: {
  sessions: Session[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRenamed: () => void
  onDeleted: (id: string) => void
  /** False until the session has an answer — there is nothing to write up before that. */
  canSave: boolean
  saving: boolean
  onSave: () => void
}): React.ReactElement {
  return (
    <div className="session-bar">
      <button className="btn" onClick={onNew}>
        + Neu
      </button>
      <div className="session-chips">
        {sessions.map((s) => (
          <SessionChip
            key={s.id}
            session={s}
            active={s.id === activeId}
            onSelect={() => onSelect(s.id)}
            onRenamed={onRenamed}
            onDeleted={() => onDeleted(s.id)}
          />
        ))}
      </div>
      <button
        className="btn"
        disabled={!canSave || saving}
        onClick={onSave}
        title={
          canSave
            ? 'Diese Session als Seite im Vault sichern'
            : 'Erst nach der ersten Antwort verfügbar'
        }
      >
        {saving ? 'Sichere…' : 'In Vault sichern'}
      </button>
    </div>
  )
}

/**
 * One session chip. Rename is an inline input (no `window.prompt` — native dialogs are blocked
 * or ugly in installed-PWA mode); delete is a two-step confirm on the chip itself.
 */
function SessionChip({
  session,
  active,
  onSelect,
  onRenamed,
  onDeleted,
}: {
  session: Session
  active: boolean
  onSelect: () => void
  onRenamed: () => void
  onDeleted: () => void
}): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [])

  const commitRename = async (): Promise<void> => {
    setEditing(false)
    const trimmed = title.trim()
    if (trimmed !== '' && trimmed !== (session.title ?? '')) {
      await api.renameSession(session.id, trimmed)
      onRenamed()
    }
  }

  const del = async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    await api.deleteSession(session.id)
    onDeleted()
  }

  if (editing) {
    return (
      <div className={`session-chip${active ? ' active' : ''}`}>
        <input
          className="session-rename"
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename()
            if (e.key === 'Escape') setEditing(false)
          }}
          aria-label="Session umbenennen"
        />
      </div>
    )
  }

  return (
    <div className={`session-chip${active ? ' active' : ''}`}>
      <button className="session-name" onClick={onSelect} title={session.title ?? 'ohne Titel'}>
        {session.title ?? 'Neue Session'}
      </button>
      <button
        className="session-act"
        onClick={() => {
          setTitle(session.title ?? '')
          setEditing(true)
        }}
        title="Umbenennen"
        aria-label="Session umbenennen"
      >
        <Icon name="edit" />
      </button>
      <button
        className={`session-act${confirming ? ' danger' : ''}`}
        onClick={() => void del()}
        title={confirming ? 'Wirklich löschen?' : 'Löschen'}
        aria-label={confirming ? 'Löschen bestätigen' : 'Session löschen'}
      >
        {confirming ? 'Wirklich?' : <Icon name="x" />}
      </button>
    </div>
  )
}

function Bubble({ message, vaultName }: { message: ChatMessage; vaultName: string }): React.ReactElement {
  const citations = parseCitations(message.citations)
  return (
    <div className={`bubble ${message.role}`}>
      <div className="bubble-body">
        {message.role === 'assistant' ? <Markdown source={message.content} /> : message.content}
      </div>
      {citations.length > 0 && (
        <div className="bubble-cites">
          <span className="cites-label">Quellen</span>
          <div className="pages">
            {citations.map((c, i) =>
              c.path ? (
                <CitationChip key={`${c.label}-${i}`} vaultName={vaultName} path={c.path} />
              ) : (
                <span key={`${c.label}-${i}`} className="pagelink unresolved" title="Seite nicht im Vault gefunden">
                  {c.label}
                </span>
              ),
            )}
          </div>
        </div>
      )}
      <div className="bubble-ts">{timeAgo(message.ts)}</div>
    </div>
  )
}
