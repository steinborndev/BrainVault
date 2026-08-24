/**
 * Human-readable progress for a research run, derived from the log lines the run already
 * streams (SPEC §6.4). No new endpoint, no server bookkeeping: the agent's tool calls ARE
 * the progress signal, they were just never read as one.
 *
 * What the runner emits per SDK message (server/src/pipeline/format-message.ts):
 *
 *   [assistant] → WebSearch({"query":"..."})     a search
 *   [assistant] → WebFetch({"url":"..."})        a source being read
 *   [assistant] → Write({"file_path":"wiki/..."}) a page being filed
 *   [user] ← tool ok                             a tool returned
 *   committed abc12345 (7 page(s))               the run's single commit
 *
 * DESIGN RULE, and the reason this file is small: every number here is counted, never
 * estimated. The steps report STATE (pending / running / done); only "Read sources" gets a
 * bar, because the lens declares its fetch cap before the run starts and is therefore the
 * one phase with a real denominator. A global percentage would be invented, and a progress
 * bar that lies is worse than no progress bar.
 *
 * Limitation worth knowing: maintenance run logs stream but are not persisted, so a reload
 * mid-run starts from an empty buffer and the steps re-fill as new lines arrive (seconds,
 * on a run that logs continuously). The run itself is unaffected.
 */

import type { JobLogLine } from '../api/types.ts'

export type ResearchStepId = 'plan' | 'search' | 'read' | 'file' | 'commit'

export interface ResearchStep {
  readonly id: ResearchStepId
  readonly title: string
}

/**
 * The run's plan, in the order the research prompt asks for it - and deliberately only the
 * phases with an observable marker in the log. "Synthesize" is not a step of its own here
 * because nothing in the stream marks it, and a step that can never be shown as current is
 * decoration; it lives inside "Synthesize and file pages", which does have a marker.
 */
export const RESEARCH_STEPS: readonly ResearchStep[] = [
  { id: 'plan', title: 'Load the research program' },
  { id: 'search', title: 'Search the web' },
  { id: 'read', title: 'Read sources' },
  { id: 'file', title: 'Synthesize and file pages' },
  { id: 'commit', title: 'Update index, log, hot cache and commit' },
]

export interface ResearchProgress {
  /** Index into RESEARCH_STEPS of the furthest phase reached; earlier steps are done. */
  readonly step: number
  readonly searches: number
  /** Distinct URLs fetched - the same page read twice is one source. */
  readonly sources: number
  /** Distinct wiki pages written or edited. */
  readonly pages: number
  /** Tool calls issued, i.e. how much work the agent has actually done. */
  readonly turns: number
  /** One sentence for "what it is doing right now", or null before the first tool call. */
  readonly now: string | null
  /** True once the run's commit line appeared. */
  readonly committed: boolean
}

export const EMPTY_PROGRESS: ResearchProgress = {
  step: 0,
  searches: 0,
  sources: 0,
  pages: 0,
  turns: 0,
  now: null,
  committed: false,
}

/** `→ Name({json})` out of one formatted log line, or null when the line is not a tool call. */
function toolCall(message: string): { name: string; input: string } | null {
  const m = /→ ([A-Za-z_]+)\((.*)$/s.exec(message)
  return m === null ? null : { name: m[1]!, input: m[2]! }
}

/**
 * A JSON field out of a tool-call payload. The payload is TRUNCATED at 160 chars by the
 * formatter, so it is frequently not valid JSON - a regex over the raw text is the correct
 * tool here, not JSON.parse.
 */
function field(input: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(input)
  return m === null ? null : m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

/** `https://example.org/a/b?c=d` → `example.org/a/b`, which is what a reader recognizes. */
function shortUrl(url: string): string {
  const stripped = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('?')[0] ?? url
  return stripped.length > 58 ? `${stripped.slice(0, 56)}…` : stripped
}

/** Bookkeeping pages ride along in every run - they are not the research output. */
const BOOKKEEPING = /^wiki\/(index|log|hot|overview)\.md$/

/** The upper bound of a lens's `fetchEstimate` ("25-35", and dash variants), or null. */
export function fetchCap(estimate: string | undefined): number | null {
  if (estimate === undefined) return null
  const numbers = estimate.match(/\d+/g)
  if (numbers === null || numbers.length === 0) return null
  return Number(numbers[numbers.length - 1])
}

export function deriveResearchProgress(lines: readonly JobLogLine[]): ResearchProgress {
  let step = 0
  let turns = 0
  let searches = 0
  let committed = false
  let now: string | null = null
  const sources = new Set<string>()
  const pages = new Set<string>()

  for (const line of lines) {
    const message = line.message

    // The commit line is the runner's, not the agent's - it ends the run.
    if (/^committed [0-9a-f]{7,} /.test(message) || message === 'nothing to commit') {
      committed = true
      step = RESEARCH_STEPS.length - 1
      now = 'Committing the run'
      continue
    }

    const call = toolCall(message)
    if (call === null) continue
    turns++

    switch (call.name) {
      case 'WebSearch': {
        searches++
        step = Math.max(step, 1)
        const query = field(call.input, 'query')
        now = query !== null ? `Searching "${query}"` : 'Searching the web'
        break
      }
      case 'WebFetch': {
        const url = field(call.input, 'url')
        if (url !== null) sources.add(url)
        step = Math.max(step, 2)
        now = url !== null ? `Reading ${shortUrl(url)}` : 'Reading a source'
        break
      }
      case 'Write':
      case 'Edit':
      case 'MultiEdit': {
        const file = field(call.input, 'file_path')
        if (file === null) break
        // Only knowledge pages count as output; index/log/hot are bookkeeping every run does.
        const relative = file.replace(/^.*?(?=wiki\/)/, '')
        if (BOOKKEEPING.test(relative)) {
          step = Math.max(step, RESEARCH_STEPS.length - 1)
          now = `Updating ${relative}`
          break
        }
        if (!relative.startsWith('wiki/')) break
        pages.add(relative)
        step = Math.max(step, 3)
        now = `Writing ${relative.replace(/^wiki\//, '').replace(/\.md$/, '')}`
        break
      }
      case 'Read':
      case 'Grep':
      case 'Glob': {
        // Reading the program file is the plan step; reading the vault is an overlap check.
        const target = field(call.input, 'file_path') ?? field(call.input, 'pattern') ?? ''
        if (/autoresearch|program\.md/.test(target)) now = 'Loading the research program'
        else if (step >= 1) now = 'Checking the vault for existing pages'
        break
      }
      default:
        break
    }
  }

  return { step, searches, sources: sources.size, pages: pages.size, turns, now, committed }
}
