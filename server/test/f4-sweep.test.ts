import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { RunRegistry } from '../src/pipeline/run-registry.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'
import type { ToolAvailability } from '../src/pipeline/preprocess/index.js'

/**
 * Finding F4: the commit pathspec comes from Write/Edit tool calls, so a page the agent creates
 * or renames with Bash is invisible to it and stays uncommitted. The fix sweeps such pages in —
 * but ONLY while the run can prove it is the sole vault writer, because time-based attribution is
 * ambiguous once runs overlap (an earlier attempt without that proof made job A commit job B's
 * page, which the M1 acceptance test caught).
 *
 * Needs a REAL git repo: the sweep is derived from `git status`.
 */

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

const okResult = (): AgentRunResult => ({
  ok: true,
  result: 'ingest done',
  usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.01 },
  durationMs: 1,
  numTurns: 1,
  sessionId: 's1',
  timedOut: false,
})

let db: Db
let store: JobStore
let vaultRoot: string
let srcDir: string
let pathspecs: string[][]

const git = (...args: string[]): void => {
  execFileSync('git', ['-C', vaultRoot, ...args], { stdio: 'pipe' })
}

/** The page an agent produced via Bash: on disk, never announced through a Write/Edit call. */
const BASH_PAGE = 'wiki/concepts/Written By Bash.md'

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-f4-'))
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-f4-'))
  pathspecs = []
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'concepts'), { recursive: true })
  fs.writeFileSync(path.join(vaultRoot, 'wiki', 'concepts', 'Base.md'), '# base')
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
})

function makeQueue(runRegistry: RunRegistry): IngestQueue {
  return new IngestQueue({
    store,
    vaultRoot,
    auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
    concurrency: 1,
    runRegistry,
    detectToolsFn: async () => NO_TOOLS,
    commit: async (_root, _msg, opts) => {
      pathspecs.push([...(opts?.pathspec ?? [])])
      return { committed: true, hash: 'abcd1234', committedPages: [] }
    },
    refreshHotCache: async () => 'noop',
    // Simulates the agent writing a page with Bash: it lands on disk, but nothing is reported
    // through onMessage, so `written` stays empty for it.
    runIngest: async () => {
      fs.writeFileSync(path.join(vaultRoot, BASH_PAGE), '# made by bash')
      return okResult()
    },
  })
}

function writeSource(name = 'note.md'): string {
  const p = path.join(srcDir, name)
  fs.writeFileSync(p, 'hello')
  return p
}

describe('F4 sweep', () => {
  it('stages a Bash-written page when the run is the sole writer', async () => {
    const q = makeQueue(new RunRegistry())
    q.start()
    await q.enqueueFile({ sourcePath: writeSource(), source: 'drop' })
    await q.onIdle()

    expect(pathspecs).toHaveLength(1)
    // Previously this page was invisible to the pathspec and stayed untracked in the vault.
    expect(pathspecs[0]).toContain(BASH_PAGE)
  })

  it('skips the sweep while another run is writing, rather than risk mis-attribution', async () => {
    const registry = new RunRegistry()
    // Stand in for a concurrent maintenance run or second ingest job holding a writer slot.
    const otherRun = registry.begin()

    const q = makeQueue(registry)
    q.start()
    await q.enqueueFile({ sourcePath: writeSource(), source: 'drop' })
    await q.onIdle()
    otherRun()

    expect(pathspecs).toHaveLength(1)
    // Not staged: with two writers active, this page cannot be attributed to either run, and
    // committing it under the wrong job is worse than leaving it for the operator.
    expect(pathspecs[0]).not.toContain(BASH_PAGE)
  })

  it('leaves files the user already had dirty alone (SPEC risk 5)', async () => {
    // The user is mid-edit when the run starts; that edit is not ours to commit.
    const userEdit = path.join(vaultRoot, 'wiki', 'concepts', 'Base.md')
    fs.writeFileSync(userEdit, '# base, edited by the user')

    const q = makeQueue(new RunRegistry())
    q.start()
    await q.enqueueFile({ sourcePath: writeSource(), source: 'drop' })
    await q.onIdle()

    expect(pathspecs[0]).toContain(BASH_PAGE)
    expect(pathspecs[0]).not.toContain('wiki/concepts/Base.md')
  })
})

describe('RunRegistry', () => {
  it('tracks active writers and reports sole-writer status', () => {
    const r = new RunRegistry()
    expect(r.activeRuns).toBe(0)
    expect(r.isSoleWriter()).toBe(false) // nobody is running — nothing to attribute

    const a = r.begin()
    expect(r.isSoleWriter()).toBe(true)
    const b = r.begin()
    expect(r.activeRuns).toBe(2)
    expect(r.isSoleWriter()).toBe(false)

    b()
    expect(r.isSoleWriter()).toBe(true)
    a()
    expect(r.activeRuns).toBe(0)
  })

  it('is idempotent, so a double release cannot corrupt the count', () => {
    const r = new RunRegistry()
    const end = r.begin()
    end()
    end()
    expect(r.activeRuns).toBe(0)
  })
})
