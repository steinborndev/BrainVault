import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { dirtyPaths } from '../src/pipeline/git.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'
import type { JobRow } from '../src/db/jobs.js'

// Real git repo: the reconcile drains an interrupted run's orphaned pages via commitPaths and
// reads the working tree via dirtyPaths — a mocked git could not exercise either.

const NO_TOOLS = {
  pdftotext: false, pdfinfo: false, ocrmypdf: false, pandoc: false, python3: false,
  exiftool: false, defuddle: false, ytDlp: false, deno: false,
} satisfies ToolAvailability

let repo: string
let db: Db
let store: JobStore

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString()
const write = (rel: string, body = 'x'): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), body)
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-recon-'))
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  write('wiki/log.md', '# Log\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

const makeQueue = (): IngestQueue =>
  new IngestQueue({
    store,
    vaultRoot: repo,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    detectToolsFn: async () => NO_TOOLS,
  })

/** Seeds a job already advanced to `ingesting`, as an abrupt stop would have left it. */
const seedIngesting = (over: { sha256: string; originalName?: string; batchId?: string }): JobRow => {
  const { job } = store.create({ source: 'drop', type: 'pdf', originalName: 'a.pdf', ...over })
  store.setRawPath(job.id, path.posix.join('.raw', job.id))
  store.transition(job.id, 'preprocessing')
  store.transition(job.id, 'ingesting')
  return store.getOrThrow(job.id)
}

describe('reconcileInterrupted', () => {
  it('recovers a completed-but-uncommitted ingest to done and commits its orphaned pages', async () => {
    const job = seedIngesting({ sha256: 'a' })
    // The crash landed after the agent wrote its pages (incl. the final log entry, which names
    // the job's .raw dir) but before the commit — so the pages sit dirty in the working tree.
    const page = 'wiki/concepts/Recovered.md'
    write(page, '# recovered\n')
    write('wiki/log.md', `# Log\n\n## [2026-07-21] ingest\n- Sources: \`.raw/${job.id}/normalized.txt\`\n`)

    const q = makeQueue()
    q.start()
    await q.ready

    const recovered = store.getOrThrow(job.id)
    expect(recovered.status).toBe('done')
    expect(recovered.error).toBeNull()
    // created_pages reflects what actually landed in the recovered commit.
    expect(JSON.parse(recovered.created_pages ?? '[]')).toContain(page)
    // A real commit was made, attributed to this job, and the tree is clean again.
    expect(git('log', '--oneline', '-1')).toMatch(/ingest: a\.pdf \(recovered after restart\)/)
    expect(git('status', '--porcelain').trim()).toBe('')
    expect(git('log', '--diff-filter=A', '--name-only', '--pretty=format:', '-1').split('\n')).toContain(page)
  })

  it('fails a mid-write ingest with no completion marker, leaving its pages uncommitted', async () => {
    const job = seedIngesting({ sha256: 'b' })
    // Dirty page but NO log-md marker for this job → genuinely mid-write, not finished.
    write('wiki/concepts/Half.md', '# half\n')

    const q = makeQueue()
    q.start()
    await q.ready

    const recovered = store.getOrThrow(job.id)
    expect(recovered.status).toBe('failed')
    expect(recovered.error).toMatch(/interrupted by a service restart/)
    // Nothing was committed — the partial page stays dirty for a retry to redo cleanly.
    expect(git('log', '--oneline', '-1')).toMatch(/base/)
    expect((await dirtyPaths(repo)).has('wiki/concepts/Half.md')).toBe(true)
  })

  it('fails a preprocessing job (never reached the agent) without touching the vault', async () => {
    const { job } = store.create({ source: 'drop', type: 'pdf', originalName: 'p.pdf', sha256: 'c' })
    store.transition(job.id, 'preprocessing')
    write('wiki/log.md', `# Log\n- \`.raw/${job.id}/x\`\n`) // even if a marker exists, preprocessing can't be done

    const q = makeQueue()
    q.start()
    await q.ready

    expect(store.getOrThrow(job.id).status).toBe('failed')
  })

  it('recovers a batch: the first member commits the shared pages, siblings inherit them', async () => {
    const a = seedIngesting({ sha256: 'ba', originalName: 'A.pdf', batchId: 'batch1' })
    const b = seedIngesting({ sha256: 'bb', originalName: 'B.pdf', batchId: 'batch1' })
    write('wiki/concepts/Shared.md', '# shared\n')
    write('wiki/log.md', `# Log\n- Sources: \`.raw/${a.id}/n.txt\`, \`.raw/${b.id}/n.txt\`\n`)

    const q = makeQueue()
    q.start()
    await q.ready

    expect(store.getOrThrow(a.id).status).toBe('done')
    expect(store.getOrThrow(b.id).status).toBe('done')
    // Exactly ONE recovery commit for the batch; the second member found a clean tree.
    const recoveryCommits = git('log', '--oneline').split('\n').filter((l) => /recovered after restart/.test(l))
    expect(recoveryCommits).toHaveLength(1)
    expect(git('status', '--porcelain').trim()).toBe('')
  })
})
