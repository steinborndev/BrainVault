/**
 * Query/Chat tab (SPEC.md §6.3). A chat against the read-only query runner: answers render
 * as markdown with **clickable citation chips** (obsidian:// deep-link + copy fallback for
 * resolved pages; plain text for unresolved) — the M4 DoD. Multiple named sessions, with
 * context preserved across follow-ups (the backend resumes the SDK session).
 *
 * The composer has two modes:
 *   - Ask      → the read-only query runner (this thread)
 *   - Research → the web-enabled autoresearch run (SPEC.md §6.4), promoted here from the
 *                maintenance tab. It is NOT a chat turn — it writes vault pages — so its
 *                live log + result render as a block in the thread area, not as a bubble.
 *
 * The backend `/query` is request/response for now (no token streaming), so a pending
 * question shows an optimistic user bubble + a "thinking…" indicator until the answer
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

type ComposerMode = 'ask' | 'research'

export function Chat(): React.ReactElement {
  const qc = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ComposerMode>('ask')
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

  // Autoresearch: the topic lives in a ref because useMaintenanceRun's starter is read at
  // click time; `lastTopic` is what the result block displays.
  const topicRef = useRef('')
  const [lastTopic, setLastTopic] = useState('')
  const research = useMaintenanceRun(() => api.research(topicRef.current))

  const threadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [messages.length, ask.isPending, research.running])

  const send = (): void => {
    const text = draft.trim()
    if (text === '') return
    if (mode === 'ask') {
      if (ask.isPending) return
      setDraft('')
      ask.mutate(text)
    } else {
      if (research.running) return
      topicRef.current = text
      setLastTopic(text)
      setDraft('')
      research.start()
    }
  }

  // "Save to vault" (SPEC.md §6.3): a write-enabled agent run that resumes this chat's SDK
  // session and triggers the vault's /save flow. Async like the maintenance runs.
  const save = useMaintenanceRun(() => api.saveSession(activeId as string))
  // A session must have answered at least once before there is anything to save.
  const canSave = activeId !== null && messages.some((m) => m.role === 'assistant')

  const selectSession = (id: string | null): void => {
    setActiveId(id)
    // The last answer's usage line and save outcome belong to the previous session —
    // carrying them over would caption the new thread with stale numbers.
    ask.reset()
    save.reset()
  }

  const sendLabel = mode === 'ask' ? (ask.isPending ? 'Asking…' : 'Send') : research.running ? 'Researching…' : 'Research'
  const busy = mode === 'ask' ? ask.isPending : research.running

  return (
    <div className="chat">
      <SessionBar
        sessions={sessions}
        activeId={activeId}
        onSelect={selectSession}
        onNew={() => selectSession(null)}
        onRenamed={() => qc.invalidateQueries({ queryKey: ['sessions'] })}
        onDeleted={(id) => {
          if (id === activeId) selectSession(null)
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
          Session saved
          {save.result.pages.length > 0 ? (
            <PageLinks vaultName={vaultName} paths={save.result.pages} />
          ) : (
            <> — no new pages.</>
          )}
        </div>
      )}

      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 && !ask.isPending && !research.running && !research.result && !research.error && (
          <div className="chat-empty">
            <div className="icon">
              <Icon name="chat" />
            </div>
            <p>Ask the vault anything — answers cite the underlying wiki pages as clickable chips.</p>
            <p className="dim">
              Or switch the composer to <strong>Research</strong> to explore a topic on the web and turn it
              into new vault pages.
            </p>
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
              <div className="bubble-body typing">thinking…</div>
            </div>
          </>
        )}
        {ask.isError && (
          <div className="bubble system">
            <div className="bubble-body">Error: {(ask.error as Error).message}</div>
          </div>
        )}
        {ask.data && !ask.isPending && (
          // Usage for the last answer — the server has always returned it (SPEC.md §7.1);
          // Cost marks it as an estimate in subscription mode.
          <div className="chat-usage">
            {tokens(ask.data.usage.tokensIn + ask.data.usage.tokensOut)} tokens ·{' '}
            <Cost value={ask.data.usage.costUsd} authMode={ask.data.authMode} />
            <CostFootnote authMode={ask.data.authMode} />
          </div>
        )}

        {(research.running || research.result || research.error) && (
          <div className="research-block">
            <div className="research-head">
              <Icon name="search" />
              <span>
                Research: <strong>{lastTopic}</strong>
              </span>
              <span className="spacer" />
              {!research.running && (
                <button className="btn ghost" onClick={research.reset} title="Dismiss" aria-label="Dismiss research result">
                  <Icon name="x" />
                </button>
              )}
            </div>
            {research.running && <JobLog jobId="maintenance:research" seed={false} />}
            {research.error && <div className="toast err">{research.error}</div>}
            {research.result?.ok && (
              <div className="toast ok">
                New/updated pages
                {research.result.pages.length > 0 ? (
                  <PageLinks vaultName={vaultName} paths={research.result.pages} />
                ) : (
                  <> — no changes.</>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-modes" role="tablist" aria-label="Composer mode">
          <button
            className={`chip${mode === 'ask' ? ' active' : ''}`}
            onClick={() => setMode('ask')}
            title="Ask the vault (read-only)"
          >
            Ask
          </button>
          <button
            className={`chip${mode === 'research' ? ' active' : ''}`}
            onClick={() => setMode('research')}
            title="Research a topic on the web and create new vault pages"
          >
            Research
          </button>
        </div>
        <div className="composer-row">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={
              mode === 'ask'
                ? 'Ask the vault… (Enter to send, Shift+Enter for a new line)'
                : 'Topic to research on the web — creates new vault pages…'
            }
            rows={2}
          />
          <button className="btn primary" disabled={draft.trim() === '' || busy} onClick={send}>
            {sendLabel}
          </button>
        </div>
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
        + New
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
      <span className="spacer" />
      <button
        className="btn"
        disabled={!canSave || saving}
        onClick={onSave}
        title={
          canSave
            ? 'Save this session as a page in the vault'
            : 'Available after the first answer'
        }
      >
        {saving ? 'Saving…' : 'Save to vault'}
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
          aria-label="Rename session"
        />
      </div>
    )
  }

  return (
    <div className={`session-chip${active ? ' active' : ''}`}>
      <button className="session-name" onClick={onSelect} title={session.title ?? 'untitled'}>
        {session.title ?? 'New session'}
      </button>
      <button
        className="session-act"
        onClick={() => {
          setTitle(session.title ?? '')
          setEditing(true)
        }}
        title="Rename"
        aria-label="Rename session"
      >
        <Icon name="edit" />
      </button>
      <button
        className={`session-act${confirming ? ' danger' : ''}`}
        onClick={() => void del()}
        title={confirming ? 'Really delete?' : 'Delete'}
        aria-label={confirming ? 'Confirm delete' : 'Delete session'}
      >
        {confirming ? 'Really?' : <Icon name="x" />}
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
          <span className="cites-label">Sources</span>
          <div className="pages">
            {citations.map((c, i) =>
              c.path ? (
                <CitationChip key={`${c.label}-${i}`} vaultName={vaultName} path={c.path} />
              ) : (
                <span key={`${c.label}-${i}`} className="pagelink unresolved" title="Page not found in the vault">
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
