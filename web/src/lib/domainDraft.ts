/**
 * Deterministic draft description for a domain candidate (SPEC §12.7 Stufe a): the create
 * form must never start with an empty description — writing an extensible one from nothing
 * is the hardest part of the flow, and the deterministic finder knows enough (key + member
 * tags) for a usable first draft. An agent-review proposal, when present, always wins over
 * this; the draft is the floor, not the ceiling.
 *
 * Wording follows the registry's own conventions page: broad on purpose ("a shelf, not a
 * book"), so the domain stays extensible as adjacent pages arrive.
 */

/** How many member tags beyond the key itself the draft names as examples. */
const MAX_EXAMPLE_TAGS = 3

export function draftDomainDescription(candidate: { key: string; tags: readonly string[] }): string {
  const label = candidate.key.replace(/[-_]+/g, ' ').trim()
  const topic = label.charAt(0).toUpperCase() + label.slice(1)
  const examples = candidate.tags.filter((t) => t !== candidate.key).slice(0, MAX_EXAMPLE_TAGS)
  const scope =
    examples.length > 0
      ? `including ${examples.join(', ')}`
      : 'methods, tools, entities and applications'
  return (
    `${topic} and closely related work - ${scope}. ` +
    `Kept deliberately broad (a shelf, not a book) so future pages on adjacent topics file here too.`
  )
}
