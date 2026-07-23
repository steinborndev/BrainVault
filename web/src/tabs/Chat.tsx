/**
 * Query/Chat tab (SPEC.md §6.3). A chat against the read-only query runner: answers render
 * as markdown with **clickable citation chips** (obsidian:// deep-link + copy fallback for
 * resolved pages; plain text for unresolved) — the M4 DoD. Multiple named sessions in a
 * sidebar (desktop) that turns into a horizontal strip on small screens; context is preserved
 * across follow-ups (the backend resumes the SDK session).
 *
 * Every assistant answer carries its own footer: sources, per-answer usage (persisted server-
 * side since schema v6), and a copy action. "Save to vault" sits at the END of the thread —
 * next to the result it saves — not in the session bar.
 *
 * The composer has two modes:
 *   - Ask      → the read-only query runner (this thread)
 *   - Research → the web-enabled autoresearch run (SPEC.md §6.4). It is NOT a chat turn — it
 *                uses the web and writes vault pages — so the composer visibly changes (violet
 *                accent + a hint line) while the mode is armed, and its live log + result
 *                render as a block in the thread area, not as a bubble.
 *
 * `/query` is still request/response — the ANSWER of record arrives with the HTTP reply — but
 * the text is **streamed live** meanwhile: the server publishes coalesced deltas on the shared
 * SSE stream and they render into the pending assistant bubble (`chatStream`). The preview is
 * plain text and is discarded the moment the real message lands, so citations, usage and the
 * persisted thread all still come from exactly one authoritative source.
 */

import { useState, useRef, useEffect, useSyncExternalStore } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, parseCitations } from '../api/client.ts'
import type { AuthMode, ChatMessage, ResearchProfile, Session } from '../api/types.ts'
import { Markdown } from '../components/Markdown.tsx'
import { PageLinks } from '../components/PageLink.tsx'
import { CitationChip } from '../components/CitationChip.tsx'
import { JobLog } from '../components/JobLog.tsx'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'
import { Icon } from '../components/Icon.tsx'
import { navigate } from '../lib/router.ts'
import { chatStream } from '../lib/chatStream.ts'
import { timeAgo, tokens } from '../lib/format.ts'
import { Cost } from '../components/Cost.tsx'

type ComposerMode = 'ask' | 'research'

/**
 * `researchPrefill` seeds the composer in Research mode from elsewhere in the app — the
 * vault graph's knowledge-gap "Start research" button navigates here with the topic. It is
 * consumed once and the query param is cleared, so a re-render never re-arms it.
 */
export function Chat({ researchPrefill = '' }: { researchPrefill?: string }): React.ReactElement {
  const qc = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ComposerMode>('ask')
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  const authMode: AuthMode = stats.data?.authMode ?? 'oauth'

  const sessionsQ = useQuery({ queryKey: ['sessions'], queryFn: api.sessions })
  const sessions = sessionsQ.data?.sessions ?? []

  const threadQ = useQuery({
    queryKey: ['session', activeId],
    queryFn: () => api.session(activeId!),
    enabled: activeId !== null,
  })
  const messages = threadQ.data?.messages ?? []

  // Live answer text for the session being asked (SPEC.md §6.3). A preview only: it is dropped
  // the moment the authoritative message arrives, which is the one carrying citations and usage.
  const streamKey = activeId ?? ''
  const streamed = useSyncExternalStore(
    (cb) => chatStream.subscribe(streamKey, cb),
    () => chatStream.snapshot(streamKey),
  )

  const ask = useMutation({
    mutationFn: (question: string) => api.query(question, activeId ?? undefined),
    onSuccess: (res) => {
      // The real message replaces the preview. Clear BOTH ids: a first question streams under
      // the session the server just created, which the client did not know when it asked.
      chatStream.clear(res.sessionId)
      chatStream.clear(streamKey)
      setActiveId(res.sessionId)
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['session', res.sessionId] })
    },
    onError: (_e, question) => {
      chatStream.clear(streamKey)
      // Give the typed question back instead of forcing a retype — but never clobber
      // something the user already started writing while the query was in flight.
      setDraft((current) => (current.trim() === '' ? question : current))
    },
  })

  // Research lenses ("Achse A"): the closed profile list for the composer picker.
  const profilesQ = useQuery({ queryKey: ['research-profiles'], queryFn: api.researchProfiles })
  const profiles = profilesQ.data?.profiles ?? []
  const [profileKey, setProfileKey] = useState<string>('broad')
  const selectedProfile = profiles.find((p) => p.key === profileKey)

  // Autoresearch: topic + lens live in refs because useMaintenanceRun's starter is read at
  // click time; `lastTopic`/`lastProfile` are what the result block displays.
  const topicRef = useRef('')
  const profileKeyRef = useRef('broad')
  const [lastTopic, setLastTopic] = useState('')
  const [lastProfile, setLastProfile] = useState<string | null>(null)
  const research = useMaintenanceRun(() => api.research(topicRef.current, profileKeyRef.current))

  const threadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [messages.length, ask.isPending, research.running])

  // The composer grows with its content (capped), and gets focus whenever the chat tab
  // becomes visible — tabs stay mounted, so plain autoFocus would only ever fire once
  // at app start, usually while this tab is hidden.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const ta = composerRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(200, ta.scrollHeight)}px`
  }, [draft])
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) composerRef.current?.focus()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // A gap's "Start research" landed us here with a topic: arm Research mode, drop it into the
  // composer for review (not auto-sent — the user confirms), then strip the query param so
  // this fires exactly once.
  useEffect(() => {
    if (researchPrefill === '') return
    setDraft(researchPrefill)
    setMode('research')
    composerRef.current?.focus()
    navigate('/research', { replace: true })
  }, [researchPrefill])

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
      profileKeyRef.current = profileKey
      setLastTopic(text)
      setLastProfile(profileKey === 'broad' ? null : selectedProfile?.label ?? null)
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
    // The save outcome belongs to the previous session — don't caption the new thread with it.
    ask.reset()
    save.reset()
  }

  const sendLabel = mode === 'ask' ? (ask.isPending ? 'Asking…' : 'Send') : research.running ? 'Researching…' : 'Research'
  const busy = mode === 'ask' ? ask.isPending : research.running

  // With nothing in the thread, the composer centers in the viewport (with the hint above
  // it) instead of hugging the bottom of an empty column; it docks down once content exists.
  const threadEmpty =
    messages.length === 0 && !ask.isPending && !ask.isError && !research.running && !research.result && !research.error

  return (
    <div className="research-layout" ref={rootRef}>
      <aside className="sess-side">
        <button className="btn sess-new" onClick={() => selectSession(null)}>
          + New session
        </button>
        <div className="sess-list">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              onSelect={() => selectSession(s.id)}
              onRenamed={() => qc.invalidateQueries({ queryKey: ['sessions'] })}
              onDeleted={() => {
                if (s.id === activeId) selectSession(null)
                qc.invalidateQueries({ queryKey: ['sessions'] })
              }}
            />
          ))}
        </div>
      </aside>

      <div className={`chat${threadEmpty ? ' empty-thread' : ''}`}>
        <div className="chat-thread" ref={threadRef}>
          {threadEmpty && (
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
            <Bubble key={m.id} message={m} vaultName={vaultName} authMode={authMode} />
          ))}

          {ask.isPending && (
            <>
              <div className="bubble user">
                <div className="bubble-body">{ask.variables}</div>
              </div>
              <div className="bubble assistant">
                {streamed === '' ? (
                  <div className="bubble-body typing">thinking…</div>
                ) : (
                  // Plain text while streaming, not Markdown: the buffer is mid-sentence by
                  // definition, and half-parsed markup would flicker as it completes. The
                  // finished message renders as Markdown with citations a moment later.
                  <div className="bubble-body streaming">{streamed}</div>
                )}
              </div>
            </>
          )}
          {ask.isError && (
            <div className="bubble system">
              <div className="bubble-body">Error: {(ask.error as Error).message}</div>
            </div>
          )}

          {(research.running || research.result || research.error) && (
            <div className="research-block">
              <div className="research-head">
                <Icon name="search" />
                <span>
                  Research: <strong>{lastTopic}</strong>
                </span>
                {lastProfile && <span className="lens-tag">{lastProfile}</span>}
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

          {/* Save-to-vault lives at the END of the thread — next to the result it saves. */}
          {canSave && (
            <div className="savebar">
              <button className="btn" disabled={save.running} onClick={save.start}>
                {save.running ? 'Saving…' : 'Save conversation to vault'}
              </button>
              <span className="dim">creates/updates wiki pages from this thread — one git commit</span>
            </div>
          )}
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
        </div>

        <div className={`composer${mode === 'research' ? ' research-mode' : ''}`}>
          {mode === 'research' && (
            <>
              <div className="comp-hint">
                <strong>Research mode</strong> — searches the web and <strong>writes new vault pages</strong>. Not a
                chat turn.
              </div>
              {profiles.length > 0 && (
                <ResearchLens
                  profiles={profiles}
                  selected={profileKey}
                  onSelect={setProfileKey}
                  topic={draft}
                />
              )}
            </>
          )}
          <div className="comp-main">
            <div className="composer-modes" role="tablist" aria-label="Composer mode">
              <button
                className={`chip${mode === 'ask' ? ' active' : ''}`}
                onClick={() => setMode('ask')}
                title="Ask the vault (read-only)"
              >
                Ask
              </button>
              <button
                className={`chip${mode === 'research' ? ' active research-on' : ''}`}
                onClick={() => setMode('research')}
                title="Research a topic on the web and create new vault pages"
              >
                Research
              </button>
            </div>
            <textarea
              ref={composerRef}
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
              rows={1}
            />
            <button
              className={`btn primary${mode === 'research' ? ' research' : ''}`}
              disabled={draft.trim() === '' || busy}
              onClick={send}
            >
              {sendLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The research-lens picker + run-plan preview ("Achse A"). Lenses are a closed list from the
 * server; selecting one previews what will actually happen BEFORE the run: the source
 * preferences, the deterministic synthesis-page title the service pins (topic + the lens's
 * `titleSuffix`), and the rough web-fetch cost. `broad` renders the classic `Research: <topic>`.
 */
function ResearchLens({
  profiles,
  selected,
  onSelect,
  topic,
}: {
  profiles: ResearchProfile[]
  selected: string
  onSelect: (key: string) => void
  topic: string
}): React.ReactElement {
  const active = profiles.find((p) => p.key === selected) ?? profiles[0]
  const shownTopic = topic.trim() || 'your topic'
  const targetTitle = `Research: ${shownTopic}${active?.titleSuffix ?? ''}`

  return (
    <div className="lens-wrap">
      <div className="lens-row">
        <span className="lens-label">Lens</span>
        <div className="lens-chips" role="radiogroup" aria-label="Research lens">
          {profiles.map((p) => (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={p.key === selected}
              className={`lens${p.key === selected ? ' active' : ''}`}
              onClick={() => onSelect(p.key)}
              title={p.blurb}
            >
              {p.label}
              {p.badge && <span className="badge">{p.badge}</span>}
            </button>
          ))}
        </div>
      </div>
      {active && (
        <div className="runplan">
          <div className="rp-row">
            <span className="rp-k">Lens</span>
            <span className="rp-v">{active.blurb}</span>
          </div>
          <div className="rp-row">
            <span className="rp-k">Prefers</span>
            <span className="rp-v">
              {active.sources.map((s) => (
                <span key={s} className="srcpill">
                  {s}
                </span>
              ))}
            </span>
          </div>
          <div className="rp-row">
            <span className="rp-k">Files as</span>
            <span className="rp-v">
              <span className="target">{targetTitle}</span>
            </span>
          </div>
          <div className="rp-row">
            <span className="rp-k">Est. cost</span>
            <span className="rp-v rp-cost">
              up to <b>{active.fetchEstimate}</b> web fetches · 1 git commit
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * One session as a sidebar row: title + meta (message count, last activity), with rename
 * (inline input — no `window.prompt`, blocked/ugly in installed PWAs) and a two-step delete.
 */
function SessionRow({
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
      <div className={`sess${active ? ' active' : ''}`}>
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
    <div className={`sess${active ? ' active' : ''}`}>
      <button className="sess-main" onClick={onSelect} title={session.title ?? 'untitled'}>
        <span className="st">{session.title ?? 'New session'}</span>
        <span className="sm">
          {session.message_count !== undefined && <span>{session.message_count} msgs</span>}
          <span>{timeAgo(session.last_ts ?? session.created_at)}</span>
        </span>
      </button>
      <span className="sess-acts">
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
      </span>
    </div>
  )
}

function Bubble({
  message,
  vaultName,
  authMode,
}: {
  message: ChatMessage
  vaultName: string
  authMode: AuthMode
}): React.ReactElement {
  const citations = parseCitations(message.citations)
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  if (message.role !== 'assistant') {
    return (
      <div className={`bubble ${message.role}`}>
        <div className="bubble-body">{message.content}</div>
        <div className="bubble-ts">{timeAgo(message.ts)}</div>
      </div>
    )
  }

  // Every answer keeps its own usage (persisted since v6); older rows simply have none.
  const hasUsage = message.tokens_out !== null
  return (
    <div className="bubble assistant">
      <div className="bubble-body">
        <Markdown source={message.content} />
      </div>
      <div className="bfoot">
        {citations.length > 0 && (
          <>
            <span className="cites-label">Sources</span>
            <span className="pages">
              {citations.map((c, i) =>
                c.path ? (
                  <CitationChip key={`${c.label}-${i}`} vaultName={vaultName} path={c.path} />
                ) : (
                  <span key={`${c.label}-${i}`} className="pagelink unresolved" title="Page not found in the vault">
                    {c.label}
                  </span>
                ),
              )}
            </span>
          </>
        )}
        <span className="bact">
          <span className="busage">
            {timeAgo(message.ts)}
            {hasUsage && (
              <>
                {' · '}
                {tokens((message.tokens_in ?? 0) + (message.tokens_out ?? 0))} tok ·{' '}
                <Cost value={message.cost_usd} authMode={authMode} />
              </>
            )}
          </span>
          <button onClick={copy} title="Copy answer as markdown">
            <Icon name="copy" /> {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </div>
    </div>
  )
}
