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

import type { GraphNode } from '../api/types.ts'

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

/** Levenshtein distance, for short single words only (variant spellings like fiber/fibre). */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = dp[j]!
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return dp[b.length]!
}

/** True when two single WORDS look like spellings of the same word. */
function isWordVariant(x: string, y: string): boolean {
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  if (`${short}s` === long || `${short}es` === long) return true // singular/plural
  let p = 0
  while (p < short.length && short[p] === long[p]) p++
  // Long shared stem: "biomedic(al|ine)", "chromatograph(y|ic)". The share bound keeps
  // short accidental prefixes ("sta-bility"/"sta-tistics") out.
  if (p >= Math.max(MIN_STEM, Math.ceil(STEM_SHARE * short.length))) return true
  // Spelling twins ("fiber"/"fibre"): tiny edit distance on a shared opening — too short
  // for the stem rule but clearly the same word.
  return short.length >= 5 && p >= 3 && editDistance(short, long) <= 2
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
