import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue } from '../src/pipeline/queue.js'
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
let app: FastifyInstance
let vaultRoot: string
let baseUrl: string

function makeConfig(): Config {
  return {
    vaultRoot,
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
  store = new JobStore(db)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  queue = new IngestQueue({
    store,
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
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
  app = await buildServer({ config: makeConfig(), store, queue, logger: false })
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
