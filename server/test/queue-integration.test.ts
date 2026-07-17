/**
 * M1 acceptance, deterministic slice (SPEC.md §10, TASKS-M1 §4): 10 mixed files through
 * the queue at concurrency 2, against a REAL temporary git vault with REAL preprocessing
 * and REAL commits. The agent run is faked — it writes a unique wiki page per job, the
 * way the real ingest skill writes pages — so the test proves the queue + git + commit
 * orchestration is sound and loses/corrupts nothing under concurrency, without spending
 * tokens. The real end-to-end run (actual agent, full toolchain) is a separate,
 * user-gated step documented in TASKS-M1 §4.
 *
 * Per-file contention on shared vault files (index/log/hot) is the vault's own
 * wiki-lock.sh domain, verified sound in M0; this test uses unique per-job pages and
 * exercises OUR commit serialization, not the vault's locking.
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

const NO_TOOLS: ToolAvailability = {
  pdftotext: false,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: false,
  python3: false,
  exiftool: false,
  defuddle: false,
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

let db: Db
let store: JobStore
let vaultRoot: string
let srcDir: string

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-git-'))
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'))
  // A real vault-like git repo.
  git(vaultRoot, 'init', '-q')
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
  fs.mkdirSync(path.join(vaultRoot, '.raw'), { recursive: true })
  fs.writeFileSync(path.join(vaultRoot, 'wiki', 'index.md'), '# Index\n')
  git(vaultRoot, 'add', '-A')
  git(vaultRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
})

describe('M1 acceptance: 10 mixed files at concurrency 2 (deterministic)', () => {
  it('all reach done, every page is committed, and the vault stays consistent', async () => {
    // Fake agent: writes a unique page per ingest, like the real skill does.
    let pageSeq = 0
    const runIngest: IngestRunner = async () => {
      const n = pageSeq++
      // Small async gap so runs genuinely overlap at concurrency 2.
      await new Promise((r) => setTimeout(r, 5))
      const page = path.join(vaultRoot, 'wiki', 'concepts', `Page-${n}.md`)
      fs.writeFileSync(page, `# Page ${n}\n\nIngested content ${n}.\n`)
      return {
        ok: true,
        result: `wrote Page-${n}`,
        usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.01 },
        durationMs: 5,
        numTurns: 3,
        sessionId: `s${n}`,
        timedOut: false,
      }
    }

    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 2,
      detectToolsFn: async () => NO_TOOLS,
      refreshHotCache: async () => 'noop',
      runIngest,
      // real commitVault + real changedWikiPages (defaults)
    })
    queue.start()

    // 10 mixed (tool-free) sources: .md and .txt, distinct content so no dedupe collisions.
    const jobIds: string[] = []
    for (let i = 0; i < 10; i++) {
      const ext = i % 2 === 0 ? 'md' : 'txt'
      const src = path.join(srcDir, `file${i}.${ext}`)
      fs.writeFileSync(src, `# Source ${i}\n\nUnique body ${i} ${'x'.repeat(i)}.\n`)
      const { job } = await queue.enqueueFile({ sourcePath: src, source: 'drop' })
      jobIds.push(job.id)
    }

    await queue.onIdle()

    // 1. Every job reached done.
    const statuses = jobIds.map((id) => store.getOrThrow(id).status)
    expect(statuses).toEqual(Array(10).fill('done'))

    // 2. Working tree is clean — every page a job wrote is committed (nothing lost).
    expect(git(vaultRoot, 'status', '--porcelain').trim()).toBe('')

    // 3. All 10 pages exist in HEAD.
    const tracked = git(vaultRoot, 'ls-files', 'wiki/concepts').trim().split('\n')
    for (let n = 0; n < 10; n++) {
      expect(tracked).toContain(`wiki/concepts/Page-${n}.md`)
    }

    // 4. The repository is not corrupt.
    expect(() => git(vaultRoot, 'fsck', '--full')).not.toThrow()

    // 5. At least one ingest commit landed, each authored by the service.
    const log = git(vaultRoot, 'log', '--format=%an|%s').trim().split('\n')
    const ingestCommits = log.filter((l) => l.startsWith('vault-service|ingest: '))
    expect(ingestCommits.length).toBeGreaterThan(0)

    // 6. created_pages attribution loses nothing: under the shared-commit-under-mutex
    // design a page may be recorded by the sibling job that swept it into its commit, so
    // an individual job's list can be empty — but the UNION must cover all 10 pages.
    const attributed = new Set<string>()
    for (const id of jobIds) {
      for (const p of JSON.parse(store.getOrThrow(id).created_pages ?? '[]') as string[]) attributed.add(p)
    }
    for (let n = 0; n < 10; n++) {
      expect(attributed).toContain(`wiki/concepts/Page-${n}.md`)
    }
  })

  it('processes a batch with a duplicate: the dup is skipped, the rest complete', async () => {
    let pageSeq = 0
    const runIngest: IngestRunner = async () => {
      const n = pageSeq++
      fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', `B-${n}.md`), `# B ${n}\n`)
      return {
        ok: true,
        result: 'ok',
        usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
        durationMs: 1,
        numTurns: 1,
        sessionId: 's',
        timedOut: false,
      }
    }
    const queue = new IngestQueue({
      store,
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      concurrency: 2,
      detectToolsFn: async () => NO_TOOLS,
      refreshHotCache: async () => 'noop',
      runIngest,
    })
    queue.start()

    const a = path.join(srcDir, 'a.md')
    fs.writeFileSync(a, 'identical content')
    const dup = path.join(srcDir, 'a-copy.md')
    fs.writeFileSync(dup, 'identical content') // same bytes → same sha256

    const first = await queue.enqueueFile({ sourcePath: a, source: 'drop' })
    const second = await queue.enqueueFile({ sourcePath: dup, source: 'watch' })
    await queue.onIdle()

    expect(store.getOrThrow(first.job.id).status).toBe('done')
    expect(store.getOrThrow(second.job.id).status).toBe('duplicate')
    expect(pageSeq).toBe(1) // the duplicate never ran the agent
  })
})
