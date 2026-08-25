import { describe, it, expect } from 'vitest'
import {
  buildActivity,
  channelCounts,
  contentPages,
  filterActivity,
  jobState,
  matchesFilter,
  type ActivityFilter,
} from '../src/lib/activity.ts'
import type { Commit, Job, MaintenanceAreaState, MaintenanceRun } from '../src/api/types.ts'

const NOW = new Date('2026-08-25T12:00:00.000Z')

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  user_id: 'local',
  batch_id: null,
  source: 'drop',
  type: 'pdf',
  original_name: 'paper.pdf',
  url: null,
  sha256: 'abc',
  status: 'done',
  raw_path: null,
  created_pages: JSON.stringify(['wiki/concepts/Thing.md']),
  error: null,
  attempts: 1,
  tokens_in: 100,
  tokens_out: 20,
  cost_usd: 0.4,
  created_at: '2026-08-25T11:00:00.000Z',
  started_at: '2026-08-25T11:01:00.000Z',
  finished_at: '2026-08-25T11:05:00.000Z',
  commit_hash: 'a1b2c3d4e5f6',
  ...over,
})

const run = (over: Partial<MaintenanceRun> = {}): MaintenanceRun => ({
  id: 'r1',
  kind: 'research',
  channel: 'maintenance:research',
  status: 'running',
  label: 'Solid-state electrolytes',
  startedAt: '2026-08-25T11:50:00.000Z',
  ...over,
})

const settle = (over: Partial<MaintenanceAreaState> = {}): MaintenanceAreaState => ({
  kind: 'lint',
  runId: 'run-lint-1',
  ok: true,
  pages: 1,
  error: null,
  finishedAt: '2026-08-25T09:00:00.000Z',
  ...over,
})

const commit = (over: Partial<Commit> = {}): Commit => ({
  hash: 'ffffffffffff',
  date: '2026-08-25T08:00:00.000Z',
  subject: 'edit page by hand',
  pages: ['wiki/concepts/Manual.md'],
  ...over,
})

const filter = (over: Partial<ActivityFilter> = {}): ActivityFilter => ({
  kind: 'all',
  state: null,
  channel: null,
  days: 30,
  query: '',
  ...over,
})

describe('jobState', () => {
  it('collapses the two working states into one "running"', () => {
    expect(jobState('preprocessing')).toBe('running')
    expect(jobState('ingesting')).toBe('running')
    expect(jobState('queued')).toBe('queued')
    expect(jobState('duplicate')).toBe('duplicate')
  })
})

describe('contentPages', () => {
  it('drops the system pages that ride along in every ingest commit', () => {
    expect(
      contentPages([
        'wiki/concepts/Thing.md',
        'wiki/hot.md',
        'wiki/index.md',
        'wiki/concepts/_index.md',
        'wiki/log.md',
      ]),
    ).toEqual(['wiki/concepts/Thing.md'])
  })
})

describe('buildActivity', () => {
  it('merges jobs, live runs, settles and unexplained commits, newest first', () => {
    const events = buildActivity({
      jobs: [job()],
      activeRuns: [run()],
      lastRuns: [settle()],
      commits: [commit()],
    })
    expect(events.map((e) => e.kind)).toEqual(['research', 'ingest', 'maintenance', 'edit'])
    expect(events[0]!.live).toBe(true)
    expect(events[1]!.state).toBe('done')
  })

  it('drops a commit a job already claims, so an ingest is not also an anonymous edit', () => {
    const events = buildActivity({
      jobs: [job({ commit_hash: 'a1b2c3d4e5f6' })],
      activeRuns: [],
      lastRuns: [],
      commits: [commit({ hash: 'a1b2c3d4e5f6', subject: 'ingest: paper' })],
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('ingest')
  })

  it('drops a commit that lands within 90s of a maintenance settle', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      lastRuns: [settle({ finishedAt: '2026-08-25T09:00:00.000Z' })],
      commits: [commit({ hash: 'deadbeef0000', date: '2026-08-25T09:00:30.000Z' })],
    })
    expect(events.map((e) => e.kind)).toEqual(['maintenance'])
  })

  it('keeps a commit that is far enough from every settle', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      lastRuns: [settle({ finishedAt: '2026-08-25T09:00:00.000Z' })],
      commits: [commit({ hash: 'deadbeef0000', date: '2026-08-25T09:05:00.000Z' })],
    })
    // Newest first: the commit is five minutes after the settle.
    expect(events.map((e) => e.kind)).toEqual(['edit', 'maintenance'])
  })

  it('files a live research run under its own kind, not under maintenance', () => {
    const events = buildActivity({ jobs: [], activeRuns: [run()], lastRuns: [], commits: [] })
    expect(events[0]!.kind).toBe('research')
    expect(events[0]!.title).toBe('Solid-state electrolytes')
  })
})

describe('matchesFilter', () => {
  const events = buildActivity({
    jobs: [job(), job({ id: 'j2', status: 'failed', source: 'url', original_name: null, url: 'https://example.org/a' })],
    activeRuns: [run()],
    lastRuns: [],
    commits: [commit()],
  })

  it('filters by kind', () => {
    expect(filterActivity(events, filter({ kind: 'ingest' }), NOW)).toHaveLength(2)
    expect(filterActivity(events, filter({ kind: 'edit' }), NOW)).toHaveLength(1)
  })

  it('filters by state and channel', () => {
    expect(filterActivity(events, filter({ state: 'failed' }), NOW)).toHaveLength(1)
    expect(filterActivity(events, filter({ channel: 'url' }), NOW)).toHaveLength(1)
  })

  it('matches the search against the title', () => {
    expect(filterActivity(events, filter({ query: 'example.org' }), NOW)).toHaveLength(1)
    expect(filterActivity(events, filter({ query: 'nothing here' }), NOW)).toHaveLength(0)
  })

  it('never hides a live row because of the time range', () => {
    const old = buildActivity({
      jobs: [job({ status: 'ingesting', started_at: '2026-01-01T00:00:00.000Z', finished_at: null })],
      activeRuns: [],
      lastRuns: [],
      commits: [],
    })
    expect(matchesFilter(old[0]!, filter({ days: 1 }), NOW)).toBe(true)
  })

  it('applies the time range to settled rows', () => {
    const oldJob = buildActivity({
      jobs: [job({ finished_at: '2026-01-01T00:00:00.000Z' })],
      activeRuns: [],
      lastRuns: [],
      commits: [],
    })
    expect(matchesFilter(oldJob[0]!, filter({ days: 30 }), NOW)).toBe(false)
    expect(matchesFilter(oldJob[0]!, filter({ days: null }), NOW)).toBe(true)
  })
})

describe('channelCounts', () => {
  it('counts every channel in the stream, biggest first', () => {
    const events = buildActivity({
      jobs: [job(), job({ id: 'j2' }), job({ id: 'j3', source: 'watch' })],
      activeRuns: [],
      lastRuns: [],
      commits: [],
    })
    expect(channelCounts(events)).toEqual([
      ['drop', 2],
      ['watch', 1],
    ])
  })
})
