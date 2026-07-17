/**
 * Web-shortcut files → URL jobs. A dropped `.url` (Windows) or `.webloc` (macOS) is not
 * content to ingest but a pointer to a web page, so the pipeline unwraps it and treats it
 * as a URL job — the same spirit as the Obsidian Web Clipper `.md` handling (SPEC.md §4.2).
 */

import fs from 'node:fs'
import path from 'node:path'

/** Extensions that are pointers to a URL rather than ingestible content. */
const SHORTCUT_EXTS = new Set(['url', 'webloc'])

export function isShortcut(fileName: string): boolean {
  return SHORTCUT_EXTS.has(path.extname(fileName).toLowerCase().replace(/^\./, ''))
}

/**
 * Reads the target URL from a `.url` (INI `URL=`) or `.webloc` (plist `<string>`) file.
 * Returns undefined when no http(s) URL is found.
 */
export function readShortcutUrl(filePath: string): string | undefined {
  const text = fs.readFileSync(filePath, 'utf8')
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.url') {
    const m = text.match(/^\s*URL\s*=\s*(\S+)\s*$/im)
    if (m && /^https?:\/\//i.test(m[1]!)) return m[1]
  }
  // .webloc (and as a fallback for any shortcut): first http(s) URL in a plist <string>.
  const s = text.match(/<string>\s*(https?:\/\/[^<\s]+)\s*<\/string>/i)
  if (s) return s[1]
  // Last resort: any bare http(s) URL in the file.
  const bare = text.match(/https?:\/\/[^\s"'<>]+/i)
  return bare ? bare[0] : undefined
}
