import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startWatcher, type Watcher } from '../src/pipeline/watcher.js'
import type { IngestQueue, BatchItem } from '../src/pipeline/queue.js'
import type { Config } from '../src/config.js'

let inbox: string
let watcher: Watcher | undefined

interface Recorder {
  batches: BatchItem[][]
  files: string[]
  urls: string[]
}

function stubQueue(rec: Recorder): IngestQueue {
  return {
    enqueueBatch: async (items: readonly BatchItem[]) => {
      rec.batches.push([...items])
      return { batchId: 'b', jobs: [] }
    },
    enqueueFile: async (input: { originalName?: string; sourcePath: string }) => {
      rec.files.push(input.originalName ?? input.sourcePath)
      return { job: { id: 'j', status: 'queued' } }
    },
    enqueueUrl: (input: { url: string }) => {
      rec.urls.push(input.url)
      return { job: { id: 'j', status: 'queued' } }
    },
  } as unknown as IngestQueue
}

function makeConfig(): Config {
  return {
    vaultRoot: inbox,
    auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
    server: {
      host: '127.0.0.1',
      port: 0,
      watchFolder: inbox,
      maxUploadBytes: 1024,
      authMode: 'local-single-user',
    },
  }
}

beforeEach(() => {
  inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'))
})
afterEach(async () => {
  await watcher?.close()
  watcher = undefined
  fs.rmSync(inbox, { recursive: true, force: true })
})

const drop = (name: string, content = 'x'): void => {
  fs.writeFileSync(path.join(inbox, name), content)
}

describe('watch folder batching', () => {
  it('groups files that arrive together into one batch', async () => {
    const rec: Recorder = { batches: [], files: [], urls: [] }
    watcher = startWatcher({
      queue: stubQueue(rec),
      config: makeConfig(),
      log: () => {},
      stabilityMs: 40,
      batchQuietMs: 120,
      batchMaxMs: 2000,
    })
    drop('one.md', 'a')
    drop('two.md', 'b')
    drop('three.md', 'c')

    await vi.waitFor(() => expect(rec.batches.length).toBe(1), { timeout: 3000 })
    expect(rec.batches[0]).toHaveLength(3)
    // Inbox emptied after enqueue.
    expect(fs.readdirSync(inbox)).toHaveLength(0)
  })

  it('enqueues a lone file individually, not as a batch', async () => {
    const rec: Recorder = { batches: [], files: [], urls: [] }
    watcher = startWatcher({
      queue: stubQueue(rec),
      config: makeConfig(),
      log: () => {},
      stabilityMs: 40,
      batchQuietMs: 120,
      batchMaxMs: 2000,
    })
    drop('solo.md', 'hello')

    await vi.waitFor(() => expect(rec.files.length).toBe(1), { timeout: 3000 })
    expect(rec.batches).toHaveLength(0)
    expect(rec.files[0]).toBe('solo.md')
  })

  it('unwraps a .url shortcut in the watch folder to a URL job', async () => {
    const rec: Recorder = { batches: [], files: [], urls: [] }
    watcher = startWatcher({
      queue: stubQueue(rec),
      config: makeConfig(),
      log: () => {},
      stabilityMs: 40,
      batchQuietMs: 120,
      batchMaxMs: 2000,
    })
    drop('link.url', '[InternetShortcut]\nURL=https://example.com/z\n')

    await vi.waitFor(() => expect(rec.urls.length).toBe(1), { timeout: 3000 })
    expect(rec.urls[0]).toBe('https://example.com/z')
  })
})
