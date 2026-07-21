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

/**
 * How a page participates in the vault (SPEC §12.4): `knowledge` is what the vault exists
 * for; `structural` pages organize it (index hubs, `_index` MOCs, the domain registry);
 * `artifact` pages document operations (lint/release reports, session logs, fold snapshots).
 * The dashboard hides everything non-knowledge behind one "System" toggle by default.
 */
export type NodeKind = 'knowledge' | 'structural' | 'artifact'

/** One wiki page. `type` is the top-level wiki directory (concepts, entities, sources, …). */
export interface GraphNode {
  /** Vault-relative POSIX path, e.g. `wiki/concepts/Compound Interest.md`. */
  readonly path: string
  /** Page name (basename without `.md`) — the label the graph renders. */
  readonly title: string
  /** Top-level bucket: `concepts` | `entities` | `sources` | `meta` | … | `root` for wiki/*.md. */
  readonly type: string
  /** Frontmatter `tags:` (as written, deduped); the thematic axis the folders don't carry. */
  readonly tags: readonly string[]
  /** Frontmatter `domain:` — the meta-category (SPEC §12.4 Stufe 1), or null when unset. */
  readonly domain: string | null
  /** Knowledge page, structural scaffolding, or operational artifact — see NodeKind. */
  readonly kind: NodeKind
  /** Out-degree (links this page makes) and in-degree (backlinks) over RESOLVED edges. */
  readonly out: number
  readonly in: number
  /** File mtime (epoch ms) — drives the "recency" color lens. Optional: only the builder sets it. */
  readonly mtimeMs?: number
  /** File size in bytes — a cheap proxy the "stubs" lens thresholds on. Builder-only. */
  readonly size?: number
}

/**
 * A knowledge gap: a wikilink target no page satisfies. The vault's own record of what
 * to write next — pages already cite it, it just doesn't exist yet. Feeds the dashboard's
 * ghost nodes and the ranked "most-wanted missing pages" list (SPEC §12.4).
 *
 * Artifact pages (lint reports, session logs, folds) never count as referrers: they QUOTE
 * dangling links while reporting on them rather than wanting the page written, so one lint
 * report would otherwise inflate every gap and mint pure-noise entries.
 */
export interface GraphGap {
  /** The missing page's name, cased as first written in a wikilink. */
  readonly title: string
  /** Indices into `nodes` of the pages linking to this target (deduped per page). */
  readonly refBy: number[]
}

export interface VaultGraph {
  readonly nodes: GraphNode[]
  /** Directed edges as [fromIndex, toIndex] into `nodes` — compact on the wire. */
  readonly edges: Array<[number, number]>
  /** Wikilink targets that resolved to no page (dangling links), counted per source of truth. */
  readonly unresolved: number
  /** Distinct unresolved targets — most knowledge-page referrers first, see the gap sort. */
  readonly gaps: GraphGap[]
  readonly builtAt: string
}

interface CacheEntry {
  readonly mtimeMs: number
  readonly size: number
  /** Raw wikilink targets as written (pre-resolution) — resolution is re-run per build. */
  readonly links: readonly string[]
  readonly tags: readonly string[]
  readonly domain: string | null
  /** Frontmatter `type:` (lowercased), the primary signal for the kind classification. */
  readonly fmType: string | null
}

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep)

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '')

/**
 * Extracts `tags:` (block or inline list), `domain:` and `type:` from a page's YAML
 * frontmatter. Deliberately a shallow parser, not a YAML library: the vault's frontmatter
 * is agent-written and flat, and this runs on every changed file of a growing vault.
 */
export function parseFrontmatterMeta(markdown: string): {
  tags: string[]
  domain: string | null
  fmType: string | null
} {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return { tags: [], domain: null, fmType: null }
  const body = fm[1]!

  const domainMatch = body.match(/^domain:[ \t]*(.+)$/m)
  const domain = domainMatch ? unquote(domainMatch[1]!) || null : null

  const typeMatch = body.match(/^type:[ \t]*(.+)$/m)
  const fmType = typeMatch ? unquote(typeMatch[1]!).toLowerCase() || null : null

  const tags: string[] = []
  // Block list:  tags:\n  - a\n  - b
  const block = body.match(/^tags:[ \t]*\r?\n((?:[ \t]+-[ \t]*.*\r?\n?)+)/m)
  if (block) {
    for (const line of block[1]!.split(/\r?\n/)) {
      const item = line.match(/^[ \t]+-[ \t]*(.+)$/)
      if (item) tags.push(unquote(item[1]!))
    }
  } else {
    // Inline list:  tags: [a, b]
    const inline = body.match(/^tags:[ \t]*\[([^\]]*)\]/m)
    if (inline) {
      for (const item of inline[1]!.split(',')) {
        const t = unquote(item)
        if (t) tags.push(t)
      }
    }
  }
  return { tags: [...new Set(tags)], domain, fmType }
}

/** Frontmatter `type:` values that mark a knowledge page wherever it lives. */
const KNOWLEDGE_TYPES: ReadonlySet<string> = new Set([
  'concept',
  'entity',
  'source',
  'reference',
  'comparison',
  'question',
  'synthesis',
  'decision',
])

/** Frontmatter `type:` values that always mark an operational artifact. */
const ARTIFACT_TYPES: ReadonlySet<string> = new Set(['session', 'fold', 'report', 'release'])

/**
 * System-page names that record a RUN rather than structure the vault. Only consulted for
 * pages already classified as system territory (most artifacts just say `type: meta`, the
 * same as the registry and the hubs), so a knowledge page named "Benchmark" is never caught.
 */
const ARTIFACT_NAME = /report|session|benchmark|snapshot|frontier|rollout|audit/i

/**
 * Classifies one page (see NodeKind). Directory alone is NOT enough — the `_index` MOCs
 * live inside the knowledge folders and `wiki/meta/` mixes the domain registry with lint
 * reports — so the frontmatter `type:` leads and the location/name break the ties.
 * `domain: meta` overrides even a knowledge `type:`: the vault marks every system page
 * with it, and ops notes reuse knowledge types (a rollout note filed as `type: decision`).
 */
export function classifyKind(
  fmType: string | null,
  domain: string | null,
  bucket: string,
  title: string,
): NodeKind {
  const metaDomain = domain === 'meta'
  if (!metaDomain && fmType !== null && KNOWLEDGE_TYPES.has(fmType)) return 'knowledge'
  if (fmType !== null && ARTIFACT_TYPES.has(fmType)) return 'artifact'
  const system =
    metaDomain ||
    fmType === 'meta' ||
    bucket === 'meta' ||
    bucket === 'folds' ||
    bucket === 'root' ||
    title.startsWith('_')
  if (!system) return 'knowledge'
  if (bucket === 'folds' || /^\d{4}-\d{2}-\d{2}/.test(title) || ARTIFACT_NAME.test(title)) {
    return 'artifact'
  }
  return 'structural'
}

export class GraphBuilder {
  private readonly cache = new Map<string, CacheEntry>()
  private lastSignature = ''
  private lastGraph: VaultGraph | undefined

  constructor(private readonly vaultRoot: string) {}

  /** Builds (or returns the cached) graph. Never throws on unreadable single files. */
  build(): VaultGraph {
    const { pages: files, assets } = this.listFiles()

    // Whole-graph short-circuit: same file set, same mtimes/sizes → same graph. Assets
    // join by path only — their content never matters, but adding/removing one changes
    // what resolves.
    const signature =
      files.map((f) => `${f.rel}:${f.mtimeMs}:${f.size}`).join('\n') + '\0' + assets.join('\n')
    if (this.lastGraph !== undefined && signature === this.lastSignature) return this.lastGraph

    // Drop cache entries for pages that no longer exist.
    const live = new Set(files.map((f) => f.abs))
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key)

    // Parse only what changed since the last build.
    for (const f of files) {
      const hit = this.cache.get(f.abs)
      if (hit !== undefined && hit.mtimeMs === f.mtimeMs && hit.size === f.size) continue
      let links: string[] = []
      let meta: { tags: string[]; domain: string | null; fmType: string | null } = {
        tags: [],
        domain: null,
        fmType: null,
      }
      try {
        const markdown = fs.readFileSync(f.abs, 'utf8')
        links = parseWikilinks(markdown)
        meta = parseFrontmatterMeta(markdown)
      } catch {
        // A page deleted mid-build or unreadable: an empty node beats a failed graph.
      }
      this.cache.set(f.abs, {
        mtimeMs: f.mtimeMs,
        size: f.size,
        links,
        tags: meta.tags,
        domain: meta.domain,
        fmType: meta.fmType,
      })
    }

    // Resolve, three layers (checked in order):
    //  1. Case-insensitive basename index, first occurrence wins — the primary rule, shared
    //     with the citation resolver (chat chips resolve a subset of what the graph does:
    //     layers 2 and 3 are graph-only, so a chip may show unresolved where the graph links).
    //  2. Path-qualified targets (`[[concepts/_index]]`) against the page's wiki-relative
    //     path — the basename index structurally can't match them, but the pages exist;
    //     without this layer the vault's `_index` nav links dominate the unresolved count.
    //  3. Non-markdown vault files (`.canvas`, `.base`, …): resolution-only — a link to an
    //     existing canvas is not a missing page, but assets never become nodes.
    const byName = new Map<string, number>()
    files.forEach((f, i) => {
      const key = f.title.toLowerCase()
      if (!byName.has(key)) byName.set(key, i)
    })
    const byPath = new Map<string, number>()
    files.forEach((f, i) => {
      // `wiki/concepts/_index.md` → `concepts/_index` (links are written wiki-relative).
      const key = f.rel.slice('wiki/'.length, -'.md'.length).toLowerCase()
      if (!byPath.has(key)) byPath.set(key, i)
    })
    const assetKeys = new Set<string>()
    for (const rel of assets) {
      const sub = rel.slice('wiki/'.length).toLowerCase()
      const base = sub.split('/').pop()!
      // Writers link assets by name with ([[dashboard.base]]) or without ([[Wiki Map]])
      // the extension, bare or path-qualified — accept all four spellings.
      for (const k of [sub, sub.replace(/\.[^./]+$/, ''), base, base.replace(/\.[^./]+$/, '')]) {
        assetKeys.add(k)
      }
    }

    // Page kinds, needed before the link loop: artifact pages don't nominate gaps.
    const kinds: NodeKind[] = files.map((f) => {
      const entry = this.cache.get(f.abs)
      return classifyKind(entry?.fmType ?? null, entry?.domain ?? null, f.type, f.title)
    })

    const outDeg = new Array<number>(files.length).fill(0)
    const inDeg = new Array<number>(files.length).fill(0)
    const edges: Array<[number, number]> = []
    const seenEdge = new Set<number>()
    let unresolved = 0
    // Distinct missing targets grouped case-insensitively (same rule as resolution above);
    // the first-written casing becomes the display title.
    const gapByKey = new Map<string, { title: string; refBy: Set<number> }>()
    files.forEach((f, from) => {
      for (const target of this.cache.get(f.abs)?.links ?? []) {
        const lower = target.toLowerCase()
        // A leading `wiki/` is tolerated everywhere: paths and asset keys are stored
        // wiki-relative, and both link spellings occur in agent-written pages.
        const wikiRel = lower.startsWith('wiki/') ? lower.slice('wiki/'.length) : lower
        const to = byName.get(lower) ?? (target.includes('/') ? byPath.get(wikiRel) : undefined)
        if (to === undefined) {
          if (assetKeys.has(wikiRel)) continue // an existing canvas/base — resolved, no node
          unresolved++
          // Path-qualified stragglers (`[[notes/Foo]]`, `.raw/…`) stay out of the gap list:
          // they are navigation or staging references, not missing CONTENT pages. Artifact
          // sources count as unresolved but never as gap referrers (see GraphGap).
          if (!target.includes('/') && kinds[from] !== 'artifact') {
            const gap = gapByKey.get(lower)
            if (gap === undefined) gapByKey.set(lower, { title: target, refBy: new Set([from]) })
            else gap.refBy.add(from)
          }
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

    const nodes: GraphNode[] = files.map((f, i) => {
      const entry = this.cache.get(f.abs)
      return {
        path: f.rel,
        title: f.title,
        type: f.type,
        tags: entry?.tags ?? [],
        domain: entry?.domain ?? null,
        kind: kinds[i]!,
        out: outDeg[i]!,
        in: inDeg[i]!,
        mtimeMs: f.mtimeMs,
        size: f.size,
      }
    })

    // Rank by how many KNOWLEDGE pages wait for the target, then by total referrers: the
    // list is a research backlog, and a gap two content pages want beats one that only
    // hubs and logs mention.
    const gaps: GraphGap[] = [...gapByKey.values()]
      .map((g) => {
        const refBy = [...g.refBy].sort((a, b) => a - b)
        return {
          title: g.title,
          refBy,
          fromKnowledge: refBy.filter((i) => kinds[i] === 'knowledge').length,
        }
      })
      .sort(
        (a, b) =>
          b.fromKnowledge - a.fromKnowledge ||
          b.refBy.length - a.refBy.length ||
          a.title.localeCompare(b.title),
      )
      .map(({ title, refBy }) => ({ title, refBy }))

    const graph: VaultGraph = { nodes, edges, unresolved, gaps, builtAt: new Date().toISOString() }
    this.lastSignature = signature
    this.lastGraph = graph
    return graph
  }

  /**
   * All wiki pages with the stat data the cache keys on, plus the vault-relative paths of
   * non-markdown wiki files (canvases, bases, …) that participate in link resolution only.
   * Both sorted for a stable signature.
   */
  private listFiles(): {
    pages: Array<{ abs: string; rel: string; title: string; type: string; mtimeMs: number; size: number }>
    assets: string[]
  } {
    const wikiRoot = path.join(this.vaultRoot, 'wiki')
    const pages: Array<{ abs: string; rel: string; title: string; type: string; mtimeMs: number; size: number }> = []
    const assets: string[] = []
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
          pages.push({
            abs,
            rel,
            title: e.name.slice(0, -3),
            type: parts.length > 2 ? parts[1]! : 'root',
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          })
        } else if (e.isFile()) {
          assets.push(toPosix(path.relative(this.vaultRoot, abs)))
        }
      }
    }
    walk(wikiRoot)
    pages.sort((a, b) => a.rel.localeCompare(b.rel))
    assets.sort()
    return { pages, assets }
  }
}
