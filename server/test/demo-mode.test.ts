import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net, { type AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { SettingsStore } from '../src/db/settings.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import { loadConfig, type Config } from '../src/config.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'

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

/**
 * DEMO MODE (SPEC.md §12.8): the read-only guarantee is ONE central request guard, so the
 * tests assert the boundary itself - reads pass, every write verb on the API is refused -
 * rather than enumerating individual routes.
 */

describe('config: DEMO_MODE flag', () => {
  let vaultRoot: string
  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
    // validateVaultRoot requires the claude-obsidian markers.
    fs.mkdirSync(path.join(vaultRoot, 'wiki'), { recursive: true })
    fs.mkdirSync(path.join(vaultRoot, 'skills'), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('defaults to off', () => {
    const config = loadConfig({ env: { VAULT_ROOT: vaultRoot }, envFile: false })
    expect(config.demoMode).toBe(false)
  })

  it.each(['1', 'true', 'yes'])('turns on for DEMO_MODE=%s', (value) => {
    const config = loadConfig({ env: { VAULT_ROOT: vaultRoot, DEMO_MODE: value }, envFile: false })
    expect(config.demoMode).toBe(true)
  })

  it('stays off for other values', () => {
    const config = loadConfig({ env: { VAULT_ROOT: vaultRoot, DEMO_MODE: '0' }, envFile: false })
    expect(config.demoMode).toBe(false)
  })
})

describe('demo mode API guard', () => {
  let db: Db
  let app: FastifyInstance
  let queue: IngestQueue
  let vaultRoot: string
  let baseUrl: string

  const demoConfig = (): Config => ({
    vaultRoot,
    obsidianVaultName: 'vault',
    // A demo instance runs without a credential by design.
    auth: null,
    telegram: null,
    demoMode: true,
    server: {
      host: '127.0.0.1',
      port: 0,
      watchFolder: path.join(vaultRoot, 'inbox'),
      maxUploadBytes: 10 * 1024 * 1024,
      authMode: 'local-single-user',
    },
  })

  beforeEach(async () => {
    db = openDb(MEMORY_DB)
    const events = new EventBus()
    const store = new JobStore(db, events)
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki'), { recursive: true })
    queue = new IngestQueue({
      store,
      vaultRoot,
      auth: null,
      events,
      detectToolsFn: async () => NO_TOOLS,
      commit: async () => ({ committed: false, hash: '', committedPages: [] }),
      refreshHotCache: async () => 'noop',
      runIngest: async () => {
        throw new Error('demo mode must never reach an ingest run')
      },
    })
    const maintenance = new MaintenanceRunner({
      vaultRoot,
      auth: null,
      events,
      commitMutex: new Mutex(),
      runAgent: async () => {
        throw new Error('demo mode must never reach an agent run')
      },
      commit: async () => ({ committed: false, hash: '', committedPages: [] }),
    })
    app = await buildServer({
      config: demoConfig(),
      store,
      chat: new ChatStore(db),
      queue,
      events,
      maintenance,
      settings: new SettingsStore(db),
      autoCommit: () => false,
      logger: false,
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await app.close()
    db.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('advertises demo mode on the health route', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { demoMode: boolean }
    expect(body.demoMode).toBe(true)
  })

  it('keeps the filesystem layout out of the settings view', async () => {
    const res = await fetch(`${baseUrl}/api/v1/settings`)
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text) as { readOnly: Record<string, string>; effective: { watchFolder: string } }
    expect(body.readOnly).not.toHaveProperty('vaultRoot')
    expect(body.readOnly).not.toHaveProperty('bind')
    expect(body.effective.watchFolder).toBe('(hidden in demo)')
    expect(text).not.toContain(vaultRoot)
    // The status fields a visitor may legitimately see stay in place.
    expect(body.readOnly.credentialConfigured).toBe('no')
  })

  it('keeps read routes open', async () => {
    for (const route of ['/api/v1/stats', '/api/v1/graph', '/api/v1/jobs']) {
      const res = await fetch(`${baseUrl}${route}`)
      expect(res.status, route).toBe(200)
    }
  })

  it.each([
    ['POST', '/api/v1/jobs'],
    ['POST', '/api/v1/maintenance/lint'],
    ['POST', '/api/v1/query'],
    ['PUT', '/api/v1/pages'],
    ['DELETE', '/api/v1/pages'],
    ['PUT', '/api/v1/settings'],
    ['POST', '/api/v1/settings/credential'],
    ['POST', '/api/v1/domains'],
  ])('refuses %s %s with 403', async (method, route) => {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('demo_read_only')
  })

  // The guard classifies by verb alone, so the spelling of the path must not matter. The
  // router decodes percent-encoding before matching, a proxy may or may not collapse
  // duplicate slashes, and a path outside the API prefix is a write all the same.
  it.each([
    ['PUT', '/%61pi/v1/pages'],
    ['DELETE', '/%61pi/v1/jobs/does-not-exist'],
    ['PUT', '//api/v1/pages'],
    ['PUT', '/API/v1/pages'],
    ['POST', '/api/v1/pages/../pages'],
    ['POST', '/not-the-api'],
    ['POST', '/'],
  ])('refuses %s %s however the path is spelled', async (method, route) => {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status, `${method} ${route}`).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('demo_read_only')
  })

  it('refuses a write sent with an absolute-form request target', async () => {
    // fetch always sends origin-form targets, so this one goes over a raw socket.
    const { port } = app.server.address() as AddressInfo
    const statusLine = await new Promise<string>((resolve, reject) => {
      let raw = ''
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          `DELETE http://127.0.0.1:${port}/api/v1/jobs/does-not-exist HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
        )
      })
      socket.on('data', (chunk: Buffer) => {
        raw += chunk.toString()
      })
      socket.on('end', () => resolve(raw.split('\r\n')[0] ?? ''))
      socket.on('error', reject)
    })
    expect(statusLine).toBe('HTTP/1.1 403 Forbidden')
  })

  it('does not let a method override header turn a read into a write', async () => {
    const res = await fetch(`${baseUrl}/api/v1/stats`, {
      headers: { 'x-http-method-override': 'DELETE' },
    })
    // The header is ignored rather than honoured: the request stays the GET it is.
    expect(res.status).toBe(200)
  })
})
