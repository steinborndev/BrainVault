/**
 * HTTP auth middleware (SPEC.md §9). v1 runs `local-single-user`: pass-through, every
 * request is the seed user `'local'`. The `token` mode is the seam that the localhost
 * guard (config.assertBindAllowed) requires before a non-loopback bind is allowed — it
 * checks a bearer token so remote access (SPEC.md §12.2/12.3) is a config step with
 * enforced auth, never an unguarded default.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ServerConfig } from '../config.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated user. Always `'local'` in v1 (SPEC.md §12.1 will scope this). */
    userId: string
  }
}

/** Paths reachable without auth — the health check must answer the systemd probe (M5). */
const PUBLIC_PATHS = new Set(['/api/v1/health'])

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers['authorization']
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  const alt = req.headers['x-auth-token']
  return typeof alt === 'string' ? alt.trim() : undefined
}

export function registerAuth(app: FastifyInstance, server: ServerConfig): void {
  app.decorateRequest('userId', '')
  app.addHook('onRequest', async (req, reply) => {
    if (server.authMode === 'token' && !PUBLIC_PATHS.has(req.url.split('?')[0] ?? req.url)) {
      const provided = bearerToken(req)
      if (provided === undefined || provided !== server.authToken) {
        await reply.code(401).send({ error: 'unauthorized' })
        return reply
      }
    }
    req.userId = 'local'
  })
}
