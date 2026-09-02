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
import type { TelegramDropStore } from '../db/telegram-drops.js'
import type { Mutex } from '../util/mutex.js'
import { GraphBuilder } from '../pipeline/graph.js'
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
import { registerSourcesRoute } from './routes/sources.js'
import { registerDomainsRoute } from './routes/domains.js'
import { MemoryDismissalStore, type DismissalStore } from '../db/domain-dismissals.js'
import type { MaintenanceStateStore } from '../db/maintenance-state.js'
import type { AgentRunStore } from '../db/agent-runs.js'

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
  /**
   * The commit mutex shared with the queue and the maintenance runner. User page edits
   * (PUT/DELETE /pages) commit behind it so they never interleave with an agent commit.
   * Optional so tests can omit it (the pages route falls back to a private mutex).
   */
  readonly commitMutex?: Mutex
  /** gitAutoCommit provider (SPEC.md §6.4), same live-settings pattern as the queue's. */
  readonly autoCommit?: () => boolean
  /** Dismissed domain candidates (SPEC.md §12.4 Stufe 3); defaults to a non-persistent store. */
  readonly domainDismissals?: DismissalStore
  /** Per-kind maintenance settle state (SPEC.md §12.7 Stufe b); omitted → empty state list. */
  readonly maintenanceState?: MaintenanceStateStore
  /** Persistent per-run history (schema v12); omitted → the history endpoint answers empty. */
  readonly agentRuns?: AgentRunStore
  /** Fastify logger config; pass `false` to silence (tests). Defaults to structured logs. */
  readonly logger?: boolean | object
  /** Env-file path the credential endpoint writes. Defaults to DEFAULT_ENV_FILE; tests inject. */
  readonly credentialFile?: string
  /** Restart trigger after a credential write under systemd. Injectable so tests observe it. */
  readonly scheduleRestart?: () => void
  /** Dropped-sender counters for the telegram status endpoint (migration v8). Optional in tests. */
  readonly telegramDrops?: TelegramDropStore
  /**
   * Shared graph builder. main.ts passes the instance the post-run validator already uses so
   * the graph cache is warmed once; when omitted (tests) the server builds its own.
   */
  readonly graph?: GraphBuilder
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
    // Behind a reverse proxy on the same machine the client address arrives in
    // X-Forwarded-For; trusting that header from loopback only keeps per-client limits
    // meaningful without letting a remote peer spoof its own address.
    trustProxy: 'loopback',
  })

  await app.register(multipart, {
    limits: { fileSize: ctx.config.server.maxUploadBytes, files: 50 },
  })

  registerAuth(app, ctx.config.server)
  // DEMO MODE (SPEC.md §12.8): ONE enforcement point for the read-only guarantee. Every
  // non-read API request is refused before any route handler runs, so mutating endpoints
  // added later are covered automatically. Static assets and all GETs stay untouched.
  if (ctx.config.demoMode) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.url.startsWith('/api/')) {
        return reply
          .code(403)
          .send({ error: 'demo_read_only', message: 'This hosted demo instance is read-only.' })
      }
    })
  }
  registerHealthRoute(app, ctx)
  registerJobsRoute(app, ctx)
  registerEventsRoute(app, ctx)
  registerStatsRoute(app, ctx)
  registerQueryRoute(app, ctx)
  registerSettingsRoute(app, ctx)
  // One shared graph builder: the graph endpoint serves it, the pages DELETE consults it for
  // the backlink count, and the domain candidate finder reads tags/domains off it (its
  // per-file cache makes all three cheap).
  const graphBuilder = ctx.graph ?? new GraphBuilder(ctx.config.vaultRoot)
  const dismissals = ctx.domainDismissals ?? new MemoryDismissalStore()
  registerMaintenanceRoute(app, ctx, graphBuilder, dismissals, ctx.maintenanceState, ctx.agentRuns)
  registerPagesRoute(app, ctx, graphBuilder)
  registerGraphRoute(app, ctx, graphBuilder)
  registerSourcesRoute(app, ctx)
  registerDomainsRoute(app, ctx, graphBuilder, dismissals)

  await registerFrontend(app)

  return app
}

/**
 * Serves the built SPA from `web/dist` at `/`, with an index fallback so client-side routes
 * (deep links into a tab) resolve to `index.html`. If the frontend hasn't been built yet
 * (dev via the Vite proxy, or a server-only checkout) the directory is simply absent and we
 * skip it — the API still runs. API 404s stay JSON, missing hashed bundles under `/assets/`
 * are real 404s (see `notFoundKind`), and only the remaining non-API paths fall back to the
 * SPA. `dir` is a parameter so the tests can serve a fixture instead of `web/dist`.
 */
export async function registerFrontend(app: FastifyInstance, dir = frontendDir()): Promise<void> {
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    app.log.warn(`frontend not built (${dir} absent) — serving API only; run \`npm run build\` in web/`)
    return
  }

  await app.register(fastifyStatic, { root: dir, wildcard: false })

  app.setNotFoundHandler((req, reply) => {
    switch (notFoundKind(req.url)) {
      case 'api':
        return reply.code(404).send({ error: 'not found' })
      case 'asset':
        return reply.code(404).type('text/plain').send('not found')
      default:
        return reply.sendFile('index.html')
    }
  })
}

/**
 * What a request that matched no route should get back.
 *
 * The `asset` case is the one worth spelling out. Vite emits hashed bundles under
 * `/assets/`, and a rebuild renames every one of them. A browser tab left open across a
 * rebuild still asks for the old name, and answering THAT with the SPA shell (200,
 * text/html) is how a stale tab turned into a blank page: the frontend loads its Graph
 * screen as a dynamic import, the browser refused the HTML as a module, and React rethrew
 * that at render time. A 404 says what actually happened, and the frontend's boundary
 * (web/src/components/ErrorBoundary.tsx) turns it into one reload.
 *
 * Deliberately NOT a "looks like a file" test: vault pages route as `/page/Some Note.md`,
 * and those deep links must keep resolving to the shell.
 */
export function notFoundKind(url: string): 'api' | 'asset' | 'shell' {
  const pathname = url.split('?')[0] ?? ''
  if (pathname.startsWith('/api/')) return 'api'
  if (pathname.startsWith('/assets/')) return 'asset'
  return 'shell'
}
