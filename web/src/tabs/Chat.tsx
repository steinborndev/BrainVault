/**
 * Research (SPEC.md §6.3/§6.4, redesign 2026-08-25 second pass) - the screen where you go
 * and find something out, in the same workspace shape as every other screen.
 *
 *   LEFT   the lens as a standing control (four profiles, a closed set - it used to take
 *          "change lens" plus a scrolling popover to pick one), then the runs, then the
 *          conversations. The lens greys out in Ask mode, because a lens shapes a research
 *          run only: it picks the sources, the fetch budget and the title the run files as.
 *   RIGHT  the composer at the top, and below it whatever you are looking at: the run
 *          history with the vault's own research backlog (the screen is never empty now), a
 *          single run, or a conversation.
 *
 * Research is the default mode: it is the reason this screen exists, and asking the vault is
 * the cheaper follow-up rather than the entry point.
 *
 * `/query` is still request/response - the ANSWER of record arrives with the HTTP reply -
 * but the text streams live meanwhile (chatStream). First questions stream too: the client
 * sends a request id and the server echoes it on the deltas, because the session id only
 * exists once the reply lands.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, parseCitations } from '../api/client.ts'
import type { AuthMode, ChatMessage, ResearchProfile, Session } from '../api/types.ts'
import { Markdown } from '../components/Markdown.tsx'
import { PageLink, PageLinks } from '../components/PageLink.tsx'
import { CitationChip } from '../components/CitationChip.tsx'
import { JobLog } from '../components/JobLog.tsx'
import { RunProgress } from '../components/RunProgress.tsx'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'
import { Icon } from '../components/Icon.tsx'
import { navigate } from '../lib/router.ts'
import { chatStream } from '../lib/chatStream.ts'
import { duration, timeAgo, tokens } from '../lib/format.ts'
import { Cost, ESTIMATE_LABEL, isEstimate } from '../components/Cost.tsx'
import { buildResearchRuns, targetTitle, type ResearchRunEntry } from '../lib/researchRuns.ts'

type ComposerMode = 'research' | 'ask'

type View =
  | { kind: 'start' }
  /** The run this browser just started (or any run still in flight). */
  | { kind: 'live' }
  | { kind: 'run'; id: string }
  | { kind: 'thread'; id: string | null }

/** How many gaps the research backlog offers at once. */
const BACKLOG_SIZE = 6

export function Chat({ researchPrefill = '' }: { researchPrefill?: string }): React.ReactElement {
  const qc = useQueryClient()
  const [mode, setMode] = useState<ComposerMode>('research')
  const [draft, setDraft] = useState('')
  const [profileKey, setProfileKey] = useState('broad')
  const [view, setView] = useState<View>({ kind: 'start' })
  const [activeId, setActiveId] = useState<string | null>(null)

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
      // The real message replaces the preview - clear every key it may have streamed under.
      chatStream.clear(res.sessionId)
      chatStream.clear(streamKey)
      if (requestIdRef.current !== '') chatStream.clear(requestIdRef.current)
      setActiveId(res.sessionId)
      setView({ kind: 'thread', id: res.sessionId })
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['session', res.sessionId] })
    },
    onError: (_e, question) => {
      chatStream.clear(streamKey)
      if (requestIdRef.current !== '') chatStream.clear(requestIdRef.current)
      // Give the typed question back instead of forcing a retype - but never clobber
      // something the user already started writing while the query was in flight.
      setDraft((current) => (current.trim() === '' ? question : current))
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  // Research lenses ("Achse A"): the closed profile list the control column offers.
  const profilesQ = useQuery({ queryKey: ['research-profiles'], queryFn: api.researchProfiles })
  const profiles = useMemo(() => profilesQ.data?.profiles ?? [], [profilesQ.data])
  const selectedProfile = profiles.find((p) => p.key === profileKey)

  // The run list: tracked runs + the synthesis pages that outlive them + failed settles.
  const historyQ = useQuery({
    queryKey: ['maintenance-history', 'research'],
    queryFn: () => api.maintenanceHistory({ kind: 'research', limit: 100 }),
  })
  const runsQ = useQuery({ queryKey: ['maintenance-runs'], queryFn: api.maintenanceRuns })
  const stateQ = useQuery({ queryKey: ['maintenance-state'], queryFn: api.maintenanceState })
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const entries = useMemo(
    () =>
      buildResearchRuns({
        history: historyQ.data?.runs ?? [],
        runs: runsQ.data?.runs ?? [],
        lastRuns: stateQ.data?.areas ?? [],
        nodes: graphQ.data?.nodes ?? [],
        profiles,
      }),
    [historyQ.data, runsQ.data, stateQ.data, graphQ.data, profiles],
  )
  const liveEntry = entries.find((e) => e.status === 'running')

  // Autoresearch: topic + lens live in refs because useMaintenanceRun's starter is read at
  // click time.
  const topicRef = useRef('')
  const profileKeyRef = useRef('broad')
  const [lastTopic, setLastTopic] = useState('')
  const [runProfileKey, setRunProfileKey] = useState('broad')
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null)
  const research = useMaintenanceRun(() => api.research(topicRef.current, profileKeyRef.current))
  const runProfile = profiles.find((p) => p.key === runProfileKey)

  const composerRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Follow a thread as it grows, and while an answer streams - but never yank the view back
  // down when the reader scrolled up to re-read something.
  useEffect(() => {
    if (view.kind !== 'thread') return
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [messages.length, ask.isPending, view.kind])
  useEffect(() => {
    const el = bodyRef.current
    if (el === null || streamed === '') return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTo({ top: el.scrollHeight })
  }, [streamed])

  // The composer grows with its content (capped).
  useEffect(() => {
    const ta = composerRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(160, ta.scrollHeight)}px`
  }, [draft])

  // A gap's "Research" landed us here with a topic: arm Research mode, drop it into the
  // composer for review (not auto-sent - the user confirms), then strip the query param so
  // this fires exactly once.
  useEffect(() => {
    if (researchPrefill === '') return
    setDraft(researchPrefill)
    setMode('research')
    setView({ kind: 'start' })
    composerRef.current?.focus()
    navigate('/research', { replace: true })
  }, [researchPrefill])

  const send = (): void => {
    const text = draft.trim()
    if (text === '') return
    if (mode === 'ask') {
      if (ask.isPending) return
      requestIdRef.current = activeId === null ? crypto.randomUUID() : ''
      setView({ kind: 'thread', id: activeId })
      setDraft('')
      ask.mutate(text)
      return
    }
    if (research.running) return
    topicRef.current = text
    profileKeyRef.current = profileKey
    setLastTopic(text)
    setRunProfileKey(profileKey)
    setRunStartedAt(new Date().toISOString())
    setDraft('')
    setView({ kind: 'live' })
    research.start()
  }

  // "Save to vault" (SPEC.md §6.3): a write-enabled agent run that resumes this chat's SDK
  // session and triggers the vault's /save flow. Async like the maintenance runs.
  const save = useMaintenanceRun(() => api.saveSession(activeId as string))
  const canSave = activeId !== null && messages.some((m) => m.role === 'assistant')

  const openThread = (id: string | null): void => {
    setActiveId(id)
    setMode('ask')
    setView({ kind: 'thread', id })
    ask.reset()
    save.reset()
    composerRef.current?.focus()
  }

  const openEntry = (entry: ResearchRunEntry): void => {
    setView(entry.status === 'running' ? { kind: 'live' } : { kind: 'run', id: entry.id })
  }

  const startAbout = (topic: string): void => {
    setMode('research')
    setDraft(topic)
    composerRef.current?.focus()
  }

  const lensDisabled = mode === 'ask'
  const busy = mode === 'ask' ? ask.isPending : research.running
  const sendLabel = mode === 'ask' ? (ask.isPending ? 'Asking…' : 'Ask') : research.running ? 'Running…' : 'Start run'
  const gaps = graphQ.data?.gaps ?? []

  return (
    <div className="workspace">
      <aside className="gpanel" aria-label="Research controls">
        <div className={`gp-sec${lensDisabled ? ' off' : ''}`} aria-disabled={lensDisabled}>
          <div className="gp-head">
            <span className="gp-eyebrow">Lens</span>
            <span className="spacer" />
            <span className="gp-state">{lensDisabled ? 'not used' : (selectedProfile?.label ?? '…')}</span>
          </div>
          <div className="lenslist" role="radiogroup" aria-label="Research lens">
            {profiles.map((p) => (
              <button
                key={p.key}
                className="lensopt"
                role="radio"
                aria-checked={p.key === profileKey}
                disabled={lensDisabled}
                tabIndex={lensDisabled ? -1 : 0}
                onClick={() => setProfileKey(p.key)}
              >
                <span className="radio" aria-hidden />
                <span>
                  <span className="lname">
                    {p.label}
                    {p.badge !== undefined && <span className="badge">{p.badge}</span>}
                  </span>
                  <span className="ldesc">{p.blurb}</span>
                </span>
              </button>
            ))}
            {profiles.length === 0 && <div className="gp-none">Loading lenses…</div>}
          </div>
          <div className="pillhint wrap">
            {lensDisabled ? (
              <>
                A lens shapes a research run only.{' '}
                <button className="linkish" onClick={() => setMode('research')}>
                  Switch to Research
                </button>
              </>
            ) : selectedProfile !== undefined ? (
              <>
                up to {selectedProfile.fetchEstimate} fetches · sources: {selectedProfile.sources.join(', ')}
              </>
            ) : null}
          </div>
        </div>

        <div className="gp-sec grow">
          <div className="gp-head">
            <span className="gp-eyebrow">Runs</span>
            <span className="spacer" />
            <span className="gp-state">{entries.length}</span>
          </div>
          <div className="domlist">
            {entries.map((e) => {
              const on =
                (view.kind === 'run' && view.id === e.id) || (view.kind === 'live' && e.status === 'running')
              return (
                <button
                  key={e.id}
                  className={`runrow${on ? ' active' : ''}`}
                  aria-pressed={on}
                  onClick={() => openEntry(e)}
                >
                  <span className={`hrow-dot ${e.status === 'running' ? 'running' : e.status}`} aria-hidden />
                  <span className="rr-body">
                    <span className="rr-t" title={e.topic}>
                      {e.topic}
                    </span>
                    <span className="rr-m">
                      {e.profileKey !== null && e.profileKey !== 'broad' && (
                        <span>{profiles.find((p) => p.key === e.profileKey)?.label ?? e.profileKey}</span>
                      )}
                      <span>{e.status === 'running' ? 'running' : timeAgo(e.finishedAt)}</span>
                    </span>
                  </span>
                </button>
              )
            })}
            {entries.length === 0 && <div className="gp-none">No research run yet.</div>}
          </div>
        </div>

        <div className="gp-sec grow">
          <div className="gp-head">
            <span className="gp-eyebrow">Conversations</span>
            <span className="spacer" />
            <button className="linkish" onClick={() => openThread(null)}>
              + New
            </button>
          </div>
          <div className="sess-list">
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={view.kind === 'thread' && s.id === activeId}
                onSelect={() => openThread(s.id)}
                onRenamed={() => qc.invalidateQueries({ queryKey: ['sessions'] })}
                onDeleted={() => {
                  if (s.id === activeId) openThread(null)
                  qc.invalidateQueries({ queryKey: ['sessions'] })
                }}
              />
            ))}
            {sessions.length === 0 && <div className="gp-none">No conversation yet.</div>}
          </div>
        </div>
      </aside>

      <div className="box">
        <div className={`composer${mode === 'research' ? ' research-mode' : ''}`}>
          <div className="comp-modes" role="radiogroup" aria-label="Mode">
            <button
              className="viewpill rs"
              role="radio"
              aria-checked={mode === 'research'}
              onClick={() => setMode('research')}
              title="Research a topic on the web and create new vault pages"
            >
              Research the web
            </button>
            <button
              className="viewpill"
              role="radio"
              aria-checked={mode === 'ask'}
              onClick={() => setMode('ask')}
              title="Ask the vault (read-only)"
            >
              Ask the vault
            </button>
            <span className="spacer" />
            <span className="faintc">
              {mode === 'research' ? 'web access on · writes pages' : 'reads the vault only'}
            </span>
          </div>
          <div className="comp-main">
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
                mode === 'research'
                  ? 'Name a topic - the run reads the web and files one synthesis page…'
                  : 'Ask the vault… (Enter to send, Shift+Enter for a new line)'
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
          {/* Both modes state what the send button will do, in the same line and the same
              shape - otherwise switching modes moved everything below by the height of
              this row. Ask has no lens, no target page and no commit; saying so is the
              honest counterpart to the research plan. */}
          {mode === 'research' ? (
            selectedProfile !== undefined && (
              <div className="planline">
                <span className="pl-lens">{selectedProfile.label}</span>
                <span className="pl-sep">·</span>
                <span className="pl-k">files as</span>
                <span className="pl-title" title={targetTitle(draft.trim() || 'your topic', selectedProfile)}>
                  {targetTitle(draft.trim() || 'your topic', selectedProfile)}
                </span>
                <span className="pl-sep">·</span>
                <span className="pl-cost">
                  up to <b>{selectedProfile.fetchEstimate}</b> fetches · 1 commit
                </span>
              </div>
            )
          ) : (
            <div className="planline">
              <span className="pl-lens ask">Read-only</span>
              <span className="pl-sep">·</span>
              <span className="pl-k">answers cite</span>
              <span className="pl-title">the vault pages they came from</span>
              <span className="pl-sep">·</span>
              <span className="pl-cost">no web access · no commit</span>
            </div>
          )}
        </div>

        <div className="box-body" ref={bodyRef}>
          {view.kind === 'start' && (
            <StartView
              entries={entries}
              profiles={profiles}
              gaps={gaps.slice(0, BACKLOG_SIZE)}
              onOpen={openEntry}
              onResearch={startAbout}
            />
          )}

          {view.kind === 'live' && (
            <LiveRunView
              entry={liveEntry}
              topic={liveEntry?.topic ?? lastTopic}
              profile={runProfile}
              startedAt={runStartedAt}
              running={research.running || liveEntry !== undefined}
              error={research.error}
              result={research.result}
              vaultName={vaultName}
              authMode={authMode}
              onRetry={research.start}
              onBack={() => setView({ kind: 'start' })}
            />
          )}

          {view.kind === 'run' && (
            <RunDetail
              entry={entries.find((e) => e.id === view.id)}
              profiles={profiles}
              vaultName={vaultName}
              authMode={authMode}
              onBack={() => setView({ kind: 'start' })}
              onRerun={(topic, key) => {
                setProfileKey(key ?? 'broad')
                startAbout(topic)
              }}
            />
          )}

          {view.kind === 'thread' && (
            <div className="thread">
              {messages.length === 0 && !ask.isPending && !ask.isError && (
                <div className="chat-empty">
                  <div className="icon">
                    <Icon name="chat" />
                  </div>
                  <p>Ask the vault anything - answers cite the underlying wiki pages as clickable chips.</p>
                  <p className="dim">
                    Read-only: nothing is written, nothing is fetched from the web. Switch the composer to{' '}
                    <strong>Research the web</strong> for that.
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
                      // definition, and half-parsed markup would flicker as it completes.
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
        </div>
      </div>
    </div>
  )
}

/**
 * The screen with nothing selected: the run record, then the vault's own backlog. Both are
 * starting points, which is what an empty research screen was missing.
 */
function StartView({
  entries,
  profiles,
  gaps,
  onOpen,
  onResearch,
}: {
  entries: ResearchRunEntry[]
  profiles: ResearchProfile[]
  gaps: Array<{ title: string; refBy: number[] }>
  onOpen: (e: ResearchRunEntry) => void
  onResearch: (topic: string) => void
}): React.ReactElement {
  const lensLabel = (key: string | null): string =>
    key === null ? '-' : (profiles.find((p) => p.key === key)?.label ?? key)
  return (
    <>
      <div className="sub-head">
        <h3 className="sub-title">Runs</h3>
        <span className="box-sub">topic, lens, the pages it filed and what it cost</span>
      </div>
      {entries.length === 0 ? (
        <div className="empty">
          No research run yet. Name a topic above, pick a lens on the left, and the run files one synthesis
          page.
        </div>
      ) : (
        <table className="dtable runs-table">
          <thead>
            <tr>
              <th>Topic</th>
              <th>Lens</th>
              <th className="num">Pages</th>
              <th className="num">Cost</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} onClick={() => onOpen(e)} tabIndex={0} aria-label={`Open the run about ${e.topic}`}>
                <td>
                  <span className="hrow-name">
                    <span className={`hrow-dot ${e.status === 'running' ? 'running' : e.status}`} aria-hidden />
                    <span className="nm" title={e.topic}>
                      {e.topic}
                    </span>
                    {e.source === 'page' && (
                      <span className="badge" title="Reconstructed from the synthesis page in the vault">
                        from vault
                      </span>
                    )}
                  </span>
                  {e.error !== null && <span className="rowerr">{e.error}</span>}
                </td>
                <td className="dimc">{lensLabel(e.profileKey)}</td>
                <td className="num dimc">{e.pages.length > 0 ? `+${e.pages.length}` : '-'}</td>
                <td className="num dimc">{e.costUsd !== null ? `$${e.costUsd.toFixed(2)}` : '-'}</td>
                <td className="faintc">{e.status === 'running' ? 'running' : timeAgo(e.finishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="sub-head">
        <h3 className="sub-title">Worth a run</h3>
        <span className="box-sub">missing pages your vault already links to</span>
      </div>
      {gaps.length === 0 ? (
        <div className="empty">No open knowledge gaps - every link resolves to a page.</div>
      ) : (
        <div className="backlog">
          {gaps.map((g) => (
            <div key={g.title} className="bl-row">
              <span className="bl-t" title={g.title}>
                {g.title}
              </span>
              <span className="bl-n">{g.refBy.length} links</span>
              <button className="btn sm research" onClick={() => onResearch(g.title)}>
                Research
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * The run in flight: what it is doing and what is left, instead of a scrolling wall of tool
 * calls. The raw log is one click away for when the summary is not enough.
 */
function LiveRunView({
  entry,
  topic,
  profile,
  startedAt,
  running,
  error,
  result,
  vaultName,
  authMode,
  onRetry,
  onBack,
}: {
  entry: ResearchRunEntry | undefined
  topic: string
  profile: ResearchProfile | undefined
  startedAt: string | null
  running: boolean
  error: string | null
  result: ReturnType<typeof useMaintenanceRun>['result']
  vaultName: string
  authMode: AuthMode
  onRetry: () => void
  onBack: () => void
}): React.ReactElement {
  const settled = result !== undefined || error !== null
  return (
    <div className="detail-pad">
      <div className="detail-head">
        <Icon name="flask" />
        <h3 className="detail-title">{topic || 'Research run'}</h3>
        {profile !== undefined && profile.key !== 'broad' && <span className="lens-tag">{profile.label}</span>}
        {running && !settled && (
          <span className="badge ingesting">
            <span className="pulse-dot" aria-hidden />
            running
          </span>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={onBack}>
          All runs
        </button>
      </div>

      {!settled && (
        <div className="run-target">
          <span className="rt-k">Files as</span>
          <span className="rt-v mono-meta">{targetTitle(topic || 'your topic', profile)}</span>
          <span className="rt-k">Commit</span>
          <span className="rt-v">one commit when the run settles - revertable from Home like any other.</span>
        </div>
      )}

      <RunProgress
        channel="maintenance:research"
        startedAt={startedAt ?? entry?.startedAt ?? null}
        profile={profile}
        running={running && !settled}
      />

      {running && !settled && (
        <details className="logbox">
          <summary>Show the raw agent log</summary>
          <JobLog jobId="maintenance:research" seed={false} />
        </details>
      )}

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
    </div>
  )
}

/** A settled run from the list: its facts, its pages, and the way to run the topic again. */
function RunDetail({
  entry,
  profiles,
  vaultName,
  authMode,
  onBack,
  onRerun,
}: {
  entry: ResearchRunEntry | undefined
  profiles: ResearchProfile[]
  vaultName: string
  authMode: AuthMode
  onBack: () => void
  onRerun: (topic: string, profileKey: string | null) => void
}): React.ReactElement {
  if (entry === undefined) return <div className="empty">That run is no longer in the list.</div>
  const profile = profiles.find((p) => p.key === entry.profileKey)
  return (
    <div className="detail-pad">
      <div className="detail-head">
        <Icon name="flask" />
        <h3 className="detail-title">{entry.topic}</h3>
        {profile !== undefined && <span className="lens-tag">{profile.label}</span>}
        <span className={`badge ${entry.status === 'failed' ? 'failed' : 'ok'}`}>{entry.status}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => onRerun(entry.topic, entry.profileKey)}>
          Run again
        </button>
        <button className="btn ghost" onClick={onBack}>
          All runs
        </button>
      </div>

      <div className="facts">
        <div className="fact">
          <span className="k">Filed as</span>
          <span className="v mono-meta">{targetTitle(entry.topic, profile)}</span>
        </div>
        <div className="fact">
          <span className="k">When</span>
          <span className="v">{timeAgo(entry.finishedAt)}</span>
        </div>
        <div className="fact">
          <span className="k">Took</span>
          <span className="v">{duration(entry.startedAt, entry.finishedAt)}</span>
        </div>
        <div className="fact">
          <span className="k">Cost</span>
          <span className="v">
            {entry.costUsd !== null ? <Cost value={entry.costUsd} authMode={authMode} /> : 'not kept'}
          </span>
        </div>
        <div className="fact">
          <span className="k">Pages</span>
          <span className="v">{entry.pages.length}</span>
        </div>
      </div>

      {entry.error !== null && <div className="toast err">{entry.error}</div>}

      {entry.pages.length > 0 && (
        <div>
          <h4 className="section-title">Pages</h4>
          <span className="pages">
            {entry.pages.map((p) => (
              <PageLink key={p} vaultName={vaultName} path={p} />
            ))}
          </span>
        </div>
      )}

      <p className="tab-hint">
        {entry.source === 'page'
          ? 'Reconstructed from the synthesis page in the vault - this run predates the run log, so its cost and duration were never recorded.'
          : entry.source === 'state'
            ? 'From the restart-proof settle record - the run wrote no page.'
            : entry.source === 'run'
              ? 'From the run record the service still holds in memory.'
              : 'From the run log - recorded when the run settled, and kept across restarts.'}
      </p>
    </div>
  )
}

/**
 * One session as a control-column row: title + meta (message count, last activity), with
 * rename (inline input - no `window.prompt`, blocked/ugly in installed PWAs) and a two-step
 * delete.
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
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    },
    [],
  )

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
