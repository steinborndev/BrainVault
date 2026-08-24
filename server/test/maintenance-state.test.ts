/**
 * Per-area maintenance state (SPEC.md §12.7 Stufe b): the SQLite store's upsert semantics,
 * and the runner actually recording every settle — success and failure — so the dashboard's
 * "what's due" head survives restarts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import {
  SqliteMaintenanceStateStore,
  MemoryMaintenanceStateStore,
} from '../src/db/maintenance-state.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'

const okResult = (text: string): AgentRunResult => ({
  ok: true,
  result: text,
  usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
  durationMs: 1,
  numTurns: 1,
  sessionId: 's',
  timedOut: false,
})

describe('SqliteMaintenanceStateStore', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => {
    db.close()
  })

  it('upserts one row per kind — the newest settle wins', () => {
    const store = new SqliteMaintenanceStateStore(db)
    store.record({ kind: 'tag-fix', runId: 'r1', ok: true, pages: 4, error: null, finishedAt: '2026-07-24T10:00:00.000Z' })
    store.record({ kind: 'tag-fix', runId: 'r2', ok: false, pages: 0, error: 'boom', finishedAt: '2026-07-24T11:00:00.000Z' })
    store.record({ kind: 'lint', runId: 'r3', ok: true, pages: 1, error: null, finishedAt: '2026-07-24T10:30:00.000Z' })

    const areas = store.list()
    expect(areas).toHaveLength(2)
    // Newest first; the tag-fix row reflects the SECOND run entirely.
    expect(areas[0]).toEqual({ kind: 'tag-fix', runId: 'r2', ok: false, pages: 0, error: 'boom', finishedAt: '2026-07-24T11:00:00.000Z' })
    expect(areas[1]!.kind).toBe('lint')
  })

  it('scopes by user', () => {
    const local = new SqliteMaintenanceStateStore(db, 'local')
    const other = new SqliteMaintenanceStateStore(db, 'other')
    local.record({ kind: 'lint', runId: 'r1', ok: true, pages: 0, error: null, finishedAt: '2026-07-24T10:00:00.000Z' })
    expect(other.list()).toEqual([])
  })
})

describe('MaintenanceRunner state persistence', () => {
  let vaultRoot: string
  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-state-'))
    fs.mkdirSync(path.join(vaultRoot, 'wiki', 'meta'), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const waitSettled = async (runner: MaintenanceRunner, id: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const run = runner.getRun(id)
      if (run !== undefined && run.status !== 'running') return
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('run never settled')
  }

  const makeRunner = (store: MemoryMaintenanceStateStore, agentOk: boolean): MaintenanceRunner =>
    new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      runAgent: async () =>
        agentOk
          ? okResult('done')
          : ({ ...okResult(''), ok: false, error: 'agent exploded' } as AgentRunResult),
      commit: async () => ({ committed: true, hash: 'abc12345', committedPages: ['wiki/hot.md'] }),
      stateStore: store,
    })

  it('records a successful settle with its committed page count', async () => {
    const store = new MemoryMaintenanceStateStore()
    const runner = makeRunner(store, true)
    const run = runner.startHotCache()
    await waitSettled(runner, run.id)

    const areas = store.list()
    expect(areas).toHaveLength(1)
    expect(areas[0]).toMatchObject({ kind: 'hot-cache', runId: run.id, ok: true, pages: 1, error: null })
    expect(areas[0]!.finishedAt).toBeTruthy()
  })

  it('records a failed settle with its error', async () => {
    const store = new MemoryMaintenanceStateStore()
    const runner = makeRunner(store, false)
    const run = runner.startHotCache()
    await waitSettled(runner, run.id)

    const areas = store.list()
    expect(areas).toHaveLength(1)
    expect(areas[0]).toMatchObject({ kind: 'hot-cache', ok: false, pages: 0, error: 'agent exploded' })
  })

  it('a lint that wrote no report settles as FAILED, not as a silent success', async () => {
    // The bug this pins down: a lint run exiting cleanly without writing its report left the
    // dashboard announcing "Lint report written" while the status head still measured the
    // area from a report weeks older, because the run record said ok and nothing checked the
    // artifact. The report IS the deliverable - lint-fix is bounded by it.
    const store = new MemoryMaintenanceStateStore()
    const runner = makeRunner(store, true)
    const run = runner.startLint()
    await waitSettled(runner, run.id)

    expect(runner.getRun(run.id)?.status).toBe('error')
    expect(store.list()[0]).toMatchObject({ kind: 'lint', ok: false })
    expect(store.list()[0]!.error).toContain('without writing a report')
  })

  it('a lint that DID write a report settles as done and carries its path', async () => {
    const store = new MemoryMaintenanceStateStore()
    const runner = new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      // The agent writes the report as a real run would, mid-run.
      runAgent: async () => {
        fs.writeFileSync(
          path.join(vaultRoot, 'wiki', 'meta', 'lint-report-2026-08-25.md'),
          '# Lint report\n\n## Orphan Pages\n\n- [[Something]]\n',
        )
        return okResult('report written')
      },
      commit: async () => ({ committed: true, hash: 'abc12345', committedPages: ['wiki/meta/lint-report-2026-08-25.md'] }),
      stateStore: store,
    })
    const run = runner.startLint()
    await waitSettled(runner, run.id)

    expect(runner.getRun(run.id)?.status).toBe('done')
    expect(runner.getRun(run.id)?.result?.reportPath).toBe('wiki/meta/lint-report-2026-08-25.md')
  })

  it('an OLD report cannot stand in for a run that produced nothing', async () => {
    // Same shape as the vault that surfaced this: a month-old report on disk, and a lint run
    // that wrote nothing. Without the freshness check the old file made the run look fine.
    const old = path.join(vaultRoot, 'wiki', 'meta', 'lint-report-2026-07-24.md')
    fs.writeFileSync(old, '# Lint report\n\n## Dead Links\n\n- [[Gone]]\n')
    const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    fs.utimesSync(old, past, past)

    const store = new MemoryMaintenanceStateStore()
    const runner = makeRunner(store, true)
    const run = runner.startLint()
    await waitSettled(runner, run.id)

    expect(runner.getRun(run.id)?.status).toBe('error')
  })

  it('a research run carries its topic and lens on the tracked record', async () => {
    // Every surface outside the composer (Home's in-flight list, the sidebar badge, the
    // inbox) needs to name what is running; the kind alone says only "research".
    const store = new MemoryMaintenanceStateStore()
    const runner = makeRunner(store, true)
    const run = runner.startResearch('solid-state battery manufacturing', 'startups')

    expect(run.label).toBe('solid-state battery manufacturing')
    expect(run.profileKey).toBe('startups')
    expect(runner.listRuns()[0]).toMatchObject({ label: 'solid-state battery manufacturing' })
    await waitSettled(runner, run.id)
  })

  it('a throwing store never breaks the settle itself', async () => {
    const store: MemoryMaintenanceStateStore = new (class extends MemoryMaintenanceStateStore {
      override record(): void {
        throw new Error('disk full')
      }
    })()
    const runner = makeRunner(store, true)
    const run = runner.startHotCache()
    await waitSettled(runner, run.id)
    expect(runner.getRun(run.id)?.status).toBe('done')
  })
})
