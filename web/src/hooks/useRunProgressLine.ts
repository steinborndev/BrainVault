/**
 * "Is it moving?" for the surfaces that only need one line: Home's in-flight rows.
 *
 * The full plan display this hook used to live beside is gone - the composer's step strip
 * (components/AgentSteps.tsx) shows the phases in both modes now, dimmed while idle, so a
 * run no longer needs a screen of its own. The derivation is unchanged and still counts
 * everything it reports (lib/researchProgress.ts).
 */

import { useJobLog } from './useJobLog.ts'
import {
  RESEARCH_STEPS,
  deriveResearchProgress,
  fetchCap,
  EMPTY_PROGRESS,
} from '../lib/researchProgress.ts'
import type { ResearchProfile } from '../api/types.ts'

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
