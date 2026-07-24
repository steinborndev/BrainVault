/**
 * Deterministic tag-hygiene analysis (the "lint equivalent" for tags): finds the redundancy
 * patterns that creep in when many independent ingest runs each coin their own tags — the
 * concrete trigger was every sub-community of one domain being labelled by the same two
 * near-synonym tags. Read-only by design: this REPORTS; any repair happens through a
 * sanctioned agent run (hard rule 1), for which these findings are the evidence.
 *
 * All rules are deterministic and threshold-based (constants below), computed from the
 * graph data the dashboard already has — no endpoint, no vault access.
 */

import type { GraphNode, TagFixAction } from '../api/types.ts'

/** The slice of a graph node the analysis reads (kind gates system pages out). */
export type TagNode = Pick<GraphNode, 'tags' | 'domain' | 'kind'>

/** A pair of tags flagged as spelling variants or near-synonyms. */
export interface TagPairFinding {
  a: string
  b: string
  aCount: number
  bCount: number
  /** Pages carrying BOTH — high overlap is what makes a variant pair worth merging. */
  both: number
  /** Implications only: true when the pair implies each other in both directions. */
  mutual?: boolean
}

/** A tag that just echoes a domain: it adds no signal beyond the page's `domain:`. */
export interface DomainEchoFinding {
  tag: string
  domain: string
  tagCount: number
  domainSize: number
  /** Pages inside the domain that carry the tag. */
  inDomain: number
}

export interface TagReport {
  distinctTags: number
  taggedPages: number
  knowledgePages: number
  /** Spelling/synonym-shaped pairs (plural, hyphenation, long shared stem). */
  variants: TagPairFinding[]
  /** a → b: a's pages (almost) always carry b too, so a adds little beyond b. */
  implications: TagPairFinding[]
  domainEchoes: DomainEchoFinding[]
  /** Tags used on exactly one page — noise for any tag-based navigation. */
  singletons: string[]
}

/** Shared-stem rule: prefixes at least this long count as "same stem" candidates. */
const MIN_STEM = 6
/** …and the shared prefix must cover at least this share of the shorter tag. */
const STEM_SHARE = 0.75
/** a → b needs at least this many pages carrying `a` — below that it's coincidence. */
const MIN_IMPLICATION_SUPPORT = 4
/** a → b fires when this share of a's pages also carry b. */
const IMPLICATION_SHARE = 0.95
/** Domain echo: the tag covers at least this share of the domain's pages… */
const ECHO_DOMAIN_COVERAGE = 0.8
/** …and lives inside the domain with at least this share of its own occurrences. */
const ECHO_TAG_CONCENTRATION = 0.9
/** Domains smaller than this can't meaningfully be "echoed". */
const MIN_ECHO_DOMAIN_SIZE = 5

/** Word split for the variant comparison: separators and case are never meaningful. */
const words = (t: string): string[] => t.toLowerCase().split(/[-_\s]+/).filter(Boolean)

/**
 * After the shared stem, a suffix longer than this makes a DIFFERENT word, not a spelling:
 * "product"+"ivity" changes the concept, "biomedic"+"al|ine" does not. Derivational pairs
 * with short suffixes on both sides (research/researcher, regulation/regulator) stay
 * flagged — they are genuinely ambiguous and exactly what the human checkbox is for.
 */
const MAX_VARIANT_SUFFIX = 4

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent transposition), for short
 * single words. Transpositions count 1 so "fiber"/"fibre" lands at distance 1 — while
 * two independent substitutions ("concept"/"context", "product"/"project") stay at 2.
 */
function osaDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1)
    row[0] = i
    return row
  })
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, rows[i - 2]![j - 2]! + 1)
      }
      rows[i]![j] = d
    }
  }
  return rows[a.length]![b.length]!
}

/** True when two single WORDS look like spellings of the same word. */
function isWordVariant(x: string, y: string): boolean {
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  if (`${short}s` === long || `${short}es` === long) return true // singular/plural
  let p = 0
  while (p < short.length && short[p] === long[p]) p++
  // Long shared stem with SHORT residues on both sides: "biomedic(al|ine)",
  // "chromatograph(y|ic)". The share bound keeps short accidental prefixes
  // ("sta-bility"/"sta-tistics") out; the suffix cap keeps derivations that change the
  // concept ("product-ivity") out.
  if (
    p >= Math.max(MIN_STEM, Math.ceil(STEM_SHARE * short.length)) &&
    short.length - p <= MAX_VARIANT_SUFFIX &&
    long.length - p <= MAX_VARIANT_SUFFIX
  ) {
    return true
  }
  // Spelling twins ("fiber"/"fibre"): one edit or transposition on a shared opening. A
  // plain distance-2 bound flagged "concept"/"context" and "product"/"project" on real
  // data — two substitutions make a different word, one transposition does not.
  return short.length >= 5 && p >= 3 && osaDistance(short, long) <= 1
}

/**
 * True for tag pairs shaped like spellings of the SAME concept. Compared word by word with
 * equal word counts required — that one rule kills three false-positive families the
 * whole-string stem match produced on real data: base-vs-compound ("person" /
 * "personal-finance", "organization" / "organizational-structure"), and tag hierarchies
 * ("claude" / "claude-ecosystem") — those are different concepts or intentional structure,
 * not spelling drift. Word-count-preserving pairs still match: "carbon-fiber" ≡
 * "carbon_fibre", "method" / "methods", "biomedical" / "biomedicine".
 */
function isVariantPair(a: string, b: string): boolean {
  const wa = words(a)
  const wb = words(b)
  if (wa.length !== wb.length) return false
  for (let i = 0; i < wa.length; i++) {
    if (wa[i] !== wb[i] && !isWordVariant(wa[i]!, wb[i]!)) return false
  }
  return true // every word equal or a variant (all-equal = pure separator/case variant)
}

export function computeTagReport(nodes: readonly TagNode[]): TagReport {
  // System pages (reports, logs, index hubs) tag themselves structurally — only knowledge
  // pages say anything about the vault's thematic tag hygiene.
  const pages = nodes.filter((n) => (n.kind ?? 'knowledge') === 'knowledge')

  const tagCount = new Map<string, number>()
  const pairCount = new Map<string, number>() // "a|b" with a < b, pages carrying both
  const domainSize = new Map<string, number>()
  const inDomainCount = new Map<string, number>() // "tag|domain"
  let taggedPages = 0
  for (const p of pages) {
    const tags = [...new Set(p.tags)].sort()
    if (tags.length > 0) taggedPages++
    if (p.domain !== null) domainSize.set(p.domain, (domainSize.get(p.domain) ?? 0) + 1)
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i]!
      tagCount.set(t, (tagCount.get(t) ?? 0) + 1)
      if (p.domain !== null) {
        const key = `${t}|${p.domain}`
        inDomainCount.set(key, (inDomainCount.get(key) ?? 0) + 1)
      }
      for (let j = i + 1; j < tags.length; j++) {
        const key = `${t}|${tags[j]!}`
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      }
    }
  }
  const both = (a: string, b: string): number => pairCount.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0

  // Variants: every distinct pair, string-shape rule. Quadratic in DISTINCT tags — a few
  // hundred tags is ~10⁴..10⁵ cheap prefix comparisons, fine for a memoized report.
  const tags = [...tagCount.keys()].sort()
  const variants: TagPairFinding[] = []
  const variantKey = new Set<string>()
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i]!
      const b = tags[j]!
      if (!isVariantPair(a, b)) continue
      variants.push({ a, b, aCount: tagCount.get(a)!, bCount: tagCount.get(b)!, both: both(a, b) })
      variantKey.add(`${a}|${b}`)
    }
  }
  variants.sort((x, y) => y.aCount + y.bCount - (x.aCount + x.bCount) || x.a.localeCompare(y.a))

  // Implications over pairs that actually co-occur; variant pairs are already reported
  // above and would only repeat there. Mutual pairs collapse into one finding, the more
  // common tag second ("a is redundant given b").
  const implications: TagPairFinding[] = []
  for (const [key, n] of pairCount) {
    const [a, b] = key.split('|') as [string, string]
    if (variantKey.has(key)) continue
    const ca = tagCount.get(a)!
    const cb = tagCount.get(b)!
    const aImplies = ca >= MIN_IMPLICATION_SUPPORT && n / ca >= IMPLICATION_SHARE
    const bImplies = cb >= MIN_IMPLICATION_SUPPORT && n / cb >= IMPLICATION_SHARE
    if (!aImplies && !bImplies) continue
    // The implied (kept) tag goes second; for mutual pairs the more common one.
    const [from, to] = aImplies && bImplies ? (ca <= cb ? [a, b] : [b, a]) : aImplies ? [a, b] : [b, a]
    implications.push({
      a: from,
      b: to,
      aCount: tagCount.get(from)!,
      bCount: tagCount.get(to)!,
      both: n,
      mutual: aImplies && bImplies,
    })
  }
  implications.sort((x, y) => y.both - x.both || x.a.localeCompare(y.a))

  // Domain echoes: the tag blankets the domain AND barely exists outside it — it repeats
  // what `domain:` already says.
  const domainEchoes: DomainEchoFinding[] = []
  for (const [key, inDomain] of inDomainCount) {
    const [tag, domain] = key.split('|') as [string, string]
    const dSize = domainSize.get(domain)!
    const tCount = tagCount.get(tag)!
    if (dSize < MIN_ECHO_DOMAIN_SIZE) continue
    if (inDomain / dSize >= ECHO_DOMAIN_COVERAGE && inDomain / tCount >= ECHO_TAG_CONCENTRATION) {
      domainEchoes.push({ tag, domain, tagCount: tCount, domainSize: dSize, inDomain })
    }
  }
  domainEchoes.sort((x, y) => y.tagCount - x.tagCount || x.tag.localeCompare(y.tag))

  const singletons = tags.filter((t) => tagCount.get(t) === 1)

  return {
    distinctTags: tags.length,
    taggedPages,
    knowledgePages: pages.length,
    variants,
    implications,
    domainEchoes,
    singletons,
  }
}

/**
 * The preselected recommendation (SPEC §12.7 Stufe a): every actionable finding whose
 * direction is unambiguous — variant merges into the more common spelling, drops of tags
 * that echo a real domain — selected up front so the user unchecks instead of building the
 * plan from scratch. Greedy and conflict-free by construction: an action that would make a
 * tag both consumed and referenced elsewhere (the `conflictingTag` rule) is left
 * unselected, first come wins (variants before echoes, each in report order). Echoes of
 * `unassigned` are never included — they are missing domains, not redundancy. Capped at
 * `max` so the preselection never promises more than one fix run applies.
 */
export function recommendedKeys(report: TagReport, max: number): Set<string> {
  const keys = new Set<string>()
  const consumed = new Set<string>()
  const referenced = new Set<string>() // any mention: consumed or merge target
  const fits = (consumes: string, keeps?: string): boolean =>
    !consumed.has(consumes) && !referenced.has(consumes) && (keeps === undefined || !consumed.has(keeps))
  const take = (key: string, consumes: string, keeps?: string): void => {
    keys.add(key)
    consumed.add(consumes)
    referenced.add(consumes)
    if (keeps !== undefined) referenced.add(keeps)
  }
  for (const v of report.variants) {
    if (keys.size >= max) return keys
    const [from, to] = v.aCount <= v.bCount ? [v.a, v.b] : [v.b, v.a]
    if (fits(from, to)) take(`merge|${from}|${to}`, from, to)
  }
  for (const e of report.domainEchoes) {
    if (keys.size >= max) return keys
    if (e.domain === 'unassigned') continue
    if (fits(e.tag)) take(`drop|${e.tag}`, e.tag)
  }
  return keys
}

/**
 * A tag referenced by two selected repairs where at least one CONSUMES it (drop, or the
 * from-side of a merge), or null when the plan is consistent. Two merges may share a
 * TARGET ("#fibre → #fiber" and "#fibres → #fiber" is fine) — but a tag that is dropped
 * or merged away must appear nowhere else: "merge #project into #product" plus "merge
 * #project into #projects" is two repairs fighting over one tag, and the agent would have
 * to guess an order. Selection-time guard for the tag-fix run.
 */
export function conflictingTag(actions: readonly TagFixAction[]): string | null {
  const refs = new Map<string, { consuming: number; total: number }>()
  const add = (tag: string, consuming: boolean): void => {
    const r = refs.get(tag) ?? { consuming: 0, total: 0 }
    r.total++
    if (consuming) r.consuming++
    refs.set(tag, r)
  }
  for (const a of actions) {
    if (a.kind === 'drop') add(a.tag, true)
    else {
      add(a.from, true)
      add(a.to, false)
    }
  }
  for (const [tag, r] of refs) {
    if (r.total > 1 && r.consuming > 0) return tag
  }
  return null
}
