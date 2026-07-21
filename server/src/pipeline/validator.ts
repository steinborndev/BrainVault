/**
 * Deterministic post-run validation — the mechanical subset of the wiki-lint checks, run
 * against exactly the pages an agent run or user edit just touched. Rationale (derived from
 * the 2026-07-19 lint report): most lint findings (frontmatter gaps, missing DragonScale
 * addresses, dead links, orphans, stale `.raw/.manifest.json` address_map entries) are
 * mechanically decidable and were all introduced *between* two expensive agent-lint runs.
 * Checking the touched pages right after each mutation surfaces them in the job log while
 * the context is fresh, instead of weeks later in the next full lint.
 *
 * READ-ONLY by design (hard rule 1): this module never writes to the vault. Findings are
 * warnings for the operator; fixes remain agent runs or user-initiated edits. Judgment-shaped
 * checks (stale claims, missing pages, cross-reference quality) stay with the wiki-lint skill.
 *
 * The DragonScale address rules mirror skills/wiki-lint/SKILL.md "Address Validation":
 * feature-gated on the vault's own artifacts, rollout baseline + grandfather list from
 * `.vault-meta/legacy-pages.txt`, `c-`/`l-` format, uniqueness, counter consistency, and the
 * address_map ↔ disk ↔ frontmatter three-way agreement. When the vault has not adopted
 * DragonScale, no address finding is ever produced.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseWikilinks } from './citations.js'
import type { VaultGraph } from './graph.js'

export type ValidationRule =
  | 'frontmatter'
  | 'dates'
  | 'address'
  | 'dead-link'
  | 'orphan'
  | 'address-map'
  | 'stale-counter'

export interface ValidationFinding {
  readonly rule: ValidationRule
  /** Vault-relative POSIX path of the page the finding is about. */
  readonly path: string
  readonly message: string
}

/** Signature the queue / maintenance runner / pages routes consume (injectable in tests). */
export type Validator = (paths: readonly string[]) => ValidationFinding[]

/** Required frontmatter fields per the vault's page template (wiki-lint "Frontmatter Gaps"). */
export const REQUIRED_FIELDS = ['type', 'status', 'created', 'updated', 'tags'] as const

/** Baseline the wiki-ingest skill documents for vaults that adopted DragonScale on ship day. */
const DEFAULT_ROLLOUT = '2026-04-23'

/** Buckets whose pages are content that should be reachable — the orphan check's scope.
 * meta/folds/root nav pages are legitimately unlinked-from and stay out. */
const CONTENT_BUCKETS = new Set(['concepts', 'entities', 'sources', 'questions', 'comparisons', 'references'])

const ADDRESS_RE = /^[cl]-\d{6}$/

/**
 * Lint reports QUOTE findings as wikilinks — dead links deliberately, orphans linked by the
 * act of reporting them. Validating a report page against the link checks (or counting its
 * links as inbound edges) would therefore invert the report's own findings.
 */
const isLintReport = (rel: string): boolean => /^wiki\/meta\/lint-report-.*\.md$/.test(rel)

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '')

interface Frontmatter {
  readonly present: boolean
  /** Scalar `key: value` pairs (first occurrence wins), values trimmed and unquoted. */
  readonly fields: ReadonlyMap<string, string>
  /** `tags:` present at all — a block list leaves the scalar value empty, so track the key. */
  readonly hasTags: boolean
}

/** Shallow frontmatter reader (same stance as graph.ts: agent-written flat YAML, no library). */
function parseFrontmatter(markdown: string): Frontmatter {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return { present: false, fields: new Map(), hasTags: false }
  const body = fm[1]!
  const fields = new Map<string, string>()
  for (const m of body.matchAll(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/gm)) {
    if (!fields.has(m[1]!)) fields.set(m[1]!, unquote(m[2]!))
  }
  return { present: true, fields, hasTags: /^tags:/m.test(body) }
}

interface DragonScaleState {
  readonly active: boolean
  /** `YYYY-MM-DD`; pages created on/after this date must carry an address. */
  readonly rollout: string
  /** Post-rollout paths explicitly grandfathered in `.vault-meta/legacy-pages.txt`. */
  readonly legacy: ReadonlySet<string>
  /** Next value the allocator would hand out; null when the counter file is unreadable. */
  readonly counter: number | null
}

function readDragonScale(vaultRoot: string): DragonScaleState {
  const counterFile = path.join(vaultRoot, '.vault-meta', 'address-counter.txt')
  const active = fs.existsSync(counterFile) && fs.existsSync(path.join(vaultRoot, 'scripts', 'allocate-address.sh'))
  if (!active) return { active: false, rollout: DEFAULT_ROLLOUT, legacy: new Set(), counter: null }

  let counter: number | null = null
  try {
    const raw = fs.readFileSync(counterFile, 'utf8').trim()
    if (/^\d+$/.test(raw)) counter = Number(raw)
  } catch {
    /* unreadable counter → skip the drift check, keep the others */
  }

  let rollout = DEFAULT_ROLLOUT
  const legacy = new Set<string>()
  try {
    for (const line of fs.readFileSync(path.join(vaultRoot, '.vault-meta', 'legacy-pages.txt'), 'utf8').split('\n')) {
      const t = line.trim()
      const m = /^#\s*rollout:\s*(\d{4}-\d{2}-\d{2})/.exec(t)
      if (m) rollout = m[1]!
      else if (t !== '' && !t.startsWith('#')) legacy.add(t)
    }
  } catch {
    /* no manifest → default baseline, nothing grandfathered */
  }
  return { active: true, rollout, legacy, counter }
}

/** Wikilink targets minus code: fenced blocks and inline code hold illustrative `[[examples]]`
 * (the 2026-07-19 lint had to hand-annotate those as false positives — strip them up front). */
function linkTargets(markdown: string): string[] {
  return parseWikilinks(markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, ''))
}

/**
 * Case-insensitive name index over EVERY vault file, keyed by basename and by basename minus
 * extension. Deliberately wider than the graph's wiki-only page index: Obsidian resolves
 * `[[fold-template]]` to skills/…/fold-template.md and `[[Wiki Map]]` to Wiki Map.canvas, and
 * flagging those as dead was the lint report's main false-positive class.
 */
function buildFileIndex(vaultRoot: string): Set<string> {
  const index = new Set<string>()
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(abs)
        continue
      }
      if (!e.isFile()) continue
      index.add(e.name.toLowerCase())
      const stem = e.name.replace(/\.[^.]+$/, '')
      if (stem !== '') index.add(stem.toLowerCase())
    }
  }
  walk(vaultRoot)
  return index
}

function linkResolves(vaultRoot: string, index: ReadonlySet<string>, target: string): boolean {
  if (target.includes('/')) {
    // Path-qualified: try the path as written, with `.md`, and wiki-relative (the vault's
    // `[[concepts/_index]]` navigation style) — confined to the vault.
    for (const cand of [target, `${target}.md`, `wiki/${target}`, `wiki/${target}.md`]) {
      const abs = path.resolve(vaultRoot, cand)
      if (abs.startsWith(vaultRoot + path.sep) && fs.existsSync(abs)) return true
    }
    const base = target.split('/').filter(Boolean).pop() ?? ''
    return base !== '' && index.has(base.toLowerCase())
  }
  return index.has(target.toLowerCase())
}

/** Every `address:` in the wiki, address → paths (the uniqueness check's evidence base). */
function scanAddresses(vaultRoot: string): Map<string, string[]> {
  const byAddress = new Map<string, string[]>()
  const wikiRoot = path.join(vaultRoot, 'wiki')
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
        let address: string | undefined
        try {
          address = parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields.get('address')
        } catch {
          continue
        }
        if (!address) continue
        const rel = path.relative(vaultRoot, abs).split(path.sep).join(path.posix.sep)
        const holders = byAddress.get(address)
        if (holders === undefined) byAddress.set(address, [rel])
        else holders.push(rel)
      }
    }
  }
  walk(wikiRoot)
  return byAddress
}

/**
 * Validates the given wiki pages (vault-relative POSIX paths; non-wiki paths are ignored).
 * Pass a freshly built graph to enable the orphan check; without it that check is skipped.
 * Never throws and never writes; a page deleted since the run simply yields no findings.
 */
export function validatePages(vaultRoot: string, paths: readonly string[], graph?: VaultGraph): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  const pages = [...new Set(paths)].filter((p) => p.startsWith('wiki/') && p.endsWith('.md'))
  if (pages.length === 0) return findings

  const ds = readDragonScale(vaultRoot)
  // These cost a vault walk / edge scan — built only when a page actually needs them.
  let fileIndex: Set<string> | undefined
  let addresses: Map<string, string[]> | undefined
  let inbound: number[] | undefined

  for (const rel of pages) {
    let markdown: string
    try {
      markdown = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
    } catch {
      continue
    }

    const fm = parseFrontmatter(markdown)
    if (!fm.present) {
      findings.push({ rule: 'frontmatter', path: rel, message: 'page has no YAML frontmatter block' })
    } else {
      const missing = REQUIRED_FIELDS.filter((f) => (f === 'tags' ? !fm.hasTags : (fm.fields.get(f) ?? '') === ''))
      if (missing.length > 0) {
        findings.push({
          rule: 'frontmatter',
          path: rel,
          message: `missing required frontmatter field(s): ${missing.join(', ')}`,
        })
      }
    }

    const created = fm.fields.get('created') ?? ''
    const updated = fm.fields.get('updated') ?? ''
    const createdMs = Date.parse(created)
    const updatedMs = Date.parse(updated)
    if (Number.isFinite(createdMs) && Number.isFinite(updatedMs) && createdMs > updatedMs) {
      findings.push({
        rule: 'dates',
        path: rel,
        message: `created (${created}) is after updated (${updated}) — bump updated: when editing`,
      })
    }

    // DragonScale addresses. Fold pages use fold_id instead and are exempt from the c-/l- rules.
    const type = (fm.fields.get('type') ?? '').toLowerCase()
    const address = fm.fields.get('address') ?? ''
    if (ds.active && type !== 'fold' && !rel.startsWith('wiki/folds/')) {
      const createdDay = created.slice(0, 10)
      if (address === '') {
        const required =
          type !== 'meta' && /^\d{4}-\d{2}-\d{2}$/.test(createdDay) && createdDay >= ds.rollout && !ds.legacy.has(rel)
        if (required) {
          findings.push({
            rule: 'address',
            path: rel,
            message: `post-rollout page (created ${createdDay}) has no address: — allocate one via scripts/allocate-address.sh`,
          })
        }
      } else if (!ADDRESS_RE.test(address)) {
        findings.push({
          rule: 'address',
          path: rel,
          message: `malformed address "${address}" — expected c-NNNNNN or l-NNNNNN`,
        })
      } else {
        if (address.startsWith('c-') && ds.counter !== null && Number(address.slice(2)) >= ds.counter) {
          findings.push({
            rule: 'address',
            path: rel,
            message: `address ${address} is at/above the allocation counter (${ds.counter}) — counter drift`,
          })
        }
        addresses ??= scanAddresses(vaultRoot)
        const others = (addresses.get(address) ?? []).filter((h) => h !== rel)
        if (others.length > 0) {
          findings.push({
            rule: 'address',
            path: rel,
            message: `address ${address} collides with ${others.join(', ')}`,
          })
        }
      }
    }

    const targets = isLintReport(rel) ? [] : linkTargets(markdown)
    if (targets.length > 0) {
      fileIndex ??= buildFileIndex(vaultRoot)
      for (const t of targets) {
        if (!linkResolves(vaultRoot, fileIndex, t)) {
          findings.push({ rule: 'dead-link', path: rel, message: `[[${t}]] does not resolve to any file in the vault` })
        }
      }
    }

    if (graph !== undefined) {
      const parts = rel.split('/')
      const bucket = parts.length > 2 ? parts[1]! : 'root'
      if (CONTENT_BUCKETS.has(bucket) && !parts[parts.length - 1]!.startsWith('_')) {
        // In-degree minus lint-report sources (see isLintReport) — computed once per call.
        inbound ??= countInboundExcludingReports(graph)
        const idx = graph.nodes.findIndex((n) => n.path === rel)
        if (idx >= 0 && inbound[idx] === 0) {
          findings.push({
            rule: 'orphan',
            path: rel,
            message: 'no other page links here — add a link from the index or a related page',
          })
        }
      }
    }
  }
  return findings
}

/** Per-node in-degree over the graph's edges, not counting links FROM lint-report pages. */
function countInboundExcludingReports(graph: VaultGraph): number[] {
  const counts = new Array<number>(graph.nodes.length).fill(0)
  for (const [from, to] of graph.edges) {
    if (!isLintReport(graph.nodes[from]!.path)) counts[to]!++
  }
  return counts
}

/**
 * The address_map ↔ disk ↔ frontmatter consistency check (`.raw/.manifest.json`): a deletion
 * is not a manifest-aware operation, so every DELETE of a mapped page silently strands an
 * entry claiming its address is in use — the 2026-07-19 lint found four. Vaults without the
 * manifest (or without address_map) yield no findings.
 */
export function validateAddressMap(vaultRoot: string): ValidationFinding[] {
  let map: Record<string, unknown>
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.raw', '.manifest.json'), 'utf8')) as {
      address_map?: Record<string, unknown>
    }
    map = parsed.address_map ?? {}
  } catch {
    return []
  }

  const findings: ValidationFinding[] = []
  for (const [rel, addr] of Object.entries(map)) {
    if (typeof addr !== 'string') continue
    const abs = path.resolve(vaultRoot, rel)
    if (!abs.startsWith(vaultRoot + path.sep)) continue // hostile/garbled entry — not ours to judge
    if (!fs.existsSync(abs)) {
      findings.push({
        rule: 'address-map',
        path: rel,
        message: `.raw/.manifest.json address_map still maps ${addr} to this page, but it no longer exists — remove the stale entry`,
      })
      continue
    }
    let onPage = ''
    try {
      onPage = parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields.get('address') ?? ''
    } catch {
      continue
    }
    if (onPage !== addr) {
      findings.push({
        rule: 'address-map',
        path: rel,
        message: `address_map says ${addr} but the page's frontmatter says ${onPage || '(none)'} — map and page diverged`,
      })
    }
  }
  return findings
}

/**
 * How far a hand-maintained header counter may lag the real count before it is flagged.
 * The tolerance absorbs legitimate semantic differences (a "Total pages" line that never
 * counted meta pages); the lint report's real drift cases were 13 and 8 pages behind.
 */
const COUNTER_SLACK = 3

/**
 * The stale-counter check (lint report "Stale Claims"): wiki/index.md and wiki/overview.md
 * carry hand-maintained "Total pages: N" / "Sources ingested: N" header lines that had
 * drifted for 3+ ingest sessions because every single-source run correctly deferred fixing
 * them. Compare the claimed numbers against the counted reality; findings are advisory.
 */
export function validateCounters(vaultRoot: string): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  const totals = countWikiPages(vaultRoot)
  if (totals === undefined) return findings

  for (const rel of ['wiki/index.md', 'wiki/overview.md']) {
    let markdown: string
    try {
      markdown = fs.readFileSync(path.join(vaultRoot, rel), 'utf8')
    } catch {
      continue
    }
    const checks: Array<{ re: RegExp; label: string; actual: number }> = [
      { re: /(?:total|wiki) pages\D{0,5}(\d+)/i, label: 'pages', actual: totals.pages },
      { re: /sources ingested\D{0,5}(\d+)/i, label: 'sources', actual: totals.sources },
    ]
    for (const { re, label, actual } of checks) {
      const m = re.exec(markdown)
      if (!m) continue
      const claimed = Number(m[1])
      if (Math.abs(actual - claimed) > COUNTER_SLACK) {
        findings.push({
          rule: 'stale-counter',
          path: rel,
          message: `header claims ${claimed} ${label} but the vault has ${actual} — update the counter (or drop it from the header)`,
        })
      }
    }
  }
  return findings
}

/** Counts wiki pages and source pages on disk (`_index` hubs excluded from sources). */
function countWikiPages(vaultRoot: string): { pages: number; sources: number } | undefined {
  const wikiRoot = path.join(vaultRoot, 'wiki')
  if (!fs.existsSync(wikiRoot)) return undefined
  let pages = 0
  let sources = 0
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
        pages++
        if (path.basename(dir) === 'sources' && !e.name.startsWith('_')) sources++
      }
    }
  }
  walk(wikiRoot)
  return { pages, sources }
}

/** The standard composition the service wires in: per-page, address_map, and counter checks. */
export function createValidator(vaultRoot: string, graph?: { build(): VaultGraph }): Validator {
  return (paths) => [
    ...validatePages(vaultRoot, paths, graph?.build()),
    ...validateAddressMap(vaultRoot),
    ...validateCounters(vaultRoot),
  ]
}
