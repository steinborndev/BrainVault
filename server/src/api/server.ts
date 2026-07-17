/**
 * The Fastify app (SPEC.md §3.1). One process hosts the REST API, and later the SSE
 * stream (M3) and static frontend (M3); it shares a single `IngestQueue` + `JobStore`
 * with the watcher. `buildServer` only constructs the app — the caller runs the
 * localhost guard (config.assertBindAllowed) and `listen`, so tests can exercise routes
 * via `app.inject` without binding a port.
 */

import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import type { Config } from '../config.js'
import type { JobStore } from '../db/jobs.js'
import type { IngestQueue } from '../pipeline/queue.js'
import { registerAuth } from './auth.js'
import { registerHealthRoute } from './routes/health.js'
import { registerJobsRoute } from './routes/jobs.js'

export interface AppContext {
  readonly config: Config
  readonly store: JobStore
  readonly queue: IngestQueue
  /** Fastify logger config; pass `false` to silence (tests). Defaults to structured logs. */
  readonly logger?: boolean | object
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify's logger is separate from job_logs; keep it terse and structured.
    logger: ctx.logger ?? { level: process.env['LOG_LEVEL'] ?? 'info' },
    bodyLimit: 1 * 1024 * 1024, // JSON bodies stay small; file uploads go through multipart.
  })

  await app.register(multipart, {
    limits: { fileSize: ctx.config.server.maxUploadBytes, files: 50 },
  })

  registerAuth(app, ctx.config.server)
  registerHealthRoute(app, ctx)
  registerJobsRoute(app, ctx)

  return app
}
