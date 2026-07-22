/**
 * validator.ts — the deterministic post-run checks (mechanisms derived from the 2026-07-19
 * lint report): frontmatter gaps, created/updated ordering, DragonScale address rules,
 * dead links (with the lenient whole-vault resolution that killed the report's
 * false-positive classes), orphans, and the address_map consistency check (2c).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  validatePages,
  validateAddressMap,
  validateCounters,
  createValidator,
  type ValidationFinding,
} from '../src/pipeline/validator.js'
import { GraphBuilder } from '../src/pipeline/graph.js'

let vaultRoot: string

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-'))
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

function write(rel: string, content: string): void {
  const abs = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/** A page with complete frontmatter; `over` overrides/adds fields, `null` drops one. */
function page(rel: string, over: Record<string, string | null> = {}, body = 'Body prose.\n'): void {
  const fields: Record<string, string | null> = {
    type: 'concept',
    status: 'developing',
    created: '2026-07-01',
    updated: '2026-07-02',
    ...over,
  }
  const scalar = Object.entries(fields)
    .filter(([k, v]) => v !== null && k !== 'tags')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const tags = 'tags' in over ? (over['tags'] === null ? '' : `\ntags: ${over['tags']}`) : '\ntags:\n  - x'
  write(rel, `---\n${scalar}${tags}\n---\n\n${body}`)
}

/** Activates DragonScale Mechanism 2 in the fixture vault. */
function dragonScale(counter = 100, legacyLines: string[] = []): void {
  write('.vault-meta/address-counter.txt', `${counter}\n`)
  write('scripts/allocate-address.sh', '#!/usr/bin/env bash\n')
  write('.vault-meta/legacy-pages.txt', ['# rollout: 2026-04-23', ...legacyLines, ''].join('\n'))
}

const rules = (findings: ValidationFinding[]): string[] => findings.map((f) => f.rule)

describe('frontmatter and dates', () => {
  it('a complete page yields no findings', () => {
    page('wiki/concepts/Alpha.md')
    expect(validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])).toEqual([])
  })

  it('flags missing required fields by name, and a missing frontmatter block outright', () => {
    page('wiki/concepts/Alpha.md', { status: null, tags: null })
    write('wiki/concepts/Bare.md', '# Bare\n\nno frontmatter at all\n')
    const findings = validatePages(vaultRoot, ['wiki/concepts/Alpha.md', 'wiki/concepts/Bare.md'])
    expect(findings).toHaveLength(2)
    expect(findings[0]!.message).toContain('status, tags')
    expect(findings[1]!.message).toContain('no YAML frontmatter')
  })

  it('accepts inline tag lists as tags being present', () => {
    page('wiki/concepts/Alpha.md', { tags: '[a, b]' })
    expect(validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])).toEqual([])
  })

  it('flags created after updated (the hot.md drift class)', () => {
    page('wiki/concepts/Alpha.md', { created: '2026-07-19', updated: '2026-07-18T12:00:00' })
    const findings = validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])
    expect(rules(findings)).toEqual(['dates'])
  })

  it('ignores non-wiki and vanished paths', () => {
    expect(validatePages(vaultRoot, ['.raw/j1/file.pdf', 'wiki/concepts/Gone.md'])).toEqual([])
  })
})

describe('DragonScale addresses', () => {
  it('is entirely inert when the vault has not adopted DragonScale', () => {
    page('wiki/concepts/Alpha.md') // post-rollout, no address
    expect(validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])).toEqual([])
  })

  it('requires an address on post-rollout content pages only', () => {
    dragonScale(100, ['wiki/concepts/Grandfathered.md'])
    page('wiki/concepts/New.md') // created 2026-07-01 >= rollout, no address → error
    page('wiki/concepts/Old.md', { created: '2026-04-01', updated: '2026-04-01' }) // legacy by date
    page('wiki/concepts/Grandfathered.md') // legacy by manifest
    page('wiki/meta/report.md', { type: 'meta' }) // meta excluded
    page('wiki/folds/f1.md', { type: 'fold' }) // folds use fold_id
    const findings = validatePages(vaultRoot, [
      'wiki/concepts/New.md',
      'wiki/concepts/Old.md',
      'wiki/concepts/Grandfathered.md',
      'wiki/meta/report.md',
      'wiki/folds/f1.md',
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'address', path: 'wiki/concepts/New.md' })
  })

  it('validates format, uniqueness, and counter consistency', () => {
    dragonScale(100)
    page('wiki/concepts/Ok.md', { address: 'c-000042' })
    page('wiki/concepts/Legacy.md', { address: 'l-000007' })
    page('wiki/concepts/Malformed.md', { address: 'c-42' })
    page('wiki/concepts/Twin.md', { address: 'c-000042' })
    page('wiki/concepts/Drift.md', { address: 'c-000150' }) // >= counter 100
    const findings = validatePages(vaultRoot, [
      'wiki/concepts/Legacy.md',
      'wiki/concepts/Malformed.md',
      'wiki/concepts/Twin.md',
      'wiki/concepts/Drift.md',
    ])
    expect(rules(findings).sort()).toEqual(['address', 'address', 'address'])
    expect(findings.find((f) => f.path === 'wiki/concepts/Malformed.md')!.message).toContain('malformed')
    expect(findings.find((f) => f.path === 'wiki/concepts/Twin.md')!.message).toContain('wiki/concepts/Ok.md')
    expect(findings.find((f) => f.path === 'wiki/concepts/Drift.md')!.message).toContain('counter')
  })
})

describe('dead links', () => {
  it('flags links that resolve to nothing, with the lenient whole-vault resolution', () => {
    page('wiki/concepts/Beta.md')
    write('skills/wiki-cli/SKILL.md', '# skill\n')
    write('skills/wiki-fold/references/fold-template.md', '# template\n')
    write('Wiki Map.canvas', '{}\n')
    write('wiki/concepts/_index.md', '# index\n')
    page(
      'wiki/concepts/Alpha.md',
      {},
      [
        'A real page link: [[Beta]] and [[beta|case-insensitive alias]].',
        'Path-qualified: [[skills/wiki-cli/SKILL.md]] and [[concepts/_index]].',
        'Basename across the vault: [[fold-template]]; non-md: [[Wiki Map]].',
        'Illustrative, must not flag: `[[Inline Example]]`',
        '```',
        '[[Fenced Example]]',
        '```',
        'Actually dead: [[Nowhere To Be Found]] and [[wiki-cli]].',
        '',
      ].join('\n'),
    )
    const findings = validatePages(vaultRoot, ['wiki/concepts/Alpha.md'])
    expect(rules(findings)).toEqual(['dead-link', 'dead-link'])
    expect(findings[0]!.message).toContain('[[Nowhere To Be Found]]')
    // [[wiki-cli]] is a REAL dead link (the file is SKILL.md — filename-stem resolution fails
    // in Obsidian too); the lint report flagged it, and so do we.
    expect(findings[1]!.message).toContain('[[wiki-cli]]')
  })

  it('resolves a link written as a page frontmatter title or alias, not just its filename', () => {
    // A reference page whose filename ("transport-fallback") differs from its title. The graph
    // resolver treats [[Transport Fallback Decision Tree]] as resolved; the validator must agree.
    page(
      'wiki/references/transport-fallback.md',
      { type: 'reference', title: 'Transport Fallback Decision Tree', aliases: '[Transport Fallback]' },
      'Reference body.\n',
    )
    page('wiki/index.md', { type: 'meta' }, [
      'By title: [[Transport Fallback Decision Tree]].',
      'By alias: [[Transport Fallback]].',
      'By filename still works: [[transport-fallback]].',
      'Genuinely dead: [[No Such Page At All]].',
    ].join('\n'))
    const findings = validatePages(vaultRoot, ['wiki/index.md']).filter((f) => f.rule === 'dead-link')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('[[No Such Page At All]]')
  })

  it('never checks links on lint reports or the append-only log/hot pages', () => {
    page('wiki/meta/lint-report-2026-07-19.md', { type: 'meta' }, 'Finding: [[Deleted Page]] is dead.\n')
    // log.md gets appended to by EVERY ingest — flagging its historical links would repeat
    // the identical findings after every run.
    page('wiki/log.md', { type: 'meta' }, 'Ingested [[Deleted Page]] back in the day.\n')
    page('wiki/hot.md', { type: 'meta' }, 'Recent: [[Deleted Page]].\n')
    expect(
      validatePages(vaultRoot, ['wiki/meta/lint-report-2026-07-19.md', 'wiki/log.md', 'wiki/hot.md']),
    ).toEqual([])
  })
})

describe('orphans (graph-backed)', () => {
  it('flags an unlinked content page, but not meta/_index pages or linked ones', () => {
    page('wiki/concepts/Linked.md')
    page('wiki/concepts/Orphan.md')
    page('wiki/meta/session-notes.md', { type: 'meta' })
    page('wiki/concepts/_index.md', { type: 'meta' }) // full frontmatter — only its orphan-exemption is under test
    write('wiki/index.md', '---\ntype: meta\n---\n[[Linked]]\n')
    const graph = new GraphBuilder(vaultRoot).build()
    const paths = ['wiki/concepts/Linked.md', 'wiki/concepts/Orphan.md', 'wiki/meta/session-notes.md', 'wiki/concepts/_index.md']
    const findings = validatePages(vaultRoot, paths, graph)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'orphan', path: 'wiki/concepts/Orphan.md' })
  })

  it('skips the orphan check when no graph is provided', () => {
    page('wiki/concepts/Orphan.md')
    expect(validatePages(vaultRoot, ['wiki/concepts/Orphan.md'])).toEqual([])
  })

  it('a page linked ONLY from a lint report still counts as an orphan', () => {
    page('wiki/concepts/Orphan.md')
    page('wiki/meta/lint-report-2026-07-19.md', { type: 'meta' }, 'Orphan found: [[Orphan]].\n')
    const graph = new GraphBuilder(vaultRoot).build()
    const findings = validatePages(vaultRoot, ['wiki/concepts/Orphan.md'], graph)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'orphan', path: 'wiki/concepts/Orphan.md' })
  })
})

describe('single-source entities (graph-backed)', () => {
  /** A seed entity plus one source page linking it — the Fokki/0xCodez class. */
  function seedEntityWithOneSource(): void {
    page('wiki/entities/Fokki.md', { type: 'entity', status: 'seed' })
    page('wiki/sources/Viral Post.md', { type: 'source' }, 'By [[Fokki]].\n')
  }

  it('flags a seed entity referenced by only one source page', () => {
    seedEntityWithOneSource()
    const graph = new GraphBuilder(vaultRoot).build()
    const findings = validatePages(vaultRoot, ['wiki/entities/Fokki.md'], graph)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'single-source-entity', path: 'wiki/entities/Fokki.md' })
    expect(findings[0]!.message).toContain('only one source page')
  })

  it('flags a seed entity linked only from concept pages — concept backlinks do not launder it', () => {
    page('wiki/entities/Fokki.md', { type: 'entity', status: 'seed' })
    page('wiki/concepts/Outlier Score.md', {}, 'Coined by [[Fokki]].\n')
    page('wiki/concepts/Faceless Pipeline.md', {}, 'See [[Fokki]].\n')
    const graph = new GraphBuilder(vaultRoot).build()
    const findings = validatePages(vaultRoot, ['wiki/entities/Fokki.md'], graph)
    expect(rules(findings)).toEqual(['single-source-entity'])
    expect(findings[0]!.message).toContain('no source page')
  })

  it('stays quiet once a second independent source references the entity', () => {
    seedEntityWithOneSource()
    page('wiki/sources/Second Source.md', { type: 'source' }, 'Also features [[Fokki]].\n')
    const graph = new GraphBuilder(vaultRoot).build()
    expect(validatePages(vaultRoot, ['wiki/entities/Fokki.md'], graph)).toEqual([])
  })

  it('a source _index hub does not count as an independent source', () => {
    seedEntityWithOneSource()
    page('wiki/sources/_index.md', { type: 'meta' }, '- [[Fokki]]\n')
    const graph = new GraphBuilder(vaultRoot).build()
    expect(rules(validatePages(vaultRoot, ['wiki/entities/Fokki.md'], graph))).toEqual(['single-source-entity'])
  })

  it('bumping status past seed is the deliberate keep-anyway override', () => {
    page('wiki/entities/Fokki.md', { type: 'entity', status: 'developing' })
    page('wiki/sources/Viral Post.md', { type: 'source' }, 'By [[Fokki]].\n')
    const graph = new GraphBuilder(vaultRoot).build()
    expect(validatePages(vaultRoot, ['wiki/entities/Fokki.md'], graph)).toEqual([])
  })

  it('skips the check when no graph is provided, and never fires outside entities/', () => {
    seedEntityWithOneSource()
    page('wiki/concepts/Seedling.md', { status: 'seed' })
    page('wiki/index.md', { type: 'meta' }, '[[Seedling]]\n')
    expect(validatePages(vaultRoot, ['wiki/entities/Fokki.md'])).toEqual([])
    const graph = new GraphBuilder(vaultRoot).build()
    expect(validatePages(vaultRoot, ['wiki/concepts/Seedling.md'], graph)).toEqual([])
  })
})

describe('address_map consistency (2c)', () => {
  it('flags entries whose page was deleted, and map/frontmatter divergence', () => {
    page('wiki/concepts/Matching.md', { address: 'c-000010' })
    page('wiki/concepts/Diverged.md', { address: 'c-000099' })
    write(
      '.raw/.manifest.json',
      JSON.stringify({
        version: 1,
        address_map: {
          'wiki/concepts/Matching.md': 'c-000010',
          'wiki/concepts/Diverged.md': 'c-000011',
          'wiki/concepts/Deleted.md': 'c-000012',
        },
      }),
    )
    const findings = validateAddressMap(vaultRoot)
    expect(findings).toHaveLength(2)
    expect(findings.find((f) => f.path === 'wiki/concepts/Deleted.md')!.message).toContain('no longer exists')
    expect(findings.find((f) => f.path === 'wiki/concepts/Diverged.md')!.message).toContain('c-000099')
  })

  it('yields nothing without a manifest or without an address_map', () => {
    expect(validateAddressMap(vaultRoot)).toEqual([])
    write('.raw/.manifest.json', JSON.stringify({ version: 1, sources: {} }))
    expect(validateAddressMap(vaultRoot)).toEqual([])
  })
})

describe('stale counters', () => {
  it('flags header counters that lag the vault by more than the slack', () => {
    for (let i = 0; i < 6; i++) page(`wiki/concepts/C${i}.md`)
    for (let i = 0; i < 4; i++) page(`wiki/sources/S${i}.md`, { type: 'source' })
    write('wiki/index.md', '---\ntype: meta\n---\nTotal pages: 3 | Sources ingested: 4\n')
    const findings = validateCounters(vaultRoot)
    // 11 pages on disk vs claimed 3 → flagged; sources 4 vs 4 → fine.
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'stale-counter', path: 'wiki/index.md' })
    expect(findings[0]!.message).toContain('claims 3 pages')
  })

  it('tolerates small semantic differences and pages without counters', () => {
    for (let i = 0; i < 6; i++) page(`wiki/concepts/C${i}.md`)
    // 7 pages on disk, header says 5 — within the slack of 3 (a "content pages only" counter).
    write('wiki/overview.md', '---\ntype: meta\n---\nWiki pages: 5\n')
    write('wiki/index.md', '---\ntype: meta\n---\nno counters here\n')
    expect(validateCounters(vaultRoot)).toEqual([])
  })
})

describe('createValidator', () => {
  it('composes the per-page checks with the address_map check', () => {
    page('wiki/concepts/Alpha.md', { status: null })
    write('.raw/.manifest.json', JSON.stringify({ address_map: { 'wiki/concepts/Deleted.md': 'c-000012' } }))
    const validate = createValidator(vaultRoot, new GraphBuilder(vaultRoot))
    const findings = validate(['wiki/concepts/Alpha.md'])
    expect(rules(findings)).toContain('frontmatter')
    expect(rules(findings)).toContain('address-map')
    // Alpha is also an orphan — the graph came from the builder we passed in.
    expect(rules(findings)).toContain('orphan')
  })
})
