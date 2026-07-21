import { describe, it, expect } from 'vitest'
import {
  escapeMd,
  truncateMessage,
  pageTitle,
  formatJobOutcome,
  formatBatchOutcome,
  formatResearchOutcome,
  MAX_MESSAGE_CHARS,
} from '../src/telegram/format.js'
import type { JobRow } from '../src/db/jobs.js'
import type { MaintenanceRun } from '../src/pipeline/maintenance.js'

function makeJob(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 'JOB0000000001',
    user_id: 'local',
    batch_id: null,
    source: 'telegram',
    type: 'pdf',
    original_name: 'paper.pdf',
    url: null,
    sha256: null,
    status: 'done',
    raw_path: null,
    created_pages: JSON.stringify(['wiki/concepts/Espresso.md', 'wiki/concepts/Milk Steaming.md']),
    error: null,
    attempts: 1,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    created_at: '2026-07-20T00:00:00.000Z',
    started_at: null,
    finished_at: null,
    notify_channel: 'telegram:500',
    ...over,
  }
}

describe('escapeMd', () => {
  it('escapes every MarkdownV2 reserved character', () => {
    const reserved = '_*[]()~`>#+-=|{}.!\\'
    const escaped = escapeMd(reserved)
    for (const c of reserved) expect(escaped).toContain(`\\${c}`)
    // Round trip: unescaping restores the original.
    expect(escaped.replace(/\\(.)/g, '$1')).toBe(reserved)
  })

  it('leaves plain words alone', () => {
    expect(escapeMd('Espresso')).toBe('Espresso')
  })
})

describe('truncateMessage', () => {
  it('caps at the Telegram limit and marks the cut', () => {
    const long = 'x'.repeat(MAX_MESSAGE_CHARS + 100)
    const cut = truncateMessage(long)
    expect(cut.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(cut.endsWith('…')).toBe(true)
    expect(truncateMessage('short')).toBe('short')
  })
})

describe('pageTitle', () => {
  it('reduces a wiki path to its title', () => {
    expect(pageTitle('wiki/concepts/Milk Steaming.md')).toBe('Milk Steaming')
    expect(pageTitle('wiki/sources/a-b.md')).toBe('a-b')
  })
})

describe('formatJobOutcome', () => {
  it('done: bold name + page TITLES only — never paths, never content (SPEC.md §9)', () => {
    const text = formatJobOutcome(makeJob())
    expect(text).toContain('✅')
    expect(text).toContain('paper\\.pdf')
    expect(text).toContain('Espresso')
    expect(text).toContain('Milk Steaming')
    expect(text).not.toContain('wiki/')
  })

  it('filters vault maintenance pages from the title list — by path, not title', () => {
    const text = formatJobOutcome(
      makeJob({
        created_pages: JSON.stringify([
          'wiki/concepts/Espresso.md',
          'wiki/concepts/_index.md',
          'wiki/index.md',
          'wiki/hot.md',
          'wiki/log.md',
          'wiki/concepts/Log.md', // a REAL page that happens to be titled "Log" stays
        ]),
      }),
    )
    expect(text).toContain('Espresso')
    expect(text).toContain('Log')
    expect(text).not.toContain('_index')
    expect(text).not.toContain('hot')
    // Only maintenance pages touched → no Pages block at all.
    const onlyMaintenance = formatJobOutcome(
      makeJob({ created_pages: JSON.stringify(['wiki/hot.md', 'wiki/sources/_index.md']) }),
    )
    expect(onlyMaintenance).not.toContain('Pages:')
  })

  it('failed: carries the error line and the retry hint', () => {
    const text = formatJobOutcome(makeJob({ status: 'failed', error: 'pdftotext missing (install poppler)' }))
    expect(text).toContain('❌')
    expect(text).toContain('pdftotext missing \\(install poppler\\)')
    expect(text).toContain('Retry')
  })

  it('deferred: names the parking, no pages', () => {
    const text = formatJobOutcome(makeJob({ status: 'deferred', created_pages: null }))
    expect(text).toContain('⏸')
    expect(text).toContain('deferred')
  })

  it('URL jobs fall back to the url as the display name', () => {
    const text = formatJobOutcome(makeJob({ original_name: null, url: 'https://example.org/a_b' }))
    expect(text).toContain('example\\.org')
  })
})

describe('formatBatchOutcome', () => {
  it('ONE message: member lines + deduped union of page titles', () => {
    const text = formatBatchOutcome([
      makeJob({ id: 'A', original_name: 'one.pdf' }),
      makeJob({
        id: 'B',
        original_name: 'two.pdf',
        status: 'failed',
        error: 'boom',
        created_pages: JSON.stringify(['wiki/concepts/Espresso.md']),
      }),
    ])
    expect(text).toContain('1/2 done')
    expect(text).toContain('one\\.pdf')
    expect(text).toContain('two\\.pdf — failed: boom')
    // 'Espresso' appears in both members' pages but only once in the message.
    expect(text.match(/Espresso/g)).toHaveLength(1)
  })

  it('all done → ✅, none done → ❌', () => {
    expect(formatBatchOutcome([makeJob()])).toContain('✅')
    expect(formatBatchOutcome([makeJob({ status: 'failed' })])).toContain('❌')
  })
})

describe('formatResearchOutcome', () => {
  const run = (over: Partial<MaintenanceRun> = {}): MaintenanceRun => ({
    id: 'RUNRESEARCH01',
    kind: 'research',
    channel: 'maintenance:research',
    status: 'done',
    startedAt: '2026-07-22T00:00:00.000Z',
    ...over,
  })

  it('done → title list with bookkeeping pages filtered, no paths (§9)', () => {
    const text = formatResearchOutcome('ionizable lipids', run({
      result: {
        ok: true,
        kind: 'research',
        pages: ['wiki/concepts/Ionizable Lipid.md', 'wiki/index.md', 'wiki/hot.md'],
        usage: undefined as never,
      },
    }))
    expect(text).toContain('ionizable lipids')
    expect(text).toContain('• Ionizable Lipid')
    expect(text).toContain('1 page(s)')
    expect(text).not.toContain('wiki/')
  })

  it('error → the reason plus a dashboard retry hint', () => {
    const text = formatResearchOutcome('x', run({ status: 'error', error: 'agent timed out' }))
    expect(text).toContain('❌')
    expect(text).toContain('agent timed out')
    expect(text).toMatch(/dashboard/i)
  })
})
