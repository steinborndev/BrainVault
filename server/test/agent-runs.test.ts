/**
 * The persistent run log (schema v12): the store's semantics, the runner writing one row per
 * settle - success AND failure - and the history endpoint that serves it.
 *
 * The gap this closes: `maintenance_state` keeps one row per KIND, so a research run's topic,
 * lens, cost and duration survived only until the next run of that kind. A run that failed
 * before writing a page left no trace at all once the in-memory registry evicted it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { SqliteAgentRunStore, MemoryAgentRunStore, type AgentRunRecord } from '../src/db/agent-runs.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'
import type { AgentRunResult } from '../src/pipeline/agent-runner.js'

const record = (over: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  id: 'r1',
  kind: 'research',
  label: 'Sodium-ion cathodes',
  profileKey: 'sota',
  ok: true,
  pages: ['wiki/questions/Research: Sodium-ion cathodes - State of the Art.md'],
  tokensIn: 40_000,
  tokensOut: 3_000,
  costUsd: 1.8,
  error: null,
  startedAt: '2026-08-25T09:00:00.000Z',
  finishedAt: '2026-08-25T09:20:00.000Z',
  ...over,
})

const okResult = (text: string): AgentRunResult => ({
  ok: true,
  result: text,
  usage: { tokensIn: 12, tokensOut: 3, costUsd: 0.5 },
  durationMs: 1,
  numTurns: 1,
  sessionId: 's',
  timedOut: false,
})

describe('SqliteAgentRunStore', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => {
    db.close()
  })

  it('keeps a row per run, newest first, with the facts the state table drops', () => {
    const store = new SqliteAgentRunStore(db)
    store.record(record())
    store.record(record({ id: 'r2', label: 'Perovskite tandems', finishedAt: '2026-08-25T10:00:00.000Z' }))

    const runs = store.list()
    expect(runs.map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(runs[1]).toMatchObject({
      label: 'Sodium-ion cathodes',
      profileKey: 'sota',
      costUsd: 1.8,
      tokensIn: 40_000,
      startedAt: '2026-08-25T09:00:00.000Z',
    })
    expect(runs[1]!.pages).toHaveLength(1)
  })

  it('keeps a failed run - the one case no vault page and no state row can show', () => {
    const store = new SqliteAgentRunStore(db)
    store.record(record({ id: 'bad', ok: false, pages: [], costUsd: 0.24, error: 'usage limit reached' }))
    store.record(record({ id: 'good', kind: 'lint', finishedAt: '2026-08-25T11:00:00.000Z' }))

    const failed = store.list({ kind: 'research' })
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ ok: false, error: 'usage limit reached', pages: [] })
  })

  it('filters by kind and caps by limit', () => {
    const store = new SqliteAgentRunStore(db)
    for (let i = 0; i < 5; i++) {
      store.record(record({ id: `r${i}`, finishedAt: `2026-08-2${i}T09:00:00.000Z` }))
      store.record(record({ id: `l${i}`, kind: 'lint', finishedAt: `2026-08-2${i}T10:00:00.000Z` }))
    }
    expect(store.list({ kind: 'research' })).toHaveLength(5)
    expect(store.list({ kind: 'lint', limit: 2 })).toHaveLength(2)
    expect(store.list({ limit: 3 })).toHaveLength(3)
  })

  it('re-settling the same id corrects the row instead of duplicating it', () => {
    const store = new SqliteAgentRunStore(db)
    store.record(record({ ok: false, error: 'transient' }))
    store.record(record({ ok: true, error: null }))
    const runs = store.list()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.ok).toBe(true)
  })

  it('prunes to the newest N so history cannot grow without bound', () => {
    const store = new SqliteAgentRunStore(db, 'local', 3)
    for (let i = 0; i < 6; i++) {
      store.record(record({ id: `r${i}`, finishedAt: `2026-08-0${i + 1}T09:00:00.000Z` }))
    }
    const runs = store.list()
    expect(runs).toHaveLength(3)
    expect(runs.map((r) => r.id)).toEqual(['r5', 'r4', 'r3'])
  })

  it('scopes by user', () => {
    const local = new SqliteAgentRunStore(db, 'local')
    const other = new SqliteAgentRunStore(db, 'other')
    local.record(record())
    expect(other.list()).toEqual([])
  })
})

describe('MemoryAgentRunStore', () => {
  it('behaves like the persistent one for the process lifetime', () => {
    const store = new MemoryAgentRunStore()
    store.record(record())
    store.record(record({ id: 'r2', kind: 'lint', finishedAt: '2026-08-25T12:00:00.000Z' }))
    expect(store.list().map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(store.list({ kind: 'research' })).toHaveLength(1)
  })
})

describe('MaintenanceRunner run history', () => {
  let vaultRoot: string
  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-runs-'))
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

  const makeRunner = (store: MemoryAgentRunStore, agentOk: boolean): MaintenanceRunner =>
    new MaintenanceRunner({
      vaultRoot,
      auth: { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'x' },
      events: new EventBus(),
      commitMutex: new Mutex(),
      runAgent: async () =>
        agentOk ? okResult('done') : ({ ...okResult(''), ok: false, error: 'agent exploded' } as AgentRunResult),
      commit: async () => ({ committed: true, hash: 'abc12345', committedPages: ['wiki/questions/Research: X.md'] }),
      runStore: store,
    })

  it('records a research run with its topic, lens, pages and cost', async () => {
    const store = new MemoryAgentRunStore()
    const runner = makeRunner(store, true)
    const run = runner.startResearch('Sodium-ion cathodes', 'sota')
    await waitSettled(runner, run.id)

    const runs = store.list({ kind: 'research' })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: run.id,
      kind: 'research',
      label: 'Sodium-ion cathodes',
      profileKey: 'sota',
      ok: true,
      costUsd: 0.5,
    })
    expect(runs[0]!.pages).toContain('wiki/questions/Research: X.md')
    expect(Date.parse(runs[0]!.startedAt)).toBeLessThanOrEqual(Date.parse(runs[0]!.finishedAt))
  })

  it('records a failed run with its error, so it survives eviction and restarts', async () => {
    const store = new MemoryAgentRunStore()
    const runner = makeRunner(store, false)
    const run = runner.startResearch('Grid-scale storage', 'startups')
    await waitSettled(runner, run.id)

    const runs = store.list()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ ok: false, label: 'Grid-scale storage', profileKey: 'startups' })
    expect(runs[0]!.error).toContain('agent exploded')
  })

  it('records the other run kinds too, with no label to speak of', async () => {
    const store = new MemoryAgentRunStore()
    const runner = makeRunner(store, true)
    const run = runner.startHotCache()
    await waitSettled(runner, run.id)

    expect(store.list({ kind: 'hot-cache' })).toHaveLength(1)
    expect(store.list({ kind: 'hot-cache' })[0]!.label).toBeNull()
  })
})
