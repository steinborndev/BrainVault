import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue, classifyFailure, guessType, type IngestRunner } from '../src/pipeline/queue.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const NO_TOOLS: ToolAvailability = {
  pdftotext: false,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: false,
  python3: false,
  exiftool: false,
  defuddle: false,
}

function okResult(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    ok: true,
    result: 'ingest done',
    usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.01 },
    durationMs: 1000,
    numTurns: 5,
    sessionId: 's1',
    timedOut: false,
    ...over,
  }
}
function failResult(error: string, over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    ok: false,
    result: '',
    usage: { tokensIn: 5, tokensOut: 0, costUsd: 0 },
    durationMs: 100,
    numTurns: 1,
    sessionId: 's1',
    timedOut: false,
    error,
    ...over,
  }
}

let db: Db
let store: JobStore
let vaultRoot: string
let srcDir: string
let commitCalls: string[]
let commitPathspecs: string[][]
let pausedTimers: Array<() => void>

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'))
  commitCalls = []
  commitPathspecs = []
  pausedTimers = []
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
})

function writeSource(name: string, content = 'hello'): string {
  const p = path.join(srcDir, name)
  fs.writeFileSync(p, content)
  return p
}

interface QueueOverrides {
  runIngest?: IngestRunner
  concurrency?: number
  maxRetries?: number
}

function makeQueue(over: QueueOverrides = {}): IngestQueue {
  return new IngestQueue({
    store,
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    concurrency: over.concurrency ?? 2,
    maxRetries: over.maxRetries ?? 2,
    detectToolsFn: async () => NO_TOOLS,
    commit: async (_root, message, opts) => {
      commitCalls.push(message)
      commitPathspecs.push([...(opts?.pathspec ?? [])])
      return { committed: true, hash: 'abcd1234ef', committedPages: ['wiki/concepts/Foo.md'] }
    },
    refreshHotCache: async () => 'hot cache noted',
    setTimeoutFn: (fn) => void pausedTimers.push(fn),
    runIngest: over.runIngest ?? (async () => okResult()),
  })
}

describe('pure helpers', () => {
  it('guessType maps extensions', () => {
    expect(guessType('a.pdf')).toBe('pdf')
    expect(guessType('a.docx')).toBe('office')
    expect(guessType('a.png')).toBe('image')
    expect(guessType('a.mp3')).toBe('av')
    expect(guessType('a.zip')).toBe('other')
    expect(guessType('a.md')).toBe('text')
  })
  it('classifyFailure distinguishes rate-limit, transient and permanent', () => {
    expect(classifyFailure(failResult('rate limit exceeded (429)'))).toBe('rate_limit')
    expect(classifyFailure(failResult('fetch failed ECONNRESET'))).toBe('transient')
    expect(classifyFailure(okResult({ ok: false, timedOut: true }))).toBe('transient')
    expect(classifyFailure(failResult('run consumed zero tokens — auth failure'))).toBe('permanent')
  })
})

describe('happy path', () => {
  it('drives a text file to done, commits, records pages/tokens, and persists the stream', async () => {
    const messages: SDKMessage[] = []
    const runIngest: IngestRunner = async (opts) => {
      const m = { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } } as unknown as SDKMessage
      messages.push(m)
      opts.onMessage(m)
      return okResult()
    }
    const q = makeQueue({ runIngest })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()

    const done = store.getOrThrow(job.id)
    expect(done.status).toBe('done')
    expect(done.type).toBe('text')
    expect(done.tokens_in).toBe(100)
    expect(JSON.parse(done.created_pages!)).toEqual(['wiki/concepts/Foo.md'])
    expect(commitCalls).toEqual(['ingest: note.md'])
    const logMessages = store.logs(job.id).map((l) => l.message)
    expect(logMessages.some((m) => m.includes('working'))).toBe(true)
    expect(logMessages.some((m) => m.includes('committed abcd1234'))).toBe(true)
    expect(logMessages.some((m) => m.includes('hot cache noted'))).toBe(true)
  })

  it('stages the shared bookkeeping paths so the vault does not stay dirty (regression)', async () => {
    // wiki-ingest rewrites .raw/.manifest.json as its delta tracker on every run. It was
    // missing from the pathspec, so each ingest left the vault permanently dirty
    // (TASKS-M5 §0). Both bookkeeping paths must ride along with the ingest commit.
    const q = makeQueue()
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('note.md'), source: 'drop' })
    await q.onIdle()

    expect(store.getOrThrow(job.id).status).toBe('done')
    expect(commitPathspecs).toHaveLength(1)
    expect(commitPathspecs[0]).toEqual(expect.arrayContaining(['.vault-meta', '.raw/.manifest.json']))
  })

  it('routes a URL job by its url, not its source channel (regression)', async () => {
    // A URL dropped via the CLI/dashboard has source 'drop' but must still preprocess as
    // a web job. Injecting preprocessUrlFn avoids real network.
    let urlSeen: string | undefined
    const q = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      detectToolsFn: async () => NO_TOOLS,
      commit: async () => ({ committed: true, hash: 'h', committedPages: ['wiki/x.md'] }),
      refreshHotCache: async () => 'noop',
      runIngest: async () => okResult(),
      preprocessUrlFn: async (input) => {
        urlSeen = input.url
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
    q.start()
    const { job } = q.enqueueUrl({ url: 'https://example.com/x', source: 'drop' })
    await q.onIdle()
    expect(urlSeen).toBe('https://example.com/x')
    expect(store.getOrThrow(job.id).status).toBe('done')
  })

  it('skips ingest for a duplicate', async () => {
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    const src = writeSource('dup.md', 'same bytes')
    await q.enqueueFile({ sourcePath: src, source: 'drop' })
    const second = await q.enqueueFile({ sourcePath: src, source: 'watch' })
    await q.onIdle()
    expect(second.job.status).toBe('duplicate')
    expect(runs).toBe(1)
  })
})

describe('deferred', () => {
  it('defers audio and moves the original to .raw/deferred/', async () => {
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('talk.mp3', 'ID3'), source: 'drop' })
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('deferred')
    expect(runs).toBe(0)
    expect(fs.existsSync(path.join(vaultRoot, '.raw', 'deferred', `${job.id}-talk.mp3`))).toBe(true)
  })
})

describe('retry and failure', () => {
  it('retries a transient failure, then succeeds', async () => {
    let n = 0
    const q = makeQueue({
      runIngest: async () => (n++ === 0 ? failResult('fetch failed') : okResult()),
    })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await q.onIdle()
    const done = store.getOrThrow(job.id)
    expect(done.status).toBe('done')
    expect(done.attempts).toBe(2)
  })

  it('gives up after maxRetries on persistent transient failures', async () => {
    const q = makeQueue({ runIngest: async () => failResult('ETIMEDOUT'), maxRetries: 2 })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await q.onIdle()
    const failed = store.getOrThrow(job.id)
    expect(failed.status).toBe('failed')
    expect(failed.attempts).toBe(3) // initial + 2 retries
  })

  it('does not retry a permanent failure', async () => {
    let n = 0
    const q = makeQueue({ runIngest: async () => (n++, failResult('run consumed zero tokens — auth')) })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('failed')
    expect(n).toBe(1)
  })
})

describe('rate-limit pause', () => {
  it('pauses on a usage-limit signal, and a pause does not burn a retry', async () => {
    let n = 0
    const q = makeQueue({ runIngest: async () => (n++ === 0 ? failResult('rate limit (429)') : okResult()) })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md'), source: 'drop' })
    await q.onIdle() // settles once the job is re-queued and the queue paused

    expect(q.isPaused).toBe(true)
    expect(store.getOrThrow(job.id).status).toBe('queued')
    expect(pausedTimers).toHaveLength(1)

    // Fire the auto-resume timer.
    pausedTimers[0]!()
    await q.onIdle()

    const done = store.getOrThrow(job.id)
    expect(done.status).toBe('done')
    expect(done.attempts).toBe(1) // the failed rate-limited attempt was refunded
  })
})

describe('batching', () => {
  it('preprocesses members individually then runs ONE combined ingest', async () => {
    const prompts: string[] = []
    let runs = 0
    const q = makeQueue({
      runIngest: async (o) => {
        runs++
        prompts.push(o.prompt)
        return okResult()
      },
    })
    q.start()
    const a = writeSource('a.md', 'alpha')
    const b = writeSource('b.md', 'bravo')
    const { batchId, jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: a },
        { kind: 'file', sourcePath: b },
      ],
      'drop',
    )
    await q.onIdle()

    expect(runs).toBe(1) // one combined run, not one per file
    expect(prompts[0]).toContain('ingest all of these')
    expect(prompts[0]).toContain('.raw/')
    for (const r of jobs) {
      const job = store.getOrThrow(r.job.id)
      expect(job.status).toBe('done')
      expect(job.batch_id).toBe(batchId)
    }
    expect(commitCalls).toHaveLength(1) // one commit for the whole batch
  })

  it('defers an unsupported member without sinking the batch', async () => {
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    const a = writeSource('a.md', 'alpha')
    const mp3 = writeSource('song.mp3', 'ID3 audio')
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: a },
        { kind: 'file', sourcePath: mp3 },
      ],
      'drop',
    )
    await q.onIdle()
    expect(runs).toBe(1)
    const statuses = jobs.map((r) => store.getOrThrow(r.job.id).status).sort()
    expect(statuses).toEqual(['deferred', 'done'])
  })

  it('retries a transient batch failure then succeeds', async () => {
    let n = 0
    const q = makeQueue({ runIngest: async () => (n++ === 0 ? failResult('ETIMEDOUT') : okResult()) })
    q.start()
    const a = writeSource('a.md', 'alpha')
    const b = writeSource('b.md', 'bravo')
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: a },
        { kind: 'file', sourcePath: b },
      ],
      'drop',
    )
    await q.onIdle()
    expect(n).toBe(2)
    for (const r of jobs) expect(store.getOrThrow(r.job.id).status).toBe('done')
  })

  it('splits usage across members so aggregate totals are not inflated', async () => {
    const q = makeQueue({
      runIngest: async () => okResult({ usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.02 } }),
    })
    q.start()
    const a = writeSource('a.md', 'alpha')
    const b = writeSource('b.md', 'bravo')
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: a },
        { kind: 'file', sourcePath: b },
      ],
      'drop',
    )
    await q.onIdle()
    const totalIn = jobs.reduce((s, r) => s + (store.getOrThrow(r.job.id).tokens_in ?? 0), 0)
    expect(totalIn).toBe(100) // 50 + 50, not 200
  })
})

describe('concurrency', () => {
  it('runs at most `concurrency` ingests at once and completes all', async () => {
    let inFlight = 0
    let peak = 0
    const runIngest: IngestRunner = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return okResult()
    }
    const q = makeQueue({ runIngest, concurrency: 2 })
    q.start()
    for (let i = 0; i < 5; i++) {
      await q.enqueueFile({ sourcePath: writeSource(`f${i}.md`, `body ${i}`), source: 'drop' })
    }
    await q.onIdle()
    expect(peak).toBe(2)
    expect(store.listByStatus('done')).toHaveLength(5)
  })
})
