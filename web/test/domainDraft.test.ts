import { describe, it, expect } from 'vitest'
import { draftDomainDescription } from '../src/lib/domainDraft.ts'

describe('draftDomainDescription', () => {
  it('is never empty and opens with the humanized key', () => {
    const d = draftDomainDescription({ key: 'machine-learning', tags: ['machine-learning'] })
    expect(d.startsWith('Machine learning ')).toBe(true)
    expect(d.length).toBeGreaterThan(40)
  })

  it('names member tags beyond the key as scope examples, capped', () => {
    const d = draftDomainDescription({
      key: 'brewing',
      tags: ['brewing', 'fermentation', 'yeast', 'hops', 'malting'],
    })
    expect(d).toContain('fermentation, yeast, hops')
    expect(d).not.toContain('malting') // beyond the example cap
    expect(d).not.toContain('including brewing') // the key itself is no example
  })

  it('falls back to a generic scope when the key is the only tag', () => {
    const d = draftDomainDescription({ key: 'meta', tags: ['meta'] })
    expect(d).toContain('methods, tools, entities and applications')
  })

  it('keeps the extensibility wording the registry conventions use', () => {
    const d = draftDomainDescription({ key: 'ai-tooling', tags: ['ai-tooling'] })
    expect(d).toContain('a shelf, not a book')
    expect(d.startsWith('Ai tooling ')).toBe(true) // separator words humanized
  })
})
