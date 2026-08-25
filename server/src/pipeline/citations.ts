/**
 * Citation extraction for chat answers (SPEC.md §6.3, TASKS-M4 §1). The read-only query
 * runner is prompted to cite vault pages inline as Obsidian wikilinks `[[Page Name]]`; the
 * dashboard renders each cited page as a clickable obsidian:// chip. This module turns the
 * answer text into resolved page paths.
 *
 * Resolution is heuristic and MUST degrade gracefully: a wikilink that names no real page
 * resolves to `path: null` (rendered as plain text, never a broken link) rather than being
 * dropped or faked. The vault is the source of truth — we only ever read it here.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface Citation {
  /** The page name as written in the answer, e.g. `Compound Interest`. */
  readonly label: string
  /** Vault-relative POSIX path (`wiki/concepts/Compound Interest.md`), or null if unresolved. */
  readonly path: string | null
}

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep)

/** One wikilink reference found in markdown. */
export interface WikilinkRef {
  /** The page name as written (aliases and headings stripped), e.g. `Compound Interest`. */
  readonly target: string
  /**
   * True when EVERY occurrence was an embed (`![[…]]`). An embed transcludes a file - most
   * often an image - so a broken one is a broken picture, not a page somebody wants written.
   * A single plain `[[link]]` anywhere in the text clears the flag.
   */
  readonly embed: boolean
}

/** Inline code spans. CommonMark allows no newline inside a single-backtick span. */
const INLINE_CODE = /`[^`\n]*`/g

/** Opening fence: up to 3 leading spaces, then 3+ backticks or tildes (info string may follow). */
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/
/** Closing fence: same run, nothing but whitespace after it. */
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * Blanks fenced blocks and inline code so illustrative `[[examples]]` inside them never count
 * as links. Line by line rather than one regex over the whole text: fence markers are
 * line-anchored, and a global regex mis-pairs them (a ``` opened inside a ~~~ block, a
 * four-backtick fence quoting a three-backtick one). Lines are emptied, not dropped, so the
 * line structure of the source survives.
 *
 * An unterminated fence swallows the rest of the document - what CommonMark and Obsidian
 * both do, and the safe direction here.
 */
function stripCode(text: string): string {
  const lines = text.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence === null) {
      const open = FENCE_OPEN.exec(line)
      if (open === null) lines[i] = line.replace(INLINE_CODE, '')
      else {
        fence = open[1]!
        lines[i] = ''
      }
      continue
    }
    const close = FENCE_CLOSE.exec(line)
    // A closing fence must use the same character and be at least as long as the opener.
    if (close !== null && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = null
    lines[i] = ''
  }
  return lines.join('\n')
}

/**
 * Pulls unique wikilink references out of markdown: `[[Page]]`, `[[Page|Alias]]`,
 * `[[Page#Heading]]` and their `![[…]]` embed forms, in first-seen order.
 *
 * Two things a naive `\[\[(.+?)\]\]` gets wrong, both measured against the real vault:
 *
 *  - **Code.** `tf.constant([[1.]] * n)` is a Python literal, not a link to a page named
 *    "1." - and a lint report quoting `[[Some Page]]` is not linking to it. Code is stripped
 *    first (the validator used to do this on its own; it belongs here, for every caller).
 *  - **Escaped pipes.** Inside a markdown table the alias separator MUST be written `\|` or
 *    the cell breaks, so comparison tables are full of `[[Compound Interest\|CI]]`. Splitting
 *    on the bare `|` leaves the escape in the page name, and the link resolves to nothing -
 *    which is how three concept pages that exist ended up ranked as the most wanted missing
 *    ones.
 */
export function parseWikilinkRefs(text: string): WikilinkRef[] {
  const byKey = new Map<string, { target: string; embed: boolean }>()
  const src = stripCode(text)
  const re = /(!?)\[\[([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const target = m[2]!.replace(/\\\|/g, '|').split('|')[0]!.split('#')[0]!.trim()
    if (target === '') continue
    const key = target.toLowerCase()
    const seen = byKey.get(key)
    if (seen === undefined) byKey.set(key, { target, embed: m[1] === '!' })
    else if (m[1] !== '!') seen.embed = false
  }
  return [...byKey.values()]
}

/**
 * Wikilink targets as plain strings, embeds included - the view every caller wants that only
 * cares WHICH pages a text names. Callers that must tell a transclusion from a link (the
 * graph's gap list) use `parseWikilinkRefs`.
 */
export function parseWikilinks(text: string): string[] {
  return parseWikilinkRefs(text).map((r) => r.target)
}

/**
 * Builds a basename → vault-relative-path index of every `wiki/**\/*.md` page. Lower-cased
 * keys for case-insensitive matching; the first occurrence wins on a collision (rare).
 */
export function indexWikiPages(vaultRoot: string): Map<string, string> {
  const index = new Map<string, string>()
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
        const key = e.name.slice(0, -3).toLowerCase()
        if (!index.has(key)) index.set(key, toPosix(path.relative(vaultRoot, abs)))
      }
    }
  }
  walk(wikiRoot)
  return index
}

/**
 * Resolves wikilink targets from an answer to vault page paths. Unresolved links are kept
 * with `path: null`. `index` may be supplied (built once per request) to avoid re-scanning.
 */
export function extractCitations(answer: string, vaultRoot: string, index?: Map<string, string>): Citation[] {
  const pages = index ?? indexWikiPages(vaultRoot)
  return parseWikilinks(answer).map((label) => ({
    label,
    path: pages.get(label.toLowerCase()) ?? null,
  }))
}
