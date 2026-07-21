/**
 * Deterministic "what does the vault already have on this topic?" lookup, used to steer a
 * research run toward EXTENDING existing pages instead of filing near-duplicates
 * (the preferred scenario per the autoresearch skill's "check the index first" rule, which
 * is otherwise only a soft instruction to the agent).
 *
 * The match is intentionally cheap and title-based: tokenise the topic and every wiki page
 * title, normalise singular/plural, and rank pages by shared significant tokens. This is a
 * heuristic surfacing candidates for the agent, not an authoritative "these are the same
 * thing" claim — the agent still decides page-by-page whether to extend or create.
 */

import path from 'node:path'
import { indexWikiPages } from './citations.js'

/** Pages that overlap a research topic, split so the prompt can treat syntheses specially. */
export interface RelatedPages {
  /** Existing "Research: …" synthesis pages (wiki/questions) — updating one beats a duplicate. */
  readonly syntheses: string[]
  /** Other overlapping pages (concepts, entities, sources, …), vault-relative paths. */
  readonly pages: string[]
}

/** At most this many related pages reach the prompt — a broad topic must not dump the vault. */
const MAX_RELATED = 12

/**
 * Words that carry no topical signal. Kept domain-neutral: generic English function words plus
 * a few research-boilerplate terms that show up in synthesis titles ("Research: Recent Insights
 * into …") and would otherwise match everything.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'to', 'with', 'from', 'into', 'its',
  'is', 'are', 'be', 'as', 'at', 'by', 'this', 'that', 'these', 'those', 'it', 'their',
  'research', 'recent', 'insights', 'insight', 'overview', 'introduction', 'update', 'updates',
  'using', 'use', 'based', 'new', 'state', 'guide', 'notes', 'note', 'about',
])

/**
 * Splits text into significant, normalised tokens: lower-cased, punctuation-stripped, stopwords
 * and short tokens dropped, and a single trailing plural `s` removed so "lipids" matches "lipid".
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue
    if (STOPWORDS.has(raw)) continue
    const normalized = raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw
    tokens.add(normalized)
  }
  return tokens
}

/** True for pages that are bookkeeping, not knowledge — never worth listing as "related". */
function isBookkeeping(relPath: string): boolean {
  const base = path.posix.basename(relPath)
  if (base === '_index.md') return true
  return (
    relPath === 'wiki/index.md' ||
    relPath === 'wiki/hot.md' ||
    relPath === 'wiki/log.md' ||
    relPath === 'wiki/overview.md'
  )
}

/**
 * Finds existing wiki pages whose title overlaps `topic`, ranked by shared significant tokens.
 * Purely advisory and failure-tolerant: any error (or an unreadable vault) yields no related
 * pages, so overlap detection can never make a research run fail.
 */
export function findRelatedPages(vaultRoot: string, topic: string): RelatedPages {
  const empty: RelatedPages = { syntheses: [], pages: [] }
  try {
    const topicTokens = tokenize(topic)
    if (topicTokens.size === 0) return empty

    const scored: { relPath: string; score: number }[] = []
    for (const [titleKey, relPath] of indexWikiPages(vaultRoot)) {
      if (isBookkeeping(relPath)) continue
      const titleTokens = tokenize(titleKey)
      let score = 0
      for (const t of topicTokens) if (titleTokens.has(t)) score++
      if (score > 0) scored.push({ relPath, score })
    }

    // Highest overlap first; stable tie-break on the path so the prompt is deterministic.
    scored.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath))

    const syntheses: string[] = []
    const pages: string[] = []
    for (const { relPath } of scored) {
      if (syntheses.length + pages.length >= MAX_RELATED) break
      if (relPath.startsWith('wiki/questions/')) syntheses.push(relPath)
      else pages.push(relPath)
    }
    return { syntheses, pages }
  } catch {
    return empty
  }
}

/**
 * Renders the related-pages block appended to the research prompt. Empty string when nothing
 * overlaps, so a fresh topic keeps the original prompt verbatim.
 */
export function renderOverlapBlock(related: RelatedPages): string {
  if (related.pages.length === 0 && related.syntheses.length === 0) return ''
  let block = ''
  if (related.pages.length > 0) {
    block +=
      '\n\nThe vault ALREADY holds pages related to this topic. Prefer EXTENDING and updating ' +
      'these over creating new ones; only add a new concept or entity page when the material ' +
      'genuinely has no home among them. Before writing any new page, check this list for one ' +
      'that already covers it and update that page instead (keep its existing title and ' +
      'frontmatter, refresh its `updated:` date):\n' +
      related.pages.map((p) => `- ${p}`).join('\n')
  }
  if (related.syntheses.length > 0) {
    block +=
      '\n\nThese existing research syntheses overlap the topic. If your findings substantially ' +
      'overlap one of them, UPDATE it (refresh its `updated:` date and fold your findings in) ' +
      'rather than filing a second near-duplicate "Research: …" page:\n' +
      related.syntheses.map((p) => `- ${p}`).join('\n')
  }
  return block
}
