/**
 * Parses the `wiki-lint` skill's report (`wiki/meta/lint-report-YYYY-MM-DD.md`) into
 * structured JSON for the Wartung tab (SPEC.md §6.4, TASKS-M4 §2). The skill writes a fixed
 * markdown shape — a `## Summary` block of counts followed by one `## <Category>` section
 * per check (Orphan Pages, Dead Links, Missing Pages, Frontmatter Gaps, Stale Claims,
 * Cross-Reference Gaps), each a bullet list. We turn that into groups of findings, each with
 * its primary `[[Page]]` resolved to a vault path so the UI can link it.
 *
 * The parse is lenient: unknown sections are kept as-is, and a report that drifts from the
 * template still yields whatever sections it does have rather than failing.
 */

import { parseWikilinks, type Citation } from './citations.js'

export interface LintFinding {
  /** The raw bullet text (minus the leading `- `). */
  readonly text: string
  /** The first wikilink in the finding, resolved to a page path (or null). */
  readonly page: Citation | null
}

export interface LintSection {
  readonly title: string
  readonly findings: LintFinding[]
}

export interface LintReport {
  /** `YYYY-MM-DD` from the report heading, or null if absent. */
  readonly date: string | null
  /** Summary counts, e.g. { "Pages scanned": 94, "Issues found": 3 }. */
  readonly summary: Record<string, number>
  readonly sections: LintSection[]
  /** Total findings across all non-summary sections. */
  readonly totalFindings: number
}

/**
 * @param markdown the report file contents
 * @param resolve  maps a page label to a Citation (label→path); typically closed over the
 *                 wiki page index so the parser stays pure/testable.
 */
export function parseLintReport(markdown: string, resolve: (label: string) => Citation): LintReport {
  const lines = markdown.split('\n')
  const dateMatch = markdown.match(/^#\s+Lint Report:?\s*(\d{4}-\d{2}-\d{2})/m)
  const date = dateMatch ? dateMatch[1]! : null

  const summary: Record<string, number> = {}
  const sections: LintSection[] = []
  let current: { title: string; findings: LintFinding[] } | null = null
  let inSummary = false

  const flush = (): void => {
    if (current) sections.push(current)
    current = null
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const h2 = /^##\s+(.*)$/.exec(line)
    if (h2) {
      flush()
      const title = h2[1]!.trim()
      if (/^summary$/i.test(title)) {
        inSummary = true
      } else {
        inSummary = false
        current = { title, findings: [] }
      }
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (!bullet) continue
    const text = bullet[1]!.trim()

    if (inSummary) {
      // "- Pages scanned: 94" → summary["Pages scanned"] = 94
      const kv = /^(.+?):\s*(\d+)\s*$/.exec(text)
      if (kv) summary[kv[1]!.trim()] = Number(kv[2])
      continue
    }

    if (current) {
      const firstLink = parseWikilinks(text)[0]
      current.findings.push({ text, page: firstLink ? resolve(firstLink) : null })
    }
  }
  flush()

  const totalFindings = sections.reduce((n, s) => n + s.findings.length, 0)
  return { date, summary, sections, totalFindings }
}
