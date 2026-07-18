import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { budgetStatus, budgetUnit, startOfToday, nextMidnight, msUntilReset } from '../src/pipeline/budget.js'
import { baselineSettings, effectiveSettings } from '../src/db/settings.js'
import type { Config } from '../src/config.js'

let db: Db
let store: JobStore

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

describe('usageSince aggregate', () => {
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
