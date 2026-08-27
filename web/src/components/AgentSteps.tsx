/**
 * The console's step rail: what the agent will do, in the order it will do it - dimmed
 * while nothing is running, lit as it happens, with one track running through the marks
 * that fills as the run advances.
 *
 * The point of showing it idle is that the run does not rearrange the screen when it starts.
 * The steps are already there, in the same place, at the same height; starting a run only
 * changes their state. Both composer modes get one, because switching modes must not move
 * anything either - which is also why the strip is one horizontal row rather than the run
 * view's vertical plan: research has five phases and a query has three, and a vertical list
 * would be two different heights.
 *
 * The row is a grid of RAIL_COLUMNS equal columns, never one column per step (2026-08-27).
 * Sharing the width between three marks put an ask's "Answer" nowhere near a run's second
 * step and stretched the three of them across a track built for five. On a fixed grid an
 * ask fills the first three columns, leaves the rest empty, and step 2 sits under step 2.
 *
 * The idle caption is gone: two sentences that said what the marks beside them already say.
 * What is left of the foot is the LIVE line - the run's own status and its elapsed time -
 * in a fixed-width slot beside the row, so it can appear without moving a single mark.
 *
 * Every state here is observed, never estimated: research counts its own tool calls
 * (lib/researchProgress.ts), a query has three observable markers (lib/askProgress.ts), and
 * the "read sources" phase carries the only honest ratio either run has - the lens's fetch
 * cap, which is declared before the run starts.
 */

import { useEffect, useState } from 'react'
import { useJobLog } from '../hooks/useJobLog.ts'
import { Icon } from './Icon.tsx'
import {
  RESEARCH_STEPS,
  deriveResearchProgress,
  fetchCap,
  EMPTY_PROGRESS,
} from '../lib/researchProgress.ts'
import { ASK_STEPS, deriveAskProgress, type AskProgressInput } from '../lib/askProgress.ts'
import type { ResearchProfile } from '../api/types.ts'

/** Short labels for the strip; the full sentence is the step's tooltip. */
const RESEARCH_SHORT: Record<string, string> = {
  plan: 'Plan',
  search: 'Search',
  read: 'Read sources',
  file: 'Write pages',
  commit: 'Commit',
}

/** mm:ss since `startedAt`, ticking once a second while the run is live. */
function useElapsed(startedAt: string | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startedAt])
  if (startedAt === null) return ''
  const total = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * The column count both strips lay out on. The longer of the two step lists, so the longer
 * one fills every column and the shorter one aligns to its left.
 */
const RAIL_COLUMNS = Math.max(RESEARCH_STEPS.length, ASK_STEPS.length)

interface StepView {
  readonly key: string
  readonly short: string
  readonly title: string
  readonly state: 'todo' | 'now' | 'done'
  readonly note: string
}

function Strip({
  steps,
  running,
  now,
  elapsed,
  tone,
}: {
  steps: StepView[]
  running: boolean
  now: string | null
  elapsed: string
  tone: 'research' | 'ask'
}): React.ReactElement {
  return (
    <div
      className={`rail ${tone}${running ? ' live' : ''}`}
      style={{ '--steps': RAIL_COLUMNS } as React.CSSProperties}
    >
      <div className="rail-row">
        {steps.map((s, i) => (
          <div key={s.key} className={`rail-step ${s.state}`} title={s.title}>
            <span className="rail-mark" aria-hidden>
              {s.state === 'done' ? <Icon name="check" /> : i + 1}
            </span>
            <span className="rail-nm">{s.short}</span>
            {/* Always rendered, empty or not: a step that starts reporting a count must not
                be the reason the row gets wider or taller. */}
            <span className="rail-note">{s.note}</span>
            {/* The connector belongs to the step it LEAVES, which is what keeps each step
                inside exactly one grid column. */}
            {i < steps.length - 1 && <span className="rail-link" aria-hidden />}
          </div>
        ))}
      </div>
      {/* A fixed slot, so the live line can fill it without shifting the marks beside it. */}
      <div className="rail-live">
        <span className="rail-now">{running ? (now ?? 'Starting…') : ''}</span>
        {elapsed !== '' && <span className="rail-el">{elapsed}</span>}
      </div>
    </div>
  )
}

/** The research strip: five phases, counted from the run's own log. */
export function ResearchSteps({
  running,
  startedAt,
  profile,
}: {
  running: boolean
  startedAt: string | null
  profile: ResearchProfile | undefined
}): React.ReactElement {
  const lines = useJobLog('maintenance:research', { seed: false })
  const p = running && lines.length > 0 ? deriveResearchProgress(lines) : EMPTY_PROGRESS
  const cap = fetchCap(profile?.fetchEstimate)
  const elapsed = useElapsed(running ? startedAt : null)

  const steps: StepView[] = RESEARCH_STEPS.map((step, i) => {
    const state: StepView['state'] = !running ? 'todo' : i < p.step ? 'done' : i === p.step ? 'now' : 'todo'
    let note = ''
    if (running) {
      if (step.id === 'search' && p.searches > 0) note = String(p.searches)
      else if (step.id === 'read' && p.sources > 0) note = cap !== null ? `${p.sources}/${cap}` : String(p.sources)
      else if (step.id === 'file' && p.pages > 0) note = String(p.pages)
    }
    return { key: step.id, short: RESEARCH_SHORT[step.id] ?? step.title, title: step.title, state, note }
  })

  return <Strip steps={steps} running={running} now={p.now} elapsed={elapsed} tone="research" />
}

/** The ask strip: three phases, from the only three markers a query actually exposes. */
export function AskSteps(input: AskProgressInput): React.ReactElement {
  const p = deriveAskProgress(input)
  const running = input.pending
  const steps: StepView[] = ASK_STEPS.map((step, i) => {
    const state: StepView['state'] = running
      ? i < p.step
        ? 'done'
        : i === p.step
          ? 'now'
          : 'todo'
      : p.done
        ? 'done'
        : 'todo'
    let note = ''
    if (step.id === 'write' && p.chars > 0) note = `${Math.round(p.chars / 100) / 10}k chars`
    else if (step.id === 'cite' && p.citations > 0) note = String(p.citations)
    return { key: step.id, short: step.short, title: step.title, state, note }
  })

  return <Strip steps={steps} running={running} now={p.now} elapsed="" tone="ask" />
}
