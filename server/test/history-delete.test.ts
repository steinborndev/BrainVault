/**
 * Per-row deletion from the activity history (SPEC.md §6.2 amendment 2026-09-05).
 *
 * `DELETE /jobs/:id` keeps its cancel meaning for a queued job and deletes a settled one;
 * a running job is refused. `DELETE /maintenance/history/:id` drops one settled agent run.
 * Both prune operational rows only - nothing here touches the vault.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { MemoryAgentRunStore } from '../src/db/agent-runs.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'

let vaultRoot: string
let app: FastifyInstance
let store: JobStore
let runs: MemoryAgentRunStore
let queue: IngestQueue

beforeEach(async () => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'histdel-'))
  const db = openDb(MEMORY_DB)
  const events = new EventBus()
  store = new JobStore(db, events)
  runs = new MemoryAgentRunStore()
  const config: Config = {
    vaultRoot,
    obsidianVaultName: 'vault',
    demoMode: false,
    auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
    telegram: null,
    server: {
      host: '127.0.0.1',
      port: 0,
      watchFolder: path.join(vaultRoot, 'inbox'),
      maxUploadBytes: 1024 * 1024,
      authMode: 'local-single-user',
    },
  }
  queue = new IngestQueue({
    store,
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    events,
  })
  app = await buildServer({
    config,
    store,
    chat: new ChatStore(db),
    queue,
    events,
    maintenance: new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events,
      commitMutex: new Mutex(),
      runAgent: async () => ({
        ok: true,
        result: '',
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        durationMs: 0,
        numTurns: 0,
        sessionId: 's',
        timedOut: false,
      }),
    }),
    agentRuns: runs,
    autoCommit: () => false,
    logger: false,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('DELETE /api/v1/jobs/:id', () => {
  it('deletes a settled job with its logs, cancels a queued one, refuses a running one', async () => {
    // Settled: a duplicate row (the case that motivated the action).
    const first = store.create({ source: 'drop', type: 'pdf', originalName: 'a.pdf', sha256: 'h1' })
    const dup = store.create({ source: 'drop', type: 'pdf', originalName: 'a.pdf', sha256: 'h1' })
    expect(dup.job.status).toBe('duplicate')
    const gone = await app.inject({ method: 'DELETE', url: `/api/v1/jobs/${dup.job.id}` })
    expect(gone.statusCode).toBe(200)
    expect(gone.json()).toEqual({ deleted: true })
    expect(store.get(dup.job.id)).toBeUndefined()
    expect(store.logs(dup.job.id)).toEqual([])

    // The original is still queued (the queue never started): DELETE means cancel.
    const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/jobs/${first.job.id}` })
    expect(cancelled.statusCode).toBe(200)
    expect((cancelled.json() as { job: { status: string } }).job.status).toBe('cancelled')
    // Now settled: a second DELETE deletes it.
    const again = await app.inject({ method: 'DELETE', url: `/api/v1/jobs/${first.job.id}` })
    expect(again.json()).toEqual({ deleted: true })
    expect(store.get(first.job.id)).toBeUndefined()

    // Running: refused, the ingest is left to finish.
    const running = store.create({ source: 'drop', type: 'text', originalName: 'r.md' })
    store.transition(running.job.id, 'preprocessing')
    store.transition(running.job.id, 'ingesting')
    const refused = await app.inject({ method: 'DELETE', url: `/api/v1/jobs/${running.job.id}` })
    expect(refused.statusCode).toBe(409)
    expect(store.get(running.job.id)?.status).toBe('ingesting')

    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/jobs/nope' })
    expect(missing.statusCode).toBe(404)
  })
})

describe('DELETE /api/v1/maintenance/history/:id', () => {
  it('drops one settled run and 404s an unknown id', async () => {
    runs.record({
      id: 'run-1',
      kind: 'retrieve-index',
      label: null,
      profileKey: null,
      ok: true,
      pages: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      error: null,
      commitHash: null,
      startedAt: '2026-09-05T08:00:00.000Z',
      finishedAt: '2026-09-05T08:00:03.000Z',
    })
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/maintenance/history/run-1' })
    expect(res.statusCode).toBe(200)
    expect(runs.list()).toEqual([])
    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/maintenance/history/run-1' })
    expect(missing.statusCode).toBe(404)
  })
})
