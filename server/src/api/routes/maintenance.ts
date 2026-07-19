/**
 * Maintenance API (SPEC.md §6.4, §6.5): lint, autoresearch, hot-cache refresh. Each is a
 * vault-mutating agent run. Runs are ASYNC/job-style (TASKS-M5 §0): the POST registers a run
 * and returns `202 { id, channel, status: 'running' }` immediately — it does NOT hold the
 * request for the (up to 15-min) run, so a slow or stuck run can never wedge the HTTP request.
 * The run streams a live log over the event bus on its `channel` (`maintenance:<kind>`), which
 * the Wartung tab renders; the client polls `GET /maintenance/runs/:id` for the final result.
 * Runs are serialized (one vault writer) and share the ingest commit mutex.
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import type { GraphBuilder } from '../../pipeline/graph.js'
import type { DismissalStore } from '../../db/domain-dismissals.js'
import { DomainRegistryMissingError } from '../../pipeline/maintenance.js'
import { readDomainRegistry, DOMAIN_REGISTRY_PATH } from '../../pipeline/domains.js'
import { findDomainCandidates } from '../../pipeline/domain-candidates.js'

export function registerMaintenanceRoute(
  app: FastifyInstance,
  ctx: AppContext,
  graph?: GraphBuilder,
  dismissals?: DismissalStore,
): void {
  const { maintenance } = ctx

  app.post('/api/v1/maintenance/lint', async (_req, reply) => {
    return reply.code(202).send(maintenance.startLint())
  })

  app.post('/api/v1/maintenance/hot-cache', async (_req, reply) => {
    return reply.code(202).send(maintenance.startHotCache())
  })

  // The domain backfill (SPEC.md §12.4 Stufe 2). 409 when no registry is installed — the
  // action is meaningless without the closed list it files against.
  app.post('/api/v1/maintenance/domain-backfill', async (_req, reply) => {
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

  app.post('/api/v1/maintenance/research', async (req, reply) => {
    const body = (req.body ?? {}) as { topic?: unknown }
    const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
    if (topic === '') return reply.code(400).send({ error: 'provide a non-empty "topic"' })
    return reply.code(202).send(maintenance.startResearch(topic))
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
