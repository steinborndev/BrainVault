/**
 * Splitting YAML frontmatter off a page body.
 *
 * Lifted out of the vault viewer (2026-08-26) so the research run detail can render a
 * synthesis page with the same rule. Two copies of "where does the body start" is how they
 * end up disagreeing about a page that has no frontmatter, or one that is malformed.
 */

/**
 * Splits YAML frontmatter off a page. Obsidian renders it as a properties panel rather than
 * body text, and so do we - dumping `type: concept created: …` into the prose is just noise.
 * Deliberately shallow (top-level `key: value` and `- item` lists); anything it can't read
 * stays in the body rather than being silently dropped.
 */
export function frontmatter(markdown: string): { fields: Array<[string, string]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (!m) return { fields: [], body: markdown }
  const fields: Array<[string, string]> = []
  let currentKey: string | null = null
  let listItems: string[] = []
  const flush = (): void => {
    if (currentKey !== null && listItems.length > 0) fields.push([currentKey, listItems.join(', ')])
    listItems = []
  }
  for (const line of m[1]!.split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && currentKey !== null) {
      listItems.push(item[1]!.replace(/^["']|["']$/g, '').trim())
      continue
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    flush()
    const key = kv[1]!
    const value = kv[2]!.replace(/^["']|["']$/g, '').trim()
    if (value === '') {
      currentKey = key // a list or block follows
    } else {
      fields.push([key, value])
      currentKey = null
    }
  }
  flush()
  return { fields, body: markdown.slice(m[0].length) }
}
