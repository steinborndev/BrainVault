import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { SettingsStore } from '../src/db/settings.js'
import { TelegramDropStore } from '../src/db/telegram-drops.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import type { QueryRunInput } from '../src/pipeline/query-runner.js'
import type { AgentRunResult, RunAgentOptions } from '../src/pipeline/agent-runner.js'
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
  ytDlp: false,
  deno: false,
}

let db: Db
let store: JobStore
let chat: ChatStore
let queue: IngestQueue
let events: EventBus
let maintenance: MaintenanceRunner
let app: FastifyInstance
// Controllable stand-in for the maintenance agent runner (no real SDK in tests).
let maintAgent: (opts: RunAgentOptions) => Promise<AgentRunResult>
// A controllable stand-in for the read-only query runner (no real SDK in tests).
let queryImpl: (input: QueryRunInput) => Promise<AgentRunResult>
const okResult = (result: string): AgentRunResult => ({
  ok: true,
  result,
  usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.01 },
  durationMs: 1,
  numTurns: 1,
  sessionId: 'sdk-session-1',
  timedOut: false,
})
let vaultRoot: string
let baseUrl: string

function makeConfig(): Config {
  return {
    vaultRoot,
    obsidianVaultName: 'vault',
    auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
    telegram: null,
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
  chat = new ChatStore(db)
  queryImpl = async () => okResult('answer with [[Some Page]] cited')
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
  maintAgent = async () =>
    okResult('maintenance done') as AgentRunResult
  maintenance = new MaintenanceRunner({
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    events,
    commitMutex: new Mutex(),
    runAgent: (opts) => maintAgent(opts),
    commit: async () => ({ committed: true, hash: 'abc12345', committedPages: ['wiki/meta/lint-report-2026-07-17.md'] }),
  })
  app = await buildServer({
    config: makeConfig(),
    store,
    chat,
    queue,
    events,
    maintenance,
    settings: new SettingsStore(db),
    runQuery: (input) => queryImpl(input),
    // These tests exercise route behaviour, not git; the temp vault is not a repo. The commit
    // path for vault-mutating routes is covered against a real repo in pages-write.test.ts.
    autoCommit: () => false,
    logger: false,
  })
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
    // Public route: must not leak filesystem layout.
    expect(body).not.toHaveProperty('vaultRoot')
  })
})

describe('setup mode (no credential)', () => {
  it('serves the API read-only-ish: health flags it, run-starting routes 503', async () => {
    const setupApp = await buildServer({
      config: { ...makeConfig(), auth: null },
      store,
      chat,
      queue: new IngestQueue({
        store,
        vaultRoot,
        auth: null,
        detectToolsFn: async () => NO_TOOLS,
      }),
      events,
      maintenance,
      settings: new SettingsStore(db),
      runQuery: (input) => queryImpl(input),
      autoCommit: () => false,
      logger: false,
    })
    try {
      const health = await setupApp.inject({ method: 'GET', url: '/api/v1/health' })
      expect(health.json()).toMatchObject({ status: 'ok', credentialConfigured: false })

      const settingsRes = await setupApp.inject({ method: 'GET', url: '/api/v1/settings' })
      expect(settingsRes.json()).toMatchObject({ readOnly: { credentialConfigured: 'no', authMode: 'none' } })

      const upload = await setupApp.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': 'application/json' },
        payload: { url: 'https://example.com/a' },
      })
      expect(upload.statusCode).toBe(503)

      const query = await setupApp.inject({
        method: 'POST',
        url: '/api/v1/query',
        headers: { 'content-type': 'application/json' },
        payload: { question: 'anything' },
      })
      expect(query.statusCode).toBe(503)

      const lint = await setupApp.inject({ method: 'POST', url: '/api/v1/maintenance/lint' })
      expect(lint.statusCode).toBe(503)
    } finally {
      await setupApp.close()
    }
  })

  it('a queue built without auth refuses to start (wiring backstop)', () => {
    const q = new IngestQueue({ store, vaultRoot, auth: null, detectToolsFn: async () => NO_TOOLS })
    expect(() => q.start()).toThrow(/setup mode/)
  })
})

describe('POST /api/v1/settings/credential', () => {
  let credFile: string
  let restarts: number
  let credApp: FastifyInstance

  const buildCredApp = async (auth: Config['auth']): Promise<FastifyInstance> =>
    buildServer({
      config: { ...makeConfig(), auth },
      store,
      chat,
      queue,
      events,
      maintenance,
      settings: new SettingsStore(db),
      runQuery: (input) => queryImpl(input),
      autoCommit: () => false,
      logger: false,
      credentialFile: credFile,
      scheduleRestart: () => {
        restarts++
      },
    })

  beforeEach(async () => {
    credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cred-')), 'env')
    restarts = 0
    credApp = await buildCredApp(null)
  })
  afterEach(async () => {
    await credApp.close()
    fs.rmSync(path.dirname(credFile), { recursive: true, force: true })
  })

  const post = (payload: object) =>
    credApp.inject({
      method: 'POST',
      url: '/api/v1/settings/credential',
      headers: { 'content-type': 'application/json' },
      payload,
    })

  it('writes the oauth token into the env file (0600), preserving other keys, dropping the rival var', async () => {
    fs.writeFileSync(credFile, 'PORT=9999\nANTHROPIC_API_KEY=old-key-to-drop\n')
    const token = `sk-ant-oat01-${'a'.repeat(24)}`
    const res = await post({ kind: 'oauth', value: token })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, envVar: 'CLAUDE_CODE_OAUTH_TOKEN', restart: 'manual' })
    expect(res.body).not.toContain(token)

    const written = fs.readFileSync(credFile, 'utf8')
    expect(written).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${token}`)
    expect(written).toContain('PORT=9999')
    expect(written).not.toContain('ANTHROPIC_API_KEY')
    expect(fs.statSync(credFile).mode & 0o777).toBe(0o600)
  })

  it('rejects a kind/prefix mismatch with guidance, without echoing the value', async () => {
    const apiKey = `sk-ant-api03-${'b'.repeat(24)}`
    const res = await post({ kind: 'oauth', value: apiKey })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/API key/)
    expect(res.body).not.toContain(apiKey)
    expect(fs.existsSync(credFile)).toBe(false)

    const swapped = await post({ kind: 'api-key', value: `sk-ant-oat01-${'c'.repeat(24)}` })
    expect(swapped.statusCode).toBe(400)
    expect(swapped.json().error).toMatch(/subscription token/)
  })

  it('rejects junk values (whitespace, too short)', async () => {
    expect((await post({ kind: 'oauth', value: 'short' })).statusCode).toBe(400)
    expect((await post({ kind: 'oauth', value: `sk-ant-oat01 ${'d'.repeat(24)}` })).statusCode).toBe(400)
  })

  it('409s when the credential comes from the process environment', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'from-shell'
    try {
      const res = await post({ kind: 'oauth', value: `sk-ant-oat01-${'e'.repeat(24)}` })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/process environment/)
    } finally {
      delete process.env['ANTHROPIC_API_KEY']
    }
  })

  it('schedules the restart under systemd and reports restart:auto', async () => {
    process.env['INVOCATION_ID'] = 'test-invocation'
    try {
      const res = await post({ kind: 'api-key', value: `sk-ant-api03-${'f'.repeat(24)}` })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ restart: 'auto' })
      expect(restarts).toBe(1)
    } finally {
      delete process.env['INVOCATION_ID']
    }
  })
})

describe('telegram settings endpoint (SPEC.md §4.3)', () => {
  let envFile: string
  let restarts: number
  let tgApp: FastifyInstance

  const buildTgApp = async (telegram: Config['telegram'] = null): Promise<FastifyInstance> =>
    buildServer({
      config: { ...makeConfig(), telegram },
      store,
      chat,
      queue,
      events,
      maintenance,
      settings: new SettingsStore(db),
      runQuery: (input) => queryImpl(input),
      autoCommit: () => false,
      logger: false,
      credentialFile: envFile,
      scheduleRestart: () => {
        restarts++
      },
    })

  beforeEach(async () => {
    envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-env-')), 'env')
    restarts = 0
    tgApp = await buildTgApp()
  })
  afterEach(async () => {
    await tgApp.close()
    fs.rmSync(path.dirname(envFile), { recursive: true, force: true })
  })

  const post = (payload: object) =>
    tgApp.inject({
      method: 'POST',
      url: '/api/v1/settings/telegram',
      headers: { 'content-type': 'application/json' },
      payload,
    })

  const TOKEN = `123456789:${'A'.repeat(34)}`

  it('writes BOTH variables into the env file (0600), preserving other keys, echoing nothing', async () => {
    fs.writeFileSync(envFile, 'PORT=9999\n')
    const res = await post({ botToken: TOKEN, allowedUserIds: ' 111 , 222 ' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, restart: 'manual' })
    expect(res.body).not.toContain(TOKEN)

    const written = fs.readFileSync(envFile, 'utf8')
    expect(written).toContain(`TELEGRAM_BOT_TOKEN=${TOKEN}`)
    expect(written).toContain('TELEGRAM_ALLOWED_USER_IDS=111,222') // normalized spacing
    expect(written).toContain('PORT=9999')
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600)
  })

  it('rejects a malformed token and username allowlists, without echoing the token', async () => {
    const bad = await post({ botToken: 'not-a-token', allowedUserIds: '111' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().issues.join(' ')).toMatch(/BotFather/)

    const usernames = await post({ botToken: TOKEN, allowedUserIds: '@benjamin' })
    expect(usernames.statusCode).toBe(400)
    expect(usernames.json().issues.join(' ')).toMatch(/not @usernames/)
    expect(usernames.body).not.toContain(TOKEN)
    expect(fs.existsSync(envFile)).toBe(false)
  })

  it('never produces the fail-closed startup state: token cannot be written without ids', async () => {
    const res = await post({ botToken: TOKEN })
    expect(res.statusCode).toBe(400)
    expect(fs.existsSync(envFile)).toBe(false)
  })

  it('409s when the variables come from the process environment', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'from-shell'
    try {
      const res = await post({ botToken: TOKEN, allowedUserIds: '111' })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/process environment/)
    } finally {
      delete process.env['TELEGRAM_BOT_TOKEN']
    }
  })

  it('DELETE removes both variables and keeps the rest of the file', async () => {
    fs.writeFileSync(envFile, `PORT=9999\nTELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_ALLOWED_USER_IDS=111\n`)
    const res = await tgApp.inject({ method: 'DELETE', url: '/api/v1/settings/telegram' })
    expect(res.statusCode).toBe(200)
    const written = fs.readFileSync(envFile, 'utf8')
    expect(written).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(written).not.toContain('TELEGRAM_ALLOWED_USER_IDS')
    expect(written).toContain('PORT=9999')
  })

  it('schedules the systemd restart and reports restart:auto', async () => {
    process.env['INVOCATION_ID'] = 'test-invocation'
    try {
      const res = await post({ botToken: TOKEN, allowedUserIds: '111' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ restart: 'auto' })
      expect(restarts).toBe(1)
    } finally {
      delete process.env['INVOCATION_ID']
    }
  })

  it('GET /settings/telegram serves the dropped-sender counters (never content, never the token)', async () => {
    const dropStore = new TelegramDropStore(db)
    dropStore.record(999, 'stranger')
    dropStore.record(999, 'stranger')
    const withDrops = await buildServer({
      config: makeConfig(),
      store,
      chat,
      queue,
      events,
      maintenance,
      settings: new SettingsStore(db),
      runQuery: (input) => queryImpl(input),
      autoCommit: () => false,
      logger: false,
      telegramDrops: dropStore,
    })
    try {
      const res = await withDrops.inject({ method: 'GET', url: '/api/v1/settings/telegram' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        configured: false,
        drops: [{ senderId: 999, username: 'stranger', count: 2 }],
      })
    } finally {
      await withDrops.close()
    }
    // Without an injected store the endpoint degrades to an empty list, not an error.
    const bare = await tgApp.inject({ method: 'GET', url: '/api/v1/settings/telegram' })
    expect(bare.json()).toEqual({ configured: false, drops: [] })
  })

  it('GET /settings reports bot status without ever carrying the token', async () => {
    const configured = await buildTgApp({ botToken: TOKEN, allowedUserIds: [111, 222] })
    try {
      const res = await configured.inject({ method: 'GET', url: '/api/v1/settings' })
      expect(res.statusCode).toBe(200)
      expect(res.json().readOnly.telegram).toBe('on (2 allowlisted users)')
      expect(res.body).not.toContain(TOKEN)
    } finally {
      await configured.close()
    }
    expect((await tgApp.inject({ method: 'GET', url: '/api/v1/settings' })).json().readOnly.telegram).toBe('off')
  })
})

describe('cross-origin guard', () => {
  it('rejects a state-changing request with a foreign Origin (drive-by CSRF)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ url: 'https://example.com/a' }),
    })
    expect(res.status).toBe(403)
  })

  it('treats Origin: null as foreign', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: JSON.stringify({ url: 'https://example.com/a' }),
    })
    expect(res.status).toBe(403)
  })

  it('allows the same-origin SPA and non-browser clients', async () => {
    const sameOrigin = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ url: 'https://example.com/same-origin' }),
    })
    expect(sameOrigin.status).toBe(202)
    // No Origin header at all (curl, systemd, scripts) — must keep working.
    const noOrigin = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/no-origin' }),
    })
    expect(noOrigin.status).toBe(202)
    // The Vite dev proxy forwards the browser's localhost:5173 origin with a rewritten Host.
    const devProxy = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ url: 'https://example.com/dev-proxy' }),
    })
    expect(devProxy.status).toBe(202)
  })

  it('leaves GET requests alone regardless of Origin', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`, { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(200)
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

  it('streams a payload-less vault event (the live-graph hint)', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    events.publish({ kind: 'vault' })

    let seen = ''
    for (let i = 0; i < 5 && !seen.includes('event: vault'); i++) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    controller.abort()
    expect(seen).toContain('event: vault\ndata: {}')
  })
})

describe('POST /api/v1/query + sessions', () => {
  it('answers, resolves citations to real pages, and persists the session', async () => {
    // A real wiki page so the [[Compound Interest]] citation resolves to a path.
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'Compound Interest.md'), '# Compound Interest')
    queryImpl = async () => okResult('Interest compounds — see [[Compound Interest]] and [[Nonexistent Page]].')

    const res = await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What is compound interest?' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessionId: string
      message: { role: string; content: string }
      citations: Array<{ label: string; path: string | null }>
    }
    expect(body.message.role).toBe('assistant')
    const resolved = body.citations.find((c) => c.label === 'Compound Interest')
    expect(resolved?.path).toBe('wiki/concepts/Compound Interest.md')
    const unresolved = body.citations.find((c) => c.label === 'Nonexistent Page')
    expect(unresolved?.path).toBeNull() // degrades to plain text, never a broken link

    // The session persisted the user + assistant messages.
    const detail = (await (await fetch(`${baseUrl}/api/v1/sessions/${body.sessionId}`)).json()) as {
      messages: Array<{ role: string }>
    }
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('continues an existing session and resumes the SDK session', async () => {
    let resumed: string | undefined
    queryImpl = async (input) => {
      resumed = input.resumeSessionId
      return okResult('follow-up answer')
    }
    const first = (await (
      await fetch(`${baseUrl}/api/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'first' }),
      })
    ).json()) as { sessionId: string }

    await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'second', sessionId: first.sessionId }),
    })
    expect(resumed).toBe('sdk-session-1') // the SDK session id from the first turn

    const missing = await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x', sessionId: 'nope' }),
    })
    expect(missing.status).toBe(404)
  })

  it('lists, renames, and deletes sessions', async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'my chat' }),
      })
    ).json()) as { session: { id: string; title: string } }
    expect(created.session.title).toBe('my chat')

    await fetch(`${baseUrl}/api/v1/sessions/${created.session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    })
    const list = (await (await fetch(`${baseUrl}/api/v1/sessions`)).json()) as {
      sessions: Array<{ id: string; title: string }>
    }
    expect(list.sessions.find((s) => s.id === created.session.id)?.title).toBe('renamed')

    const del = await fetch(`${baseUrl}/api/v1/sessions/${created.session.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const gone = await fetch(`${baseUrl}/api/v1/sessions/${created.session.id}`)
    expect(gone.status).toBe(404)
  })

  it('rejects an empty question', async () => {
    const res = await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '  ' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/pages (citation preview)', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'Foo.md'), '# Foo\n\nbody text')
    // A secret OUTSIDE the wiki, to prove the guard actually confines reads.
    fs.writeFileSync(path.join(vaultRoot, 'secret.md'), 'TOP SECRET')
  })

  it('returns the markdown of a wiki page', async () => {
    const res = await fetch(`${baseUrl}/api/v1/pages?path=wiki/concepts/Foo.md`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { markdown: string; truncated: boolean }
    expect(body.markdown).toContain('body text')
    expect(body.truncated).toBe(false)
  })

  it('refuses to read outside the wiki', async () => {
    // The path comes from agent-produced citations, so it is attacker-adjacent input.
    for (const p of [
      'secret.md',
      '../secret.md',
      'wiki/../secret.md',
      'wiki/concepts/../../secret.md',
      '/etc/passwd',
      '../../../../etc/passwd',
    ]) {
      const res = await fetch(`${baseUrl}/api/v1/pages?path=${encodeURIComponent(p)}`)
      expect(res.status, `${p} must be rejected`).toBe(400)
      expect(await res.text()).not.toContain('TOP SECRET')
    }
  })

  it('rejects non-markdown and missing paths', async () => {
    expect((await fetch(`${baseUrl}/api/v1/pages`)).status).toBe(400)
    expect((await fetch(`${baseUrl}/api/v1/pages?path=wiki/notes.txt`)).status).toBe(400)
    expect((await fetch(`${baseUrl}/api/v1/pages?path=wiki/nope.md`)).status).toBe(404)
  })
})

describe('POST /api/v1/sessions/:id/save', () => {
  const poll = async (id: string): Promise<{ status: string; result?: { ok: boolean; pages: string[] } }> => {
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${baseUrl}/api/v1/maintenance/runs/${id}`)
      const body = (await r.json()) as { status: string; result?: { ok: boolean; pages: string[] } }
      if (body.status !== 'running') return body
      await new Promise((res) => setTimeout(res, 5))
    }
    throw new Error('save run did not settle')
  }

  it('404s for an unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/v1/sessions/nope/save`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('400s when the session never completed a query (nothing to resume)', async () => {
    const created = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'empty' }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    const res = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/save`, { method: 'POST' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/nothing to save/)
  })

  it('resumes the chat SDK session under a WRITE profile and commits', async () => {
    // Ask something first so the session records an sdk_session_id to resume.
    await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'what is in the vault?' }),
    })
    const list = (await (await fetch(`${baseUrl}/api/v1/sessions`)).json()) as {
      sessions: Array<{ id: string }>
    }
    const sessionId = list.sessions[0]!.id

    let seen: { profile: string | undefined; resumeSessionId: string | undefined } = {
      profile: undefined,
      resumeSessionId: undefined,
    }
    maintAgent = async (opts) => {
      seen = { profile: opts.profile, resumeSessionId: opts.resumeSessionId }
      return okResult('saved')
    }

    const res = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/save`, { method: 'POST' })
    expect(res.status).toBe(202)
    const started = (await res.json()) as { id: string; kind: string; channel: string }
    expect(started.kind).toBe('save')
    expect(started.channel).toBe('maintenance:save')

    const run = await poll(started.id)
    expect(run.status).toBe('done')
    expect(run.result?.ok).toBe(true)
    // The chat is read-only by design, so the save must run write-enabled and carry the
    // conversation forward — otherwise it has nothing to write, or no permission to write it.
    expect(seen.profile).toBe('ingest')
    expect(seen.resumeSessionId).toBe('sdk-session-1')
  })
})

describe('GET/PUT /api/v1/settings', () => {
  interface SettingsResp {
    effective: { watchFolder: string; concurrency: number; maxUploadBytes: number; gitAutoCommit: boolean }
    baseline: { concurrency: number }
    overrides: Record<string, unknown>
    readOnly: Record<string, string>
    restartRequiredKeys: string[]
    pendingRestart?: string[]
  }
  const get = async (): Promise<SettingsResp> =>
    (await (await fetch(`${baseUrl}/api/v1/settings`)).json()) as SettingsResp
  const put = async (body: unknown): Promise<Response> =>
    fetch(`${baseUrl}/api/v1/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('reports effective/baseline/overrides and the key STATUS but never the credential', async () => {
    const body = await get()
    expect(body.overrides).toEqual({})
    expect(body.effective.concurrency).toBe(body.baseline.concurrency)
    expect(body.readOnly.authMode).toBe('oauth')
    expect(body.readOnly.credentialSource).toBe('CLAUDE_CODE_OAUTH_TOKEN')
    // Hard rule 3: only the STATUS is exposed — no field carries the credential value.
    expect(Object.keys(body.readOnly)).not.toContain('credential')
    expect(Object.keys(body.readOnly)).not.toContain('authToken')
    expect(body.readOnly.credentialConfigured).toBe('yes')
    expect(body.restartRequiredKeys.sort()).toEqual(['maxUploadBytes', 'watchFolder'])
  })

  it('applies a concurrency change live to the running queue', async () => {
    expect(queue.stats().concurrency).toBe(2)
    const res = await put({ concurrency: 4 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SettingsResp
    expect(body.effective.concurrency).toBe(4)
    expect(body.pendingRestart).toEqual([]) // concurrency is live, no restart needed
    expect(queue.stats().concurrency).toBe(4)
  })

  it('flags a restart-required key instead of pretending it applied', async () => {
    const res = await put({ watchFolder: '/tmp/other-inbox' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SettingsResp
    expect(body.effective.watchFolder).toBe('/tmp/other-inbox')
    expect(body.pendingRestart).toEqual(['watchFolder'])
  })

  it('rejects keys that would breach the bind or credential rules', async () => {
    const bindBefore = (await get()).readOnly.bind
    for (const bad of [{ host: '0.0.0.0' }, { port: 80 }, { CLAUDE_CODE_OAUTH_TOKEN: 'leak' }]) {
      const res = await put(bad)
      expect(res.status).toBe(400)
    }
    // The bind is unchanged by the rejected writes, and still loopback (hard rule 2).
    const after = await get()
    expect(after.readOnly.bind).toBe(bindBefore)
    expect(after.readOnly.bind ?? '').toMatch(/^127\.0\.0\.1:/)
    expect(after.overrides).toEqual({})
  })

  it('clears an override with null, falling back to the baseline', async () => {
    await put({ concurrency: 5 })
    expect((await get()).effective.concurrency).toBe(5)
    await put({ concurrency: null })
    const body = await get()
    expect(body.overrides.concurrency).toBeUndefined()
    expect(body.effective.concurrency).toBe(body.baseline.concurrency)
  })
})

describe('POST /api/v1/maintenance (async job-style)', () => {
  type StartedRun = { id: string; channel: string; status: string; kind: string }
  type PolledRun = {
    status: 'running' | 'done' | 'error'
    error?: string
    result?: {
      ok: boolean
      lint?: { summary: Record<string, number>; sections: Array<{ title: string; findings: unknown[] }>; totalFindings: number }
      reportPath?: string
    }
  }

  /** Polls the run endpoint until it settles (or a bounded number of tries elapses). */
  async function pollRun(id: string): Promise<PolledRun> {
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${baseUrl}/api/v1/maintenance/runs/${id}`)
      expect(r.status).toBe(200)
      const body = (await r.json()) as PolledRun
      if (body.status !== 'running') return body
      await new Promise((res) => setTimeout(res, 5))
    }
    throw new Error('maintenance run did not settle in time')
  }

  it('accepts a lint run immediately, then polls a structured, parsed report', async () => {
    // The lint agent writes a report file; the runner reads + parses it.
    maintAgent = async () => {
      fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
      fs.writeFileSync(
        path.join(vaultRoot, 'wiki', 'meta', 'lint-report-2026-07-17.md'),
        [
          '# Lint Report: 2026-07-17',
          '## Summary',
          '- Pages scanned: 94',
          '- Issues found: 2',
          '## Orphan Pages',
          '- [[Lonely Page]]: no inbound links.',
          '## Dead Links',
          '- [[Ghost]]: referenced in [[Some Page]] but does not exist.',
        ].join('\n'),
      )
      return okResult('lint done')
    }

    // POST returns at once with a run id — it does NOT hold the request for the run.
    const res = await fetch(`${baseUrl}/api/v1/maintenance/lint`, { method: 'POST' })
    expect(res.status).toBe(202)
    const started = (await res.json()) as StartedRun
    expect(started.channel).toBe('maintenance:lint')
    expect(started.status).toBe('running')
    expect(started.id).toBeTruthy()

    const run = await pollRun(started.id)
    expect(run.status).toBe('done')
    expect(run.result?.ok).toBe(true)
    expect(run.result?.lint?.summary['Pages scanned']).toBe(94)
    expect(run.result?.lint?.totalFindings).toBe(2)
    expect(run.result?.lint?.sections.map((s) => s.title)).toEqual(['Orphan Pages', 'Dead Links'])
    expect(run.result?.reportPath).toBe('wiki/meta/lint-report-2026-07-17.md')
  })

  it('lint-fix refuses without a report (409), else runs bounded by the newest report', async () => {
    // No wiki/meta/lint-report-*.md yet → nothing bounds the run → 409.
    const refused = await fetch(`${baseUrl}/api/v1/maintenance/lint-fix`, { method: 'POST' })
    expect(refused.status).toBe(409)

    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    fs.writeFileSync(
      path.join(vaultRoot, 'wiki', 'meta', 'lint-report-2026-07-18.md'),
      '# Lint Report: 2026-07-18\n## Frontmatter Gaps\n- [[Some Page]]: missing `status`.',
    )
    let prompt = ''
    maintAgent = async (opts) => {
      prompt = opts.prompt
      return okResult('fixed 1 finding')
    }

    const res = await fetch(`${baseUrl}/api/v1/maintenance/lint-fix`, { method: 'POST' })
    expect(res.status).toBe(202)
    const started = (await res.json()) as StartedRun
    expect(started.channel).toBe('maintenance:lint-fix')

    const run = await pollRun(started.id)
    expect(run.status).toBe('done')
    expect(run.result?.ok).toBe(true)
    // The prompt is BOUND to the newest report and pins the safe/needs-review split.
    expect(prompt).toContain('wiki/meta/lint-report-2026-07-18.md')
    expect(prompt).toContain('do NOT')
  })

  it('cleanup requires titles, bounds the run to them, and sanitizes the input', async () => {
    const bad = await fetch(`${baseUrl}/api/v1/maintenance/cleanup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages: [] }),
    })
    expect(bad.status).toBe(400)

    let prompt = ''
    let extra = ''
    maintAgent = async (opts) => {
      prompt = opts.prompt
      extra = opts.systemPromptExtra ?? ''
      return okResult('cleaned 2 references')
    }
    const res = await fetch(`${baseUrl}/api/v1/maintenance/cleanup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages: ['Espresso', '  Milk\nSteaming  ', 42, ''] }),
    })
    expect(res.status).toBe(202)
    const started = (await res.json()) as StartedRun
    expect(started.channel).toBe('maintenance:cleanup')

    const run = await pollRun(started.id)
    expect(run.status).toBe('done')
    // Bounded to exactly the sanitized titles; append-only records are protected.
    expect(prompt).toContain('"Espresso"')
    expect(prompt).toContain('"Milk Steaming"')
    expect(prompt).toContain('log.md')
    expect(prompt).toContain('address_map')
    // Write runs carry the page-hygiene checklist and entity-notability rules (prevention
    // side of the validator).
    expect(extra).toContain('<page_hygiene>')
    expect(extra).toContain('<entity_notability>')
  })

  it('repair validates tasks against the live graph and bounds the run to them', async () => {
    // A path that names no page in the live graph rejects the WHOLE request — the user
    // selected specific things, silently dropping one would repair less than they asked.
    const unknown = await fetch(`${baseUrl}/api/v1/maintenance/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ kind: 'connect', path: 'wiki/concepts/No Such Page.md' }] }),
    })
    expect(unknown.status).toBe(400)
    const badKind = await fetch(`${baseUrl}/api/v1/maintenance/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ kind: 'delete', path: 'wiki/index.md' }] }),
    })
    expect(badKind.status).toBe(400)

    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'Repair Island.md'), 'alone')
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'Repair Cake.md'), 'see [[Repair Fund]]')
    fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'Repair Fund.md'), 'x')

    let prompt = ''
    maintAgent = async (opts) => {
      prompt = opts.prompt
      return okResult('repaired')
    }
    const res = await fetch(`${baseUrl}/api/v1/maintenance/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tasks: [
          { kind: 'connect', path: 'wiki/concepts/Repair Island.md', reason: 'isolated  in\nknowledge view' },
          { kind: 'edge', from: 'wiki/concepts/Repair Cake.md', to: 'wiki/concepts/Repair Fund.md' },
        ],
      }),
    })
    expect(res.status).toBe(202)
    const started = (await res.json()) as StartedRun
    expect(started.channel).toBe('maintenance:repair')

    const run = await pollRun(started.id)
    expect(run.status).toBe('done')
    // Bounded to exactly the selected tasks; reasons are whitespace-collapsed; the prompt
    // pins the no-create/no-delete boundary.
    expect(prompt).toContain('CONNECT wiki/concepts/Repair Island.md')
    expect(prompt).toContain('isolated in knowledge view')
    expect(prompt).toContain('REVIEW LINK wiki/concepts/Repair Cake.md -> wiki/concepts/Repair Fund.md')
    expect(prompt).toContain('Do not create, delete, rename or merge')
  })

  it('research requires a topic; hot-cache starts and settles', async () => {
    const bad = await fetch(`${baseUrl}/api/v1/maintenance/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '  ' }),
    })
    expect(bad.status).toBe(400)

    const hot = await fetch(`${baseUrl}/api/v1/maintenance/hot-cache`, { method: 'POST' })
    expect(hot.status).toBe(202)
    const started = (await hot.json()) as StartedRun
    expect(started.status).toBe('running')

    const run = await pollRun(started.id)
    expect(run.status).toBe('done')
    expect(run.result?.ok).toBe(true)
  })

  it('lists research lenses and rejects an unknown lens', async () => {
    const list = await fetch(`${baseUrl}/api/v1/maintenance/research/profiles`)
    expect(list.status).toBe(200)
    const body = (await list.json()) as { profiles: { key: string }[]; default: string }
    expect(body.default).toBe('broad')
    expect(body.profiles.map((p) => p.key)).toEqual(expect.arrayContaining(['broad', 'sota', 'patents', 'startups']))

    const bad = await fetch(`${baseUrl}/api/v1/maintenance/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'lipids', profileKey: 'not-a-lens' }),
    })
    expect(bad.status).toBe(400)
  })

  it('injects the selected lens block (deterministic title) into the research prompt', async () => {
    let prompt = ''
    maintAgent = async (opts) => {
      prompt = opts.prompt
      return okResult('research done')
    }
    const res = await fetch(`${baseUrl}/api/v1/maintenance/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'ionizable lipids', profileKey: 'patents' }),
    })
    expect(res.status).toBe(202)
    const started = (await res.json()) as StartedRun
    expect(started.channel).toBe('maintenance:research')
    const run = await pollRun(started.id)
    expect(run.status).toBe('done')
    // The service pins the synthesis title deterministically; the agent does not choose it.
    expect(prompt).toContain('research_lens')
    expect(prompt).toContain('Research: ionizable lipids — Patent Landscape')
    expect(prompt).toMatch(/does NOT\s+override the page-hygiene/)
  })

  it('omitting the lens keeps the base research prompt (no lens block)', async () => {
    let prompt = ''
    maintAgent = async (opts) => {
      prompt = opts.prompt
      return okResult('research done')
    }
    const res = await fetch(`${baseUrl}/api/v1/maintenance/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'ionizable lipids' }),
    })
    expect(res.status).toBe(202)
    const run = await pollRun(((await res.json()) as StartedRun).id)
    expect(run.status).toBe('done')
    expect(prompt).not.toContain('research_lens')
  })

  it('returns 404 for an unknown run id', async () => {
    const res = await fetch(`${baseUrl}/api/v1/maintenance/runs/does-not-exist`)
    expect(res.status).toBe(404)
  })

  it('domain backfill 409s without a registry, and starts once one is installed', async () => {
    const before = await fetch(`${baseUrl}/api/v1/domains`)
    expect(((await before.json()) as { installed: boolean }).installed).toBe(false)

    const refused = await fetch(`${baseUrl}/api/v1/maintenance/domain-backfill`, { method: 'POST' })
    expect(refused.status).toBe(409)

    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    fs.writeFileSync(
      path.join(vaultRoot, 'wiki', 'meta', 'domains.md'),
      '## Domains\n\n## biomedicine\n\nBiology.\n\n**Tags:** `biomedical`\n',
    )

    const listed = (await (await fetch(`${baseUrl}/api/v1/domains`)).json()) as {
      installed: boolean
      domains: Array<{ key: string }>
    }
    expect(listed.installed).toBe(true)
    expect(listed.domains.map((d) => d.key)).toEqual(['biomedicine'])

    const started = await fetch(`${baseUrl}/api/v1/maintenance/domain-backfill`, { method: 'POST' })
    expect(started.status).toBe(202)
    expect(((await started.json()) as StartedRun).status).toBe('running')
  })
})

describe('domain governance (SPEC §12.4 Stufe 3)', () => {
  type StartedRun = { id: string; channel: string; status: string; kind: string }
  const registryPath = (): string => path.join(vaultRoot, 'wiki', 'meta', 'domains.md')

  function seedRegistry(): void {
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
    fs.writeFileSync(registryPath(), '## Domains\n\n## biomedicine\n\nBio.\n\n**Tags:** `biomedical`\n')
  }

  /** N unassigned pages sharing a tag — the shape the finder is meant to surface. */
  function seedUnassigned(count: number, tag: string): void {
    const dir = path.join(vaultRoot, 'wiki', 'concepts')
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(
        path.join(dir, `Cand${i}.md`),
        `---\ntags:\n  - ${tag}\ndomain: unassigned\n---\n\n# Cand${i}\n`,
      )
    }
  }

  it('surfaces a candidate, then stops after it is dismissed, and returns on restore', async () => {
    seedRegistry()
    seedUnassigned(6, 'design')

    const first = (await (await fetch(`${baseUrl}/api/v1/domains/candidates`)).json()) as {
      candidates: Array<{ key: string; pageCount: number }>
      unassignedCount: number
    }
    expect(first.candidates.map((c) => c.key)).toEqual(['design'])
    expect(first.candidates[0]!.pageCount).toBe(6)
    expect(first.unassignedCount).toBe(6)

    await fetch(`${baseUrl}/api/v1/domains/candidates/design/dismiss`, { method: 'POST' })
    const after = (await (await fetch(`${baseUrl}/api/v1/domains/candidates`)).json()) as {
      candidates: unknown[]
      dismissed: Array<{ key: string }>
    }
    expect(after.candidates).toEqual([])
    expect(after.dismissed.map((d) => d.key)).toEqual(['design'])

    await fetch(`${baseUrl}/api/v1/domains/candidates/design/dismiss`, { method: 'DELETE' })
    const restored = (await (await fetch(`${baseUrl}/api/v1/domains/candidates`)).json()) as {
      candidates: Array<{ key: string }>
    }
    expect(restored.candidates.map((c) => c.key)).toEqual(['design'])
  })

  it('creates a domain by appending to the registry page, and rejects duplicates and bad keys', async () => {
    seedRegistry()

    const bad = await fetch(`${baseUrl}/api/v1/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'Not A Key', description: 'x' }),
    })
    expect(bad.status).toBe(400)

    const created = await fetch(`${baseUrl}/api/v1/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'history', description: 'The past.', tags: ['history'] }),
    })
    expect(created.status).toBe(200)

    // The registry page itself must now parse with the new domain in it.
    const listed = (await (await fetch(`${baseUrl}/api/v1/domains`)).json()) as {
      domains: Array<{ key: string; description: string; tags: string[] }>
    }
    expect(listed.domains.map((d) => d.key)).toEqual(['biomedicine', 'history'])
    expect(listed.domains[1]).toMatchObject({ description: 'The past.', tags: ['history'] })

    const dup = await fetch(`${baseUrl}/api/v1/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'history', description: 'again' }),
    })
    expect(dup.status).toBe(409)
  })

  it('accepting a candidate dismisses it, so it does not reappear before the backfill runs', async () => {
    seedRegistry()
    seedUnassigned(6, 'design')

    await fetch(`${baseUrl}/api/v1/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'design',
        description: 'Visual design.',
        tags: ['design'],
        dismissCandidate: 'design',
      }),
    })

    const after = (await (await fetch(`${baseUrl}/api/v1/domains/candidates`)).json()) as {
      candidates: unknown[]
    }
    expect(after.candidates).toEqual([])
  })

  it('the agent review refuses to start when there is nothing to judge', async () => {
    seedRegistry()
    const res = await fetch(`${baseUrl}/api/v1/maintenance/domain-review`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('the agent review starts once candidates exist', async () => {
    seedRegistry()
    seedUnassigned(6, 'design')
    const res = await fetch(`${baseUrl}/api/v1/maintenance/domain-review`, { method: 'POST' })
    expect(res.status).toBe(202)
    expect(((await res.json()) as StartedRun).kind).toBe('domain-review')
  })
})
