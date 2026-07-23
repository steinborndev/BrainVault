/**
 * Maintenance API (SPEC.md §6.4, §6.5): lint, autoresearch, hot-cache refresh. Each is a
 * vault-mutating agent run. Runs are ASYNC/job-style (TASKS-M5 §0): the POST registers a run
 * and returns `202 { id, channel, status: 'running' }` immediately — it does NOT hold the
 * request for the (up to 15-min) run, so a slow or stuck run can never wedge the HTTP request.
 * The run streams a live log over the event bus on its `channel` (`maintenance:<kind>`), which
 * the Wartung tab renders; the client polls `GET /maintenance/runs/:id` for the final result.
 * Runs are serialized (one vault writer) and share the ingest commit mutex.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AppContext } from '../server.js'
import type { GraphBuilder } from '../../pipeline/graph.js'
import type { DismissalStore } from '../../db/domain-dismissals.js'
import { DomainRegistryMissingError, LintReportMissingError, type RepairTask } from '../../pipeline/maintenance.js'
import { RetrieveScriptsMissingError, retrieveIndexStats } from '../../pipeline/retrieve-index.js'
import { readDomainRegistry, DOMAIN_REGISTRY_PATH } from '../../pipeline/domains.js'
import { findDomainCandidates } from '../../pipeline/domain-candidates.js'
import {
  researchProfileList,
  isResearchProfileKey,
  DEFAULT_PROFILE_KEY,
} from '../../pipeline/research-profiles.js'

export function registerMaintenanceRoute(
  app: FastifyInstance,
  ctx: AppContext,
  graph?: GraphBuilder,
  dismissals?: DismissalStore,
): void {
  const { maintenance } = ctx

  /** Setup mode (no credential): every run-starting POST answers 503 instead of spawning. */
  const credentialMissing = (reply: FastifyReply): boolean => {
    if (ctx.config.auth !== null) return false
    void reply.code(503).send({
      error: 'no Anthropic credential configured — add it under Maintenance → Settings, then restart',
    })
    return true
  }

  app.post('/api/v1/maintenance/lint', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    return reply.code(202).send(maintenance.startLint())
  })

  // Fix the newest lint report's SAFE findings (the skill's own safe/needs-review split).
  // 409 without a report — the report is what bounds the run.
  app.post('/api/v1/maintenance/lint-fix', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    try {
      return reply.code(202).send(maintenance.startLintFix())
    } catch (err) {
      if (err instanceof LintReportMissingError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.post('/api/v1/maintenance/hot-cache', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    return reply.code(202).send(maintenance.startHotCache())
  })

  /**
   * Reference cleanup after user deletions (the delete flow's follow-up offer): a bounded
   * agent run over the dangling references the named deletions left behind. Titles are
   * attacker-adjacent input that ends up in a prompt — enforce shape and size hard.
   */
  app.post('/api/v1/maintenance/cleanup', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    const body = (req.body ?? {}) as { pages?: unknown }
    const raw = Array.isArray(body.pages) ? body.pages : []
    const pages = raw
      .filter((p): p is string => typeof p === 'string')
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p !== '' && p.length <= 200)
      .slice(0, 20)
    if (pages.length === 0) {
      return reply.code(400).send({ error: 'provide "pages": the deleted page titles to clean up after' })
    }
    return reply.code(202).send(maintenance.startReferenceCleanup(pages))
  })

  /**
   * Graph repair (the explorer panel's "Repair" action): a bounded agent run over
   * user-selected connectivity problems. Task paths are attacker-adjacent input headed for
   * a prompt — every path must name a page in the LIVE graph (no free-text targets), any
   * invalid task rejects the whole request (the user selected specific things; silently
   * dropping one would repair less than they asked), and free-text reasons are size-capped.
   */
  app.post('/api/v1/maintenance/repair', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    if (graph === undefined) return reply.code(409).send({ error: 'graph unavailable' })
    const known = new Set(graph.build().nodes.map((n) => n.path))
    const clean = (v: unknown, max: number): string | undefined => {
      if (typeof v !== 'string') return undefined
      const s = v.replace(/\s+/g, ' ').trim()
      return s !== '' && s.length <= max ? s : undefined
    }
    const body = (req.body ?? {}) as { tasks?: unknown }
    const raw = Array.isArray(body.tasks) ? body.tasks : []
    if (raw.length === 0 || raw.length > 10) {
      return reply.code(400).send({ error: 'provide "tasks": 1-10 repair tasks' })
    }
    const tasks: RepairTask[] = []
    for (const item of raw) {
      const t = (item ?? {}) as Record<string, unknown>
      const reason = clean(t['reason'], 200)
      if (t['kind'] === 'connect') {
        const path = clean(t['path'], 300)
        if (path === undefined || !known.has(path)) {
          return reply.code(400).send({ error: `connect task names no known wiki page: ${String(t['path'])}` })
        }
        tasks.push({ kind: 'connect', path, ...(reason ? { reason } : {}) })
      } else if (t['kind'] === 'edge') {
        const from = clean(t['from'], 300)
        const to = clean(t['to'], 300)
        if (from === undefined || !known.has(from) || to === undefined || !known.has(to)) {
          return reply.code(400).send({ error: `edge task names an unknown wiki page: ${String(t['from'])} -> ${String(t['to'])}` })
        }
        tasks.push({ kind: 'edge', from, to, ...(reason ? { reason } : {}) })
      } else {
        return reply.code(400).send({ error: 'each task needs kind "connect" or "edge"' })
      }
    }
    return reply.code(202).send(maintenance.startGraphRepair(tasks))
  })

  // The domain backfill (SPEC.md §12.4 Stufe 2). 409 when no registry is installed — the
  // action is meaningless without the closed list it files against.
  app.post('/api/v1/maintenance/domain-backfill', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    try {
      return reply.code(202).send(maintenance.startDomainBackfill())
    } catch (err) {
      if (err instanceof DomainRegistryMissingError) {
        return reply.code(409).send({ error: err.message, registryPath: DOMAIN_REGISTRY_PATH })
      }
      throw err
    }
  })

  /**
   * The OPTIONAL agent pass over the deterministic candidates (SPEC.md §12.4 Stufe 3). The
   * candidates are recomputed here rather than taken from the client, so a stale browser tab
   * cannot make the agent judge themes that no longer exist. 409 when there is nothing to judge.
   */
  app.post('/api/v1/maintenance/domain-review', async (_req, reply) => {
    if (credentialMissing(reply)) return reply
    if (graph === undefined) return reply.code(409).send({ error: 'graph unavailable' })
    const { candidates } = findDomainCandidates({
      graph: graph.build(),
      registry: readDomainRegistry(ctx.config.vaultRoot),
      dismissed: dismissals?.keys() ?? new Set<string>(),
    })
    if (candidates.length === 0) {
      return reply.code(409).send({ error: 'no domain candidates to review' })
    }
    return reply.code(202).send(maintenance.startDomainReview(candidates))
  })

  // The closed lens list for the composer's profile picker ("Achse A"). Static — served so the
  // UI never hardcodes what the service accepts, and the POST below validates against the same set.
  app.get('/api/v1/maintenance/research/profiles', async (_req, reply) => {
    return reply.send({ profiles: researchProfileList(), default: DEFAULT_PROFILE_KEY })
  })

  app.post('/api/v1/maintenance/research', async (req, reply) => {
    if (credentialMissing(reply)) return reply
    const body = (req.body ?? {}) as { topic?: unknown; profileKey?: unknown }
    const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
    if (topic === '') return reply.code(400).send({ error: 'provide a non-empty "topic"' })
    // A lens is optional (omit → default "broad"), but a PROVIDED one must be on the closed list:
    // free-text lenses are exactly the free-for-all the closed set exists to prevent.
    let profileKey: string | undefined
    if (body.profileKey !== undefined) {
      if (typeof body.profileKey !== 'string' || !isResearchProfileKey(body.profileKey)) {
        return reply.code(400).send({ error: `unknown research profile: ${String(body.profileKey)}` })
      }
      profileKey = body.profileKey
    }
    return reply.code(202).send(maintenance.startResearch(topic, profileKey))
  })

  /**
   * Deterministic retrieval-index rebuild (SPEC.md §12.6). Deliberately NOT gated on the
   * credential: no agent runs, so it works in setup mode too. First run provisions.
   * 409 when the vault clone predates the wiki-retrieve skill (no scripts to run).
   */
  app.post('/api/v1/maintenance/retrieve-index', async (_req, reply) => {
    try {
      return reply.code(202).send(maintenance.startRetrieveIndex())
    } catch (err) {
      if (err instanceof RetrieveScriptsMissingError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  // Index status for the Maintenance-tab card: provisioned?, chunk count, index age.
  app.get('/api/v1/maintenance/retrieve-index', async (_req, reply) => {
    return reply.send(retrieveIndexStats(ctx.config.vaultRoot))
  })

  // Poll a run's state/result. Returns 404 once the run has been evicted from history.
  app.get('/api/v1/maintenance/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = maintenance.getRun(id)
    if (!run) return reply.code(404).send({ error: 'unknown maintenance run' })
    return reply.send(run)
  })

  // Recent runs, newest first — lets the UI restore state after a reload.
  app.get('/api/v1/maintenance/runs', async (_req, reply) => {
    return reply.send({ runs: maintenance.listRuns() })
  })
}
