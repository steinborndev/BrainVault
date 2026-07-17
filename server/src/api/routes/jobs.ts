/**
 * Jobs API (SPEC.md §4.1, §6.5). `POST /api/v1/jobs` is the drag-and-drop / upload
 * entry point: it accepts file uploads (multipart), a pasted URL, or pasted text, and
 * enqueues them. Multiple files in one request share a `batch_id` (SPEC.md §4.1) — the
 * combined `ingest all of these` run is wired in the batching task. List/detail endpoints
 * feed the Ingestion tab.
 *
 * The endpoint never inspects or executes upload content beyond the size cap; the
 * magic-byte guard and type classification happen in preprocessing (hard rule 6).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import type { BatchItem } from '../../pipeline/queue.js'
import { isShortcut, readShortcutUrl } from '../../pipeline/shortcut.js'

interface EnqueuedRef {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly duplicateOf?: string
}

/** Staging dir for uploaded bytes before they are copied into the vault `.raw/`. */
function stagingDir(): string {
  const dir = path.join(os.tmpdir(), 'vault-service-uploads')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function registerJobsRoute(app: FastifyInstance, ctx: AppContext): void {
  const { queue, store } = ctx

  app.post('/api/v1/jobs', async (req, reply) => {
    const enqueued: EnqueuedRef[] = []

    if (req.isMultipart()) {
      const staged: Array<{ tempPath: string; name: string }> = []
      for await (const part of req.files()) {
        const name = part.filename || `upload-${ulid()}`
        const tempPath = path.join(stagingDir(), `${ulid()}-${path.basename(name)}`)
        await fs.promises.writeFile(tempPath, await part.toBuffer())
        staged.push({ tempPath, name })
      }
      if (staged.length === 0) {
        return reply.code(400).send({ error: 'multipart request contained no files' })
      }
      try {
        // A .url/.webloc becomes a URL item; everything else is a file item.
        const items: BatchItem[] = staged.map(({ tempPath, name }) => {
          const url = isShortcut(name) ? readShortcutUrl(tempPath) : undefined
          return url ? { kind: 'url', url } : { kind: 'file', sourcePath: tempPath, originalName: name }
        })

        // Multiple files → one batch: preprocess each, then a single combined run (SPEC.md §4.1).
        if (items.length > 1) {
          const { batchId, jobs } = await queue.enqueueBatch(items, 'drop')
          jobs.forEach((r, i) =>
            enqueued.push({
              id: r.job.id,
              name: staged[i]!.name,
              status: r.job.status,
              ...(r.duplicateOf ? { duplicateOf: r.duplicateOf } : {}),
            }),
          )
          return reply.code(202).send({ batchId, jobs: enqueued })
        }

        const only = items[0]!
        if (only.kind === 'url') {
          const { job } = queue.enqueueUrl({ url: only.url, source: 'drop' })
          enqueued.push({ id: job.id, name: staged[0]!.name, status: job.status })
        } else {
          const { job, duplicateOf } = await queue.enqueueFile({
            sourcePath: only.sourcePath,
            source: 'drop',
            originalName: only.originalName ?? staged[0]!.name,
          })
          enqueued.push({ id: job.id, name: staged[0]!.name, status: job.status, ...(duplicateOf ? { duplicateOf } : {}) })
        }
        return reply.code(202).send({ jobs: enqueued })
      } finally {
        for (const { tempPath } of staged) fs.rmSync(tempPath, { force: true })
      }
    }

    // JSON body: a pasted URL or pasted text (SPEC.md §4.1).
    const body = (req.body ?? {}) as { url?: unknown; text?: unknown; title?: unknown }
    if (typeof body.url === 'string' && body.url.trim() !== '') {
      const { job } = queue.enqueueUrl({ url: body.url.trim(), source: 'drop' })
      return reply.code(202).send({ jobs: [{ id: job.id, name: body.url.trim(), status: job.status }] })
    }
    if (typeof body.text === 'string' && body.text.trim() !== '') {
      const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : 'pasted-text'
      const name = `${title.replace(/[^\w.-]+/g, '-')}.md`
      const tempPath = path.join(stagingDir(), `${ulid()}-${name}`)
      await fs.promises.writeFile(tempPath, body.text, 'utf8')
      try {
        const { job } = await queue.enqueueFile({ sourcePath: tempPath, source: 'drop', originalName: name })
        return reply.code(202).send({ jobs: [{ id: job.id, name, status: job.status }] })
      } finally {
        fs.rmSync(tempPath, { force: true })
      }
    }

    return reply.code(400).send({ error: 'provide a file upload (multipart), a "url", or "text"' })
  })

  // List recent jobs for the Ingestion tab (SPEC.md §6.2).
  app.get('/api/v1/jobs', async (req) => {
    const query = req.query as { status?: string; limit?: string }
    const limit = Math.min(Number(query.limit ?? '100') || 100, 500)
    const rows = query.status
      ? store.listByStatus(query.status as never).slice(0, limit)
      : store.recent(limit)
    return { jobs: rows }
  })

  app.get('/api/v1/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = store.get(id)
    if (job === undefined) return reply.code(404).send({ error: 'no such job' })
    return { job, logs: store.logs(id) }
  })
}
