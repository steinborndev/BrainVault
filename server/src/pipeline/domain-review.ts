/**
 * Parses the optional agent judgement on domain candidates (SPEC.md §12.4 Stufe 3).
 *
 * The deterministic finder decides WHICH themes are big enough to consider; this pass decides
 * whether each one is real. The agent answers in a fixed block-per-candidate shape and we parse
 * its final message directly — deliberately NOT via a file in the vault (unlike the lint
 * report): a proposal is transient operational advice, not wiki content, and writing it into
 * the vault would leave litter every time the user says "no".
 *
 * The parse is lenient, like the lint parser: a block missing a field still yields whatever it
 * has, and text that drifts from the template yields no verdicts rather than throwing — the UI
 * then falls back to showing the agent's prose.
 */

/** What the agent concluded about one candidate. */
export type DomainVerdict =
  /** A genuine new domain; `key`/`description`/`tags` carry the proposal. */
  | 'new-domain'
  /** These pages belong in an existing domain; `existing` names it. */
  | 'existing'
  /** Not a coherent theme — pages merely share a label. */
  | 'not-a-domain'

export interface DomainReviewEntry {
  /** The candidate key this block judges (matches DomainCandidate.key). */
  readonly candidate: string
  readonly verdict: DomainVerdict
  /** Proposed registry key for a `new-domain` verdict (may differ from the candidate tag). */
  readonly key?: string
  readonly description?: string
  readonly tags?: readonly string[]
  /** The domain to file under, for an `existing` verdict. */
  readonly existing?: string
  readonly reason?: string
}

export interface DomainReview {
  readonly entries: readonly DomainReviewEntry[]
}

const VERDICTS: Record<string, DomainVerdict> = {
  'new-domain': 'new-domain',
  existing: 'existing',
  'not-a-domain': 'not-a-domain',
}

/** The response shape the agent is asked to produce; kept next to the parser that reads it. */
export const DOMAIN_REVIEW_FORMAT = [
  'Answer with ONE block per candidate, nothing else — no preamble, no closing summary:',
  '',
  '## <candidate key, exactly as given>',
  'verdict: new-domain | existing | not-a-domain',
  'key: <proposed registry key, lowercase-hyphenated>   (only for new-domain)',
  'description: <one sentence describing what the domain covers>   (only for new-domain)',
  'tags: <comma-separated tags for the registry entry>   (only for new-domain)',
  'existing: <registry key these pages belong to>   (only for existing)',
  'reason: <one or two sentences justifying the verdict>',
].join('\n')

export function parseDomainReview(text: string): DomainReview {
  const entries: DomainReviewEntry[] = []
  const lines = text.split(/\r?\n/)
  let current: { candidate: string; fields: Map<string, string> } | null = null

  const flush = (): void => {
    if (!current) return
    const f = current.fields
    const verdict = VERDICTS[(f.get('verdict') ?? '').toLowerCase().trim()]
    // A block without a recognisable verdict is noise (a stray heading in prose), not an entry.
    if (verdict !== undefined) {
      const tags = f.get('tags')
      entries.push({
        candidate: current.candidate,
        verdict,
        ...(f.get('key') ? { key: f.get('key')!.toLowerCase() } : {}),
        ...(f.get('description') ? { description: f.get('description')! } : {}),
        ...(tags
          ? {
              tags: tags
                .split(',')
                .map((t) => t.trim().replace(/^`|`$/g, '').toLowerCase())
                .filter((t) => t !== ''),
            }
          : {}),
        ...(f.get('existing') ? { existing: f.get('existing')!.toLowerCase() } : {}),
        ...(f.get('reason') ? { reason: f.get('reason')! } : {}),
      })
    }
    current = null
  }

  for (const line of lines) {
    const heading = line.match(/^##+[ \t]+(.+?)[ \t]*$/)
    if (heading) {
      flush()
      current = { candidate: heading[1]!.trim().toLowerCase(), fields: new Map() }
      continue
    }
    if (!current) continue
    const field = line.match(/^[ \t]*([a-zA-Z-]+)[ \t]*:[ \t]*(.*)$/)
    if (field) {
      const value = field[2]!.trim()
      if (value !== '') current.fields.set(field[1]!.toLowerCase(), value)
    }
  }
  flush()

  return { entries }
}
