/**
 * GET /api/v1/pages?path=… — the raw markdown of one wiki page, for the Chat tab's inline
 * citation preview (SPEC.md §6.3: citation chips with an "Inline-Preview des Seiteninhalts").
 *
 * READ-ONLY, and deliberately narrow. The `path` comes from a citation the agent produced, so it
 * is attacker-adjacent input: it is resolved against the vault root and rejected unless the
 * result is still inside `VAULT_ROOT/wiki` and is a `.md` file. That rules out `../` traversal,
 * absolute paths, and symlink escapes (the realpath check), so this endpoint can never be used to
 * read the credential file, the database, or anything else outside the wiki.
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
    const { path: raw } = (req.query ?? {}) as { path?: string }
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
    try {
      markdown = fs.readFileSync(real, 'utf8')
    } catch {
      return reply.code(404).send({ error: 'no such page' })
    }

    const truncated = markdown.length > PREVIEW_LIMIT
    return reply.send({
      path: raw,
      markdown: truncated ? markdown.slice(0, PREVIEW_LIMIT) : markdown,
      truncated,
    })
  })
}
