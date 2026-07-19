/**
 * /api/v1/domains — the vault's meta-category registry and the governance loop around it
 * (SPEC.md §12.4, Meta-Kategorien Stufe 2/3).
 *
 *   GET    /domains                      the registry (installed? + parsed entries)
 *   GET    /domains/candidates           themes among `unassigned` pages big enough to
 *                                        justify a new domain — deterministic, free
 *   POST   /domains                      create a domain: append a section to the registry
 *                                        page, as ONE git commit behind the shared mutex
 *   POST   /domains/candidates/:key/dismiss    stop proposing this theme
 *   DELETE /domains/candidates/:key/dismiss    reconsider it
 *
 * Creating a domain is the one write here, and it goes through the same discipline as a user
 * page edit (CLAUDE.md hard rule 1 as amended): `commitPaths` with an exact pathspec — never
 * `commitVault`, whose `add -A` fallback could sweep a concurrent agent's half-written pages
 * into this commit — inside the shared commit mutex so it cannot interleave with an agent's.
 *
 * New domains are created HERE, by a user action, and never by an agent: that asymmetry is the
 * whole point of the registry (the ingest guardrail forbids agents coining keys).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import type { GraphBuilder } from '../../pipeline/graph.js'
import { commitPaths } from '../../pipeline/git.js'
import { Mutex } from '../../util/mutex.js'
import {
  readDomainRegistry,
  appendDomainSection,
  isValidDomainKey,
  DOMAIN_REGISTRY_PATH,
} from '../../pipeline/domains.js'
import { findDomainCandidates } from '../../pipeline/domain-candidates.js'
import type { DismissalStore } from '../../db/domain-dismissals.js'

export function registerDomainsRoute(
  app: FastifyInstance,
  ctx: AppContext,
  graph: GraphBuilder,
  dismissals: DismissalStore,
): void {
  const { config } = ctx
  const commitMutex = ctx.commitMutex ?? new Mutex()
  const autoCommit = ctx.autoCommit ?? ((): boolean => true)

  app.get('/api/v1/domains', async (_req, reply) => {
    const registry = readDomainRegistry(config.vaultRoot)
    return reply.send({
      installed: registry !== null,
      path: DOMAIN_REGISTRY_PATH,
      domains: registry?.domains ?? [],
    })
  })

  app.get('/api/v1/domains/candidates', async (_req, reply) => {
    const report = findDomainCandidates({
      graph: graph.build(),
      registry: readDomainRegistry(config.vaultRoot),
      dismissed: dismissals.keys(),
    })
    return reply.send({ ...report, dismissed: dismissals.list() })
  })

  app.post('/api/v1/domains/candidates/:key/dismiss', async (req, reply) => {
    const { key } = req.params as { key: string }
    dismissals.dismiss(key.toLowerCase())
    return reply.send({ ok: true, key: key.toLowerCase() })
  })

  app.delete('/api/v1/domains/candidates/:key/dismiss', async (req, reply) => {
    const { key } = req.params as { key: string }
    dismissals.restore(key.toLowerCase())
    return reply.send({ ok: true, key: key.toLowerCase() })
  })

  app.post('/api/v1/domains', async (req, reply) => {
    const body = (req.body ?? {}) as { key?: unknown; description?: unknown; tags?: unknown; dismissCandidate?: unknown }
    const key = typeof body.key === 'string' ? body.key.trim().toLowerCase() : ''
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean)
      : []

    if (!isValidDomainKey(key)) {
      return reply.code(400).send({ error: 'key must be lowercase letters, digits and hyphens' })
    }
    if (description === '') return reply.code(400).send({ error: 'provide a "description"' })

    const abs = path.join(config.vaultRoot, DOMAIN_REGISTRY_PATH)
    if (!fs.existsSync(abs)) {
      return reply.code(409).send({ error: `no registry at ${DOMAIN_REGISTRY_PATH}`, registryPath: DOMAIN_REGISTRY_PATH })
    }

    // Read-modify-write inside the mutex: two concurrent creates (or an agent commit landing
    // mid-write) must not be able to lose one of the sections.
    const result = await commitMutex.runExclusive(async () => {
      const markdown = fs.readFileSync(abs, 'utf8')
      const next = appendDomainSection(markdown, { key, description, tags })
      if (next === null) return { duplicate: true as const }
      fs.writeFileSync(abs, next, 'utf8')
      const commit = autoCommit()
        ? await commitPaths(config.vaultRoot, `domains: add ${key}`, [DOMAIN_REGISTRY_PATH])
        : undefined
      return { duplicate: false as const, commit }
    })

    if (result.duplicate) return reply.code(409).send({ error: `domain "${key}" already exists` })

    // A candidate that became a domain must stop being proposed. Its pages still carry
    // `unassigned` until a backfill runs, so without this the theme would reappear at once.
    if (typeof body.dismissCandidate === 'string' && body.dismissCandidate.trim() !== '') {
      dismissals.dismiss(body.dismissCandidate.trim().toLowerCase())
    }

    return reply.send({
      ok: true,
      key,
      path: DOMAIN_REGISTRY_PATH,
      commit: result.commit?.hash ?? null,
      committed: result.commit?.committed ?? false,
    })
  })
}
