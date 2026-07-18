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
import { PageLink } from '../components/PageLink.tsx'
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

  const newSession = (): void => {
    setActiveId(null)
    ask.reset()
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
      />

      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 && !ask.isPending && (
          <div className="chat-empty">
            <div className="icon">💬</div>
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
}: {
  sessions: Session[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRenamed: () => void
  onDeleted: (id: string) => void
}): React.ReactElement {
  const rename = async (s: Session): Promise<void> => {
    const title = window.prompt('Session umbenennen:', s.title ?? '')
    if (title && title.trim()) {
      await api.renameSession(s.id, title.trim())
      onRenamed()
    }
  }
  const del = async (s: Session): Promise<void> => {
    if (window.confirm(`Session „${s.title ?? 'ohne Titel'}" löschen?`)) {
      await api.deleteSession(s.id)
      onDeleted(s.id)
    }
  }

  return (
    <div className="session-bar">
      <button className="btn" onClick={onNew}>
        + Neu
      </button>
      <div className="session-chips">
        {sessions.map((s) => (
          <div key={s.id} className={`session-chip${s.id === activeId ? ' active' : ''}`}>
            <button className="session-name" onClick={() => onSelect(s.id)} title={s.title ?? 'ohne Titel'}>
              {s.title ?? 'Neue Session'}
            </button>
            <button className="session-act" onClick={() => void rename(s)} title="Umbenennen">
              ✎
            </button>
            <button className="session-act" onClick={() => void del(s)} title="Löschen">
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
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
                <PageLink key={`${c.label}-${i}`} vaultName={vaultName} path={c.path} />
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
