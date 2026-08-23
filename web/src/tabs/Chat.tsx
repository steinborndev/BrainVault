/**
 * Research screen (SPEC.md §6.3, redesign 2026-08). Two lanes in one rail: conversations
 * (the read-only query runner, answers with citation chips) and research runs (the
 * web-enabled autoresearch, SPEC §6.4) — the run block used to render inside whatever
 * session thread happened to be open, implying a relationship that never existed. A run now
 * has its own view; starting one switches to it, and the last settled run stays reachable
 * after a reload via the restart-proof maintenance state.
 *
 * The composer keeps its two modes with the violet side-effect signaling, but the research
 * plan collapses to ONE line (lens · deterministic title · fetch cap · 1 commit) with the
 * lens picker in a popover — the old hint + chip row + 4-row plan stacked ~300px of chrome
 * before typing.
 *
 * `/query` is still request/response — the ANSWER of record arrives with the HTTP reply —
 * but the text streams live meanwhile (chatStream). First questions stream too: the client
 * sends a request id and the server echoes it on the deltas, because the session id only
 * exists once the reply lands.
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
import { Cost, ESTIMATE_LABEL, isEstimate } from '../components/Cost.tsx'

type ComposerMode = 'ask' | 'research'
type View = 'thread' | 'run'

/**
 * `researchPrefill` seeds the composer in Research mode from elsewhere in the app — the
 * graph's knowledge-gap button, Home's most-wanted list and the palette navigate here with
 * a CLEAN topic (the page name, so lens title suffixes stay intact). Consumed once.
 */
export function Chat({ researchPrefill = '' }: { researchPrefill?: string }): React.ReactElement {
  const qc = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ComposerMode>('ask')
  const [view, setView] = useState<View>('thread')
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

  // Live answer text (SPEC.md §6.3), a preview only. First questions have no session id
  // yet, so they stream under a client-generated request id the server echoes.
  const requestIdRef = useRef('')
  const streamKey = activeId ?? requestIdRef.current
  const streamed = useSyncExternalStore(
    (cb) => chatStream.subscribe(streamKey, cb),
    () => chatStream.snapshot(streamKey),
  )

  const ask = useMutation({
    mutationFn: (question: string) => api.query(question, activeId ?? undefined, requestIdRef.current || undefined),
    onSuccess: (res) => {
      // The real message replaces the preview — clear every key it may have streamed under.
      chatStream.clear(res.sessionId)
      chatStream.clear(streamKey)
      if (requestIdRef.current !== '') chatStream.clear(requestIdRef.current)
      setActiveId(res.sessionId)
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['session', res.sessionId] })
    },
    onError: (_e, question) => {
      chatStream.clear(streamKey)
      if (requestIdRef.current !== '') chatStream.clear(requestIdRef.current)
      // Give the typed question back instead of forcing a retype — but never clobber
      // something the user already started writing while the query was in flight.
      setDraft((current) => (current.trim() === '' ? question : current))
      // The failed question and the server's error message land in the session as
      // persisted rows too — refresh so the sidebar shows the session it created.
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  // Research lenses ("Achse A"): the closed profile list for the composer picker.
  const profilesQ = useQuery({ queryKey: ['research-profiles'], queryFn: api.researchProfiles })
  const profiles = profilesQ.data?.profiles ?? []
  const [profileKey, setProfileKey] = useState<string>('broad')
  const selectedProfile = profiles.find((p) => p.key === profileKey)

  // Autoresearch: topic + lens live in refs because useMaintenanceRun's starter is read at
  // click time; `lastTopic`/`lastProfile` are what the run view displays.
  const topicRef = useRef('')
  const profileKeyRef = useRef('broad')
  const [lastTopic, setLastTopic] = useState('')
  const [lastProfile, setLastProfile] = useState<string | null>(null)
  const research = useMaintenanceRun(() => api.research(topicRef.current, profileKeyRef.current))
  // The last settled research run, restart-proof (maintenance_state) — the rail shows it
  // even after a reload, when the client-side run state is gone.
  const maintState = useQuery({ queryKey: ['maintenance-state'], queryFn: api.maintenanceState })
  const lastResearchState = maintState.data?.areas.find((a) => a.kind === 'research')
  const clientRunVisible = research.running || research.result !== undefined || research.error !== null

  const threadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [messages.length, ask.isPending])
  // Follow the stream while the reader is pinned to the bottom — but never yank the view
  // back down when they scrolled up to re-read something.
  useEffect(() => {
    const el = threadRef.current
    if (el === null || streamed === '') return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTo({ top: el.scrollHeight })
  }, [streamed])

  // The composer grows with its content (capped), and gets focus whenever the screen
  // becomes visible — screens stay mounted, so plain autoFocus would only ever fire once
  // at app start, usually while this screen is hidden.
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

  // A gap's "Research" landed us here with a topic: arm Research mode, drop it into the
  // composer for review (not auto-sent — the user confirms), then strip the query param so
  // this fires exactly once.
  useEffect(() => {
    if (researchPrefill === '') return
    setDraft(researchPrefill)
    setMode('research')
    setView('thread')
    composerRef.current?.focus()
    navigate('/research', { replace: true })
  }, [researchPrefill])

  const send = (): void => {
    const text = draft.trim()
    if (text === '') return
    if (mode === 'ask') {
      if (ask.isPending) return
      requestIdRef.current = activeId === null ? crypto.randomUUID() : ''
      setView('thread')
      setDraft('')
      ask.mutate(text)
    } else {
      if (research.running) return
      topicRef.current = text
      profileKeyRef.current = profileKey
      setLastTopic(text)
      setLastProfile(profileKey === 'broad' ? null : selectedProfile?.label ?? null)
      setDraft('')
      setView('run')
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
    setView('thread')
    // The save outcome belongs to the previous session — don't caption the new thread with it.
    ask.reset()
    save.reset()
  }

  const sendLabel = mode === 'ask' ? (ask.isPending ? 'Asking…' : 'Send') : research.running ? 'Researching…' : 'Research'
  const busy = mode === 'ask' ? ask.isPending : research.running

  // With nothing in the thread, the composer centers in the viewport (with the hint above
  // it) instead of hugging the bottom of an empty column; it docks down once content exists.
  const threadEmpty = view === 'thread' && messages.length === 0 && !ask.isPending && !ask.isError

  return (
    <div className="research-layout" ref={rootRef}>
      <aside className="sess-side">
        <div className="rail-label">
          Conversations
          <span className="spacer" />
          <button className="linkish rail-new" onClick={() => selectSession(null)}>
            + New
          </button>
        </div>
        <div className="sess-list">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={view === 'thread' && s.id === activeId}
              onSelect={() => selectSession(s.id)}
              onRenamed={() => qc.invalidateQueries({ queryKey: ['sessions'] })}
              onDeleted={() => {
                if (s.id === activeId) selectSession(null)
                qc.invalidateQueries({ queryKey: ['sessions'] })
              }}
            />
          ))}
        </div>
        {(clientRunVisible || lastResearchState !== undefined) && (
          <div className="rail-runs">
            <div className="rail-label">Research runs</div>
            {clientRunVisible && (
              <button className={`sess run-item${view === 'run' ? ' active' : ''}`} onClick={() => setView('run')}>
                <span className="sess-main">
                  <span className="st">
                    {research.running && <span className="pulse-dot" aria-hidden />} {lastTopic || 'Research run'}
                  </span>
                  <span className="sm">
                    {research.running ? (
                      <span className="run-state running">running</span>
                    ) : research.error !== null ? (
                      <span className="run-state failed">failed</span>
                    ) : (
                      <>
                        <span className="run-state done">done</span>
                        {research.result !== undefined && research.result.pages.length > 0 && (
                          <span>+{research.result.pages.length} pages</span>
                        )}
                      </>
                    )}
                  </span>
                </span>
              </button>
            )}
            {!clientRunVisible && lastResearchState !== undefined && (
              <button className={`sess run-item${view === 'run' ? ' active' : ''}`} onClick={() => setView('run')}>
                <span className="sess-main">
                  <span className="st">Last research run</span>
                  <span className="sm">
                    <span className={`run-state ${lastResearchState.ok ? 'done' : 'failed'}`}>
                      {lastResearchState.ok ? 'done' : 'failed'}
                    </span>
                    {lastResearchState.pages > 0 && <span>+{lastResearchState.pages} pages</span>}
                    <span>{timeAgo(lastResearchState.finishedAt)}</span>
                  </span>
                </span>
              </button>
            )}
          </div>
        )}
      </aside>

      <div className={`chat${threadEmpty ? ' empty-thread' : ''}`}>
        {view === 'run' ? (
          <div className="chat-thread run-view" ref={threadRef}>
            <RunView
              running={research.running}
              error={research.error}
              result={research.result}
              topic={lastTopic}
              lensLabel={lastProfile}
              lastState={lastResearchState}
              vaultName={vaultName}
              authMode={authMode}
              onRetry={research.start}
              onBack={() => setView('thread')}
            />
          </div>
        ) : (
          <div className="chat-thread" ref={threadRef}>
            {threadEmpty && (
              <div className="chat-empty">
                <div className="icon">
                  <Icon name="chat" />
                </div>
                <p>Ask the vault anything - answers cite the underlying wiki pages as clickable chips.</p>
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

            {/* Save-to-vault lives at the END of the thread — next to the result it saves. */}
            {canSave && (
              <div className="savebar">
                <button className="btn" disabled={save.running} onClick={save.start}>
                  {save.running ? 'Saving…' : 'Save conversation to vault'}
                </button>
                <span className="dim">creates/updates wiki pages from this thread - one git commit</span>
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
                  <> - no new pages.</>
                )}
              </div>
            )}
          </div>
        )}

        <div className={`composer${mode === 'research' ? ' research-mode' : ''}`}>
          {mode === 'research' && (
            <>
              <div className="comp-hint">
                <strong>Research mode</strong> - searches the web and <strong>writes new vault pages</strong>. Not a
                chat turn.
              </div>
              {selectedProfile !== undefined && (
                <PlanLine profile={selectedProfile} profiles={profiles} topic={draft} onSelect={setProfileKey} />
              )}
            </>
          )}
          <div className="comp-main">
            <div className="composer-modes" role="group" aria-label="Composer mode">
              <button
                className={`chip${mode === 'ask' ? ' active' : ''}`}
                aria-pressed={mode === 'ask'}
                onClick={() => setMode('ask')}
                title="Ask the vault (read-only)"
              >
                Ask
              </button>
              <button
                className={`chip${mode === 'research' ? ' active research-on' : ''}`}
                aria-pressed={mode === 'research'}
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
                  : 'Topic to research on the web - creates new vault pages…'
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
 * The research run's own view (redesign 2026-08): live log while running, result with pages
 * and cost when settled — no longer squatting inside whichever conversation was open. After
 * a reload only the restart-proof settle facts remain (kind, outcome, page count); the
 * topic and page list live with the run, which the server does not persist yet.
 */
function RunView({
  running,
  error,
  result,
  topic,
  lensLabel,
  lastState,
  vaultName,
  authMode,
  onRetry,
  onBack,
}: {
  running: boolean
  error: string | null
  result: ReturnType<typeof useMaintenanceRun>['result']
  topic: string
  lensLabel: string | null
  lastState: { ok: boolean; pages: number; finishedAt: string; error: string | null } | undefined
  vaultName: string
  authMode: AuthMode
  onRetry: () => void
  onBack: () => void
}): React.ReactElement {
  const clientRun = running || result !== undefined || error !== null
  return (
    <div className="run-detail">
      <div className="research-head">
        <Icon name="flask" />
        {clientRun ? (
          <span>
            Research: <strong>{topic}</strong>
          </span>
        ) : (
          <span>
            <strong>Last research run</strong>
            {lastState !== undefined && <span className="dim"> · {timeAgo(lastState.finishedAt)}</span>}
          </span>
        )}
        {lensLabel !== null && clientRun && <span className="lens-tag">{lensLabel}</span>}
        <span className="spacer" />
        <button className="btn ghost" onClick={onBack}>
          Back to conversation
        </button>
      </div>
      {clientRun ? (
        <>
          {running && <JobLog jobId="maintenance:research" seed={false} />}
          {error !== null && (
            <div className="toast err">
              {error}{' '}
              <button className="btn" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
          {result?.ok === true && (
            <div className="toast ok">
              New/updated pages
              {result.usage.costUsd > 0 && (
                <span>
                  {' '}
                  · <Cost value={result.usage.costUsd} authMode={authMode} />
                  {isEstimate(authMode) && <span className="dim"> ({ESTIMATE_LABEL})</span>}
                </span>
              )}
              {result.pages.length > 0 ? <PageLinks vaultName={vaultName} paths={result.pages} /> : <> - no changes.</>}
            </div>
          )}
        </>
      ) : lastState !== undefined ? (
        <div className="run-facts">
          <span className={`run-state ${lastState.ok ? 'done' : 'failed'}`}>{lastState.ok ? 'done' : 'failed'}</span>
          {lastState.pages > 0 && (
            <span>
              {lastState.pages} page{lastState.pages > 1 ? 's' : ''} created or updated
            </span>
          )}
          {lastState.error !== null && <span className="dim">{lastState.error}</span>}
          <p className="tab-hint">
            The pages of this run are in the Home activity stream and the vault; per-run detail beyond this
            settle record is not persisted yet.
          </p>
        </div>
      ) : (
        <div className="empty">No research run yet.</div>
      )}
    </div>
  )
}

/**
 * The run plan as ONE line (redesign 2026-08): lens, the deterministic synthesis-page title
 * the service pins (topic + the lens's `titleSuffix`), the fetch cap and the single commit —
 * always visible while typing. The lens picker (with blurbs and source preferences, the
 * consent detail) opens as a popover instead of permanently stacking above the input.
 */
function PlanLine({
  profile,
  profiles,
  topic,
  onSelect,
}: {
  profile: ResearchProfile
  profiles: ResearchProfile[]
  topic: string
  onSelect: (key: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const shownTopic = topic.trim() || 'your topic'
  const targetTitle = `Research: ${shownTopic}${profile.titleSuffix}`

  return (
    <div className="planline-wrap" ref={wrapRef}>
      <div className="planline">
        <span className="pl-lens">{profile.label}</span>
        <span className="pl-sep">·</span>
        <span className="pl-k">files as</span>
        <span className="pl-title" title={targetTitle}>
          {targetTitle}
        </span>
        <span className="pl-sep">·</span>
        <span className="pl-cost">
          up to <b>{profile.fetchEstimate}</b> fetches · 1 commit
        </span>
        <span className="spacer" />
        <button className="linkish pl-change" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
          Change lens <Icon name="chevron" />
        </button>
      </div>
      {open && (
        <div className="lens-pop" role="menu" aria-label="Research lens">
          {profiles.map((p) => (
            <button
              key={p.key}
              role="menuitemradio"
              aria-checked={p.key === profile.key}
              className={`lens-opt${p.key === profile.key ? ' on' : ''}`}
              onClick={() => {
                onSelect(p.key)
                setOpen(false)
              }}
            >
              <span className="lo-head">
                {p.label}
                {p.badge !== undefined && <span className="badge">{p.badge}</span>}
              </span>
              <span className="lo-blurb">{p.blurb}</span>
              <span className="lo-sources">
                {p.sources.map((s) => (
                  <span key={s} className="srcpill">
                    {s}
                  </span>
                ))}
              </span>
            </button>
          ))}
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
