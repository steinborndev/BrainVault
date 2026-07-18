/**
 * The Fastify app (SPEC.md §3.1). One process hosts the REST API, the SSE live stream
 * (M3), and the built React frontend (M3), so the whole app is a single origin on
 * `127.0.0.1:8420`. It shares a single `IngestQueue` + `JobStore` + `EventBus` with the
 * watcher. `buildServer` only constructs the app — the caller runs the localhost guard
 * (config.assertBindAllowed) and `listen`, so tests can exercise routes via `app.inject`
 * without binding a port.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import type { Config } from '../config.js'
import type { JobStore } from '../db/jobs.js'
import type { ChatStore } from '../db/chat.js'
import type { IngestQueue } from '../pipeline/queue.js'
import type { EventBus } from '../pipeline/events.js'
import type { QueryRunner } from '../pipeline/query-runner.js'
import type { MaintenanceRunner } from '../pipeline/maintenance.js'
import type { SettingsStore } from '../db/settings.js'
import { registerAuth } from './auth.js'
import { registerHealthRoute } from './routes/health.js'
import { registerJobsRoute } from './routes/jobs.js'
import { registerEventsRoute } from './routes/events.js'
import { registerStatsRoute } from './routes/stats.js'
import { registerQueryRoute } from './routes/query.js'
import { registerMaintenanceRoute } from './routes/maintenance.js'
import { registerSettingsRoute } from './routes/settings.js'
import { registerPagesRoute } from './routes/pages.js'
import { registerGraphRoute } from './routes/graph.js'

export interface AppContext {
  readonly config: Config
  readonly store: JobStore
  /** Runtime settings overrides (SPEC.md §6.4/§6.5). Optional so tests can omit it. */
  readonly settings?: SettingsStore
  /** Chat sessions + messages store (M4). */
  readonly chat: ChatStore
  readonly queue: IngestQueue
  /** Live-update bus shared with the queue/store; the SSE route is its only subscriber. */
  readonly events: EventBus
  /** Read-only query runner; injectable so tests mock it (defaults to the real SDK runner). */
  readonly runQuery?: QueryRunner
  /** Maintenance runner (lint / autoresearch / hot-cache). */
  readonly maintenance: MaintenanceRunner
  /** Fastify logger config; pass `false` to silence (tests). Defaults to structured logs. */
  readonly logger?: boolean | object
}

/** Location of the built frontend (`web/dist`), resolved relative to this source file. */
function frontendDir(): string {
  // server/src/api/server.ts → ../../../web/dist
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..', 'web', 'dist')
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
  registerEventsRoute(app, ctx)
  registerStatsRoute(app, ctx)
  registerQueryRoute(app, ctx)
  registerMaintenanceRoute(app, ctx)
  registerSettingsRoute(app, ctx)
  registerPagesRoute(app, ctx)
  registerGraphRoute(app, ctx)

  await registerFrontend(app)

  return app
}

/**
 * Serves the built SPA from `web/dist` at `/`, with an index fallback so client-side routes
 * (deep links into a tab) resolve to `index.html`. If the frontend hasn't been built yet
 * (dev via the Vite proxy, or a server-only checkout) the directory is simply absent and we
 * skip it — the API still runs. API 404s stay JSON; only non-API paths fall back to the SPA.
 */
async function registerFrontend(app: FastifyInstance): Promise<void> {
  const dir = frontendDir()
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    app.log.warn(`frontend not built (${dir} absent) — serving API only; run \`npm run build\` in web/`)
    return
  }

  await app.register(fastifyStatic, { root: dir, wildcard: false })

  app.setNotFoundHandler((req, reply) => {
    // Unknown API routes are genuine 404s; everything else serves the SPA shell.
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
}
