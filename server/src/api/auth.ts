/**
 * HTTP auth middleware (SPEC.md §9). v1 runs `local-single-user`: pass-through, every
 * request is the seed user `'local'`. The `token` mode is the seam that the localhost
 * guard (config.assertBindAllowed) requires before a non-loopback bind is allowed — it
 * checks a bearer token so remote access (SPEC.md §12.2/12.3) is a config step with
 * enforced auth, never an unguarded default.
 */

import crypto from 'node:crypto'
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

/** Methods that mutate state and therefore need the cross-origin check. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * CSRF guard for the localhost threat model: `local-single-user` mode has no credential, so
 * the only thing keeping a malicious website from firing state-changing requests at
 * 127.0.0.1 is the browser — and multipart POSTs are CORS-"simple", i.e. sent without a
 * preflight. Browsers attach `Origin` to every cross-origin state-changing request; the SPA
 * itself is same-origin, so its Origin equals the Host header. Non-browser clients (curl,
 * systemd probes) send no Origin and pass. `Origin: null` (sandboxed iframes, some
 * redirects) is treated as foreign. Loopback origins on any port are allowed too: the Vite
 * dev proxy forwards the browser's `Origin: http://localhost:5173` while rewriting Host,
 * and a hostile *website* can never present a loopback origin.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  try {
    const url = new URL(origin)
    return url.host === req.headers.host || LOOPBACK_HOSTNAMES.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * Constant-time token comparison. In `token` mode this check is the sole barrier justifying a
 * non-loopback bind (config.assertBindAllowed), so a timing side-channel matters. Hashing both
 * sides first gives equal-length buffers for `timingSafeEqual` without leaking length.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers['authorization']
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  const alt = req.headers['x-auth-token']
  return typeof alt === 'string' ? alt.trim() : undefined
}

export function registerAuth(app: FastifyInstance, server: ServerConfig): void {
  app.decorateRequest('userId', '')
  app.addHook('onRequest', async (req, reply) => {
    if (STATE_CHANGING.has(req.method) && !originAllowed(req)) {
      await reply.code(403).send({ error: 'cross-origin request rejected' })
      return reply
    }
    if (server.authMode === 'token' && !PUBLIC_PATHS.has(req.url.split('?')[0] ?? req.url)) {
      const provided = bearerToken(req)
      if (provided === undefined || !tokenMatches(provided, server.authToken ?? '')) {
        await reply.code(401).send({ error: 'unauthorized' })
        return reply
      }
    }
    req.userId = 'local'
  })
}
