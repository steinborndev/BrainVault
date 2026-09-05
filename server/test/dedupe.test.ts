/**
 * Dedupe in three stages (SPEC.md §12.9, 2026-09-05).
 *
 *   1. the hash the vault remembers in `.raw/<job-id>/manifest.json`, which survives a
 *      cleared history - a byte-identical drop is a `duplicate` at creation even when the
 *      original's job row is gone;
 *   2. the DOI a normalized document names, matched against the source pages' frontmatter
 *      BEFORE an agent run - a re-downloaded paper (different bytes, same DOI) is a
 *      `duplicate` after preprocessing, its staged copy discarded, no run paid for;
 *   3. a run that finishes without writing a wiki page is marked `no-changes` rather than
 *      passing as an ordinary `done`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue, type IngestRunner } from '../src/pipeline/queue.js'
import { DedupeIndex, extractDoi, normalizeDoi, pageDois } from '../src/pipeline/dedupe.js'
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
  deno: false,
}

const okResult = (): AgentRunResult => ({
  ok: true,
  result: 'ingest done',
  usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.01 },
  durationMs: 1000,
  numTurns: 5,
  sessionId: 's1',
  timedOut: false,
})

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

function write(rel: string, content: string): void {
  const abs = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function writeSource(name: string, content: string): string {
  const p = path.join(srcDir, name)
  fs.writeFileSync(p, content)
  return p
}

const SHA_OF_SAME = 'a'.repeat(64)

/** A prior ingest the vault remembers: a `.raw/` job dir with its manifest, and a source page. */
function seedPriorIngest(opts: { sha256?: string; doi?: string } = {}): void {
  write(
    '.raw/JOBOLD/manifest.json',
    JSON.stringify({
      jobId: 'JOBOLD',
      source: 'drop',
      type: 'pdf',
      originalName: 'paper.pdf',
      original: 'paper.pdf',
      normalized: 'normalized.txt',
      ...(opts.sha256 !== undefined ? { sha256: opts.sha256 } : {}),
    }),
  )
  write('.raw/JOBOLD/paper.pdf', '%PDF-1.4 old bytes\n')
  write('.raw/JOBOLD/normalized.txt', 'old text\n')
  write(
    'wiki/sources/Paper.md',
    `---\ntype: source\ntitle: Paper\nurl: "https://doi.org/${opts.doi ?? '10.1000/xyz123'}"\n---\n# Paper\n`,
  )
  write(
    '.raw/.manifest.json',
    JSON.stringify({
      sources: {
        '.raw/JOBOLD/normalized.txt': { ingested_at: '2026-08-01', pages_created: ['wiki/sources/Paper.md'] },
      },
    }),
  )
}

interface Over {
  runIngest?: IngestRunner
  commitPages?: string[]
  discard?: (vaultRoot: string, relDir: string) => Promise<boolean>
  preprocessText?: string
  doiDedupe?: () => boolean
}

let discarded: string[]

function makeQueue(over: Over = {}): IngestQueue {
  discarded = []
  return new IngestQueue({
    store,
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    concurrency: 1,
    detectToolsFn: async () => NO_TOOLS,
    commit: async () => ({ committed: true, hash: 'abcd1234ef', committedPages: over.commitPages ?? ['wiki/concepts/Foo.md'] }),
    refreshHotCache: async () => 'hot cache noted',
    setTimeoutFn: () => undefined,
    runIngest: over.runIngest ?? (async () => okResult()),
    ...(over.doiDedupe ? { doiDedupe: over.doiDedupe } : {}),
    discardStaging:
      over.discard ??
      (async (_root, relDir) => {
        discarded.push(relDir)
        fs.rmSync(path.join(vaultRoot, relDir), { recursive: true, force: true })
        return true
      }),
    // A stand-in preprocessor that writes the normalized text the DOI check reads.
    preprocessFile: async (input) => {
      fs.mkdirSync(input.jobDir, { recursive: true })
      const text = over.preprocessText ?? fs.readFileSync(input.sourcePath, 'utf8')
      fs.writeFileSync(path.join(input.jobDir, 'normalized.txt'), text)
      const manifest = {
        jobId: input.jobId,
        source: input.source,
        type: 'pdf' as const,
        originalName: input.originalName,
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
        createdAt: new Date().toISOString(),
        original: input.originalName,
        normalized: 'normalized.txt',
        ocrApplied: false,
        passImageToAgent: false,
        deferred: false,
        notes: [],
      }
      const manifestPath = path.join(input.jobDir, 'manifest.json')
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
      return {
        type: 'pdf',
        deferred: false,
        manifestPath,
        primaryArtifact: `.raw/${input.jobId}/normalized.txt`,
        manifest,
      }
    },
  })
}

describe('extractDoi', () => {
  it('normalizes case and trailing punctuation', () => {
    expect(normalizeDoi('10.1002/ABC.123.')).toBe('10.1002/abc.123')
    expect(normalizeDoi('10.1002/abc.123,')).toBe('10.1002/abc.123')
  })

  it('picks the DOI on the first page, and among several the one the watermark repeats', () => {
    const own = '10.1002/own.777'
    const cited = '10.1000/cited.1'
    const page = (n: number): string =>
      `page ${n} text\nDownloaded from https://publisher.example/doi/${own} on [05/09/2026]\n`
    const head = `Title\nDOI: ${own}\nSee also ${cited}\n`
    const text = head + [1, 2, 3].map(page).join('') + `References\n1. x ${cited}\n2. y 10.5555/other.9\n`
    expect(extractDoi(text)).toBe(own)
  })

  it('returns undefined when the head names no DOI', () => {
    expect(extractDoi('a plain note about nothing in particular')).toBeUndefined()
    // A DOI only in the reference list is someone else's paper.
    expect(extractDoi(`${'x '.repeat(5000)}\nrefs 10.1000/abc`)).toBeUndefined()
    // Layout padding does not push a title-page DOI out of the head.
    expect(extractDoi(`Title${' '.repeat(20000)}\nDOI: 10.1000/padded`)).toBe('10.1000/padded')
  })
})

describe('pageDois', () => {
  it('reads url and doi keys from the frontmatter and ignores the body', () => {
    const md = `---\ntitle: T\nurl: "https://doi.org/10.1002/ABC"\ndoi: 10.1002/abc\n---\nbody cites 10.9999/other\n`
    expect(pageDois(md)).toEqual(['10.1002/abc'])
    expect(pageDois('# no frontmatter 10.1002/abc')).toEqual([])
  })
})

describe('DedupeIndex', () => {
  it('finds a hash in the .raw manifests and re-reads only what changed', () => {
    seedPriorIngest({ sha256: SHA_OF_SAME })
    const index = new DedupeIndex(vaultRoot)
    expect(index.byHash(SHA_OF_SAME)).toEqual({ jobId: 'JOBOLD', originalName: 'paper.pdf' })
    expect(index.byHash('b'.repeat(64))).toBeUndefined()
    // A manifest without a valid hash is skipped, not mis-read.
    write('.raw/JOBBAD/manifest.json', JSON.stringify({ sha256: 'not-a-hash' }))
    expect(index.byHash('not-a-hash')).toBeUndefined()
    // Removing the dir forgets the hash.
    fs.rmSync(path.join(vaultRoot, '.raw', 'JOBOLD'), { recursive: true })
    expect(index.byHash(SHA_OF_SAME)).toBeUndefined()
  })

  it('maps a DOI to its source page and the job that created it', () => {
    seedPriorIngest({ doi: '10.1002/paper.1' })
    const index = new DedupeIndex(vaultRoot)
    const hit = index.byDoi('10.1002/PAPER.1')
    expect(hit?.page).toBe('wiki/sources/Paper.md')
    expect(hit?.jobId).toBe('JOBOLD')
    expect(index.byDoi('10.1002/unknown')).toBeUndefined()
  })

  it('resolves no job for a page the delta tracker does not attribute', () => {
    seedPriorIngest({ doi: '10.1002/paper.1' })
    write('.raw/.manifest.json', JSON.stringify({ sources: {} }))
    const index = new DedupeIndex(vaultRoot)
    expect(index.byDoi('10.1002/paper.1')?.jobId).toBeNull()
  })
})

describe('stage 1: the vault remembers a hash the history forgot', () => {
  it('marks a byte-identical drop as duplicate of the vault job, with no run', async () => {
    const src = writeSource('again.pdf', 'same bytes')
    // The vault's memory of the earlier ingest is the hash of exactly these bytes.
    const { sha256File } = await import('../src/pipeline/hash.js')
    seedPriorIngest({ sha256: await sha256File(src) })

    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    const created = await q.enqueueFile({ sourcePath: src, source: 'drop' })
    await q.onIdle()

    expect(created.duplicateOf).toBe('JOBOLD')
    const row = store.getOrThrow(created.job.id)
    expect(row.status).toBe('duplicate')
    expect(row.duplicate_of).toBe('JOBOLD')
    expect(row.error).toMatch(/already in the vault/)
    expect(row.sha256).toBeNull()
    expect(runs).toBe(0)
    // Nothing was staged for a duplicate.
    expect(fs.existsSync(path.join(vaultRoot, '.raw', created.job.id))).toBe(false)
  })

  it('prefers the job row when the history still has it', async () => {
    const src = writeSource('x.pdf', 'same bytes')
    const { sha256File } = await import('../src/pipeline/hash.js')
    seedPriorIngest({ sha256: await sha256File(src) })
    // The same hash is ALSO still in the history, under a different job id: that row is
    // the one the dashboard can open, so it is the one the duplicate points at.
    const inDb = store.create({ source: 'drop', type: 'pdf', originalName: 'x.pdf', sha256: await sha256File(src) })
    store.transition(inDb.job.id, 'cancelled')
    const q = makeQueue()
    q.start()
    const again = await q.enqueueFile({ sourcePath: src, source: 'drop' })
    await q.onIdle()
    expect(again.duplicateOf).toBe(inDb.job.id)
    expect(store.getOrThrow(again.job.id).error).toMatch(/still in the history/)
  })
})

describe('stage 2: a DOI the vault already holds, decided after preprocessing', () => {
  const DOI = '10.1002/paper.1'
  const paperText = `Title of the paper\nDOI: ${DOI}\n\nDownloaded from x/doi/${DOI} on [05/09/2026]\nbody\n`

  it('settles the job as duplicate before any agent run and discards the staged copy', async () => {
    seedPriorIngest({ doi: DOI })
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    // Different bytes (a new watermark date), same DOI.
    const src = writeSource('redownload.pdf', paperText)
    const { job } = await q.enqueueFile({ sourcePath: src, source: 'drop' })
    await q.onIdle()

    const row = store.getOrThrow(job.id)
    expect(row.status).toBe('duplicate')
    expect(row.duplicate_of).toBe('JOBOLD')
    expect(row.error).toMatch(/wiki\/sources\/Paper\.md/)
    expect(row.error).toMatch(DOI)
    expect(row.finished_at).not.toBeNull()
    expect(runs).toBe(0)
    expect(discarded).toEqual([`.raw/${job.id}`])
    expect(fs.existsSync(path.join(vaultRoot, '.raw', job.id))).toBe(false)
    const log = store.logs(job.id).map((l) => l.message).join('\n')
    expect(log).toMatch(/duplicate by DOI/)
    expect(log).toMatch(/staged copy .* removed/)
  })

  it('keeps the staged copy when git already tracks it, and says so', async () => {
    seedPriorIngest({ doi: DOI })
    const q = makeQueue({ discard: async () => false })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('r.pdf', paperText), source: 'drop' })
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('duplicate')
    expect(store.logs(job.id).map((l) => l.message).join('\n')).toMatch(/kept: git already tracks it/)
  })

  it('does not mistake a page written after the job for a prior ingest', async () => {
    // The page carries the DOI but no job is attributed to it, and it is newer than the job:
    // that is what this job's own earlier attempt would look like.
    seedPriorIngest({ doi: DOI })
    write('.raw/.manifest.json', JSON.stringify({ sources: {} }))
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('r.pdf', paperText), source: 'drop' })
    // Touch the page so it is newer than the job row.
    const page = path.join(vaultRoot, 'wiki/sources/Paper.md')
    const later = new Date(Date.parse(store.getOrThrow(job.id).created_at) + 5000)
    fs.utimesSync(page, later, later)
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('done')
    expect(runs).toBe(1)
  })

  it('treats an unattributed page OLDER than the job as a prior ingest', async () => {
    seedPriorIngest({ doi: DOI })
    write('.raw/.manifest.json', JSON.stringify({ sources: {} }))
    const page = path.join(vaultRoot, 'wiki/sources/Paper.md')
    const earlier = new Date(Date.now() - 60_000)
    fs.utimesSync(page, earlier, earlier)
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('r.pdf', paperText), source: 'drop' })
    await q.onIdle()
    const row = store.getOrThrow(job.id)
    expect(row.status).toBe('duplicate')
    expect(row.duplicate_of).toBeNull()
    expect(row.error).toMatch(/an earlier ingest/)
    expect(runs).toBe(0)
  })

  it('drops a duplicate member out of a batch and ingests the rest', async () => {
    seedPriorIngest({ doi: DOI })
    let prompt = ''
    const q = makeQueue({
      runIngest: async (opts) => {
        prompt = opts.prompt
        return okResult()
      },
    })
    q.start()
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: writeSource('dup.pdf', paperText) },
        { kind: 'file', sourcePath: writeSource('new.pdf', 'Another paper\nDOI: 10.1002/new.2\n') },
      ],
      'drop',
    )
    await q.onIdle()
    expect(store.getOrThrow(jobs[0]!.job.id).status).toBe('duplicate')
    expect(store.getOrThrow(jobs[1]!.job.id).status).toBe('done')
    expect(prompt).toContain(`.raw/${jobs[1]!.job.id}/normalized.txt`)
    expect(prompt).not.toContain(jobs[0]!.job.id)
  })

  it('is switched off by the doiDedupe setting (the escape hatch for a wrong match)', async () => {
    seedPriorIngest({ doi: DOI })
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()), doiDedupe: () => false })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('r.pdf', paperText), source: 'drop' })
    await q.onIdle()
    expect(store.getOrThrow(job.id).status).toBe('done')
    expect(runs).toBe(1)
  })

  it('lets a document without a DOI, or with an unknown one, through to ingest', async () => {
    seedPriorIngest({ doi: DOI })
    let runs = 0
    const q = makeQueue({ runIngest: async () => (runs++, okResult()) })
    q.start()
    await q.enqueueFile({ sourcePath: writeSource('note.md', 'just a note'), source: 'drop' })
    await q.enqueueFile({ sourcePath: writeSource('other.pdf', 'Other\nDOI: 10.1002/other.9\n'), source: 'drop' })
    await q.onIdle()
    expect(runs).toBe(2)
  })
})

describe('stage 3: a run that wrote nothing is marked no-changes', () => {
  it('sets outcome when the commit landed with zero wiki pages', async () => {
    const q = makeQueue({ commitPages: [] })
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md', 'plain'), source: 'drop' })
    await q.onIdle()
    const row = store.getOrThrow(job.id)
    expect(row.status).toBe('done')
    expect(row.commit_hash).toBe('abcd1234ef')
    expect(row.outcome).toBe('no-changes')
    expect(store.logs(job.id).map((l) => l.message).join('\n')).toMatch(/no changes: the run finished but wrote no wiki page/)
  })

  it('leaves an ordinary run unmarked', async () => {
    const q = makeQueue()
    q.start()
    const { job } = await q.enqueueFile({ sourcePath: writeSource('a.md', 'plain'), source: 'drop' })
    await q.onIdle()
    expect(store.getOrThrow(job.id).outcome).toBeNull()
  })

  it('marks every member of a batch whose combined commit carried no page', async () => {
    const q = makeQueue({ commitPages: [] })
    q.start()
    const { jobs } = await q.enqueueBatch(
      [
        { kind: 'file', sourcePath: writeSource('a.md', 'a') },
        { kind: 'file', sourcePath: writeSource('b.md', 'b') },
      ],
      'drop',
    )
    await q.onIdle()
    for (const j of jobs) expect(store.getOrThrow(j.job.id).outcome).toBe('no-changes')
  })
})

describe('JobStore.remove', () => {
  it('deletes a settled row with its logs and refuses an active one', () => {
    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'x.md' })
    expect(() => store.remove(job.id)).toThrow(/only a settled job/)
    store.transition(job.id, 'cancelled')
    expect(store.remove(job.id)).toBe(true)
    expect(store.get(job.id)).toBeUndefined()
    expect(store.logs(job.id)).toEqual([])
    expect(store.remove(job.id)).toBe(false)
  })
})
