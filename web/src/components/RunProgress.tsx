/**
 * What the research agent is doing, and what is still ahead - the run view's answer to
 * "is this thing making progress or stuck?", which a scrolling log answers badly.
 *
 * Three layers, in the order a person actually asks:
 *   1. DOING NOW    the last tool call in plain words, plus elapsed time
 *   2. THE PLAN     the run's real steps (lib/researchProgress.ts), each with what it produced
 *   3. THE NUMBERS  searches, sources, pages, turns - all counted from the log, none estimated
 *
 * Only "Read sources" carries a bar: the lens declares its fetch cap up front, so that phase
 * has a denominator the service knows. Everything else reports state. The raw log stays one
 * disclosure away for when the summary is not enough.
 */

import { useEffect, useState } from 'react'
import { useJobLog } from '../hooks/useJobLog.ts'
import { Icon } from './Icon.tsx'
import {
  RESEARCH_STEPS,
  deriveResearchProgress,
  fetchCap,
  EMPTY_PROGRESS,
  type ResearchProgress,
} from '../lib/researchProgress.ts'
import type { ResearchProfile } from '../api/types.ts'

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
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function RunProgress({
  channel,
  startedAt,
  profile,
  running,
}: {
  /** SSE channel of the run, e.g. `maintenance:research`. */
  channel: string
  startedAt: string | null
  /** The lens, for the fetch cap. Undefined while the profile list is still loading. */
  profile: ResearchProfile | undefined
  running: boolean
}): React.ReactElement {
  // Maintenance runs stream their log but do not persist it, so there is nothing to seed.
  const lines = useJobLog(channel, { seed: false })
  const progress: ResearchProgress = lines.length > 0 ? deriveResearchProgress(lines) : EMPTY_PROGRESS
  const elapsed = useElapsed(running ? startedAt : null)
  const cap = fetchCap(profile?.fetchEstimate)

  return (
    <div className="prog">
      <div className="prog-now">
        {running ? <span className="prog-spin" aria-hidden /> : <span className="prog-done" aria-hidden><Icon name="check" /></span>}
        <span className="prog-txt">
          <span className="prog-lab">{running ? 'Doing now' : 'Finished'}</span>
          <span className="prog-act" title={progress.now ?? undefined}>
            {progress.now ?? (running ? 'Starting the run…' : 'Run complete')}
          </span>
        </span>
        {elapsed !== '' && (
          <span className="prog-el">
            elapsed
            <b>{elapsed}</b>
          </span>
        )}
      </div>

      <div className="prog-steps">
        {RESEARCH_STEPS.map((step, i) => {
          const done = i < progress.step || (!running && progress.committed)
          const current = running && i === progress.step
          const showBar = step.id === 'read' && current && cap !== null
          return (
            <div key={step.id} className={`prog-step${done ? ' done' : current ? ' now' : ''}`}>
              <span className="prog-mark" aria-hidden>
                {done ? <Icon name="check" /> : current ? <span className="prog-dot" /> : i + 1}
              </span>
              <span className="prog-nm">{step.title}</span>
              <span className="prog-res">{stepResult(step.id, progress, cap, done, current)}</span>
              {showBar && (
                <span className="prog-bar-wrap">
                  <span className="prog-bar">
                    <i style={{ width: `${Math.min(100, Math.round((progress.sources / cap) * 100))}%` }} />
                  </span>
                  <span className="prog-cap">
                    <span>the lens caps this run at {cap} fetches</span>
                    <span>{Math.min(100, Math.round((progress.sources / cap) * 100))}%</span>
                  </span>
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div className="prog-counters">
        <Counter value={progress.searches} label="searches" />
        <Counter value={progress.sources} label="sources read" />
        <Counter value={progress.pages} label="pages written" />
        <Counter value={progress.turns} label="tool calls" />
      </div>
    </div>
  )
}

/** What a step has to show for itself - counted facts only, blank when it has none yet. */
function stepResult(
  id: string,
  p: ResearchProgress,
  cap: number | null,
  done: boolean,
  current: boolean,
): string {
  if (!done && !current) return ''
  switch (id) {
    case 'plan':
      return done ? 'loaded' : ''
    case 'search':
      return p.searches > 0 ? `${p.searches} search${p.searches === 1 ? '' : 'es'}` : ''
    case 'read':
      if (p.sources === 0) return ''
      return current && cap !== null ? `${p.sources} of ${cap}` : `${p.sources} source${p.sources === 1 ? '' : 's'}`
    case 'file':
      return p.pages > 0 ? `${p.pages} page${p.pages === 1 ? '' : 's'}` : ''
    case 'commit':
      return p.committed ? '1 commit' : ''
    default:
      return ''
  }
}

function Counter({ value, label }: { value: number; label: string }): React.ReactElement {
  return (
    <div className="prog-counter">
      <div className="cv">{value}</div>
      <div className="cl">{label}</div>
    </div>
  )
}

/**
 * The one-line form for surfaces that only need "is it moving": Home's in-flight list and
 * the inbox's live rows. Same derivation, no plan, no counters.
 */
export function useRunProgressLine(
  channel: string,
  profile: ResearchProfile | undefined,
): { text: string; ratio: number } {
  const lines = useJobLog(channel, { seed: false })
  const progress = lines.length > 0 ? deriveResearchProgress(lines) : EMPTY_PROGRESS
  const cap = fetchCap(profile?.fetchEstimate)
  const step = RESEARCH_STEPS[progress.step]
  const text =
    progress.step === 2 && cap !== null
      ? `reading sources · ${progress.sources} of ${cap}`
      : (step?.title.toLowerCase() ?? 'starting')
  // The bar is the fetch phase's real ratio; elsewhere it reflects step position, which the
  // caller renders as an indeterminate-looking sliver rather than a claim about time left.
  const ratio =
    progress.step === 2 && cap !== null
      ? Math.min(1, progress.sources / cap)
      : (progress.step + 1) / RESEARCH_STEPS.length
  return { text, ratio }
}
