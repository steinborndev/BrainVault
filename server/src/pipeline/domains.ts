/**
 * The domain registry (SPEC.md §12.4, Meta-Kategorien Stufe 2) — the list of meta-categories
 * pages may be filed under, read from the vault page `wiki/meta/domains.md`.
 *
 * The registry lives in the VAULT, not in this repo or SQLite, and that is deliberate: it is
 * git-versioned with the content it describes, editable in the dashboard's own page editor,
 * and readable by an agent run without any extra plumbing. `scripts/vault-extensions/domains.md`
 * holds the seed copy that `scripts/install-domain-registry.sh` installs; once installed, the
 * vault's copy is the source of truth and this module only ever READS it (hard rule 1).
 *
 * Absent registry = feature off, not an error: ingest runs then get no domain instruction and
 * the backfill refuses to run. That keeps a fresh checkout working before setup.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Vault-relative location of the registry page. */
export const DOMAIN_REGISTRY_PATH = 'wiki/meta/domains.md'

/** The sentinel a page carries when no domain in the registry fits it. */
export const UNASSIGNED = 'unassigned'

export interface DomainEntry {
  /** The key written into a page's `domain:` frontmatter, e.g. `biomedicine`. */
  readonly key: string
  /** First prose paragraph under the heading — what the domain covers. */
  readonly description: string
  /** Tags listed as classification guidance (lowercased, deduped). */
  readonly tags: readonly string[]
}

export interface DomainRegistry {
  readonly domains: readonly DomainEntry[]
  /** Where it was read from (vault-relative), for diagnostics. */
  readonly path: string
}

/**
 * Parses the registry page. The format is prose-first so the page stays readable and
 * hand-editable: each domain is an `## <key>` section under the `## Domains` marker, with an
 * optional `**Tags:** \`a\`, \`b\`` line. Everything above `## Domains` is documentation for
 * the human and is skipped — that is why the marker exists.
 */
export function parseDomainRegistry(markdown: string, from: string = DOMAIN_REGISTRY_PATH): DomainRegistry {
  // Body only: a `## Domains` line inside the frontmatter block would be nonsense, but
  // stripping frontmatter first also keeps a `related:` list from ever being read as prose.
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const marker = body.search(/^##[ \t]+Domains[ \t]*$/m)
  if (marker < 0) return { domains: [], path: from }

  const after = body.slice(marker).split(/\r?\n/).slice(1) // drop the marker line itself
  const domains: DomainEntry[] = []
  const seen = new Set<string>()
  let current: { key: string; description: string[]; tags: string[]; descDone: boolean; inTags: boolean } | null = null

  const flush = (): void => {
    if (!current) return
    // A duplicated key would silently shadow; first definition wins, like wikilink resolution.
    if (!seen.has(current.key)) {
      seen.add(current.key)
      domains.push({
        key: current.key,
        description: current.description.join(' ').trim(),
        tags: [...new Set(current.tags)],
      })
    }
    current = null
  }

  for (const line of after) {
    const heading = line.match(/^##[ \t]+(.+?)[ \t]*$/)
    if (heading) {
      flush()
      const key = heading[1]!.trim().toLowerCase()
      // Only registry-shaped keys start a domain; a prose subheading ("How this works") can't.
      current = /^[a-z0-9][a-z0-9-]*$/.test(key)
        ? { key, description: [], tags: [], descDone: false, inTags: false }
        : null
      continue
    }
    if (!current) continue
    const tagLine = line.match(/^\*\*Tags:\*\*[ \t]*(.*)$/)
    if (tagLine) {
      for (const m of tagLine[1]!.matchAll(/`([^`]+)`/g)) current.tags.push(m[1]!.trim().toLowerCase())
      current.descDone = true
      current.inTags = true
      continue
    }
    // Description is the LEAD paragraph only: the first blank line after prose closes it, so
    // a section may carry further notes for the human without bloating the agent instruction.
    if (line.trim() === '') {
      if (current.description.length > 0) current.descDone = true
      current.inTags = false
      continue
    }
    // A long tag list wraps across lines; keep collecting until a blank line ends it. Without
    // this, everything past the first wrap is silently dropped (found in a live vault, where
    // the seed registry's 12-tag domains arrived with 4).
    if (current.inTags) {
      for (const m of line.matchAll(/`([^`]+)`/g)) current.tags.push(m[1]!.trim().toLowerCase())
      continue
    }
    if (!current.descDone) current.description.push(line.trim())
  }
  flush()

  return { domains, path: from }
}

/** Reads and parses the registry, or returns null when the vault has none installed. */
export function readDomainRegistry(vaultRoot: string): DomainRegistry | null {
  const abs = path.join(vaultRoot, DOMAIN_REGISTRY_PATH)
  let markdown: string
  try {
    markdown = fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
  const registry = parseDomainRegistry(markdown)
  return registry.domains.length > 0 ? registry : null
}

/** A registry key: lowercase, hyphenated, no spaces — same shape the parser accepts. */
export const isValidDomainKey = (key: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(key)

/**
 * Appends a new domain section to the registry markdown, in the same shape the seed uses so a
 * grown registry stays indistinguishable from a hand-written one.
 *
 * Returns null when the key already exists (the caller turns that into a 409) — adding a
 * duplicate would silently shadow, since the parser lets the first definition win.
 */
export function appendDomainSection(
  markdown: string,
  entry: { key: string; description: string; tags: readonly string[] },
): string | null {
  const existing = parseDomainRegistry(markdown)
  if (existing.domains.some((d) => d.key === entry.key)) return null

  const tagLine =
    entry.tags.length > 0 ? `\n\n**Tags:** ${entry.tags.map((t) => `\`${t}\``).join(', ')}` : ''
  const section = `\n## ${entry.key}\n\n${entry.description.trim()}${tagLine}\n`
  // Exactly one blank line between sections, whatever trailing whitespace the file had.
  return `${markdown.replace(/\s*$/, '')}\n${section}`
}

/**
 * The system-prompt extension handed to vault-writing runs, or '' when no registry exists.
 *
 * This is the guardrail that stops the drift Stufe 1 measured: the agent may only pick a
 * listed key or `unassigned`, and explicitly may NOT coin a new one. New domains are a human
 * decision made by editing the registry page (SPEC.md §12.4 Stufe 3).
 */
export function domainSystemPrompt(registry: DomainRegistry | null): string {
  if (!registry || registry.domains.length === 0) return ''
  const list = registry.domains
    .map((d) => {
      const tags = d.tags.length > 0 ? `\n  typical tags: ${d.tags.join(', ')}` : ''
      return `- ${d.key} — ${d.description}${tags}`
    })
    .join('\n')
  return `
<domain_registry>
Every wiki page you create or substantially rewrite must carry a \`domain:\` field in its
YAML frontmatter, holding EXACTLY ONE key from this closed list:

${list}
- ${UNASSIGNED} — nothing above fits this page.

Rules:
- Never invent a domain key that is not on this list. If no listed domain fits, use
  \`${UNASSIGNED}\`. That is a correct, expected outcome, not a failure — new domains are
  added by a human editing ${DOMAIN_REGISTRY_PATH}, never by an ingest run.
- The tag hints are guidance, not a lookup table. Classify by what the page is ABOUT.
- Ignore entity-shaped tags (person, organization, product, researcher) when classifying:
  they describe what a page IS, not what it is about.
- The field goes on EVERY page type — sources and entities too, not just concepts. Filtering
  the graph by domain is the point, and it only works if every page carries one.
- Set \`domain:\` on pages you create. Do not retrofit unrelated existing pages in an ingest
  run; a separate backfill handles those.
</domain_registry>
`.trim()
}
