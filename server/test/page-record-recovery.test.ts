/**
 * Recording what an ingest produced when the SERVICE was not the one that committed it
 * (2026-08-26).
 *
 * The vault's own wiki-ingest skill commits its work. When it wins that race the service's
 * `commitVault` finds an empty index, and the job used to end up with no page list and no
 * commit hash at all - the dashboard showed a finished ingest with "-" pages and no links,
 * while its commit sat beside it as a second, unexplained row because nothing could join
 * the two. These pin the three pieces of the repair: the git primitive that attributes a
 * commit to a job, the live path through the queue, and the startup backfill for the jobs
 * that already went through it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue, type IngestRunner } from '../src/pipeline/queue.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'
import { commitTouching } from '../src/pipeline/git.js'

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

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

/** Commits as somebody who is not the service - the way the ingest skill does. */
const commitAs = (cwd: string, message: string): string => {
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=agent', '-c', 'user.email=a@a', 'commit', '-q', '--no-verify', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD').trim()
}

const write = (root: string, rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), body)
}

let db: Db
let store: JobStore
let vaultRoot: string
let srcDir: string

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-vault-'))
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-src-'))
  git(vaultRoot, 'init', '-q')
  write(vaultRoot, 'wiki/index.md', '# Index\n')
  fs.mkdirSync(path.join(vaultRoot, '.raw'), { recursive: true })
  commitAs(vaultRoot, 'init')
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
})

describe('commitTouching', () => {
  it('finds the commit that carried a job’s raw payload, with the wiki pages it changed', async () => {
    write(vaultRoot, '.raw/job-1/manifest.json', '{}')
    write(vaultRoot, 'wiki/concepts/Alpha.md', '# Alpha\n')
    write(vaultRoot, 'wiki/concepts/Beta.md', '# Beta\n')
    const hash = commitAs(vaultRoot, 'ingest: something')

    const found = await commitTouching(vaultRoot, '.raw/job-1')
    expect(found?.hash).toBe(hash)
    expect(found?.pages).toEqual(['wiki/concepts/Alpha.md', 'wiki/concepts/Beta.md'])
  })

  it('is job-scoped: another job’s raw directory finds nothing', async () => {
    write(vaultRoot, '.raw/job-1/manifest.json', '{}')
    write(vaultRoot, 'wiki/concepts/Alpha.md', '# Alpha\n')
    commitAs(vaultRoot, 'ingest: something')

    expect(await commitTouching(vaultRoot, '.raw/job-2')).toBeNull()
  })

  it('refuses a commit older than the run - a raw payload committed earlier is not this run’s work', async () => {
    write(vaultRoot, '.raw/job-1/manifest.json', '{}')
    commitAs(vaultRoot, 'ingest: an earlier run')

    const future = new Date(Date.now() + 60_000)
    expect(await commitTouching(vaultRoot, '.raw/job-1', future)).toBeNull()
    // Without the guard the same call answers.
    expect(await commitTouching(vaultRoot, '.raw/job-1', null)).not.toBeNull()
  })

  /**
   * Git records whole seconds; `started_at` records milliseconds. A commit made in the
   * same second a run began therefore reads as fractionally older than the run, and a
   * strict comparison discarded exactly the commit this exists to find - which is what a
   * fast run produces every single time.
   */
  it('accepts a commit from the same second the run started', async () => {
    write(vaultRoot, '.raw/job-1/manifest.json', '{}')
    write(vaultRoot, 'wiki/concepts/Alpha.md', '# Alpha\n')
    const hash = commitAs(vaultRoot, 'ingest: a fast run')
    // Anchored to the commit's own stamp, or the assertion depends on where in the wall
    // clock's second the test happens to run.
    const committedAt = Date.parse(git(vaultRoot, 'show', '-s', '--format=%cI', hash).trim())

    // Inside the second: what a sub-second run looks like against a whole-second stamp.
    expect(await commitTouching(vaultRoot, '.raw/job-1', new Date(committedAt + 999))).not.toBeNull()
    // Past it: genuinely older than the run, and still refused.
    expect(await commitTouching(vaultRoot, '.raw/job-1', new Date(committedAt + 1001))).toBeNull()
  })

  it('answers null for a path no commit ever touched', async () => {
    expect(await commitTouching(vaultRoot, '.raw/never')).toBeNull()
  })
})

describe('an ingest whose own run committed the work', () => {
  /**
   * The fake agent behaves like the real ingest skill on the day this broke: it writes its
   * pages, then commits them together with its raw payload. By the time the service tries,
   * there is nothing left to stage.
   */
  const makeQueue = (): IngestQueue =>
    new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 1,
      detectToolsFn: async () => NO_TOOLS,
      refreshHotCache: async () => 'noop',
      runIngest: agentThatCommits,
    })

  const agentThatCommits: IngestRunner = async (opts) => {
    const page = path.join(vaultRoot, 'wiki', 'concepts', 'Agent Page.md')
    fs.mkdirSync(path.dirname(page), { recursive: true })
    fs.writeFileSync(page, '# Agent Page\n')
    opts.onMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: page } }] },
    } as never)
    commitAs(vaultRoot, 'ingest: committed by the run itself')
    return {
      ok: true,
      result: 'done',
      usage: { tokensIn: 10, tokensOut: 1, costUsd: 0.01 },
      durationMs: 1,
      numTurns: 1,
      sessionId: 's1',
      timedOut: false,
    }
  }

  it('records the run’s own commit against the job, pages and hash', async () => {
    const queue = makeQueue()
    queue.start()
    const src = path.join(srcDir, 'note.md')
    fs.writeFileSync(src, '# A note\n\nSomething to ingest.\n')
    const { job } = await queue.enqueueFile({ sourcePath: src, source: 'drop' })
    await queue.onIdle()

    const row = store.getOrThrow(job.id)
    expect(row.status).toBe('done')
    expect(JSON.parse(row.created_pages ?? '[]')).toContain('wiki/concepts/Agent Page.md')
    expect(row.commit_hash).toBe(git(vaultRoot, 'rev-parse', 'HEAD').trim())
  })

  it('says in the job log which commit it adopted, so the attribution is traceable', async () => {
    const queue = makeQueue()
    queue.start()
    const src = path.join(srcDir, 'note.md')
    fs.writeFileSync(src, '# A note\n\nSomething to ingest.\n')
    const { job } = await queue.enqueueFile({ sourcePath: src, source: 'drop' })
    await queue.onIdle()

    const log = store.logs(job.id).map((l) => l.message)
    expect(log.some((m) => m.includes('committed its own work as'))).toBe(true)
  })
})

describe('startup backfill', () => {
  it('repairs a finished job that never recorded its pages', async () => {
    // A job that ran before the fix: done, has a raw payload, no hash, no page list.
    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'old.md', sha256: 'abc' })
    store.setRawPath(job.id, `.raw/${job.id}`)
    store.transition(job.id, 'preprocessing')
    store.transition(job.id, 'ingesting')
    store.transition(job.id, 'done')
    expect(store.getOrThrow(job.id).created_pages).toBeNull()

    // Its work is in git under someone else's name, together with its raw payload.
    write(vaultRoot, `.raw/${job.id}/manifest.json`, '{}')
    write(vaultRoot, 'wiki/concepts/Recovered.md', '# Recovered\n')
    const hash = commitAs(vaultRoot, 'ingest: old.md')

    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      detectToolsFn: async () => NO_TOOLS,
      runIngest: async () => {
        throw new Error('no run in this test')
      },
    })
    queue.start()
    await queue.ready

    const row = store.getOrThrow(job.id)
    expect(JSON.parse(row.created_pages ?? '[]')).toEqual(['wiki/concepts/Recovered.md'])
    expect(row.commit_hash).toBe(hash)
  })

  it('leaves a job alone once it has a record, so the repair does not repeat', () => {
    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'fine.md', sha256: 'def' })
    store.setRawPath(job.id, `.raw/${job.id}`)
    store.transition(job.id, 'preprocessing')
    store.transition(job.id, 'ingesting')
    store.transition(job.id, 'done')
    store.setCreatedPages(job.id, ['wiki/concepts/Fine.md'])
    store.setCommitHash(job.id, 'deadbeef')

    expect(store.settledWithoutPages().map((j) => j.id)).not.toContain(job.id)
  })

  it('ignores jobs with no raw payload - they never ran an ingest', () => {
    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'nothing.md', sha256: 'ghi' })
    store.transition(job.id, 'preprocessing')
    store.transition(job.id, 'ingesting')
    store.transition(job.id, 'done')

    expect(store.settledWithoutPages().map((j) => j.id)).not.toContain(job.id)
  })
})
