/**
 * /api/v1/sources - where each wiki page came from, and the documents themselves.
 *
 *   GET /api/v1/sources              the page to source index (pipeline/sources.ts)
 *   GET /api/v1/sources/raw?path=…   one ingested document out of `.raw/`
 *
 * READ-ONLY. Neither route writes anything, and `raw` is confined to `VAULT_ROOT/.raw` -
 * re-checked after `realpath`, so a symlink parked in a job folder cannot become a read
 * primitive for the credential file, the database, or the wiki.
 *
 * WHAT IS NEVER SERVED INLINE: 54 of the ingests are scraped web pages, kept as
 * `raw.html`. Rendering that from the dashboard's own origin would execute whatever script
 * the scraped page carries, with access to the dashboard's storage and its API - a stored
 * XSS with the whole vault behind it. So the inline set is an ALLOW-list of formats the
 * browser cannot be tricked into executing (PDF, images, plain text); everything else is
 * sent as a download, and `nosniff` keeps the browser from second-guessing either way.
 * The Library links web sources to their live URL instead, which is what the reader
 * actually wants from a web ingest.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import { SourceIndexBuilder } from '../../pipeline/sources.js'

/**
 * Formats safe to hand the browser inline. An allow-list on purpose: anything not named
 * here is downloaded, so a new raw format can never become executable by omission.
 */
const INLINE_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  // Text, as text/plain rather than its real type: `text/markdown` downloads in every
  // browser, and `text/html` is the thing this route refuses to render.
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
  '.vtt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
}

type Resolved =
  | { readonly ok: true; readonly real: string; readonly name: string }
  | { readonly ok: false; readonly status: number; readonly error: string }

/** Confines a raw path to an EXISTING file under `VAULT_ROOT/.raw`. */
function resolveRawFile(vaultRoot: string, raw: string): Resolved {
  const rawRoot = path.resolve(vaultRoot, '.raw')
  const resolved = path.resolve(vaultRoot, raw)
  // The separator suffix matters: without it a sibling directory whose name merely starts
  // with ".raw" would pass the prefix test.
  if (!resolved.startsWith(rawRoot + path.sep)) {
    return { ok: false, status: 400, error: 'path is outside .raw' }
  }
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch {
    return { ok: false, status: 404, error: 'no such document' }
  }
  // Re-checked after the symlinks are gone: a link inside a job folder must not reach out.
  if (!real.startsWith(rawRoot + path.sep)) {
    return { ok: false, status: 400, error: 'path is outside .raw' }
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(real)
  } catch {
    return { ok: false, status: 404, error: 'no such document' }
  }
  if (!stat.isFile()) return { ok: false, status: 400, error: 'not a file' }
  return { ok: true, real, name: path.basename(real) }
}

/** RFC 5987 filename, so a German umlaut in a recipe scan survives the header. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function registerSourcesRoute(app: FastifyInstance, ctx: AppContext, builder?: SourceIndexBuilder): void {
  const index = builder ?? new SourceIndexBuilder(ctx.config.vaultRoot)

  app.get('/api/v1/sources', async () => index.build())

  app.get('/api/v1/sources/raw', async (req, reply) => {
    const { path: raw } = (req.query ?? {}) as { path?: string }
    if (typeof raw !== 'string' || raw.trim() === '') {
      return reply.code(400).send({ error: 'provide a "path" query parameter' })
    }
    const found = resolveRawFile(ctx.config.vaultRoot, raw)
    if (!found.ok) return reply.code(found.status).send({ error: found.error })

    const inline = INLINE_TYPES[path.extname(found.real).toLowerCase()]
    return reply
      .header('Content-Type', inline ?? 'application/octet-stream')
      .header('Content-Disposition', disposition(inline ? 'inline' : 'attachment', found.name))
      // Without this the browser may sniff a downloaded `.html` back into markup.
      .header('X-Content-Type-Options', 'nosniff')
      // A job folder's payload never changes after the ingest wrote it.
      .header('Cache-Control', 'private, max-age=3600')
      .send(fs.createReadStream(found.real))
  })
}
