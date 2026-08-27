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
  return (
    <div className="gaplist">
      {gaps.map((g) => (
        <button key={g.title} className="gapcard" onClick={() => onResearch(g.title)}>
          <span className="t" title={g.title}>
            {g.title}
          </span>
          <span className="m">
            {g.refBy.length} page{g.refBy.length === 1 ? '' : 's'} link{g.refBy.length === 1 ? 's' : ''} here
          </span>
        </button>
      ))}
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
