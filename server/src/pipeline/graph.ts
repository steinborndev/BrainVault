/**
 * The wikilink graph of the vault (SPEC.md §12.4) — nodes are `wiki/**\/*.md` pages, edges are
 * resolved `[[wikilinks]]` between them. Feeds `GET /api/v1/graph` for the in-dashboard
 * graph view. READ-ONLY: this module only ever reads the vault (hard rule 1).
 *
 * Built to stay cheap as the vault grows (the whole point of replacing Obsidian's laggy
 * graph): parses are cached per file keyed on (mtime, size), so a rebuild stats every page
 * but re-reads only the ones that changed, and an unchanged vault returns the previous
 * graph object outright. At 10k pages a rebuild is ~10k stat() calls — well under a
 * millisecond-budget problem — and the response is index-based (edges as [from, to] pairs
 * into the node array), so the payload stays compact.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseWikilinks } from './citations.js'

/** One wiki page. `type` is the top-level wiki directory (concepts, entities, sources, …). */
export interface GraphNode {
  /** Vault-relative POSIX path, e.g. `wiki/concepts/Compound Interest.md`. */
  readonly path: string
  /** Page name (basename without `.md`) — the label the graph renders. */
  readonly title: string
  /** Top-level bucket: `concepts` | `entities` | `sources` | `meta` | … | `root` for wiki/*.md. */
  readonly type: string
  /** Out-degree (links this page makes) and in-degree (backlinks) over RESOLVED edges. */
  readonly out: number
  readonly in: number
}

export interface VaultGraph {
  readonly nodes: GraphNode[]
  /** Directed edges as [fromIndex, toIndex] into `nodes` — compact on the wire. */
  readonly edges: Array<[number, number]>
  /** Wikilink targets that resolved to no page (dangling links), counted per source of truth. */
  readonly unresolved: number
  readonly builtAt: string
}

interface CacheEntry {
  readonly mtimeMs: number
  readonly size: number
  /** Raw wikilink targets as written (pre-resolution) — resolution is re-run per build. */
  readonly links: readonly string[]
}

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep)

export class GraphBuilder {
  private readonly cache = new Map<string, CacheEntry>()
  private lastSignature = ''
  private lastGraph: VaultGraph | undefined

  constructor(private readonly vaultRoot: string) {}

  /** Builds (or returns the cached) graph. Never throws on unreadable single files. */
  build(): VaultGraph {
    const files = this.listPages()

    // Whole-graph short-circuit: same file set, same mtimes/sizes → same graph.
    const signature = files.map((f) => `${f.rel}:${f.mtimeMs}:${f.size}`).join('\n')
    if (this.lastGraph !== undefined && signature === this.lastSignature) return this.lastGraph

    // Drop cache entries for pages that no longer exist.
    const live = new Set(files.map((f) => f.abs))
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key)

    // Parse only what changed since the last build.
    for (const f of files) {
      const hit = this.cache.get(f.abs)
      if (hit !== undefined && hit.mtimeMs === f.mtimeMs && hit.size === f.size) continue
      let links: string[] = []
      try {
        links = parseWikilinks(fs.readFileSync(f.abs, 'utf8'))
      } catch {
        // A page deleted mid-build or unreadable: an empty node beats a failed graph.
      }
      this.cache.set(f.abs, { mtimeMs: f.mtimeMs, size: f.size, links })
    }

    // Resolve: case-insensitive basename index, first occurrence wins (same rule the
    // citation resolver uses, so chat chips and graph edges can never disagree).
    const byName = new Map<string, number>()
    files.forEach((f, i) => {
      const key = f.title.toLowerCase()
      if (!byName.has(key)) byName.set(key, i)
    })

    const outDeg = new Array<number>(files.length).fill(0)
    const inDeg = new Array<number>(files.length).fill(0)
    const edges: Array<[number, number]> = []
    const seenEdge = new Set<number>()
    let unresolved = 0
    files.forEach((f, from) => {
      for (const target of this.cache.get(f.abs)?.links ?? []) {
        const to = byName.get(target.toLowerCase())
        if (to === undefined) {
          unresolved++
          continue
        }
        if (to === from) continue
        const key = from * files.length + to
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push([from, to])
        outDeg[from]!++
        inDeg[to]!++
      }
    })

    const nodes: GraphNode[] = files.map((f, i) => ({
      path: f.rel,
      title: f.title,
      type: f.type,
      out: outDeg[i]!,
      in: inDeg[i]!,
    }))

    const graph: VaultGraph = { nodes, edges, unresolved, builtAt: new Date().toISOString() }
    this.lastSignature = signature
    this.lastGraph = graph
    return graph
  }

  /** All wiki pages with the stat data the cache keys on. Sorted for a stable signature. */
  private listPages(): Array<{ abs: string; rel: string; title: string; type: string; mtimeMs: number; size: number }> {
    const wikiRoot = path.join(this.vaultRoot, 'wiki')
    const out: Array<{ abs: string; rel: string; title: string; type: string; mtimeMs: number; size: number }> = []
    const walk = (dir: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else if (e.isFile() && e.name.endsWith('.md')) {
          let stat: fs.Stats
          try {
            stat = fs.statSync(abs)
          } catch {
            continue
          }
          const rel = toPosix(path.relative(this.vaultRoot, abs))
          const parts = rel.split('/') // wiki/<bucket>/... or wiki/<file>.md
          out.push({
            abs,
            rel,
            title: e.name.slice(0, -3),
            type: parts.length > 2 ? parts[1]! : 'root',
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          })
        }
      }
    }
    walk(wikiRoot)
    out.sort((a, b) => a.rel.localeCompare(b.rel))
    return out
  }
}
