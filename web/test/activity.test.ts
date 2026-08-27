import { describe, it, expect } from 'vitest'
import {
  buildActivity,
  classifyCommit,
  channelCounts,
  contentPages,
  filterActivity,
  jobState,
  matchesFilter,
  type ActivityFilter,
} from '../src/lib/activity.ts'
import type {
  AgentRunRecord,
  Commit,
  Job,
  MaintenanceAreaState,
  MaintenanceRun,
} from '../src/api/types.ts'

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

const logged = (over: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  id: 'run-log-1',
  kind: 'research',
  label: 'Sodium-ion cathodes',
  profileKey: 'sota',
  ok: true,
  pages: ['wiki/questions/Research: Sodium-ion cathodes - State of the Art.md'],
  tokensIn: 100,
  tokensOut: 20,
  costUsd: 1.8,
  error: null,
  commitHash: null,
  startedAt: '2026-08-25T09:00:00.000Z',
  finishedAt: '2026-08-25T09:20:00.000Z',
  ...over,
})

describe('classifyCommit', () => {
  it('reads what wrote a commit off the subject the service itself set', () => {
    expect(classifyCommit('ingest: paper.pdf')).toEqual({ kind: 'ingest', channel: 'git' })
    expect(classifyCommit('maintenance: tag fix (3 actions)')).toEqual({ kind: 'maintenance', channel: 'git' })
    expect(classifyCommit('chat: save session about batteries')).toEqual({ kind: 'maintenance', channel: 'git' })
    expect(classifyCommit('edit: Sourdough Hydration')).toEqual({ kind: 'edit', channel: 'manual' })
    expect(classifyCommit('delete: Old Draft')).toEqual({ kind: 'edit', channel: 'manual' })
    expect(classifyCommit('domains: add psychology')).toEqual({ kind: 'edit', channel: 'manual' })
    expect(classifyCommit('recover a payload by hand')).toEqual({ kind: 'edit', channel: 'manual' })
  })
})

describe('buildActivity after clearing the job history', () => {
  // Clearing deletes job rows only - it must never touch the vault's git history. The
  // commits those jobs made are then all that is left of them, and calling an ingest
  // commit a manual edit would contradict the vault's own log.
  it('keeps an orphaned ingest commit an INGEST, not a manual edit', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      lastRuns: [],
      commits: [commit({ subject: 'ingest: paper.pdf', hash: 'aaaa1111bbbb' })],
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'ingest', channel: 'git' })
  })

  it('still calls a page edit a manual edit', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      lastRuns: [],
      commits: [commit({ subject: 'edit: Sourdough Hydration' })],
    })
    expect(events[0]).toMatchObject({ kind: 'edit', channel: 'manual' })
  })
})

describe('buildActivity with the persistent run log', () => {
  it('lists every logged run, with its cost and the pages it wrote', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      runHistory: [logged(), logged({ id: 'run-log-2', kind: 'lint', label: null, costUsd: 0.6 })],
      lastRuns: [],
      commits: [],
    })
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.kind).sort()).toEqual(['maintenance', 'research'])
    const research = events.find((e) => e.kind === 'research')!
    expect(research).toMatchObject({ costUsd: 1.8, runKind: 'research', title: 'Sodium-ion cathodes' })
    expect(research.startedIso).toBe('2026-08-25T09:00:00.000Z')
  })

  it('drops the per-kind settle row the log already covers', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      runHistory: [logged({ id: 'same', kind: 'lint', label: null })],
      lastRuns: [settle({ kind: 'lint', runId: 'same' })],
      commits: [],
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.id).toBe('logrun:same')
  })

  it('keeps a settle row for a kind the log has nothing newer for', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      runHistory: [logged({ id: 'r', kind: 'lint', label: null, finishedAt: '2026-08-20T09:00:00.000Z' })],
      lastRuns: [settle({ kind: 'tag-fix', runId: 'older', finishedAt: '2026-08-24T09:00:00.000Z' })],
      commits: [],
    })
    expect(events.map((e) => e.id).sort()).toEqual(['logrun:r', 'settle:tag-fix:older'])
  })

  it('a logged run suppresses the commit it made, same as a settle record did', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      runHistory: [logged({ finishedAt: '2026-08-25T09:00:00.000Z' })],
      lastRuns: [],
      commits: [commit({ hash: 'ffff0000ffff', date: '2026-08-25T09:00:30.000Z', subject: 'maintenance: research' })],
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.id).toContain('logrun:')
    // …and the hash goes TO the run rather than over the side with the commit event. This
    // row predates schema v13 and has no hash of its own; dropping the matched commit
    // outright is what made every agent run's detail read "nothing was committed".
    expect(events[0]!.commit).toBe('ffff0000ffff')
  })

  it('carries the commit a v13 run recorded, without needing a commit event at all', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      runHistory: [logged({ commitHash: 'abc123abc123' })],
      lastRuns: [],
      commits: [],
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.commit).toBe('abc123abc123')
  })

  it('suppresses a run\'s own commit by hash, however far apart the clocks put them', () => {
    // The 90 s window is a fallback for hashless rows. A run that knows its hash needs no
    // window - and must not be tricked into an anonymous "edit" by a slow clock either.
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      runHistory: [logged({ commitHash: 'abc123abc123', finishedAt: '2026-08-25T09:00:00.000Z' })],
      lastRuns: [],
      commits: [commit({ hash: 'abc123abc123', date: '2026-08-25T09:40:00.000Z', subject: 'maintenance: research' })],
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.id).toContain('logrun:')
    expect(events[0]!.commit).toBe('abc123abc123')
  })

  it('gives a hashless run the NEAREST commit when two runs share a window', () => {
    // Two pre-v13 runs settling a minute apart is exactly where time proximity is ambiguous:
    // this commit is inside the 90 s window of BOTH. It is 1 s from 'late' and 59 s from
    // 'early', so taking the first match in list order would attach it to the wrong run.
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      runHistory: [
        logged({ id: 'early', finishedAt: '2026-08-25T09:00:00.000Z' }),
        logged({ id: 'late', kind: 'lint', label: null, finishedAt: '2026-08-25T09:01:00.000Z' }),
      ],
      lastRuns: [],
      commits: [commit({ hash: '1a1a1a1a1a1a', date: '2026-08-25T09:00:59.000Z', subject: 'maintenance: lint' })],
    })
    expect(events).toHaveLength(2)
    expect(events.find((e) => e.id === 'logrun:late')!.commit).toBe('1a1a1a1a1a1a')
    expect(events.find((e) => e.id === 'logrun:early')!.commit).toBeNull()
  })

  it('keeps a second commit in the same window visible instead of absorbing it', () => {
    // A run makes exactly one commit. Anything else landing in its window came from elsewhere
    // - a page edited by hand, say - and used to vanish, because the old join dropped every
    // commit near ANY settle rather than pairing each one off.
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      runHistory: [logged({ finishedAt: '2026-08-25T09:00:00.000Z' })],
      lastRuns: [],
      commits: [
        commit({ hash: 'ffff0000ffff', date: '2026-08-25T09:00:10.000Z', subject: 'maintenance: research' }),
        commit({ hash: 'dddd1111dddd', date: '2026-08-25T09:00:40.000Z', subject: 'edit: Sourdough Hydration' }),
      ],
    })
    expect(events).toHaveLength(2)
    expect(events.find((e) => e.id.startsWith('logrun:'))!.commit).toBe('ffff0000ffff')
    expect(events.find((e) => e.id === 'commit:dddd1111dddd')).toMatchObject({ kind: 'edit', channel: 'manual' })
  })

  it('leaves a run that committed nothing without a hash to show', () => {
    const events = buildActivity({
      jobs: [],
      activeRuns: [],
      runHistory: [logged({ commitHash: null, pages: [], finishedAt: '2026-08-25T09:00:00.000Z' })],
      lastRuns: [],
      commits: [commit({ hash: 'aaaabbbbcccc', date: '2026-08-25T06:00:00.000Z' })],
    })
    const logrun = events.find((e) => e.id.startsWith('logrun:'))!
    expect(logrun.commit).toBeNull()
    // The unrelated commit three hours earlier stays its own event.
    expect(events).toHaveLength(2)
  })
})
