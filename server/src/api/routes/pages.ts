/**
 * /api/v1/pages — read, edit and delete single wiki pages (SPEC.md §6.3, §12.4).
 *
 *   GET    ?path=…            truncated markdown for the Chat tab's citation preview
 *   GET    ?path=…&full=1     whole page + title/type/mtime for the vault viewer
 *   PUT    {path, markdown, baseMtime}   user edit — write + immediate git commit
 *   DELETE ?path=…            user delete — unlink + immediate git commit
 *
 * The mutations implement the "editing stays a git commit" rule (CLAUDE.md hard rule 1, as
 * amended 2026-07-18): the dashboard never mutates the vault without versioning it, so every
 * edit/delete is one revertable commit, serialized behind the SAME commit mutex the ingest
 * queue and maintenance runner use — a user edit can never interleave with an agent commit.
 * `commitPaths` (not commitVault) is used deliberately: it stages exactly the edited page and
 * has no `git add -A` fallback, so a concurrently running agent's half-written pages cannot
 * be swept into a user's commit.
 *
 * Every path is attacker-adjacent input (agent-produced citations, client-side routes): it is
 * resolved against the vault root and rejected unless the result is still inside
 * `VAULT_ROOT/wiki` and is a `.md` file, re-checked after `realpath` (symlink escapes). This
 * endpoint can never read or write the credential file, the database, or anything else
 * outside the wiki.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import { commitPaths } from '../../pipeline/git.js'
import { Mutex } from '../../util/mutex.js'
import type { GraphBuilder } from '../../pipeline/graph.js'

/** How much of a page to send for a preview — enough to judge relevance, not a whole document. */
const PREVIEW_LIMIT = 4_000

type Resolved =
  | { readonly ok: true; readonly real: string; readonly rel: string; readonly title: string }
  | { readonly ok: false; readonly status: number; readonly error: string }

/** Confines a raw path to an EXISTING `.md` file under `VAULT_ROOT/wiki`. */
function resolveWikiPage(vaultRoot: string, raw: string): Resolved {
  const wikiRoot = path.resolve(vaultRoot, 'wiki')
  const resolved = path.resolve(vaultRoot, raw)
  // The separator suffix matters: without it, a sibling directory whose name merely starts
  // with "wiki" (e.g. "wiki-private") would pass the prefix test.
  if (resolved !== wikiRoot && !resolved.startsWith(wikiRoot + path.sep)) {
    return { ok: false, status: 400, error: 'path is outside the wiki' }
  }
  if (!resolved.endsWith('.md')) {
    return { ok: false, status: 400, error: 'only markdown pages are served' }
  }
  let real: string
  try {
    // Resolves symlinks; a link pointing out of the wiki must not become a read/write primitive.
    real = fs.realpathSync(resolved)
  } catch {
    return { ok: false, status: 404, error: 'no such page' }
  }
  if (real !== wikiRoot && !real.startsWith(wikiRoot + path.sep)) {
    return { ok: false, status: 400, error: 'path is outside the wiki' }
  }
  return {
    ok: true,
    real,
    rel: path.relative(vaultRoot, real).split(path.sep).join(path.posix.sep),
    title: path.basename(real, '.md'),
  }
}

export function registerPagesRoute(app: FastifyInstance, ctx: AppContext, graph?: GraphBuilder): void {
  const { config } = ctx
  // Tests may build the app without the shared mutex/settings; defaults keep them working.
  const commitMutex = ctx.commitMutex ?? new Mutex()
  const autoCommit = ctx.autoCommit ?? ((): boolean => true)

  app.get('/api/v1/pages', async (req, reply) => {
    const { path: raw, full } = (req.query ?? {}) as { path?: string; full?: string }
    if (typeof raw !== 'string' || raw.trim() === '') {
      return reply.code(400).send({ error: 'provide a "path" query parameter' })
    }
    const page = resolveWikiPage(config.vaultRoot, raw)
    if (!page.ok) return reply.code(page.status).send({ error: page.error })

    let markdown: string
    let mtime: string | undefined
    try {
      markdown = fs.readFileSync(page.real, 'utf8')
      mtime = fs.statSync(page.real).mtime.toISOString()
    } catch {
      return reply.code(404).send({ error: 'no such page' })
    }

    // `full=1`: the vault viewer renders the whole page, plus title/type for its header.
    if (full === '1' || full === 'true') {
      const parts = page.rel.split('/')
      return reply.send({
        path: raw,
        markdown,
        truncated: false,
        title: page.title,
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

  /**
   * User edit of one page. Optimistic concurrency: the client sends the mtime it loaded
   * (`baseMtime`); if the file changed since — an agent run, another tab — the edit is
   * refused with 409 instead of silently overwriting the newer content.
   */
  app.put('/api/v1/pages', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown; markdown?: unknown; baseMtime?: unknown }
    const raw = typeof body.path === 'string' ? body.path : ''
    if (raw.trim() === '') return reply.code(400).send({ error: 'provide "path"' })
    if (typeof body.markdown !== 'string') return reply.code(400).send({ error: 'provide "markdown"' })
    const markdown = body.markdown

    const page = resolveWikiPage(config.vaultRoot, raw)
    if (!page.ok) return reply.code(page.status).send({ error: page.error })

    // Check-and-write happens INSIDE the commit mutex so no agent commit (which also holds
    // it) can land between the staleness check and the write.
    const result = await commitMutex.runExclusive(async () => {
      const current = fs.statSync(page.real).mtime.toISOString()
      if (typeof body.baseMtime === 'string' && body.baseMtime !== current) {
        return { conflict: current }
      }
      fs.writeFileSync(page.real, markdown, 'utf8')
      const commit = autoCommit()
        ? await commitPaths(config.vaultRoot, `edit: ${page.title}`, [page.rel])
        : undefined
      return { mtime: fs.statSync(page.real).mtime.toISOString(), commit }
    })

    if ('conflict' in result) {
      return reply.code(409).send({
        error: 'page changed since it was loaded — reload before editing',
        currentMtime: result.conflict,
      })
    }
    return reply.send({
      ok: true,
      path: page.rel,
      mtime: result.mtime,
      commit: result.commit?.hash ?? null,
      committed: result.commit?.committed ?? false,
    })
  })

  /**
   * User delete of one page. The response carries `staleLinks` — how many OTHER pages linked
   * here (the graph's in-degree, computed before the unlink) — so the UI can point the user
   * at a lint run to clean the now-dangling references up.
   */
  app.delete('/api/v1/pages', async (req, reply) => {
    const { path: raw } = (req.query ?? {}) as { path?: string }
    if (typeof raw !== 'string' || raw.trim() === '') {
      return reply.code(400).send({ error: 'provide a "path" query parameter' })
    }
    const page = resolveWikiPage(config.vaultRoot, raw)
    if (!page.ok) return reply.code(page.status).send({ error: page.error })

    // Backlink count BEFORE the file disappears (the cached graph makes this ~free).
    let staleLinks = 0
    if (graph !== undefined) {
      const g = graph.build()
      const idx = g.nodes.findIndex((n) => n.path === page.rel)
      if (idx >= 0) staleLinks = g.nodes[idx]!.in
    }

    const commit = await commitMutex.runExclusive(async () => {
      fs.unlinkSync(page.real)
      return autoCommit() ? await commitPaths(config.vaultRoot, `delete: ${page.title}`, [page.rel]) : undefined
    })

    return reply.send({
      ok: true,
      path: page.rel,
      staleLinks,
      commit: commit?.hash ?? null,
      committed: commit?.committed ?? false,
    })
  })
}
