import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'

type JobsResp = { batchId?: string; jobs: Array<{ id: string; name: string; status: string }> }
type HealthResp = { status: string; queue: { concurrency: number }; jobs: Record<string, number> }
type ListResp = { jobs: Array<{ id: string }> }
type DetailResp = { job: { id: string }; logs: unknown[] }

const NO_TOOLS: ToolAvailability = {
  pdftotext: false,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: false,
  python3: false,
  exiftool: false,
  defuddle: false,
}

let db: Db
let store: JobStore
let queue: IngestQueue
let events: EventBus
let app: FastifyInstance
let vaultRoot: string
let baseUrl: string

function makeConfig(): Config {
  return {
    vaultRoot,
    obsidianVaultName: 'vault',
    auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
    server: {
      host: '127.0.0.1',
      port: 0,
      watchFolder: path.join(vaultRoot, 'inbox'),
      maxUploadBytes: 10 * 1024 * 1024,
      authMode: 'local-single-user',
    },
  }
}

beforeEach(async () => {
  db = openDb(MEMORY_DB)
  events = new EventBus()
  store = new JobStore(db, events)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  queue = new IngestQueue({
    store,
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    events,
    detectToolsFn: async () => NO_TOOLS,
    commit: async () => ({ committed: true, hash: 'h', committedPages: ['wiki/x.md'] }),
    refreshHotCache: async () => 'noop',
    runIngest: async () => ({
      ok: true,
      result: 'ok',
      usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
      durationMs: 1,
      numTurns: 1,
      sessionId: 's',
      timedOut: false,
    }),
    preprocessUrlFn: async (input) => {
      fs.mkdirSync(input.jobDir, { recursive: true })
      return {
        type: 'web',
        deferred: false,
        manifestPath: path.join(input.jobDir, 'manifest.json'),
        primaryArtifact: `.raw/${input.jobId}/normalized.md`,
        manifest: {} as never,
      }
    },
  })
  queue.start()
  app = await buildServer({ config: makeConfig(), store, queue, events, logger: false })
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await queue.onIdle()
  await app.close()
  db.close()
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('GET /api/v1/health', () => {
  it('reports ok with queue + job snapshots', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HealthResp
    expect(body.status).toBe('ok')
    expect(body.queue.concurrency).toBe(2)
    expect(body.jobs).toBeDefined()
  })
})

describe('POST /api/v1/jobs', () => {
  it('accepts a URL job', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/a' }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as JobsResp
    expect(body.jobs).toHaveLength(1)
    expect(body.jobs[0]!.name).toBe('https://example.com/a')
  })

  it('accepts pasted text', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '# Note\nbody', title: 'my note' }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as JobsResp
    expect(body.jobs[0]!.name).toBe('my-note.md')
  })

  it('accepts a multipart batch of files with a shared batchId', async () => {
    const form = new FormData()
    form.append('files', new Blob(['# one'], { type: 'text/markdown' }), 'one.md')
    form.append('files', new Blob(['two body'], { type: 'text/plain' }), 'two.txt')
    const res = await fetch(`${baseUrl}/api/v1/jobs`, { method: 'POST', body: form })
    expect(res.status).toBe(202)
    const body = (await res.json()) as JobsResp
    expect(body.batchId).toBeTruthy()
    expect(body.jobs).toHaveLength(2)
    await queue.onIdle()
    // Both members carry the same batch_id.
    const jobs = store.recent(10)
    const batchIds = new Set(jobs.map((j) => j.batch_id))
    expect(batchIds.has(body.batchId!)).toBe(true)
  })

  it('rejects an empty request', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/jobs', () => {
  it('lists jobs and fetches one by id with logs', async () => {
    const created = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/b' }),
    })
    const { jobs } = (await created.json()) as JobsResp
    const id = jobs[0]!.id

    const list = (await (await fetch(`${baseUrl}/api/v1/jobs`)).json()) as ListResp
    expect(list.jobs.some((j) => j.id === id)).toBe(true)

    const detail = await fetch(`${baseUrl}/api/v1/jobs/${id}`)
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as DetailResp
    expect(body.job.id).toBe(id)
    expect(Array.isArray(body.logs)).toBe(true)

    const missing = await fetch(`${baseUrl}/api/v1/jobs/nope`)
    expect(missing.status).toBe(404)
  })
})

describe('POST /api/v1/jobs/:id/retry', () => {
  it('re-queues a failed job and 409s a non-retryable one', async () => {
    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'x.md' })
    store.transition(job.id, 'failed', { patch: { error: 'boom' } })

    const res = await fetch(`${baseUrl}/api/v1/jobs/${job.id}/retry`, { method: 'POST' })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { job: { status: string } }
    expect(body.job.status).toBe('queued')

    // A done/terminal job cannot be retried.
    const done = store.create({ source: 'drop', type: 'text', originalName: 'y.md' })
    store.transition(done.job.id, 'cancelled')
    const bad = await fetch(`${baseUrl}/api/v1/jobs/${done.job.id}/retry`, { method: 'POST' })
    expect(bad.status).toBe(409)

    const missing = await fetch(`${baseUrl}/api/v1/jobs/nope/retry`, { method: 'POST' })
    expect(missing.status).toBe(404)
  })
})

describe('DELETE /api/v1/jobs/:id', () => {
  it('cancels a queued job but refuses a running/terminal one', async () => {
    queue.stop() // so the worker doesn't claim the row we create
    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'q.md' })
    const res = await fetch(`${baseUrl}/api/v1/jobs/${job.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(store.getOrThrow(job.id).status).toBe('cancelled')

    // Once cancelled (terminal) a second cancel is a 409.
    const again = await fetch(`${baseUrl}/api/v1/jobs/${job.id}`, { method: 'DELETE' })
    expect(again.status).toBe(409)
  })
})

describe('DELETE /api/v1/jobs (clear history)', () => {
  it('clears at-rest jobs, respects a status filter, and never touches active jobs', async () => {
    queue.stop() // keep the queued job from being claimed
    const done1 = store.create({ source: 'drop', type: 'text', originalName: 'd1.md' })
    store.transition(done1.job.id, 'preprocessing')
    store.transition(done1.job.id, 'ingesting')
    store.transition(done1.job.id, 'done')
    const failed1 = store.create({ source: 'drop', type: 'text', originalName: 'f1.md' })
    store.transition(failed1.job.id, 'failed', { patch: { error: 'x' } })
    const queued1 = store.create({ source: 'drop', type: 'text', originalName: 'q1.md' })

    // Clear only failed → done + queued remain.
    const r1 = await fetch(`${baseUrl}/api/v1/jobs?status=failed`, { method: 'DELETE' })
    expect(r1.status).toBe(200)
    expect(((await r1.json()) as { removed: number }).removed).toBe(1)
    expect(store.get(failed1.job.id)).toBeUndefined()
    expect(store.get(done1.job.id)).toBeDefined()

    // Clear all at-rest → done goes, the queued (active) job stays.
    const r2 = await fetch(`${baseUrl}/api/v1/jobs`, { method: 'DELETE' })
    expect(((await r2.json()) as { removed: number }).removed).toBe(1)
    expect(store.get(done1.job.id)).toBeUndefined()
    expect(store.get(queued1.job.id)).toBeDefined()

    // An active status is rejected.
    const bad = await fetch(`${baseUrl}/api/v1/jobs?status=ingesting`, { method: 'DELETE' })
    expect(bad.status).toBe(400)

    // Cleanup: the queue is stopped and holds a queued job, which would wedge onIdle in
    // afterEach — cancel it so the queue settles.
    store.transition(queued1.job.id, 'cancelled')
  })
})

describe('GET /api/v1/stats', () => {
  it('returns page counts, queue state, and the vault name', async () => {
    const res = await fetch(`${baseUrl}/api/v1/stats`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      vaultName: string
      pages: { total: number }
      queue: { concurrency: number }
      kpis7d: Record<string, number>
      watcher: { active: boolean }
    }
    expect(body.vaultName).toBe('vault')
    expect(typeof body.pages.total).toBe('number')
    expect(body.queue.concurrency).toBe(2)
    expect(body.watcher.active).toBe(true)
    expect(body.kpis7d).toBeDefined()
  })
})

describe('GET /api/v1/events (SSE)', () => {
  it('streams a job event when a job transitions', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // Give the subscription a tick to register, then cause a transition.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'sse.md' })
    store.transition(job.id, 'cancelled')

    let seen = ''
    // Read a few chunks until we observe a job event (or bail after a bounded number).
    for (let i = 0; i < 5 && !seen.includes('event: job'); i++) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    controller.abort()
    expect(seen).toContain('event: job')
  })
})
