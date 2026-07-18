/**
 * Regression tests for the deep-review fix wave (2026-07-18): SSRF address pinning,
 * usage accumulation across attempts, the filterable job list, batch-enqueue robustness,
 * the watch-folder size cap, and rate-limit reset-time parsing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue, parseRetryAfterMs, type IngestRunner } from '../src/pipeline/queue.js'
import { pinnedRequest, type ValidatedUrl } from '../src/pipeline/preprocess/web.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'
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

let db: Db
let store: JobStore
let vaultRoot: string
let srcDir: string

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'))
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

function makeQueue(over: { runIngest?: IngestRunner } = {}): IngestQueue {
  return new IngestQueue({
    store,
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    detectToolsFn: async () => NO_TOOLS,
    commit: async () => ({ committed: true, hash: 'abcd1234ef', committedPages: [] }),
    refreshHotCache: async () => 'noted',
    setTimeoutFn: () => {},
    runIngest: over.runIngest ?? (async () => okResult()),
  })
}

describe('parseRetryAfterMs (SPEC.md §7.1 expected release time)', () => {
  const now = Date.parse('2026-07-18T12:00:00Z')

  it('reads a retry-after seconds echo', () => {
    expect(parseRetryAfterMs('429 too many requests, retry-after: 90', now)).toBe(90_000)
    expect(parseRetryAfterMs('Retry After 5', now)).toBe(5_000)
  })

  it('reads the usage-limit epoch marker', () => {
    const epoch = Math.floor(now / 1000) + 600
    expect(parseRetryAfterMs(`Claude AI usage limit reached|${epoch}`, now)).toBe(600_000)
  })

  it('reads an ISO reset time and ignores one in the past', () => {
    expect(parseRetryAfterMs('quota resets at 2026-07-18T12:10:00Z', now)).toBe(600_000)
    expect(parseRetryAfterMs('quota resets at 2026-07-18T11:00:00Z', now)).toBeUndefined()
  })

  it('returns undefined for texts with no time information', () => {
    expect(parseRetryAfterMs('rate limit exceeded', now)).toBeUndefined()
  })
})

describe('usage accumulation across attempts (fix: retry-then-success under-counted)', () => {
  it('sums tokens from a failed attempt and the successful retry', () => {
    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'a.md' })
    store.transition(job.id, 'preprocessing')
    store.transition(job.id, 'ingesting')
    store.transition(job.id, 'failed', { patch: { tokensIn: 500, tokensOut: 50, costUsd: 0.5, error: 'boom' } })
    store.transition(job.id, 'queued')
    store.transition(job.id, 'preprocessing')
    store.transition(job.id, 'ingesting')
    const done = store.transition(job.id, 'done', { patch: { tokensIn: 300, tokensOut: 30, costUsd: 0.3 } })
    expect(done.tokens_in).toBe(800)
    expect(done.tokens_out).toBe(80)
    expect(done.cost_usd).toBeCloseTo(0.8)
  })
})

describe('JobStore.list (GET /jobs?status=&type=, SPEC.md §6.5)', () => {
  it('filters by status and type together', () => {
    const a = store.create({ source: 'drop', type: 'pdf', originalName: 'a.pdf' }).job
    store.create({ source: 'drop', type: 'text', originalName: 'b.md' })
    store.transition(a.id, 'preprocessing')
    store.transition(a.id, 'failed', { patch: { error: 'x' } })
    expect(store.list({ status: 'failed', type: 'pdf' }).map((j) => j.id)).toEqual([a.id])
    expect(store.list({ status: 'failed', type: 'text' })).toEqual([])
    expect(store.list({ type: 'text' })).toHaveLength(1)
    expect(store.list({})).toHaveLength(2)
  })
})

describe('batch enqueue robustness (fix: one unreadable member stranded its siblings)', () => {
  it('fails the unreadable member and still runs the rest of the batch', async () => {
    const q = makeQueue()
    q.start()
    const good = writeSource('good.md', 'fine')
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: good },
        { kind: 'file', sourcePath: path.join(srcDir, 'missing.md') },
      ],
      'drop',
    )
    await q.onIdle()
    const byName = new Map(jobs.map((r) => [r.job.original_name, store.get(r.job.id)!]))
    expect(byName.get('missing.md')!.status).toBe('failed')
    expect(byName.get('missing.md')!.error).toMatch(/could not read/)
    expect(byName.get('good.md')!.status).toBe('done')
  })
})

describe('watch-folder size cap (SPEC.md §4.2 "wie 4.1")', () => {
  it('rejectOversizedFile records a visible failed job and stages the original', () => {
    const q = makeQueue()
    const src = writeSource('big.pdf', 'x'.repeat(1000))
    const job = q.rejectOversizedFile({
      sourcePath: src,
      originalName: 'big.pdf',
      source: 'watch',
      sizeBytes: 1000,
      limitBytes: 100,
    })
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/maxUploadBytes/)
    // Staged into .raw so the inbox can be emptied without data loss; retry can re-enter.
    expect(fs.existsSync(path.join(vaultRoot, '.raw', job.id, 'big.pdf'))).toBe(true)
  })
})

describe('pinnedRequest (SSRF fix: the socket goes to the validated address, not DNS)', () => {
  let server: http.Server
  let port: number

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://elsewhere.test/next' })
        res.end()
        return
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('y'.repeat(64 * 1024))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      // Echo the Host header so the test can prove hostname and socket target diverged.
      res.end(`host=${req.headers.host ?? ''}`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  })

  /** A hostname that no resolver knows — reaching the server proves the pin was used. */
  const pinned = (urlPath: string): ValidatedUrl => ({
    url: new URL(`http://pinned-host.invalid:${port}${urlPath}`),
    address: '127.0.0.1',
  })

  it('connects to the pinned address while keeping the original Host header', async () => {
    const res = await pinnedRequest(pinned('/'), 5000, 1024 * 1024)
    expect(res.status).toBe(200)
    expect(res.body).toBe(`host=pinned-host.invalid:${port}`)
  })

  it('surfaces redirects for per-hop re-validation instead of following them', async () => {
    const res = await pinnedRequest(pinned('/redirect'), 5000, 1024 * 1024)
    expect(res.status).toBe(302)
    expect(res.location).toBe('http://elsewhere.test/next')
  })

  it('aborts mid-stream when the body exceeds the cap', async () => {
    await expect(pinnedRequest(pinned('/big'), 5000, 1024)).rejects.toThrow(/cap/)
  })
})
