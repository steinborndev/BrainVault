/**
 * The research progress derivation (src/lib/researchProgress.ts). The whole point of these
 * tests is that every number is COUNTED from the log rather than estimated - so they pin
 * the counting, and they pin the parser against the log format the server actually emits
 * (server/src/pipeline/format-message.ts), including its 160-char truncation of tool input.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveResearchProgress,
  fetchCap,
  RESEARCH_STEPS,
  EMPTY_PROGRESS,
} from '../src/lib/researchProgress.ts'
import type { JobLogLine } from '../src/api/types.ts'

const line = (message: string): JobLogLine => ({ ts: '2026-08-25T10:00:00.000Z', level: 'info', message })

/** Exactly the shape formatMessage produces for a tool call. */
const call = (name: string, input: unknown): JobLogLine =>
  line(`[assistant] → ${name}(${JSON.stringify(input).slice(0, 160)})`)

const stepOf = (id: string): number => RESEARCH_STEPS.findIndex((s) => s.id === id)

describe('deriveResearchProgress', () => {
  it('an empty log is the empty progress, not step 1 of something', () => {
    expect(deriveResearchProgress([])).toEqual(EMPTY_PROGRESS)
  })

  it('the first WebSearch enters the search step and names the query', () => {
    const p = deriveResearchProgress([call('WebSearch', { query: 'solid-state pilot lines' })])
    expect(p.step).toBe(stepOf('search'))
    expect(p.searches).toBe(1)
    expect(p.now).toBe('Searching "solid-state pilot lines"')
  })

  it('the first WebFetch enters the read step and names the source, host-first', () => {
    const p = deriveResearchProgress([
      call('WebSearch', { query: 'x' }),
      call('WebFetch', { url: 'https://www.example.org/press/pilot-line?utm=1' }),
    ])
    expect(p.step).toBe(stepOf('read'))
    expect(p.sources).toBe(1)
    expect(p.now).toBe('Reading example.org/press/pilot-line')
  })

  it('counts DISTINCT sources - the same page read twice is one source', () => {
    const p = deriveResearchProgress([
      call('WebFetch', { url: 'https://example.org/a' }),
      call('WebFetch', { url: 'https://example.org/a' }),
      call('WebFetch', { url: 'https://example.org/b' }),
    ])
    expect(p.sources).toBe(2)
    expect(p.turns).toBe(3)
  })

  it('a wiki Write enters the file step; bookkeeping pages are not research output', () => {
    const p = deriveResearchProgress([
      call('Write', { file_path: 'wiki/concepts/Dry Electrode Coating.md' }),
      call('Edit', { file_path: 'wiki/index.md' }),
      call('Edit', { file_path: 'wiki/hot.md' }),
    ])
    // index/hot ride along in every run - counting them would inflate "pages written".
    expect(p.pages).toBe(1)
    // ...but touching them IS the last step, so the plan advances.
    expect(p.step).toBe(stepOf('commit'))
  })

  it('an absolute file path still resolves to its vault-relative page', () => {
    const p = deriveResearchProgress([call('Write', { file_path: '/home/u/vault/wiki/concepts/Anode.md' })])
    expect(p.pages).toBe(1)
    expect(p.now).toBe('Writing concepts/Anode')
  })

  it('the runner commit line ends the run at the last step', () => {
    const p = deriveResearchProgress([
      call('WebSearch', { query: 'x' }),
      line('committed abc12345 (7 wiki page(s))'),
    ])
    expect(p.committed).toBe(true)
    expect(p.step).toBe(RESEARCH_STEPS.length - 1)
  })

  it('"nothing to commit" also settles the run - a run that wrote nothing still ended', () => {
    expect(deriveResearchProgress([line('nothing to commit')]).committed).toBe(true)
  })

  it('steps never go backwards when search and fetch interleave', () => {
    const p = deriveResearchProgress([
      call('WebFetch', { url: 'https://example.org/a' }),
      call('WebSearch', { query: 'follow-up' }),
    ])
    expect(p.step).toBe(stepOf('read'))
    // The now-line still reports the truth about the LAST thing it did.
    expect(p.now).toBe('Searching "follow-up"')
  })

  it('survives the formatter truncating tool input mid-JSON', () => {
    // formatMessage slices the payload at 160 chars, so the log frequently carries invalid
    // JSON - the parser must read fields out of the raw text rather than JSON.parse it.
    const long = `[assistant] → WebFetch({"url":"https://example.org/a-very-long-path","prompt":"${'x'.repeat(400)}`
    const p = deriveResearchProgress([line(long)])
    expect(p.sources).toBe(1)
    expect(p.now).toContain('example.org/a-very-long-path')
  })

  it('ignores lines that are not tool calls, including the agent thinking out loud', () => {
    const p = deriveResearchProgress([
      line('[assistant] I will start by checking what the vault already covers.'),
      line('[system] thinking_tokens'),
      line('[user] ← tool ok'),
    ])
    expect(p.turns).toBe(0)
    expect(p.step).toBe(0)
  })
})

describe('fetchCap', () => {
  it('takes the upper bound of a lens estimate, whatever separates the two numbers', () => {
    expect(fetchCap('25-35')).toBe(35)
    expect(fetchCap('40')).toBe(40)
    // The lens estimate is a free-form label; it has carried a typographic dash before, so
    // the parser must not depend on which one. Built from a code point rather than written
    // literally, because those characters are banned from this codebase's text.
    expect(fetchCap(`30${String.fromCharCode(0x2013)}45`)).toBe(45)
  })

  it('is null when there is nothing to count against - no bar, rather than a made-up one', () => {
    expect(fetchCap(undefined)).toBeNull()
    expect(fetchCap('a handful')).toBeNull()
  })
})
