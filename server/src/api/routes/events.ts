/**
 * GET /api/v1/events — the Server-Sent Events stream that drives the live dashboard
 * (SPEC.md §6.5, TASKS-M3 §1). It is the spine of the UI: every job transition, every
 * agent log line, and a "stats changed" hint are pushed here so the browser never polls
 * for the DoD's live log.
 *
 * Transport notes:
 *  - `text/event-stream`, one JSON payload per `data:` line, `event:` = the bus event kind.
 *  - A heartbeat comment (`: ping`) every 15 s keeps intermediaries and the browser from
 *    dropping an idle connection, and lets us detect a dead socket to unsubscribe.
 *  - On disconnect we unsubscribe from the bus and clear the heartbeat — no listener leak
 *    (CLAUDE.md: clean unsubscribe on disconnect).
 *
 * SSE cannot set an Authorization header, so in the future `token` auth mode this route
 * would need a query-param token; v1 ships only `local-single-user` (pass-through), so the
 * standard auth hook already lets it through.
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import type { BusEvent } from '../../pipeline/events.js'

const HEARTBEAT_MS = 15_000

export function registerEventsRoute(app: FastifyInstance, ctx: AppContext): void {
  const bus = ctx.events

  app.get('/api/v1/events', (req, reply) => {
    // Take the socket out of Fastify's request/response lifecycle: we own the raw stream for
    // its whole (open-ended) lifetime and send nothing through `reply`.
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defensive against any proxy that might buffer (nginx); harmless on localhost.
      'X-Accel-Buffering': 'no',
    })
    // Tell the client to reconnect after 3 s if the stream drops, and greet immediately so
    // the browser's EventSource fires `onopen` without waiting for the first event.
    res.write('retry: 3000\n\n')
    res.write(': connected\n\n')

    const send = (event: BusEvent): void => {
      // A single SSE message: an `event:` type line + one `data:` JSON line. `stats` and
      // `vault` are bare refresh hints and carry no payload.
      const payload =
        event.kind === 'job'
          ? { job: event.job }
          : event.kind === 'log'
            ? { log: event.log }
            : event.kind === 'chat'
              ? { chat: event.chat }
              : {}
      res.write(`event: ${event.kind}\ndata: ${JSON.stringify(payload)}\n\n`)
    }

    const unsubscribe = bus.subscribe(send)
    // The write is guarded: a connection that reset mid-write surfaces as a throw here (or as
    // an 'error' event below), and either must tear the subscription down, not crash the server.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        close()
      }
    }, HEARTBEAT_MS)

    const close = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    // Fires when the browser navigates away, the tab closes, or the socket drops. A hijacked
    // response has no Fastify error handling left, so the raw 'error' event needs a listener
    // of its own — an unhandled 'error' on the stream would take the process down.
    req.raw.on('close', close)
    reply.raw.on('close', close)
    req.raw.on('error', close)
    reply.raw.on('error', close)
  })
}
