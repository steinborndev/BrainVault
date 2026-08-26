/**
 * Research (SPEC.md §6.3/§6.4, redesign 2026-08-26 third pass) - the screen where you go and
 * find something out. Two ways to do that, named the same way in both places they appear:
 *
 *   WEB RESEARCH    a run that reads the web and files pages. Costs fetches, commits once.
 *   VAULT RESEARCH  a question the vault answers from what it already holds. Cites pages,
 *                   writes nothing.
 *
 * They are the same object from the user's side - something you asked, and the record of what
 * came back - so they are two ledgers of the same shape in the main box, splitting the height
 * and scrolling on their own. The columns then say how they differ.
 *
 *   LEFT   what SHAPES a run and what the runs add up to: the lens as a standing control
 *          (four profiles, a closed set), a filter over the web ledger, the running totals,
 *          and the queue as a status foot - a run takes a queue slot, the same as a drop.
 *   RIGHT  the composer, then the two ledgers, then the vault's own backlog as a band of
 *          offers. Opening a run or a conversation replaces the ledgers with that one thing
 *          and a way back.
 *
 * Every object is listed ONCE. The runs used to appear twice - a short list in the rail and a
 * full ledger in the box - which existed only because opening a run replaced the ledger and
 * left no way back; the detail view has a Back button instead.
 *
 * `/query` is still request/response - the ANSWER of record arrives with the HTTP reply - but
 * the text streams live meanwhile (chatStream). First questions stream too: the client sends
 * a request id and the server echoes it on the deltas, because the session id only exists
 * once the reply lands.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, parseCitations } from '../api/client.ts'
import type { AuthMode, ChatMessage, ResearchProfile, Session } from '../api/types.ts'
import { Markdown } from '../components/Markdown.tsx'
import { PageLink, PageLinks } from '../components/PageLink.tsx'
import { CitationChip } from '../components/CitationChip.tsx'
import { JobLog } from '../components/JobLog.tsx'
import { AskSteps, ResearchSteps } from '../components/AgentSteps.tsx'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'
import { Fact, Facts } from '../components/Fact.tsx'
import { QueueState } from '../components/ActivityRows.tsx'
import { Icon } from '../components/Icon.tsx'
import { queryState, merge } from '../components/QueryState.tsx'
import { navigate } from '../lib/router.ts'
import { openableRow } from '../lib/tableRow.ts'
import { chatStream } from '../lib/chatStream.ts'
import { duration, timeAgo, tokens } from '../lib/format.ts'
import { Cost, ESTIMATE_LABEL, isEstimate } from '../components/Cost.tsx'
import { buildResearchRuns, targetTitle, type ResearchRunEntry } from '../lib/researchRuns.ts'

type ComposerMode = 'research' | 'ask'

/**
 * A run in flight does not get a screen of its own: the step strip under the composer is
 * already showing it, in the same place it sits while idle, so starting a run changes state
 * rather than layout. `run` is a settled run picked out of the list.
 */
type View = { kind: 'start' } | { kind: 'run'; id: string } | { kind: 'thread'; id: string | null }

/** How many gaps the research backlog offers at once. */
const BACKLOG_SIZE = 40

export function Chat({ researchPrefill = '' }: { researchPrefill?: string }): React.ReactElement {
  const qc = useQueryClient()
  const [mode, setMode] = useState<ComposerMode>('research')
  const [draft, setDraft] = useState('')
  const [profileKey, setProfileKey] = useState('broad')
  const [view, setView] = useState<View>({ kind: 'start' })
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Narrows the web ledger to one lens; null = all of them. */
  const [lensFilter, setLensFilter] = useState<string | null>(null)

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
  // The citation count of the newest answer - the ask strip's last step reports it.
  const lastCitations = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role === 'assistant') return parseCitations(m.citations).length
    }
    return 0
  })()

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
    // Every screen stays MOUNTED and is hidden with `[hidden]` (App.tsx), so this runs once
    // while the Research screen has no layout at all - and an element with no layout reports
    // `scrollHeight: 0`. Writing that back pinned the field to `height: 0px`, where it stayed
    // until the first keystroke, because `draft` never changed in between. Reloading straight
    // onto /research measured a laid-out element and looked fine, which is why it read as "too
    // small until you reload". With no inline height the `rows={1}` height stands, which is
    // exactly the height this would have computed anyway.
    if (ta.offsetParent === null) return
    ta.style.height = 'auto'
    // `scrollHeight` counts content and padding but not the border, and the stylesheet is
    // border-box - so assigning it straight back made the field two pixels shorter than its
    // own content every time, which is why one line of placeholder sat clipped at the bottom.
    const border = ta.offsetHeight - ta.clientHeight
    ta.style.height = `${Math.min(160, ta.scrollHeight + border)}px`
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
    setView({ kind: 'start' })
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
    // A running entry has no detail to open - the strip under the composer is its view.
    setView(entry.status === 'running' ? { kind: 'start' } : { kind: 'run', id: entry.id })
  }

  const startAbout = (topic: string): void => {
    setMode('research')
    setDraft(topic)
    composerRef.current?.focus()
  }

  // What the two ledgers add up to. Runs whose cost was never recorded (they predate the run
  // log) are left out of the total rather than counted as free - the tile says how many.
  const settled = entries.filter((e) => e.status !== 'running')
  const failedRuns = entries.filter((e) => e.status === 'failed').length
  const pagesFiled = entries.reduce((sum, e) => sum + e.pages.length, 0)
  const costed = settled.filter((e) => e.costUsd !== null)
  const spend = costed.reduce((sum, e) => sum + (e.costUsd ?? 0), 0)
  const lensCounts = new Map<string, number>()
  for (const e of entries) {
    const key = e.profileKey ?? 'broad'
    lensCounts.set(key, (lensCounts.get(key) ?? 0) + 1)
  }
  const shownEntries = lensFilter === null ? entries : entries.filter((e) => (e.profileKey ?? 'broad') === lensFilter)

  // What the thread bar calls this conversation. A session that was never saved has no
  // title yet, and the sessions list already names that state "New conversation".
  const threadTitle =
    activeId === null
      ? 'New conversation'
      : (sessions.find((s) => s.id === activeId)?.title ?? 'New conversation')

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
                  Switch to Web Research
                </button>
              </>
            ) : selectedProfile !== undefined ? (
              <>
                up to {selectedProfile.fetchEstimate} fetches · sources: {selectedProfile.sources.join(', ')}
              </>
            ) : null}
          </div>
        </div>

        {/* Narrows the web ledger. The backlog under the ledgers is never filtered: it is
            what the vault is missing, not what you did. */}
        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Filter</span>
            <span className="spacer" />
            {lensFilter !== null && (
              <button className="btn ghost" onClick={() => setLensFilter(null)}>
                <Icon name="x" /> Clear
              </button>
            )}
          </div>
          <div className="pillrow" role="radiogroup" aria-label="Filter web research by lens">
            <button
              className="viewpill"
              role="radio"
              aria-checked={lensFilter === null}
              onClick={() => setLensFilter(null)}
            >
              All {entries.length}
            </button>
            {profiles.map((p) => {
              const n = lensCounts.get(p.key) ?? 0
              return (
                <button
                  key={p.key}
                  className="viewpill"
                  role="radio"
                  aria-checked={lensFilter === p.key}
                  disabled={n === 0}
                  title={n === 0 ? `No run has used the ${p.label} lens yet` : undefined}
                  onClick={() => setLensFilter(lensFilter === p.key ? null : p.key)}
                >
                  {p.label} {n}
                </button>
              )
            })}
          </div>
        </div>

        {/* What the two ledgers add up to, in the same metric-list shape Home uses. */}
        <div className="gp-sec grow">
          <div className="gp-head">
            <span className="gp-eyebrow">Research so far</span>
          </div>
          <div className="railfacts">
            <button
              className="vzf"
              onClick={() => {
                setLensFilter(null)
                setView({ kind: 'start' })
              }}
            >
              <b>{entries.length}</b>
              <span>{failedRuns > 0 ? `runs, ${failedRuns} failed` : 'web research runs'}</span>
            </button>
            <button className="vzf" onClick={() => navigate('/library')}>
              <b>{pagesFiled}</b>
              <span>pages filed</span>
            </button>
            <button className="vzf" onClick={() => setView({ kind: 'start' })}>
              <b>{sessions.length}</b>
              <span>vault conversations</span>
            </button>
            <div className="vzf static">
              <b>
                <Cost value={spend} authMode={authMode} />
              </b>
              <span>
                recorded across {costed.length} run{costed.length === 1 ? '' : 's'}
              </span>
            </div>
            <button className="vzf" onClick={() => navigate('/graph?gaps=1')}>
              <b>{gaps.length}</b>
              <span>gaps worth a run</span>
            </button>
          </div>
        </div>

        {/* A run takes a queue slot, the same as a drop - so Research states the queue in the
            same place, and the same shape, that Home does. */}
        <div className="gp-sec gp-foot">
          <div className="gp-head">
            <span className="gp-eyebrow">Queue</span>
          </div>
          <QueueState
            paused={stats.data?.queue.paused === true}
            reason={stats.data?.queue.pauseReason ?? null}
            concurrency={stats.data?.queue.concurrency}
            active={stats.data?.queue.active ?? 0}
            queued={stats.data?.queue.queued ?? 0}
          />
        </div>
      </aside>

      <div className="box">
        {/* The console (2026-08-26): mode, topic, what the run will cost and the phases it
            goes through, in ONE raised card. These were four strips of equal value stacked
            on the same ground as the run table below them, and the tab had no visible place
            to start. The card is inset, lifted a step, and carries a rail in the mode's own
            colour - so which mode is armed is legible from the shape, not just the label. */}
        <div className={`console${mode === 'ask' ? ' ask' : ''}`}>
          <div className="console-head">
            <div className="seg" role="radiogroup" aria-label="Mode">
              <button
                role="radio"
                aria-checked={mode === 'research'}
                onClick={() => setMode('research')}
                title="Research a topic on the web and create new vault pages"
              >
                Web Research
              </button>
              <button
                role="radio"
                aria-checked={mode === 'ask'}
                onClick={() => setMode('ask')}
                title="Ask the vault (read-only)"
              >
                Vault Research
              </button>
            </div>
            <span className="spacer" />
            {/* What the armed mode is ALLOWED to do. The two modes differ in exactly these
                two capabilities, and a run that can reach the web and write pages should not
                announce itself in the same faint grey as a read-only query. */}
            <span className="caps">
              {mode === 'research' ? (
                <>
                  <span className="cap">
                    <Icon name="globe" /> Web access
                  </span>
                  <span className="cap">
                    <Icon name="file" /> Writes pages
                  </span>
                </>
              ) : (
                <>
                  <span className="cap">
                    <Icon name="book" /> Reads the vault
                  </span>
                  <span className="cap off">No commit</span>
                </>
              )}
            </span>
          </div>
          <div className="console-main">
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
            <button className="btn-run" disabled={draft.trim() === '' || busy} onClick={send}>
              {sendLabel}
            </button>
          </div>
          {/* Both modes state what the send button will do, in the same line and the same
              shape - otherwise switching modes moved everything below by the height of this
              row. Each fact carries its own key now, so the row is scanned rather than read
              as a sentence of separators. Ask has no lens, no target page and no commit;
              saying so is the honest counterpart to the research plan. */}
          {mode === 'research' ? (
            selectedProfile !== undefined && (
              <div className="planline">
                <span className="pl-fact">
                  <span className="pl-key">Lens</span>
                  <span className="pl-val pl-hi">{selectedProfile.label}</span>
                </span>
                <span className="pl-fact">
                  <span className="pl-key">Files as</span>
                  <span className="pl-val pl-page" title={targetTitle(draft.trim() || 'your topic', selectedProfile)}>
                    {targetTitle(draft.trim() || 'your topic', selectedProfile)}
                  </span>
                </span>
                <span className="pl-fact">
                  <span className="pl-key">Budget</span>
                  <span className="pl-val">
                    up to <b>{selectedProfile.fetchEstimate}</b> fetches
                  </span>
                </span>
                <span className="pl-fact">
                  <span className="pl-key">Commits</span>
                  <span className="pl-val">
                    <b>1</b>
                  </span>
                </span>
              </div>
            )
          ) : (
            <div className="planline">
              <span className="pl-fact">
                <span className="pl-key">Mode</span>
                <span className="pl-val pl-hi">Read-only</span>
              </span>
              <span className="pl-fact">
                <span className="pl-key">Answers</span>
                <span className="pl-val">cite the vault pages they came from</span>
              </span>
              <span className="pl-fact">
                <span className="pl-key">Writes</span>
                <span className="pl-val">nothing - no web access, no commit</span>
              </span>
            </div>
          )}
          {/* The rail is the console's FOOTER, not a sibling: it describes the run this
              console starts. Always here, in both modes - dimmed while nothing runs, lit as
              it happens, so a run starting never moves the screen. */}
          {mode === 'research' ? (
            <ResearchSteps
              running={research.running || liveEntry !== undefined}
              startedAt={runStartedAt ?? liveEntry?.startedAt ?? null}
              profile={runProfile ?? selectedProfile}
            />
          ) : (
            <AskSteps
              pending={ask.isPending}
              streamed={streamed}
              citations={lastCitations}
              answered={messages.some((m) => m.role === 'assistant')}
            />
          )}
        </div>

        {mode === 'research' && research.error !== null && (
          <div className="toast err runbanner">
            {research.error}{' '}
            <button className="btn" onClick={research.start}>
              Retry
            </button>
          </div>
        )}
        {mode === 'research' && research.result?.ok === true && (
          <div className="toast ok runbanner">
            {lastTopic === '' ? 'Run finished' : `Run finished: ${lastTopic}`}
            {research.result.usage.costUsd > 0 && (
              <span>
                {' '}
                · <Cost value={research.result.usage.costUsd} authMode={authMode} />
                {isEstimate(authMode) && <span className="dim"> ({ESTIMATE_LABEL})</span>}
              </span>
            )}
            {research.result.pages.length > 0 ? (
              <PageLinks vaultName={vaultName} paths={research.result.pages} />
            ) : (
              <> - no changes.</>
            )}
          </div>
        )}

        {/* The way back out of a conversation. It sits OUTSIDE the scrolling body on
            purpose: the thread scrolls itself to the newest message, so a bar inside it
            would be somewhere above the fold for the whole conversation - which is how a
            reader ended up with no way back to the overview at all. The run detail keeps
            its own "All runs" button inside its pane, where the content is short enough
            that it stays in view. */}
        {view.kind === 'thread' && (
          <div className="thread-bar">
            <button className="backlink" onClick={() => setView({ kind: 'start' })}>
              <Icon name="back" />
              All conversations
            </button>
            <Icon name="chat" />
            <h3 className="detail-title" title={threadTitle}>
              {threadTitle}
            </h3>
          </div>
        )}

        <div className={`box-body${view.kind === 'start' ? ' start-view' : ''}`} ref={bodyRef}>
          {view.kind === 'start' && (
            <StartView
              entries={shownEntries}
              totalRuns={entries.length}
              profiles={profiles}
              sessions={sessions}
              gaps={gaps.slice(0, BACKLOG_SIZE)}
              authMode={authMode}
              runState={queryState(merge(historyQ, runsQ, stateQ), 'the run history')}
              sessionState={queryState(sessionsQ, 'the conversations')}
              gapState={queryState(graphQ, 'the knowledge gaps')}
              activeSessionId={activeId}
              onOpen={openEntry}
              onOpenThread={openThread}
              onResearch={startAbout}
              onSessionsChanged={() => qc.invalidateQueries({ queryKey: ['sessions'] })}
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
  totalRuns,
  profiles,
  sessions,
  gaps,
  authMode,
  runState,
  sessionState,
  gapState,
  activeSessionId,
  onOpen,
  onOpenThread,
  onResearch,
  onSessionsChanged,
}: {
  entries: ResearchRunEntry[]
  /** Runs before the lens filter, so the count can say "6 of 13" rather than lying. */
  totalRuns: number
  profiles: ResearchProfile[]
  sessions: Session[]
  gaps: Array<{ title: string; refBy: number[] }>
  authMode: AuthMode
  /** Loading/failed for the three queries the run list is built from; null once ready. */
  runState: React.ReactElement | null
  sessionState: React.ReactElement | null
  /** Same for the graph query behind the backlog. */
  gapState: React.ReactElement | null
  activeSessionId: string | null
  onOpen: (e: ResearchRunEntry) => void
  onOpenThread: (id: string | null) => void
  onResearch: (topic: string) => void
  onSessionsChanged: () => void
}): React.ReactElement {
  const lensLabel = (key: string | null): string =>
    key === null ? '-' : (profiles.find((p) => p.key === key)?.label ?? key)
  return (
    <>
      {/* Two ledgers of the same shape, splitting the height: what you sent to the web, and
          what you asked the vault. Same object from the user's side; the columns are where
          they differ - one files pages and costs fetches, the other cites pages and commits
          nothing. */}
      <div className="sv-sec">
        <div className="sub-head">
          <h3 className="sub-title">Web Research</h3>
          <span className="box-sub">topic, lens, the pages it filed and what it cost</span>
          <span className="spacer" />
          <span className="count">
            {entries.length}
            {entries.length !== totalRuns ? ` of ${totalRuns}` : ''}
          </span>
        </div>
        <div className="sv-scroll">
          {runState ??
            (entries.length === 0 ? (
              <div className="empty">
                {totalRuns === 0
                  ? 'No research run yet. Name a topic above, pick a lens on the left, and the run files one synthesis page.'
                  : 'No run used that lens. Clear the filter on the left to see the rest.'}
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
                    <tr key={e.id} {...openableRow(() => onOpen(e), `Open the run about ${e.topic}`)}>
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
                      <td className="num dimc">
                        {e.costUsd !== null ? <Cost value={e.costUsd} authMode={authMode} /> : '-'}
                      </td>
                      <td className="faintc">{e.status === 'running' ? 'running' : timeAgo(e.finishedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
        </div>
      </div>

      <div className="sv-sec">
        <div className="sub-head">
          <h3 className="sub-title">Vault Research</h3>
          <span className="box-sub">questions the vault answered from what it already holds</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => onOpenThread(null)}>
            + New
          </button>
          <span className="count">{sessions.length}</span>
        </div>
        <div className="sv-scroll">
          {sessionState ??
            (sessions.length === 0 ? (
              <div className="empty">
                Nothing asked yet. Switch the composer to Vault Research and ask - the answer cites the pages
                it came from, and nothing is written.
              </div>
            ) : (
              <table className="dtable sess-table">
                <thead>
                  <tr>
                    <th>Question</th>
                    <th className="num">Turns</th>
                    <th>Last reply</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <SessionLedgerRow
                      key={s.id}
                      session={s}
                      active={s.id === activeSessionId}
                      onSelect={() => onOpenThread(s.id)}
                      onChanged={onSessionsChanged}
                    />
                  ))}
                </tbody>
              </table>
            ))}
        </div>
      </div>

      {/* The backlog is not history, it is an offer - so it is a band of cards with a verb on
          them rather than a third table, and it keeps its own height instead of taking a
          third of the two ledgers'. */}
      <div className="sv-sec sv-band">
        <div className="sub-head">
          <h3 className="sub-title">Worth a run</h3>
          <span className="box-sub">pages your vault links to but has never written</span>
          <span className="spacer" />
          <span className="count">{gaps.length}</span>
        </div>
        <div className="sv-scroll">
          {gapState ??
            (gaps.length === 0 ? (
              <div className="empty">No open knowledge gaps - every link resolves to a page.</div>
            ) : (
              <div className="offers">
                {gaps.map((g) => (
                  <button key={g.title} className="offer" onClick={() => onResearch(g.title)}>
                    <span className="of-t" title={g.title}>
                      {g.title}
                    </span>
                    <span className="of-m">
                      <span className="of-n">
                        {g.refBy.length} page{g.refBy.length === 1 ? '' : 's'} link{g.refBy.length === 1 ? 's' : ''}{' '}
                        here
                      </span>
                      <span className="of-go">Research</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
        </div>
      </div>
    </>
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
        <button className="backlink" onClick={onBack}>
          <Icon name="back" />
          All runs
        </button>
        <Icon name="flask" />
        <h3 className="detail-title">{entry.topic}</h3>
        {profile !== undefined && <span className="lens-tag">{profile.label}</span>}
        <span className={`badge ${entry.status === 'failed' ? 'failed' : 'ok'}`}>{entry.status}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => onRerun(entry.topic, entry.profileKey)}>
          Run again
        </button>
      </div>

      <Facts>
        <Fact k="Filed as" v={<span className="mono-meta">{targetTitle(entry.topic, profile)}</span>} />
        <Fact k="When" v={timeAgo(entry.finishedAt)} />
        <Fact k="Took" v={duration(entry.startedAt, entry.finishedAt)} />
        <Fact
          k="Cost"
          v={entry.costUsd !== null ? <Cost value={entry.costUsd} authMode={authMode} /> : 'not kept'}
        />
        <Fact k="Pages" v={entry.pages.length} />
      </Facts>

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
 * One conversation as a ledger row: the question, how many turns it took, when it last
 * answered, and the two actions it owns. Rename is an inline input (no `window.prompt` -
 * blocked and ugly in installed PWAs) and delete is two-step, both unchanged from the rail
 * row this replaces; what changed is that a conversation is now listed in the same shape as
 * a research run, because from the user's side they are the same kind of thing.
 */
function SessionLedgerRow({
  session,
  active,
  onSelect,
  onChanged,
}: {
  session: Session
  active: boolean
  onSelect: () => void
  onChanged: () => void
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
      onChanged()
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
    onChanged()
  }

  return (
    <tr className={active ? 'active' : undefined}>
      <td>
        {editing ? (
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
            aria-label="Rename conversation"
          />
        ) : (
          <span
            className="hrow-name"
            {...openableRow(onSelect, `Open the conversation ${session.title ?? 'untitled'}`)}
          >
            <span className="hrow-dot done" aria-hidden />
            <span className="nm" title={session.title ?? 'untitled'}>
              {session.title ?? 'New conversation'}
            </span>
          </span>
        )}
      </td>
      <td className="num dimc">{session.message_count ?? '-'}</td>
      <td className="faintc">{timeAgo(session.last_ts ?? session.created_at)}</td>
      {/* The flex row is a span INSIDE the cell. A `td` set to `display: flex` drops out of
          the table layout: this one stopped taking its 10% column, so the active row's
          background ended three columns in, and its `opacity` made the cell its own layer
          with a seam down the edge. Same rule as the library's `.lt-cell`. */}
      <td className="lt-acts-cell">
        <span className="rowacts">
          <button
            className="session-act"
            onClick={() => {
              setTitle(session.title ?? '')
              setEditing(true)
            }}
            title="Rename"
            aria-label="Rename conversation"
          >
            <Icon name="edit" />
          </button>
          <button
            className={`session-act${confirming ? ' danger' : ''}`}
            onClick={() => void del()}
            title={confirming ? 'Really delete?' : 'Delete'}
            aria-label={confirming ? 'Confirm delete' : 'Delete conversation'}
          >
            {confirming ? 'Really?' : <Icon name="x" />}
          </button>
        </span>
      </td>
    </tr>
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
