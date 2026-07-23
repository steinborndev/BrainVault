/**
 * Hybrid-retrieval index maintenance (SPEC.md §12.6, TASKS-RETRIEVE §1): exclude-file
 * idempotence, feature detection, the deterministic builder (fake process runner — the
 * real python never runs here), the post-ingest debounce scheduler, and the maintenance
 * runner's `retrieve-index` kind (no agent, no credential, serialized builds).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  RETRIEVE_EXCLUDE_ENTRIES,
  RetrieveScriptsMissingError,
  ensureIndexExcluded,
  hasRetrieveScripts,
  isRetrieveProvisioned,
  retrieveIndexStats,
  buildRetrieveIndex,
  startRetrieveIndexScheduler,
  type ProcessRunner,
  type RetrieveIndexBuilder,
} from '../src/pipeline/retrieve-index.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { querySystemPrompt, QUERY_SYSTEM_PROMPT } from '../src/pipeline/system-prompt.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import type { JobRow } from '../src/db/jobs.js'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function makeVault(opts: { scripts?: boolean; git?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  roots.push(root)
  if (opts.scripts !== false) {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    for (const s of ['retrieve.py', 'contextual-prefix.py', 'bm25-index.py']) {
      fs.writeFileSync(path.join(root, 'scripts', s), '#!/usr/bin/env python3\n')
    }
  }
  if (opts.git !== false) fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  return root
}

function provision(root: string, chunks = 3): void {
  const chunkDir = path.join(root, '.vault-meta', 'chunks', 'addr-001')
  fs.mkdirSync(chunkDir, { recursive: true })
  for (let i = 0; i < chunks; i++) {
    fs.writeFileSync(path.join(chunkDir, `chunk-${String(i).padStart(3, '0')}.json`), '{}')
  }
  fs.mkdirSync(path.join(root, '.vault-meta', 'bm25'), { recursive: true })
  fs.writeFileSync(path.join(root, '.vault-meta', 'bm25', 'index.json'), '{}')
}

function doneJob(): JobRow {
  return { status: 'done' } as unknown as JobRow
}

const settled = async (runner: MaintenanceRunner, id: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (runner.getRun(id)?.status !== 'running') return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('run never settled')
}

describe('ensureIndexExcluded', () => {
  it('writes all entries and is idempotent', () => {
    const root = makeVault()
    ensureIndexExcluded(root)
    ensureIndexExcluded(root)
    const content = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8')
    for (const entry of RETRIEVE_EXCLUDE_ENTRIES) {
      expect(content.split('\n').filter((l) => l.trim() === entry)).toHaveLength(1)
    }
  })

  it('appends to existing content without duplicating present entries', () => {
    const root = makeVault()
    const infoDir = path.join(root, '.git', 'info')
    fs.mkdirSync(infoDir, { recursive: true })
    fs.writeFileSync(path.join(infoDir, 'exclude'), '# custom\n.vault-meta/chunks/\n')
    ensureIndexExcluded(root)
    const lines = fs.readFileSync(path.join(infoDir, 'exclude'), 'utf8').split('\n')
    expect(lines[0]).toBe('# custom')
    expect(lines.filter((l) => l.trim() === '.vault-meta/chunks/')).toHaveLength(1)
    expect(lines).toContain('.vault-meta/bm25/')
    expect(lines).toContain('.vault-meta/embed-cache.json')
  })

  it('is a no-op when the vault is not a git repo', () => {
    const root = makeVault({ git: false })
    ensureIndexExcluded(root)
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false)
  })
})

describe('feature detection & stats', () => {
  it('reports scripts/provisioned/chunks across the provisioning lifecycle', () => {
    const bare = makeVault({ scripts: false })
    expect(hasRetrieveScripts(bare)).toBe(false)
    expect(retrieveIndexStats(bare)).toEqual({
      scriptsPresent: false,
      provisioned: false,
      chunkCount: 0,
      indexBuiltAt: null,
    })

    const root = makeVault()
    expect(hasRetrieveScripts(root)).toBe(true)
    expect(isRetrieveProvisioned(root)).toBe(false)

    provision(root, 4)
    expect(isRetrieveProvisioned(root)).toBe(true)
    const stats = retrieveIndexStats(root)
    expect(stats.provisioned).toBe(true)
    expect(stats.chunkCount).toBe(4)
    expect(stats.indexBuiltAt).not.toBeNull()
  })

  it('counts chunk files recursively and ignores other files', () => {
    const root = makeVault()
    provision(root, 2)
    const other = path.join(root, '.vault-meta', 'chunks', 'addr-002')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'chunk-000.json'), '{}')
    fs.writeFileSync(path.join(other, 'notes.txt'), 'x')
    expect(retrieveIndexStats(root).chunkCount).toBe(3)
  })
})

describe('buildRetrieveIndex', () => {
  it('runs prefix then bm25 in the vault, provisions dirs and excludes', async () => {
    const root = makeVault()
    const calls: Array<{ bin: string; args: readonly string[]; cwd: string }> = []
    const run: ProcessRunner = async (bin, args, opts) => {
      calls.push({ bin, args, cwd: opts.cwd })
      return { stdout: '', stderr: '' }
    }
    const result = await buildRetrieveIndex({ vaultRoot: root, run })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ bin: 'python3', args: ['scripts/contextual-prefix.py', '--all'], cwd: root })
    expect(calls[1]).toMatchObject({ bin: 'python3', args: ['scripts/bm25-index.py', 'build'], cwd: root })
    // No --allow-egress anywhere: index builds must stay on-machine (stage 3 changes this).
    expect(calls.flatMap((c) => [...c.args])).not.toContain('--allow-egress')
    expect(fs.existsSync(path.join(root, '.vault-meta', 'chunks'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.vault-meta', 'bm25'))).toBe(true)
    expect(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.vault-meta/bm25/')
    expect(result.chunkCount).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports the chunk count the scripts produced', async () => {
    const root = makeVault()
    const run: ProcessRunner = async (bin, args) => {
      if (args[0] === 'scripts/contextual-prefix.py') provision(root, 5)
      return { stdout: '', stderr: '' }
    }
    const result = await buildRetrieveIndex({ vaultRoot: root, run })
    expect(result.chunkCount).toBe(5)
  })

  it('throws RetrieveScriptsMissingError on a pre-v1.7 vault', async () => {
    const root = makeVault({ scripts: false })
    const run: ProcessRunner = async () => ({ stdout: '', stderr: '' })
    await expect(buildRetrieveIndex({ vaultRoot: root, run })).rejects.toBeInstanceOf(RetrieveScriptsMissingError)
  })

  it('propagates a failing script', async () => {
    const root = makeVault()
    const run: ProcessRunner = async () => {
      throw new Error('python3 scripts/bm25-index.py build failed: exit 1')
    }
    await expect(buildRetrieveIndex({ vaultRoot: root, run })).rejects.toThrow(/bm25-index/)
  })
})

describe('startRetrieveIndexScheduler', () => {
  it('debounces a burst of done jobs into one rebuild', () => {
    vi.useFakeTimers()
    const events = new EventBus()
    const start = vi.fn()
    const scheduler = startRetrieveIndexScheduler({ events, start, isProvisioned: () => true, debounceMs: 1000 })
    events.publish({ kind: 'job', job: doneJob() })
    events.publish({ kind: 'job', job: doneJob() })
    events.publish({ kind: 'job', job: doneJob() })
    vi.advanceTimersByTime(999)
    expect(start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(start).toHaveBeenCalledTimes(1)
    scheduler.close()
  })

  it('resets the quiet window on each done job', () => {
    vi.useFakeTimers()
    const events = new EventBus()
    const start = vi.fn()
    const scheduler = startRetrieveIndexScheduler({ events, start, isProvisioned: () => true, debounceMs: 1000 })
    events.publish({ kind: 'job', job: doneJob() })
    vi.advanceTimersByTime(800)
    events.publish({ kind: 'job', job: doneJob() })
    vi.advanceTimersByTime(800)
    expect(start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(start).toHaveBeenCalledTimes(1)
    scheduler.close()
  })

  it('ignores non-done and non-job events, and stays inert when unprovisioned', () => {
    vi.useFakeTimers()
    const events = new EventBus()
    const start = vi.fn()
    let provisioned = false
    const scheduler = startRetrieveIndexScheduler({
      events,
      start,
      isProvisioned: () => provisioned,
      debounceMs: 1000,
    })
    events.publish({ kind: 'stats' })
    events.publish({ kind: 'job', job: { status: 'failed' } as unknown as JobRow })
    vi.advanceTimersByTime(2000)
    expect(start).not.toHaveBeenCalled()
    // Unprovisioned at fire time → skipped; provisioned mid-window → runs without restart.
    events.publish({ kind: 'job', job: doneJob() })
    vi.advanceTimersByTime(1000)
    expect(start).not.toHaveBeenCalled()
    provisioned = true
    events.publish({ kind: 'job', job: doneJob() })
    vi.advanceTimersByTime(1000)
    expect(start).toHaveBeenCalledTimes(1)
    scheduler.close()
  })

  it('close() cancels a pending rebuild, and a throwing start never escapes the timer', () => {
    vi.useFakeTimers()
    const events = new EventBus()
    const start = vi.fn()
    const scheduler = startRetrieveIndexScheduler({ events, start, isProvisioned: () => true, debounceMs: 1000 })
    events.publish({ kind: 'job', job: doneJob() })
    scheduler.close()
    vi.advanceTimersByTime(2000)
    expect(start).not.toHaveBeenCalled()

    const throwing = startRetrieveIndexScheduler({
      events,
      start: () => {
        throw new Error('scripts vanished')
      },
      isProvisioned: () => true,
      debounceMs: 1000,
    })
    events.publish({ kind: 'job', job: doneJob() })
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    throwing.close()
  })
})

describe('querySystemPrompt (stage 1 read-path flip)', () => {
  it('keeps the legacy prompt byte-for-byte while unprovisioned', () => {
    const root = makeVault() // scripts present, index not built
    expect(querySystemPrompt(root)).toBe(QUERY_SYSTEM_PROMPT)
    expect(querySystemPrompt(root)).toContain('hot cache → index → relevant pages')
    expect(querySystemPrompt(root)).not.toContain('retrieve.py')
  })

  it('switches to chunk retrieval once the index is provisioned — with rerank pinned off', () => {
    const root = makeVault()
    provision(root)
    const prompt = querySystemPrompt(root)
    expect(prompt).toContain('scripts/retrieve.py')
    expect(prompt).toContain('--no-rerank')
    // The rest of the read-only contract must survive the flip unchanged.
    expect(prompt).toContain('read-only')
    expect(prompt).toContain('[[Page Name]]')
    // The fallback still names the legacy order for the script-failure case.
    expect(prompt).toContain('hot cache → index → relevant pages')
  })
})

describe('MaintenanceRunner retrieve-index kind', () => {
  const runner = (root: string, buildIndex?: RetrieveIndexBuilder) =>
    new MaintenanceRunner({
      vaultRoot: root,
      // Deterministic runs need no credential — auth null (setup mode) must work.
      auth: null,
      events: new EventBus(),
      commitMutex: new Mutex(),
      runAgent: (() => {
        throw new Error('retrieve-index must never spawn an agent')
      }) as never,
      ...(buildIndex ? { buildIndex } : {}),
    })

  it('settles done with the build summary, without an agent or credential', async () => {
    const root = makeVault()
    const m = runner(root, async () => ({ chunkCount: 7, durationMs: 1500 }))
    const run = m.startRetrieveIndex()
    expect(run.status).toBe('running')
    expect(run.kind).toBe('retrieve-index')
    expect(run.channel).toBe('maintenance:retrieve-index')
    await settled(m, run.id)
    const final = m.getRun(run.id)
    expect(final?.status).toBe('done')
    expect(final?.result?.ok).toBe(true)
    expect(final?.result?.answer).toContain('7 chunk(s)')
    expect(final?.result?.usage).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 })
  })

  it('settles error when the build fails, and fires onRunSettled', async () => {
    const root = makeVault()
    const m = runner(root, async () => {
      throw new Error('python3 missing')
    })
    const run = m.startRetrieveIndex()
    const notified = new Promise<string | undefined>((resolve) => {
      m.onRunSettled(run.id, (r) => resolve(r.error))
    })
    await settled(m, run.id)
    expect(m.getRun(run.id)?.status).toBe('error')
    expect(await notified).toContain('python3 missing')
  })

  it('throws synchronously on a vault without wiki-retrieve scripts', () => {
    const root = makeVault({ scripts: false })
    const m = runner(root, async () => ({ chunkCount: 0, durationMs: 0 }))
    expect(() => m.startRetrieveIndex()).toThrow(RetrieveScriptsMissingError)
  })

  it('serializes concurrent builds on the index mutex', async () => {
    const root = makeVault()
    let inFlight = 0
    let maxInFlight = 0
    const m = runner(root, async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return { chunkCount: 1, durationMs: 20 }
    })
    const a = m.startRetrieveIndex()
    const b = m.startRetrieveIndex()
    await settled(m, a.id)
    await settled(m, b.id)
    expect(maxInFlight).toBe(1)
    expect(m.getRun(a.id)?.status).toBe('done')
    expect(m.getRun(b.id)?.status).toBe('done')
  })
})
