/**
 * The second panel of Home's stock zone (2026-08-27).
 *
 * The graph used the whole width and needed about half of it. This is what fills the other
 * half: one of three views over payloads the screen already has (lib/homePanels.ts). The
 * switcher in the head is deliberate - which one earns the slot is a question the data
 * answers differently per vault, so it stays a choice rather than a decision made once here.
 *
 * The body is a FIXED height, and every view fills it the same way. A view that sized itself
 * to its content made the whole zone taller than a chart one and moved every row below it.
 * It is also the same dark inset the graph sits in next door, so the zone reads as one band
 * of two pictures rather than a boxed picture beside a bare list.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { Icon } from './Icon.tsx'
import { PageLink } from './PageLink.tsx'
import { domainColor } from '../lib/domains.ts'
import { PANEL_IDS, dayLabel, domainCounts, recentPages, type PanelId } from '../lib/homePanels.ts'
import type { GraphNode } from '../api/types.ts'
import type { ActivityEvent } from '../lib/activity.ts'

const TITLES: Record<PanelId, { tab: string; eyebrow: string }> = {
  domains: { tab: 'Domains', eyebrow: 'Domains' },
  week: { tab: 'This week', eyebrow: 'What the vault learned' },
  gaps: { tab: 'Gaps', eyebrow: 'Worth a run' },
}

export function HomePanel({
  panel,
  onPanel,
  nodes,
  events,
  gaps,
  vaultName,
  now,
  onOpenDomain,
  onOpenGaps,
  onResearch,
}: {
  panel: PanelId
  onPanel: (id: PanelId) => void
  nodes: readonly GraphNode[]
  /** The activity stream - what the runs actually wrote, and when. */
  events: readonly ActivityEvent[]
  gaps: ReadonlyArray<{ title: string; refBy: number[] }>
  vaultName: string
  /** Passed in rather than read here, so the panel renders the same way in a test. */
  now: number
  /** The Library, filtered to one domain - a bar you click is a question about that domain. */
  onOpenDomain: (domain: string) => void
  onOpenGaps: () => void
  /** Research, with the gap's name in the composer (`/research?prefill=`, the param it reads). */
  onResearch: (topic: string) => void
}): React.ReactElement {
  return (
    <div className="vz-panel">
      <div className="vz-phead">
        <span className="gp-eyebrow">{TITLES[panel].eyebrow}</span>
        <span className="spacer" />
        <div className="seg sm" role="radiogroup" aria-label="Second panel">
          {PANEL_IDS.map((id) => (
            <button key={id} role="radio" aria-checked={panel === id} onClick={() => onPanel(id)}>
              {TITLES[id].tab}
            </button>
          ))}
        </div>
      </div>
      <div className="vz-body inset">
        <Body
          panel={panel}
          nodes={nodes}
          events={events}
          gaps={gaps}
          vaultName={vaultName}
          now={now}
          onOpenDomain={onOpenDomain}
          onResearch={onResearch}
        />
      </div>
      <div className="vz-foot">
        <Foot panel={panel} nodes={nodes} events={events} gaps={gaps} now={now} onOpenGaps={onOpenGaps} />
      </div>
    </div>
  )
}

function Body({
  panel,
  nodes,
  events,
  gaps,
  vaultName,
  now,
  onOpenDomain,
  onResearch,
}: {
  panel: PanelId
  nodes: readonly GraphNode[]
  /** The activity stream - what the runs actually wrote, and when. */
  events: readonly ActivityEvent[]
  gaps: ReadonlyArray<{ title: string; refBy: number[] }>
  vaultName: string
  now: number
  onOpenDomain: (domain: string) => void
  onResearch: (topic: string) => void
}): React.ReactElement {
  if (panel === 'domains') {
    const { domains } = domainCounts(nodes)
    if (domains.length === 0) return <div className="empty">No page carries a domain yet.</div>
    const max = domains[0]!.pages
    return (
      <div className="ranklist">
        {domains.map((d) => (
          <button
            key={d.domain}
            className="rank"
            onClick={() => onOpenDomain(d.domain)}
            title={`List the ${d.pages} pages in ${d.domain}`}
          >
            <span className="lab">
              <span className="dot" style={{ background: domainColor(d.domain) }} aria-hidden />
              <span className="nm">{d.domain}</span>
            </span>
            <span className="barrow">
              <span className="track">
                <i style={{ width: `${(d.pages / max) * 100}%`, background: domainColor(d.domain) }} />
              </span>
              <span className="n">{d.pages}</span>
            </span>
          </button>
        ))}
      </div>
    )
  }

  if (panel === 'week') {
    const days = recentPages(events, now)
    if (days.length === 0) return <div className="empty">Nothing new this week.</div>
    return (
      <div className="newlist">
        {days.map((g) => (
          <div key={g.ago} className="daygroup">
            <div className="day">
              {dayLabel(g.ago)} · {g.pages.length}
            </div>
            <div className="items">
              {g.pages.map((path) => (
                <PageLink key={path} vaultName={vaultName} path={path} />
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (gaps.length === 0) return <div className="empty">No open knowledge gaps - every link resolves to a page.</div>
  return <Gaps gaps={gaps} onResearch={onResearch} />
}

/** The cleanup run accepts at most this many titles; the picker stops there too. */
const MAX_UNLINK = 20

/**
 * The gap cards, with the second way out of a gap (2026-09-05). A gap closes either by
 * research (the card itself) or by deciding it never deserved a page and unlinking it - a
 * single-mention person, an image caption, a callout title an ingest linked by reflex. The
 * pick control on each card collects those; one bounded agent run (`cleanupGaps`) then turns
 * the links into words, as one revertable commit. Two steps to start it, because it spends
 * a run and rewrites pages; the run is tracked here until it settles, and the graph
 * refetches so the cards disappear.
 */
function Gaps({
  gaps,
  onResearch,
}: {
  gaps: ReadonlyArray<{ title: string; refBy: number[] }>
  onResearch: (topic: string) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<readonly string[]>([])
  const [armed, setArmed] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // Picks that stopped being gaps (a research run wrote the page) drop out on their own.
  const open = new Set(gaps.map((g) => g.title))
  const live = picked.filter((t) => open.has(t))

  const start = useMutation({
    mutationFn: () => api.cleanupGaps(live),
    onSuccess: (run) => {
      setRunId(run.id)
      setNote(null)
    },
    onError: (e: Error) => setNote(`Could not start: ${e.message}`),
    onSettled: () => setArmed(false),
  })
  const runQ = useQuery({
    queryKey: ['maintenance-run', runId],
    queryFn: () => api.maintenanceRun(runId as string),
    enabled: runId !== null,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'running' ? false : 2000),
  })
  const run = runQ.data
  const running = start.isPending || (runId !== null && (run === undefined || run.status === 'running'))

  useEffect(() => {
    if (run === undefined || run.status === 'running') return
    if (run.status === 'done') {
      setNote(`Unlinked ${live.length} gap${live.length === 1 ? '' : 's'} - revertable from the activity stream.`)
      setPicked([])
    } else {
      setNote(`Unlinking failed: ${run.error ?? run.result?.error ?? 'unknown error'}`)
    }
    setRunId(null)
    void qc.invalidateQueries({ queryKey: ['graph'] })
    void qc.invalidateQueries({ queryKey: ['stats'] })
    void qc.invalidateQueries({ queryKey: ['maintenance-history'] })
    // `live` is read once, when the run settles; re-running on every pick would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status])

  const toggle = (title: string): void => {
    setArmed(false)
    setPicked((p) => (p.includes(title) ? p.filter((t) => t !== title) : p.length >= MAX_UNLINK ? p : [...p, title]))
  }

  return (
    <div className="gapview">
      {(live.length > 0 || running || note !== null) && (
        <div className="gapbar" role="status">
          {running ? (
            <span className="dim">Unlinking {live.length} gap{live.length === 1 ? '' : 's'}… one agent run, one commit.</span>
          ) : live.length > 0 ? (
            <>
              <span>
                {live.length} picked{live.length >= MAX_UNLINK ? ` (max ${MAX_UNLINK} per run)` : ''}
              </span>
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => setPicked([])}>
                Clear
              </button>
              <button
                className={`btn sm${armed ? ' danger' : ''}`}
                onClick={() => (armed ? start.mutate() : setArmed(true))}
                title="Turns every link to these titles into plain text - one agent run, one revertable commit. No page is created or deleted."
              >
                {armed ? `Really unlink ${live.length}?` : 'Unlink these'}
              </button>
            </>
          ) : (
            <>
              <span className="dim">{note}</span>
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => setNote(null)} aria-label="Dismiss">
                <Icon name="x" />
              </button>
            </>
          )}
        </div>
      )}
      <div className="gaplist">
        {gaps.map((g) => {
          const on = live.includes(g.title)
          return (
            <div key={g.title} className={`gapcard${on ? ' picked' : ''}`}>
              <button className="gap-go" onClick={() => onResearch(g.title)} title={`Research "${g.title}"`}>
                <span className="t" title={g.title}>
                  {g.title}
                </span>
                <span className="m">
                  {g.refBy.length} page{g.refBy.length === 1 ? '' : 's'} link{g.refBy.length === 1 ? 's' : ''} here
                </span>
              </button>
              <button
                className={`gap-pick${on ? ' on' : ''}`}
                aria-pressed={on}
                aria-label={on ? `Unpick ${g.title}` : `Pick ${g.title} for unlinking`}
                title={on ? 'Picked for unlinking' : 'Pick: this should not become a page, unlink it instead'}
                disabled={running}
                onClick={() => toggle(g.title)}
              >
                <Icon name={on ? 'check' : 'x'} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The figures under the body - what the picture above adds up to. */
function Foot({
  panel,
  nodes,
  events,
  gaps,
  now,
  onOpenGaps,
}: {
  panel: PanelId
  nodes: readonly GraphNode[]
  /** The activity stream - what the runs actually wrote, and when. */
  events: readonly ActivityEvent[]
  gaps: ReadonlyArray<{ title: string; refBy: number[] }>
  now: number
  onOpenGaps: () => void
}): React.ReactElement {
  if (panel === 'domains') {
    const { domains, unfiled } = domainCounts(nodes)
    return (
      <>
        <span className="vzl">
          <b>{domains.length}</b> domains
        </span>
        <span className="vzl">
          <b>{unfiled}</b> pages unfiled
        </span>
      </>
    )
  }

  if (panel === 'week') {
    const days = recentPages(events, now)
    const total = days.reduce((n, d) => n + d.pages.length, 0)
    return (
      <span className="vzl" title="Counted from the runs listed in the stream, which is capped - the vault's own 7-day growth is in the hero.">
        <b>{total}</b> pages the listed runs wrote
      </span>
    )
  }

  // Distinct missing PAGES, which is what the list above shows one card each of - the head
  // of the gaps view next door counts the links behind them separately (12 links, 10 pages).
  return (
    <button className="vzl linkish" onClick={onOpenGaps}>
      <b>{gaps.length}</b> pages linked but not written
    </button>
  )
}
