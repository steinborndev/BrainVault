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

/**
 * Pulls unique wikilink targets from `[[Page]]`, `[[Page|Alias]]`, and `[[Page#Heading]]`.
 * Returns the target (the part before `|` or `#`), trimmed, first-seen order preserved.
 */
export function parseWikilinks(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const re = /\[\[([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const target = m[1]!.split('|')[0]!.split('#')[0]!.trim()
    if (target === '') continue
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
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
