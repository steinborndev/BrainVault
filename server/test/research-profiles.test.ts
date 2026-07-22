import { describe, it, expect } from 'vitest'
import {
  RESEARCH_PROFILES,
  DEFAULT_PROFILE_KEY,
  getResearchProfile,
  isResearchProfileKey,
  renderProfileBlock,
  researchTargetTitle,
  researchProfileList,
} from '../src/pipeline/research-profiles.js'

describe('research profiles (Achse A)', () => {
  it('exposes a closed set with broad as the default', () => {
    expect(DEFAULT_PROFILE_KEY).toBe('broad')
    expect(RESEARCH_PROFILES.map((p) => p.key)).toContain('broad')
    expect(isResearchProfileKey('sota')).toBe(true)
    expect(isResearchProfileKey('patents')).toBe(true)
    expect(isResearchProfileKey('startups')).toBe(true)
    expect(isResearchProfileKey('made-up-lens')).toBe(false)
  })

  it('falls back to the default lens for an unknown or omitted key', () => {
    expect(getResearchProfile(undefined).key).toBe('broad')
    expect(getResearchProfile('nope').key).toBe('broad')
    expect(getResearchProfile('sota').key).toBe('sota')
  })

  it('pins a distinct, deterministic synthesis title per lens so two lenses never collide', () => {
    const broad = getResearchProfile('broad')
    const sota = getResearchProfile('sota')
    const patents = getResearchProfile('patents')
    expect(researchTargetTitle(broad, 'ionizable lipids')).toBe('Research: ionizable lipids')
    expect(researchTargetTitle(sota, 'ionizable lipids')).toBe('Research: ionizable lipids — State of the Art')
    expect(researchTargetTitle(patents, 'ionizable lipids')).toBe('Research: ionizable lipids — Patent Landscape')
    // No two lenses share a synthesis title for the same topic.
    const titles = RESEARCH_PROFILES.map((p) => researchTargetTitle(p, 'x'))
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('renders NO block for the default lens, so a plain run keeps the base prompt verbatim', () => {
    expect(renderProfileBlock(getResearchProfile('broad'), 'anything')).toBe('')
  })

  it('renders a subordinate lens block that pins the title and forbids new page types/domains', () => {
    const block = renderProfileBlock(getResearchProfile('sota'), 'brain-computer interfaces')
    expect(block).toContain('research_lens')
    expect(block).toContain('State of the Art')
    expect(block).toContain('Research: brain-computer interfaces — State of the Art')
    expect(block).toContain('arXiv')
    // The subordination clause is load-bearing (analysis point 3).
    expect(block).toMatch(/does NOT\s+override the page-hygiene, entity-notability, or domain rules/)
    expect(block).toContain('adds no new')
    expect(block).toContain('invents no new domains')
  })

  it('carries the entity-notability guardrail on the startups lens', () => {
    const block = renderProfileBlock(getResearchProfile('startups'), 'battery recycling')
    expect(block).toMatch(/entity-notability rules above already allow it/)
  })

  it('lists lenses for the UI without leaking prompt internals', () => {
    const list = researchProfileList()
    expect(list[0]?.key).toBe('broad')
    for (const info of list) {
      expect(info).toHaveProperty('label')
      expect(info).toHaveProperty('sources')
      expect(info).toHaveProperty('fetchEstimate')
      expect(info).toHaveProperty('titleSuffix')
      // `emphasis`/`guard` are prompt-only and must not reach the client shape.
      expect(info).not.toHaveProperty('emphasis')
      expect(info).not.toHaveProperty('guard')
    }
  })
})
