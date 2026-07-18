/**
 * GET /api/v1/pages?path=…[&full=1] — the markdown of one wiki page. Two consumers:
 * the Chat tab's inline citation preview (SPEC.md §6.3, truncated) and the vault viewer
 * (SPEC.md §12.4, `full=1`: whole page + title/type metadata for the page view).
 *
 * READ-ONLY, and deliberately narrow. The `path` comes from a citation the agent produced (or a
 * client-side route), so it is attacker-adjacent input: it is resolved against the vault root and
 * rejected unless the result is still inside `VAULT_ROOT/wiki` and is a `.md` file. That rules
 * out `../` traversal, absolute paths, and symlink escapes (the realpath check), so this endpoint
 * can never be used to read the credential file, the database, or anything else outside the wiki.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'

/** How much of a page to send for a preview — enough to judge relevance, not a whole document. */
const PREVIEW_LIMIT = 4_000

export function registerPagesRoute(app: FastifyInstance, ctx: AppContext): void {
  const { config } = ctx

  app.get('/api/v1/pages', async (req, reply) => {
    const { path: raw, full } = (req.query ?? {}) as { path?: string; full?: string }
    if (typeof raw !== 'string' || raw.trim() === '') {
      return reply.code(400).send({ error: 'provide a "path" query parameter' })
    }

    const wikiRoot = path.resolve(config.vaultRoot, 'wiki')
    const resolved = path.resolve(config.vaultRoot, raw)

    // Confine to the wiki subtree. The separator suffix matters: without it, a sibling directory
    // whose name merely starts with "wiki" (e.g. "wiki-private") would pass the prefix test.
    if (resolved !== wikiRoot && !resolved.startsWith(wikiRoot + path.sep)) {
      return reply.code(400).send({ error: 'path is outside the wiki' })
    }
    if (!resolved.endsWith('.md')) {
      return reply.code(400).send({ error: 'only markdown pages can be previewed' })
    }

    let real: string
    try {
      // Resolves symlinks; a link pointing out of the wiki must not become a read primitive.
      real = fs.realpathSync(resolved)
    } catch {
      return reply.code(404).send({ error: 'no such page' })
    }
    if (real !== wikiRoot && !real.startsWith(wikiRoot + path.sep)) {
      return reply.code(400).send({ error: 'path is outside the wiki' })
    }

    let markdown: string
    let mtime: string | undefined
    try {
      markdown = fs.readFileSync(real, 'utf8')
      mtime = fs.statSync(real).mtime.toISOString()
    } catch {
      return reply.code(404).send({ error: 'no such page' })
    }

    // `full=1`: the vault viewer renders the whole page, plus title/type for its header.
    if (full === '1' || full === 'true') {
      const rel = raw.split(path.sep).join('/')
      const parts = rel.split('/')
      return reply.send({
        path: raw,
        markdown,
        truncated: false,
        title: path.basename(real, '.md'),
        type: parts.length > 2 ? parts[1] : 'root',
        mtime,
      })
    }

    const truncated = markdown.length > PREVIEW_LIMIT
    return reply.send({
      path: raw,
      markdown: truncated ? markdown.slice(0, PREVIEW_LIMIT) : markdown,
      truncated,
    })
  })
}
