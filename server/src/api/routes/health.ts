/**
 * GET /api/v1/health — liveness + a queue/jobs snapshot. Public (no auth) so the systemd
 * unit (M5) and smoke checks can probe it. Feeds the dashboard "Übersicht" tab (SPEC.md §6.1).
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'

export function registerHealthRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/health', async () => {
    return {
      status: 'ok',
      // No vaultRoot here: this route is public (PUBLIC_PATHS), and once the token-mode
      // remote-bind seam is used it must not leak filesystem layout to the unauthenticated.
      // The authenticated settings route exposes it for the UI.
      queue: ctx.queue.stats(),
      jobs: ctx.store.counts(),
      // Client-side pre-checks (the dropzone warns before uploading a file the server
      // would 413) — TASKS-M3 §5 noted this as the missing proactive half of the cap.
      limits: { maxUploadBytes: ctx.config.server.maxUploadBytes },
    }
  })
}
