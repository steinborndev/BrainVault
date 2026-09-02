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
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'
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
 * The SSE route holds one socket per dashboard tab for as long as the tab lives. A cap
 * per client address keeps a single visitor (or a script) from pinning the process with
 * an unbounded number of open streams - and a released stream must free its slot again.
 */
describe('event stream cap per client', () => {
  let db: Db
  let app: FastifyInstance
  let vaultRoot: string
  let baseUrl: string

  const config = (): Config => ({
    vaultRoot,
    obsidianVaultName: 'vault',
    auth: null,
    telegram: null,
    demoMode: false,
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
    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: null,
      events,
      detectToolsFn: async () => NO_TOOLS,
      commit: async () => ({ committed: false, hash: '', committedPages: [] }),
      refreshHotCache: async () => 'noop',
      runIngest: async () => {
        throw new Error('not reached')
      },
    })
    const maintenance = new MaintenanceRunner({
      vaultRoot,
      auth: null,
      events,
      commitMutex: new Mutex(),
      runAgent: async () => {
        throw new Error('not reached')
      },
      commit: async () => ({ committed: false, hash: '', committedPages: [] }),
    })
    app = await buildServer({
      config: config(),
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

  it('refuses the ninth concurrent stream and frees the slot when one closes', async () => {
    const controllers: AbortController[] = []
    const openStream = async (): Promise<number> => {
      const ac = new AbortController()
      controllers.push(ac)
      // fetch resolves once headers arrive; the body stays open, which is the whole point.
      const res = await fetch(`${baseUrl}/api/v1/events`, { signal: ac.signal })
      return res.status
    }
    try {
      const first = []
      for (let i = 0; i < 8; i++) first.push(await openStream())
      expect(first).toEqual(Array(8).fill(200))

      const ninth = await fetch(`${baseUrl}/api/v1/events`)
      expect(ninth.status).toBe(429)
      expect(ninth.headers.get('retry-after')).toBe('30')
      expect(((await ninth.json()) as { error: string }).error).toBe('too_many_streams')

      // Dropping one stream releases its slot for the next visitor tab.
      controllers[0]!.abort()
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(await openStream()).toBe(200)
    } finally {
      for (const ac of controllers) ac.abort()
    }
  })
})
