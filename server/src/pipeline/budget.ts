/**
 * Daily budget (SPEC.md §7.1, §11.3 risk 3): a configurable per-day ceiling that pauses the
 * ingest queue when exceeded and releases it at the next local midnight.
 *
 * The UNIT depends on the Anthropic auth mode, because the two modes constrain different things:
 *  - `oauth` (subscription): the limit is a JOB COUNT per day ("Job-Budget pro Tag … Anzahl
 *    Ingests, nicht als Dollarbetrag", SPEC.md §7.1). There is no real per-job money to cap —
 *    runs compete with interactive use for the subscription's shared limits.
 *  - `api-key`: the limit is a USD amount, where pay-per-use means real cost per job.
 *
 * This module is the single definition of "spent today" and "over budget" so the queue's pause
 * decision and the dashboard's budget display can never disagree.
 */

import type { Config } from '../config.js'
import type { JobStore } from '../db/jobs.js'
import type { EffectiveSettings } from '../db/settings.js'

export type BudgetUnit = 'jobs' | 'usd'

export interface BudgetStatus {
  /** Configured ceiling, or null when no budget is set (the default — unlimited). */
  readonly limit: number | null
  /** What `limit`/`spent` are counted in, decided by the auth mode. */
  readonly unit: BudgetUnit
  /** Consumed since local midnight: ingests in oauth mode, USD in api-key mode. */
  readonly spent: number
  /** True when a budget is set and has been reached — the queue pauses. */
  readonly exceeded: boolean
  /** ISO timestamp the budget window resets at (next local midnight). */
  readonly resetsAt: string
}

/** The unit the budget is expressed in for this auth mode. */
export function budgetUnit(config: Config): BudgetUnit {
  return config.auth.mode === 'oauth' ? 'jobs' : 'usd'
}

/** Local midnight that starts today's budget window. */
export function startOfToday(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Local midnight that ends it — when a budget pause auto-resumes. */
export function nextMidnight(now: Date = new Date()): Date {
  const start = startOfToday(now)
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
}

/** Milliseconds until the budget window resets (at least 1, so a timer always fires). */
export function msUntilReset(now: Date = new Date()): number {
  return Math.max(1, nextMidnight(now).getTime() - now.getTime())
}

/**
 * Evaluates today's budget. Used both by the queue (to decide whether to pause) and by
 * `/api/v1/stats` (to show it), so the two are always consistent.
 */
export function budgetStatus(
  config: Config,
  settings: EffectiveSettings,
  store: JobStore,
  now: Date = new Date(),
): BudgetStatus {
  const unit = budgetUnit(config)
  const limit = settings.dailyBudget
  const usage = store.usageSince(startOfToday(now).toISOString())
  const spent = unit === 'jobs' ? usage.ingests : usage.costUsd
  return {
    limit,
    unit,
    spent,
    exceeded: limit !== null && spent >= limit,
    resetsAt: nextMidnight(now).toISOString(),
  }
}
