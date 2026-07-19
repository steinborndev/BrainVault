/**
 * Domain registry tests (SPEC.md §12.4 Stufe 2): parsing the vault's `wiki/meta/domains.md`,
 * the system-prompt extension it produces, and the backfill's refusal to run without one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseDomainRegistry,
  readDomainRegistry,
  domainSystemPrompt,
  DOMAIN_REGISTRY_PATH,
  UNASSIGNED,
} from '../src/pipeline/domains.js'
import { MaintenanceRunner, DomainRegistryMissingError } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import { IngestQueue, type IngestRunner } from '../src/pipeline/queue.js'
import { JobStore } from '../src/db/jobs.js'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'

const REGISTRY = `---
type: meta
title: "Domain Registry"
tags:
  - meta
---

# Domain Registry

Prose the parser must ignore, including a decoy heading below.

## How a new domain is born

Five or more coherent pages. This section is documentation, not a domain.

## Domains

## biomedicine

Biology, medicine and drug delivery.

Further notes for the human that must NOT reach the agent instruction.

**Tags:** \`mrna-delivery\`, \`biomedical\`, \`Drug-Delivery\`, \`mrna-delivery\`

## finance

Money and markets.

**Tags:** \`german-finance\`, \`investment-funds\`,
\`banking\`, \`regulation\`,
\`securities\`

## meta

The wiki's own machinery.
`

let vaultRoot: string
beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-vault-'))
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
})
afterEach(() => fs.rmSync(vaultRoot, { recursive: true, force: true }))

describe('parseDomainRegistry', () => {
  it('reads keys, lead-paragraph descriptions and deduped lowercase tags', () => {
    const reg = parseDomainRegistry(REGISTRY)
    expect(reg.domains.map((d) => d.key)).toEqual(['biomedicine', 'finance', 'meta'])

    const bio = reg.domains[0]!
    expect(bio.description).toBe('Biology, medicine and drug delivery.')
    expect(bio.description).not.toContain('Further notes') // lead paragraph only
    expect(bio.tags).toEqual(['mrna-delivery', 'biomedical', 'drug-delivery']) // deduped, lowercased
    expect(reg.domains[2]!.tags).toEqual([]) // a domain may list no tags
  })

  it('collects a tag list that wraps across lines', () => {
    // Regression: the first live registry had 12-tag domains wrapped over three lines and
    // arrived with 4 — everything past the `**Tags:**` line itself was dropped.
    const finance = parseDomainRegistry(REGISTRY).domains.find((d) => d.key === 'finance')!
    expect(finance.tags).toEqual(['german-finance', 'investment-funds', 'banking', 'regulation', 'securities'])
  })

  it('stops collecting tags at the blank line, so the next section is unaffected', () => {
    const reg = parseDomainRegistry(
      '## Domains\n\n## a\n\ndesc a\n\n**Tags:** `x`,\n`y`\n\nTrailing prose with `not-a-tag`.\n\n## b\n\ndesc b\n',
    )
    expect(reg.domains[0]!.tags).toEqual(['x', 'y'])
    expect(reg.domains.map((d) => d.key)).toEqual(['a', 'b'])
  })

  it('ignores everything above the "## Domains" marker', () => {
    // "How a new domain is born" sits above the marker and is registry-key-shaped enough to
    // be a trap; it must not become a domain.
    expect(parseDomainRegistry(REGISTRY).domains.map((d) => d.key)).not.toContain('how a new domain is born')
  })

  it('returns no domains when the marker is missing, and ignores prose subheadings after it', () => {
    expect(parseDomainRegistry('# Nothing here\n\n## biomedicine\n\ntext').domains).toEqual([])
    const reg = parseDomainRegistry('## Domains\n\n## Not A Key\n\ntext\n\n## ok-key\n\ndesc\n')
    expect(reg.domains.map((d) => d.key)).toEqual(['ok-key'])
  })

  it('lets the first definition win when a key is duplicated', () => {
    const reg = parseDomainRegistry('## Domains\n\n## dup\n\nfirst\n\n## dup\n\nsecond\n')
    expect(reg.domains).toHaveLength(1)
    expect(reg.domains[0]!.description).toBe('first')
  })
})

describe('readDomainRegistry', () => {
  it('returns null when the vault has no registry, and the parsed registry when it does', () => {
    expect(readDomainRegistry(vaultRoot)).toBeNull()
    fs.writeFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), REGISTRY)
    expect(readDomainRegistry(vaultRoot)?.domains).toHaveLength(3)
  })

  it('treats an empty (marker-less) registry as absent', () => {
    fs.writeFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), '# Empty\n\nno domains here\n')
    expect(readDomainRegistry(vaultRoot)).toBeNull()
  })
})

describe('domainSystemPrompt', () => {
  it('is empty without a registry, so runs behave exactly as before the feature', () => {
    expect(domainSystemPrompt(null)).toBe('')
    expect(domainSystemPrompt({ domains: [], path: DOMAIN_REGISTRY_PATH })).toBe('')
  })

  it('lists every key plus the unassigned escape hatch and forbids inventing keys', () => {
    const prompt = domainSystemPrompt(parseDomainRegistry(REGISTRY))
    expect(prompt).toContain('- biomedicine — Biology, medicine and drug delivery.')
    expect(prompt).toContain('typical tags: mrna-delivery, biomedical, drug-delivery')
    expect(prompt).toContain(`- ${UNASSIGNED} —`)
    expect(prompt).toContain('Never invent a domain key')
    expect(prompt).toContain(DOMAIN_REGISTRY_PATH)
  })
})

describe('ingest runs receive the registry', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => db.close())

  /** Runs one file through the queue and returns the systemPromptExtra the runner saw. */
  async function ingestOnce(): Promise<string | undefined> {
    let seen: string | undefined
    const runIngest: IngestRunner = async (opts) => {
      seen = opts.systemPromptExtra
      return {
        ok: true,
        result: 'done',
        usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
        messages: [],
        durationMs: 1,
        numTurns: 1,
        sessionId: 'test-session',
        timedOut: false,
      }
    }
    const queue = new IngestQueue({
      store: new JobStore(db),
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 1,
      detectToolsFn: async () => ({}) as never,
      commit: async () => ({ committed: true, hash: 'abc', committedPages: [] }),
      refreshHotCache: async () => '',
      runIngest,
    })
    queue.start()
    const src = path.join(vaultRoot, 'note.md')
    fs.writeFileSync(src, 'hello')
    await queue.enqueueFile({ sourcePath: src, source: 'drop' })
    await queue.onIdle()
    queue.stop()
    return seen
  }

  it('passes the domain rules when a registry exists', async () => {
    fs.writeFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), REGISTRY)
    const extra = await ingestOnce()
    expect(extra).toContain('<domain_registry>')
    expect(extra).toContain('biomedicine')
    expect(extra).toContain(UNASSIGNED)
  })

  it('passes nothing when the vault has no registry', async () => {
    expect(await ingestOnce()).toBe('')
  })
})

describe('domain backfill guard', () => {
  const runner = (): MaintenanceRunner =>
    new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      // Never reached in these tests: the guard throws before any agent work.
      runAgent: async () => {
        throw new Error('agent must not run without a registry')
      },
    })

  it('refuses to start without a registry', () => {
    expect(() => runner().startDomainBackfill()).toThrow(DomainRegistryMissingError)
    expect(() => runner().startDomainBackfill()).toThrow(/install it/)
  })

  it('starts a tracked run once a registry exists', () => {
    fs.writeFileSync(path.join(vaultRoot, DOMAIN_REGISTRY_PATH), REGISTRY)
    const run = runner().startDomainBackfill()
    expect(run.kind).toBe('domain-backfill')
    expect(run.channel).toBe('maintenance:domain-backfill')
    expect(run.status).toBe('running')
  })
})
