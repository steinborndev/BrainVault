/**
 * Progress for an "ask the vault" run - the read-only counterpart to `researchProgress.ts`.
 *
 * The two runs expose very different signals, and this file exists because the difference
 * has to be respected rather than papered over. A research run streams its tool calls, so
 * its phases are counted from the log. A query does not: `/query` is request/response, and
 * the only thing that streams is the answer text itself (the `chat` SSE deltas). So there
 * are exactly three observable markers, and therefore exactly three phases:
 *
 *   asked, nothing back yet   the runner is retrieving and reading pages
 *   text arriving             the answer is being written
 *   reply landed              the answer of record, with its citations
 *
 * Same design rule as the research side: every state here is observed, never estimated.
 * There is no bar, because a query has no denominator the client could honestly show.
 */

export type AskStepId = 'retrieve' | 'write' | 'cite'

export interface AskStep {
  readonly id: AskStepId
  readonly title: string
  /** The short form for the compact stepper under the composer. */
  readonly short: string
}

export const ASK_STEPS: readonly AskStep[] = [
  { id: 'retrieve', title: 'Search the vault and read the matching pages', short: 'Retrieve' },
  { id: 'write', title: 'Write the answer', short: 'Answer' },
  { id: 'cite', title: 'Attach the pages it came from', short: 'Cite' },
]

export interface AskProgress {
  /** Index into ASK_STEPS of the phase in progress; earlier ones are done. */
  readonly step: number
  /** Characters of answer text received so far - the only quantity a query streams. */
  readonly chars: number
  /** Pages cited by the finished answer; 0 while it is still running. */
  readonly citations: number
  readonly done: boolean
  /** One line for "what it is doing right now", or null before anything happened. */
  readonly now: string | null
}

export const EMPTY_ASK_PROGRESS: AskProgress = {
  step: 0,
  chars: 0,
  citations: 0,
  done: false,
  now: null,
}

export interface AskProgressInput {
  /** True from the moment the question goes out until the reply lands. */
  readonly pending: boolean
  /** The answer text streamed so far. */
  readonly streamed: string
  /** Citations on the settled answer - only meaningful once `pending` is false. */
  readonly citations: number
  /** True once an answer has landed in this thread. */
  readonly answered: boolean
}

export function deriveAskProgress(input: AskProgressInput): AskProgress {
  if (input.pending) {
    const writing = input.streamed.length > 0
    return {
      step: writing ? 1 : 0,
      chars: input.streamed.length,
      citations: 0,
      done: false,
      now: writing ? 'Writing the answer' : 'Searching the vault',
    }
  }
  if (!input.answered) return EMPTY_ASK_PROGRESS
  return {
    step: ASK_STEPS.length - 1,
    chars: input.streamed.length,
    citations: input.citations,
    done: true,
    now: input.citations > 0 ? `Answered with ${input.citations} source${input.citations === 1 ? '' : 's'}` : 'Answered',
  }
}
