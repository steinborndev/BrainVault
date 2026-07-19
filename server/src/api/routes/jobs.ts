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
import { JobStore, type JobStatus } from '../../db/jobs.js'
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
  const { queue, store, events } = ctx

  app.post('/api/v1/jobs', async (req, reply) => {
    // Setup mode: the queue never claims, so accepting the upload would strand it in
    // `queued` with no feedback. Refuse with the same guidance the other run routes give.
    if (ctx.config.auth === null) {
      return reply.code(503).send({
        error: 'no Anthropic credential configured — add it under Maintenance → Settings, then restart',
      })
    }
    const enqueued: EnqueuedRef[] = []

    if (req.isMultipart()) {
      const staged: Array<{ tempPath: string; name: string }> = []
      try {
        // The staging loop is INSIDE the cleanup scope: when a later part exceeds the size
        // limit, the parts already written must still be removed, and the client deserves
        // the honest 413 rather than a generic 500.
        try {
          for await (const part of req.files()) {
            const name = part.filename || `upload-${ulid()}`
            const tempPath = path.join(stagingDir(), `${ulid()}-${path.basename(name)}`)
            staged.push({ tempPath, name })
            await fs.promises.writeFile(tempPath, await part.toBuffer())
          }
        } catch (err) {
          const code = (err as { code?: string }).code
          if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
            return reply.code(413).send({
              error: `upload exceeds the configured limit (${ctx.config.server.maxUploadBytes} bytes per file, 50 files)`,
            })
          }
          throw err
        }
        if (staged.length === 0) {
          return reply.code(400).send({ error: 'multipart request contained no files' })
        }
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

  // List recent jobs for the Ingestion tab, filterable by status AND type (SPEC.md §6.2, §6.5).
  app.get('/api/v1/jobs', async (req) => {
    const query = req.query as { status?: string; type?: string; limit?: string }
    const limit = Math.min(Number(query.limit ?? '100') || 100, 500)
    const filters: { status?: JobStatus; type?: string } = {}
    if (query.status) filters.status = query.status as JobStatus
    if (query.type) filters.type = query.type
    return { jobs: store.list({ ...filters, limit }) }
  })

  app.get('/api/v1/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = store.get(id)
    if (job === undefined) return reply.code(404).send({ error: 'no such job' })
    return { job, logs: store.logs(id) }
  })

  // Clear finished jobs from the history ("Verlauf leeren", SPEC.md §6.2). With `?status=`
  // only that status is cleared (so the UI can clear just the active filter); otherwise all
  // at-rest jobs go. Active jobs (queued/preprocessing/ingesting) are never touched, and the
  // vault is untouched — this only prunes operational rows (hard rule 1).
  app.delete('/api/v1/jobs', async (req, reply) => {
    const { status } = req.query as { status?: string }
    if (status !== undefined && !JobStore.CLEARABLE_STATUSES.includes(status as JobStatus)) {
      return reply.code(400).send({
        error: `status must be one of ${JobStore.CLEARABLE_STATUSES.join(', ')} (active jobs cannot be cleared)`,
      })
    }
    const removed = store.clearHistory(status as JobStatus | undefined)
    // No per-job delete event exists; a stats signal nudges connected clients to refetch.
    if (removed > 0) events.publish({ kind: 'stats' })
    return reply.code(200).send({ removed })
  })

  // Manual retry of a failed/deferred job (SPEC.md §6.2 "Erneut versuchen"). Emits an SSE
  // `job` update via the store transition inside queue.retryJob.
  app.post('/api/v1/jobs/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (store.get(id) === undefined) return reply.code(404).send({ error: 'no such job' })
    try {
      const job = queue.retryJob(id)
      return reply.code(202).send({ job })
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message })
    }
  })

  // Cancel a queued job (→ cancelled). A job already being preprocessed/ingested is left to
  // finish — we never kill an agent mid-write, which could leave the vault half-written
  // (hard rule 1). Emits an SSE `job` update via the transition.
  app.delete('/api/v1/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = store.get(id)
    if (job === undefined) return reply.code(404).send({ error: 'no such job' })
    if (job.status !== 'queued') {
      return reply
        .code(409)
        .send({ error: `job is ${job.status}; only a queued job can be cancelled (a running ingest is left to finish)` })
    }
    const updated = store.transition(id, 'cancelled', { log: 'cancelled by user (SPEC.md §6.2)' })
    return reply.code(200).send({ job: updated })
  })
}
