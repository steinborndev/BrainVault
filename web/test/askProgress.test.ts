import { describe, it, expect } from 'vitest'
import { ASK_STEPS, EMPTY_ASK_PROGRESS, deriveAskProgress } from '../src/lib/askProgress.ts'

describe('deriveAskProgress', () => {
  it('is empty before anything was asked - the strip renders dimmed from this', () => {
    expect(deriveAskProgress({ pending: false, streamed: '', citations: 0, answered: false })).toEqual(
      EMPTY_ASK_PROGRESS,
    )
  })

  it('sits on retrieve while the question is out and nothing has come back', () => {
    const p = deriveAskProgress({ pending: true, streamed: '', citations: 0, answered: false })
    expect(p.step).toBe(0)
    expect(p.now).toBe('Searching the vault')
    expect(p.done).toBe(false)
  })

  it('moves to writing as soon as answer text streams', () => {
    const p = deriveAskProgress({ pending: true, streamed: 'Sulfide electrolytes', citations: 0, answered: false })
    expect(p.step).toBe(1)
    expect(p.chars).toBe(20)
    expect(p.now).toBe('Writing the answer')
  })

  it('lands on the citation step once the reply is of record', () => {
    const p = deriveAskProgress({ pending: false, streamed: 'done', citations: 3, answered: true })
    expect(p.step).toBe(ASK_STEPS.length - 1)
    expect(p.done).toBe(true)
    expect(p.citations).toBe(3)
    expect(p.now).toBe('Answered with 3 sources')
  })

  it('says so in the singular for one source', () => {
    const p = deriveAskProgress({ pending: false, streamed: 'x', citations: 1, answered: true })
    expect(p.now).toBe('Answered with 1 source')
  })

  it('reports an answer with no citations as answered, not as unfinished', () => {
    const p = deriveAskProgress({ pending: false, streamed: 'x', citations: 0, answered: true })
    expect(p.done).toBe(true)
    expect(p.now).toBe('Answered')
  })
})
