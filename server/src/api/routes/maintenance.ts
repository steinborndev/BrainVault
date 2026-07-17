/**
 * Maintenance API (SPEC.md §6.4, §6.5): lint, autoresearch, hot-cache refresh. Each runs a
 * vault-mutating agent run to completion and returns its result; the run streams a live log
 * over the event bus on the `maintenance:<kind>` channel, which the Wartung tab renders while
 * the request is in flight. Runs are serialized (one vault writer) and share the ingest
 * commit mutex, so a maintenance commit never interleaves with an ingest commit.
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import { maintenanceChannel } from '../../pipeline/maintenance.js'

export function registerMaintenanceRoute(app: FastifyInstance, ctx: AppContext): void {
  const { maintenance } = ctx

  app.post('/api/v1/maintenance/lint', async (_req, reply) => {
    const result = await maintenance.lint()
    return reply.code(result.ok ? 200 : 502).send({ channel: maintenanceChannel('lint'), ...result })
  })

  app.post('/api/v1/maintenance/hot-cache', async (_req, reply) => {
    const result = await maintenance.refreshHotCache()
    return reply.code(result.ok ? 200 : 502).send({ channel: maintenanceChannel('hot-cache'), ...result })
  })

  app.post('/api/v1/maintenance/research', async (req, reply) => {
    const body = (req.body ?? {}) as { topic?: unknown }
    const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
    if (topic === '') return reply.code(400).send({ error: 'provide a non-empty "topic"' })
    const result = await maintenance.research(topic)
    return reply.code(result.ok ? 200 : 502).send({ channel: maintenanceChannel('research'), ...result })
  })
}
