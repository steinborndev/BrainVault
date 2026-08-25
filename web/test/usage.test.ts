import { describe, it, expect } from 'vitest'
import { spendByChannel, spendItems, topSpend, totalSpend, withinDays } from '../src/lib/usage.ts'
import type { Job, MaintenanceRun } from '../src/api/types.ts'

const NOW = new Date('2026-08-25T12:00:00.000Z')

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  user_id: 'local',
  batch_id: null,
  source: 'drop',
  type: 'pdf',
  original_name: 'paper.pdf',
  url: null,
  sha256: null,
  status: 'done',
  raw_path: null,
  created_pages: null,
  error: null,
  attempts: 1,
  tokens_in: 1000,
  tokens_out: 200,
  cost_usd: 0.4,
  created_at: '2026-08-25T10:00:00.000Z',
  started_at: '2026-08-25T10:00:00.000Z',
  finished_at: '2026-08-25T10:04:00.000Z',
  ...over,
})

const run = (over: Partial<MaintenanceRun> = {}): MaintenanceRun => ({
  id: 'r1',
  kind: 'research',
  channel: 'maintenance:research',
  status: 'done',
  label: 'Batteries',
  startedAt: '2026-08-24T09:00:00.000Z',
  finishedAt: '2026-08-24T09:20:00.000Z',
  result: {
    ok: true,
    kind: 'research',
    pages: [],
    usage: { tokensIn: 40000, tokensOut: 3000, costUsd: 1.8 },
  },
  ...over,
})

describe('spendItems', () => {
  it('takes both priced sources: job costs and run usage', () => {
    const items = spendItems([job()], [run()])
    expect(items.map((i) => i.kind)).toEqual(['ingest', 'run'])
    expect(items.map((i) => i.channel)).toEqual(['drop', 'research'])
  })

  it('skips rows that cost nothing - an unpriced job is not a zero-cost run', () => {
    expect(spendItems([job({ cost_usd: null }), job({ id: 'j2', cost_usd: 0 })], [])).toHaveLength(0)
    expect(spendItems([], [run({ result: undefined })])).toHaveLength(0)
  })

  it('sorts newest first', () => {
    const items = spendItems([job({ finished_at: '2026-08-20T10:00:00.000Z' })], [run()])
    expect(items[0]!.kind).toBe('run')
  })
})

describe('withinDays', () => {
  it('keeps only what falls inside the window', () => {
    const items = spendItems([job(), job({ id: 'j2', finished_at: '2026-08-01T10:00:00.000Z' })], [])
    expect(withinDays(items, 7, NOW)).toHaveLength(1)
    expect(withinDays(items, null, NOW)).toHaveLength(2)
  })
})

describe('spendByChannel', () => {
  it('sums per channel, biggest first', () => {
    const items = spendItems([job(), job({ id: 'j2', source: 'watch', cost_usd: 0.1 })], [run()])
    expect(spendByChannel(items)).toEqual([
      { channel: 'research', costUsd: 1.8, runs: 1 },
      { channel: 'drop', costUsd: 0.4, runs: 1 },
      { channel: 'watch', costUsd: 0.1, runs: 1 },
    ])
  })
})

describe('topSpend and totalSpend', () => {
  it('ranks the most expensive runs and adds the window up', () => {
    const items = spendItems([job(), job({ id: 'j2', cost_usd: 0.9 })], [run()])
    expect(topSpend(items, 2).map((i) => i.id)).toEqual(['r1', 'j2'])
    expect(totalSpend(items)).toBeCloseTo(3.1, 5)
  })
})
