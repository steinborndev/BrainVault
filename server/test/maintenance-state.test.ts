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
