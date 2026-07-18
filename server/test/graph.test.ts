/**
 * GraphBuilder tests (SPEC.md §12.4): wikilink graph extraction, resolution rules (alias,
 * heading, case-insensitivity, dangling links), and the two cache layers that keep the
 * endpoint cheap as the vault grows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GraphBuilder } from '../src/pipeline/graph.js'

let vaultRoot: string

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-vault-'))
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

function page(rel: string, content: string): void {
  const abs = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

describe('GraphBuilder', () => {
  it('builds nodes with types and resolved directed edges', () => {
    page('wiki/concepts/Alpha.md', 'links to [[Beta]] and [[Gamma Source|the source]]')
    page('wiki/concepts/Beta.md', 'back to [[Alpha#History]]')
    page('wiki/sources/Gamma Source.md', 'no links')
    page('wiki/index.md', '[[Alpha]] [[Beta]] [[Gamma Source]]')

    const g = new GraphBuilder(vaultRoot).build()
    const byTitle = new Map(g.nodes.map((n, i) => [n.title, i]))

    expect(g.nodes).toHaveLength(4)
    expect(g.nodes[byTitle.get('Alpha')!]!.type).toBe('concepts')
    expect(g.nodes[byTitle.get('Gamma Source')!]!.type).toBe('sources')
    expect(g.nodes[byTitle.get('index')!]!.type).toBe('root')

    const edgeSet = new Set(g.edges.map(([a, b]) => `${g.nodes[a]!.title}->${g.nodes[b]!.title}`))
    expect(edgeSet).toContain('Alpha->Beta') // plain link
    expect(edgeSet).toContain('Alpha->Gamma Source') // alias resolved to target
    expect(edgeSet).toContain('Beta->Alpha') // heading stripped
    expect(g.nodes[byTitle.get('Alpha')!]!.in).toBe(2) // Beta + index
    expect(g.nodes[byTitle.get('Alpha')!]!.out).toBe(2)
  })

  it('resolves case-insensitively and counts dangling links as unresolved', () => {
    page('wiki/concepts/Compound Interest.md', 'see [[compound interest]] (self), [[Nowhere]]')
    page('wiki/concepts/Other.md', '[[COMPOUND INTEREST]]')
    const g = new GraphBuilder(vaultRoot).build()
    // Self-links are dropped, case-insensitive resolution works, [[Nowhere]] is dangling.
    expect(g.edges).toHaveLength(1)
    expect(g.unresolved).toBe(1)
  })

  it('returns the identical graph object while nothing changed (whole-graph cache)', () => {
    page('wiki/concepts/A.md', '[[B]]')
    page('wiki/concepts/B.md', 'x')
    const builder = new GraphBuilder(vaultRoot)
    const first = builder.build()
    expect(builder.build()).toBe(first)
  })

  it('re-parses only changed files and reflects edits, additions and deletions', async () => {
    page('wiki/concepts/A.md', '[[B]]')
    page('wiki/concepts/B.md', 'x')
    const builder = new GraphBuilder(vaultRoot)
    expect(builder.build().edges).toHaveLength(1)

    // mtime granularity can be coarse — make sure the edit is observable.
    await new Promise((r) => setTimeout(r, 20))
    page('wiki/concepts/A.md', 'no links any more, but longer than before')
    expect(builder.build().edges).toHaveLength(0)

    page('wiki/concepts/C.md', '[[A]] [[B]]')
    expect(builder.build().edges).toHaveLength(2)

    fs.rmSync(path.join(vaultRoot, 'wiki/concepts/C.md'))
    const afterDelete = builder.build()
    expect(afterDelete.nodes.map((n) => n.title).sort()).toEqual(['A', 'B'])
    expect(afterDelete.edges).toHaveLength(0)
  })
})
