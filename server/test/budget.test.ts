import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { SqliteAgentRunStore } from '../src/db/agent-runs.js'
import { budgetStatus, budgetUnit, startOfToday, nextMidnight, msUntilReset } from '../src/pipeline/budget.js'
import { baselineSettings, effectiveSettings } from '../src/db/settings.js'
import type { Config } from '../src/config.js'

let db: Db
let store: JobStore
let runs: SqliteAgentRunStore

const makeConfig = (mode: 'oauth' | 'api-key'): Config =>
  ({
    vaultRoot: '/v',
    obsidianVaultName: 'v',
    auth: { mode, credential: 'c', envVar: mode === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY' },
    server: {
      host: '127.0.0.1',
      port: 8420,
      watchFolder: '/inbox',
      maxUploadBytes: 1024,
      authMode: 'local-single-user',
    },
  }) as Config

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
  runs = new SqliteAgentRunStore(db)
})

/** Drives a job to a terminal state with usage, so it counts toward today's budget. */
function finishedJob(sha: string, status: 'done' | 'failed', costUsd: number, tokens = 100): void {
  const { job } = store.create({ source: 'drop', type: 'pdf', originalName: `${sha}.pdf`, sha256: sha })
  store.transition(job.id, 'preprocessing')
  store.transition(job.id, 'ingesting')
  store.transition(job.id, status, {
    patch: { tokensIn: tokens, tokensOut: tokens, costUsd },
  })
}

/**
 * A settled agent run in the run log (research, lint, hot cache, …). These spend the same
 * tokens against the same limits as an ingest, so they count the same way.
 */
function finishedRun(id: string, costUsd: number, tokens = 100, ok = true): void {
  runs.record({
    id,
    kind: 'research',
    label: 'a topic',
    profileKey: 'broad',
    ok,
    pages: [],
    tokensIn: tokens,
    tokensOut: tokens,
    costUsd,
    error: ok ? null : 'boom',
    commitHash: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  })
}

describe('usageSince aggregate', () => {
  it('counts agent runs alongside ingests, because both spend the same tokens', () => {
    // Until 2026-08-25 this read `jobs` alone. A vault filled mainly by research therefore
    // reported a spend of $0, and - the part that mattered - those runs passed the daily
    // budget untouched, though a single research run can cost more than a day of ingests.
    finishedJob('a', 'done', 0.5)
    finishedRun('r1', 2.5, 1000)
    const usage = store.usageSince(startOfToday().toISOString())
    expect(usage.ingests).toBe(2)
    expect(usage.costUsd).toBeCloseTo(3)
    expect(usage.tokensIn).toBe(1100)
  })

  it('counts a failed agent run too - it spent its tokens either way', () => {
    finishedRun('r1', 1.25, 500, false)
    const usage = store.usageSince(startOfToday().toISOString())
    expect(usage.ingests).toBe(1)
    expect(usage.costUsd).toBeCloseTo(1.25)
  })

  it('leaves agent runs outside the window alone', () => {
    runs.record({
      id: 'old', kind: 'lint', label: null, profileKey: null, ok: true, pages: [],
      tokensIn: 999, tokensOut: 999, costUsd: 9.99, error: null, commitHash: null,
      startedAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:10:00.000Z',
    })
    const usage = store.usageSince(startOfToday().toISOString())
    expect(usage.ingests).toBe(0)
    expect(usage.costUsd).toBe(0)
  })

  it('sums tokens/cost and counts ingests over done AND failed runs', () => {
    // A failed run still spent tokens and still competed for the subscription limit, so it
    // must count — otherwise a run of failures blows through a budget unnoticed.
    finishedJob('a', 'done', 0.5)
    finishedJob('b', 'failed', 0.25)
    const usage = store.usageSince(startOfToday().toISOString())
    expect(usage.ingests).toBe(2)
    expect(usage.costUsd).toBeCloseTo(0.75)
    expect(usage.tokensIn).toBe(200)
    expect(usage.tokensOut).toBe(200)
  })

  it('excludes jobs that never ran an agent (duplicate/queued)', () => {
    finishedJob('same', 'done', 1)
    store.create({ source: 'watch', type: 'pdf', sha256: 'same' }) // duplicate
    store.create({ source: 'drop', type: 'pdf', originalName: 'q.pdf', sha256: 'q' }) // queued
    const usage = store.usageSince(startOfToday().toISOString())
    expect(usage.ingests).toBe(1)
    expect(usage.costUsd).toBeCloseTo(1)
  })

  it('ignores work finished before the window', () => {
    finishedJob('a', 'done', 2)
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    expect(store.usageSince(tomorrow)).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, ingests: 0 })
  })
})

describe('budget unit depends on the auth mode (SPEC.md §7.1)', () => {
  it('counts JOBS in subscription mode — the limit is not a dollar amount there', () => {
    const config = makeConfig('oauth')
    expect(budgetUnit(config)).toBe('jobs')
    finishedJob('a', 'done', 5) // expensive but only ONE ingest
    finishedJob('b', 'done', 5)

    const settings = effectiveSettings(config, { dailyBudget: 3 })
    const status = budgetStatus(config, settings, store)
    expect(status.unit).toBe('jobs')
    expect(status.spent).toBe(2) // 2 ingests, not $10
    expect(status.exceeded).toBe(false)

    finishedJob('c', 'done', 0.01)
    expect(budgetStatus(config, settings, store).spent).toBe(3)
    expect(budgetStatus(config, settings, store).exceeded).toBe(true)
  })

  it('lets an agent run exhaust the budget, not just ingests', () => {
    // The hole this closes: a research run is the most expensive thing the service does, and
    // the budget it is supposed to be bounded by could not see it at all.
    const config = makeConfig('oauth')
    const settings = effectiveSettings(config, { dailyBudget: 2 })
    finishedRun('r1', 7.2, 14_803_910)
    expect(budgetStatus(config, settings, store).spent).toBe(1)
    finishedRun('r2', 3.1)
    const status = budgetStatus(config, settings, store)
    expect(status.spent).toBe(2)
    expect(status.exceeded).toBe(true)
  })

  it('counts an agent run against a dollar budget in api-key mode', () => {
    const config = makeConfig('api-key')
    const settings = effectiveSettings(config, { dailyBudget: 5 })
    finishedRun('r1', 7.2)
    const status = budgetStatus(config, settings, store)
    expect(status.spent).toBeCloseTo(7.2)
    expect(status.exceeded).toBe(true)
  })

  it('counts USD in api-key mode, where cost is real', () => {
    const config = makeConfig('api-key')
    expect(budgetUnit(config)).toBe('usd')
    finishedJob('a', 'done', 1.5)

    const settings = effectiveSettings(config, { dailyBudget: 2 })
    expect(budgetStatus(config, settings, store).spent).toBeCloseTo(1.5)
    expect(budgetStatus(config, settings, store).exceeded).toBe(false)

    finishedJob('b', 'done', 0.6) // total 2.1 > 2
    expect(budgetStatus(config, settings, store).exceeded).toBe(true)
  })

  it('is never exceeded when no budget is configured (the default)', () => {
    const config = makeConfig('oauth')
    for (const s of ['a', 'b', 'c', 'd']) finishedJob(s, 'done', 10)
    const status = budgetStatus(config, baselineSettings(config), store)
    expect(status.limit).toBeNull()
    expect(status.exceeded).toBe(false)
  })
})

describe('budget window', () => {
  const noon = new Date(2026, 6, 18, 12, 30, 0)

  it('runs from local midnight to the next local midnight', () => {
    expect(startOfToday(noon).getHours()).toBe(0)
    expect(startOfToday(noon).getDate()).toBe(18)
    expect(nextMidnight(noon).getDate()).toBe(19)
    expect(nextMidnight(noon).getHours()).toBe(0)
  })

  it('reports the time left until reset', () => {
    expect(msUntilReset(noon)).toBe(11.5 * 60 * 60 * 1000)
    // Always at least 1ms so a resume timer can never be scheduled with 0/negative delay.
    expect(msUntilReset(new Date(2026, 6, 18, 23, 59, 59, 999))).toBeGreaterThan(0)
  })
})
