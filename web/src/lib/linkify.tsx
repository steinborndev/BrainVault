/**
 * Turns plain text into React nodes with bare URLs and patent publication numbers made
 * clickable (SPEC.md §12.4 convenience). Used by the Markdown body renderer and the
 * frontmatter properties panel, so a `url:` field or a patent number written anywhere in a
 * source page becomes a link without the author having to write Markdown link syntax.
 *
 * Safe by construction: it only ever emits <a> elements with an href we built or validated,
 * never raw HTML — ingested content cannot inject markup.
 */

import type { ReactNode } from 'react'

/**
 * Country codes we recognize as the prefix of a patent publication number. Kept to the ones
 * that actually occur in the vault plus the major offices; a two-letter word like "US" only
 * becomes a link when immediately followed by a long digit run (see LINK_SRC + the length
 * guard), so "USB" or "US 10 patents" never match.
 */
const PATENT_CC = 'US|EP|WO|DE|CN|JP|KR|FR|GB|CA|AU|IN|CH|AT|NL|SE|IT|ES|TW|RU|BR'

/** Fewest / most digits a real publication number carries (rejects years like "US2020"). */
const PATENT_MIN_DIGITS = 6
const PATENT_MAX_DIGITS = 13

/**
 * URL first (so a patent-looking digit run INSIDE a URL is swallowed by the URL), then a
 * patent number: country code, an optional single space, a digit run (commas allowed, no
 * inner spaces — matches how the vault writes them), an optional kind code (A1/B2/…).
 */
const LINK_SRC =
  '(https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?\'"])' +
  `|(\\b(${PATENT_CC})\\s?(\\d[\\d,]*\\d)\\s?([A-C]\\d?)?\\b)`

/** Espacenet (EPO) publication-number search — official, worldwide, one scheme for every CC. */
export function espacenetUrl(publicationNumber: string): string {
  return `https://worldwide.espacenet.com/patent/search?q=pn%3D${publicationNumber}`
}

export function linkifyText(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = new RegExp(LINK_SRC, 'g') // fresh each call: a shared /g regex carries lastIndex
  let last = 0
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyBase}-lk-${i++}`
    if (m[1] !== undefined) {
      out.push(
        <a key={key} href={m[1]} target="_blank" rel="noreferrer">
          {m[1]}
        </a>,
      )
    } else {
      const cc = m[3]!
      const digits = m[4]!.replace(/,/g, '')
      const kind = (m[5] ?? '').toUpperCase()
      if (digits.length >= PATENT_MIN_DIGITS && digits.length <= PATENT_MAX_DIGITS) {
        out.push(
          <a
            key={key}
            href={espacenetUrl(`${cc}${digits}${kind}`)}
            target="_blank"
            rel="noreferrer"
            title="Open in Espacenet (EPO)"
          >
            {m[2]}
          </a>,
        )
      } else {
        out.push(m[2]!) // a country code + short number that isn't a patent — leave as text
      }
    }
    last = m.index + m[0]!.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length > 0 ? out : [text]
}
