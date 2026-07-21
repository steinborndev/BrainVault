import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findRelatedPages, renderOverlapBlock } from '../src/pipeline/related-pages.js'

/** Lays out a throwaway vault with the given wiki-relative page paths. */
function makeVault(pages: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'related-pages-'))
  for (const rel of pages) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, '# stub\n')
  }
  return root
}

describe('findRelatedPages', () => {
  let root: string
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it('surfaces existing pages that share significant title tokens', () => {
    root = makeVault([
      'wiki/concepts/Ionizable Lipid.md',
      'wiki/concepts/Lipid Nanoparticle.md',
      'wiki/concepts/Compound Interest.md',
    ])
    const related = findRelatedPages(root, 'ionizable lipids')
    expect(related.pages).toContain('wiki/concepts/Ionizable Lipid.md')
    expect(related.pages).toContain('wiki/concepts/Lipid Nanoparticle.md')
    expect(related.pages).not.toContain('wiki/concepts/Compound Interest.md')
  })

  it('normalises singular/plural so "lipids" matches "Lipid"', () => {
    root = makeVault(['wiki/concepts/Ionizable Lipid.md'])
    expect(findRelatedPages(root, 'lipids').pages).toEqual(['wiki/concepts/Ionizable Lipid.md'])
  })

  it('separates existing research syntheses from other pages', () => {
    root = makeVault([
      'wiki/questions/Research: Recent Insights into Lipid Nanoparticles.md',
      'wiki/concepts/Lipid Nanoparticle.md',
    ])
    const related = findRelatedPages(root, 'lipid nanoparticle')
    expect(related.syntheses).toEqual([
      'wiki/questions/Research: Recent Insights into Lipid Nanoparticles.md',
    ])
    expect(related.pages).toEqual(['wiki/concepts/Lipid Nanoparticle.md'])
  })

  it('ranks by shared token count and caps the list at 12', () => {
    const pages = Array.from({ length: 20 }, (_, i) => `wiki/concepts/Lipid Topic ${i}.md`)
    // One page shares two tokens; it must rank ahead of the single-token matches.
    pages.push('wiki/concepts/Lipid Nanoparticle.md')
    root = makeVault(pages)
    const related = findRelatedPages(root, 'lipid nanoparticle')
    expect(related.pages.length + related.syntheses.length).toBeLessThanOrEqual(12)
    expect(related.pages[0]).toBe('wiki/concepts/Lipid Nanoparticle.md')
  })

  it('ignores bookkeeping pages and stopword-only topics', () => {
    root = makeVault([
      'wiki/index.md',
      'wiki/hot.md',
      'wiki/concepts/_index.md',
      'wiki/concepts/Research Overview.md',
    ])
    // "research"/"overview" are stopwords → no significant topic tokens → nothing related.
    expect(findRelatedPages(root, 'research overview').pages).toEqual([])
  })

  it('returns empty for a missing vault instead of throwing', () => {
    expect(findRelatedPages('/nonexistent/vault/path', 'anything')).toEqual({
      syntheses: [],
      pages: [],
    })
  })
})

describe('renderOverlapBlock', () => {
  it('is empty when nothing overlaps, so a fresh topic keeps the base prompt', () => {
    expect(renderOverlapBlock({ syntheses: [], pages: [] })).toBe('')
  })

  it('names both concept pages and syntheses with distinct guidance', () => {
    const block = renderOverlapBlock({
      syntheses: ['wiki/questions/Research: Lipids.md'],
      pages: ['wiki/concepts/Ionizable Lipid.md'],
    })
    expect(block).toContain('wiki/concepts/Ionizable Lipid.md')
    expect(block).toContain('wiki/questions/Research: Lipids.md')
    expect(block).toContain('EXTENDING')
    expect(block).toMatch(/near-duplicate/i)
  })
})
