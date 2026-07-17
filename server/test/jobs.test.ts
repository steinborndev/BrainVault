import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore, JobStateError, ALLOWED_TRANSITIONS } from '../src/db/jobs.js'

let db: Db
let store: JobStore

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new JobStore(db)
})

const pdf = { source: 'drop', type: 'pdf', originalName: 'a.pdf' } as const

describe('create', () => {
  it('creates a queued job with an id and a creation log line', () => {
    const { job, duplicateOf } = store.create({ ...pdf, sha256: 'h1' })
    expect(job.status).toBe('queued')
    expect(job.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/) // ulid
    expect(job.user_id).toBe('local')
    expect(duplicateOf).toBeUndefined()
    expect(store.logs(job.id)[0]?.message).toMatch(/job created from drop/)
  })

  it('marks a second job with the same sha256 as duplicate and keeps it visible', () => {
    const first = store.create({ ...pdf, sha256: 'same' })
    const second = store.create({ source: 'watch', type: 'pdf', sha256: 'same' })
    expect(second.job.status).toBe('duplicate')
    expect(second.duplicateOf).toBe(first.job.id)
    expect(second.job.sha256).toBeNull() // original owns the UNIQUE hash
    expect(second.job.finished_at).not.toBeNull()
    expect(store.listByStatus('duplicate')).toHaveLength(1)
    expect(store.logs(second.job.id)[0]?.message).toMatch(/duplicate of/)
  })

  it('does not dedupe URL jobs (no sha256)', () => {
    const a = store.create({ source: 'url', type: 'web', url: 'https://x' })
    const b = store.create({ source: 'url', type: 'web', url: 'https://x' })
    expect(a.job.status).toBe('queued')
    expect(b.job.status).toBe('queued')
  })
})

describe('transition', () => {
  it('walks the happy path and stamps timestamps', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    expect(job.started_at).toBeNull()

    const pre = store.transition(job.id, 'preprocessing')
    expect(pre.started_at).not.toBeNull()

    const ing = store.transition(job.id, 'ingesting')
    expect(ing.started_at).toBe(pre.started_at) // not re-stamped

    const done = store.transition(job.id, 'done', { patch: { createdPages: ['Wiki/Foo.md'] } })
    expect(done.status).toBe('done')
    expect(done.finished_at).not.toBeNull()
    expect(JSON.parse(done.created_pages!)).toEqual(['Wiki/Foo.md'])
  })

  it('rejects an illegal transition', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    expect(() => store.transition(job.id, 'done')).toThrow(JobStateError)
  })

  it('rejects any transition out of a terminal state', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    store.transition(job.id, 'cancelled')
    expect(() => store.transition(job.id, 'queued')).toThrow(/terminal/)
  })

  it('records usage and error on failure', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    store.transition(job.id, 'preprocessing')
    store.transition(job.id, 'ingesting')
    const failed = store.transition(job.id, 'failed', {
      patch: { error: 'boom', tokensIn: 100, tokensOut: 5, costUsd: 0.01 },
    })
    expect(failed.error).toBe('boom')
    expect(failed.tokens_in).toBe(100)
    expect(store.logs(job.id).some((l) => l.level === 'error')).toBe(true)
  })

  it('clears the stale error when a failed job is retried', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    store.transition(job.id, 'preprocessing')
    store.transition(job.id, 'ingesting')
    store.transition(job.id, 'failed', { patch: { error: 'transient' } })
    const requeued = store.transition(job.id, 'queued')
    expect(requeued.error).toBeNull()
    expect(requeued.finished_at).toBeNull()
  })
})

describe('claimNextQueued', () => {
  it('claims the oldest queued job and moves it to preprocessing', () => {
    const a = store.create({ ...pdf, sha256: 'a' })
    store.create({ ...pdf, sha256: 'b' })
    const claimed = store.claimNextQueued()
    expect(claimed?.id).toBe(a.job.id)
    expect(claimed?.status).toBe('preprocessing')
    expect(store.listByStatus('queued')).toHaveLength(1)
  })

  it('never returns the same job twice (no double-claim)', () => {
    store.create({ ...pdf, sha256: 'a' })
    const first = store.claimNextQueued()
    const second = store.claimNextQueued()
    expect(first).toBeDefined()
    expect(second).toBeUndefined()
  })

  it('returns undefined on an empty queue', () => {
    expect(store.claimNextQueued()).toBeUndefined()
  })
})

describe('incrementAttempts', () => {
  it('counts up', () => {
    const { job } = store.create({ ...pdf, sha256: 'h' })
    expect(store.incrementAttempts(job.id)).toBe(1)
    expect(store.incrementAttempts(job.id)).toBe(2)
  })
})

describe('ALLOWED_TRANSITIONS', () => {
  it('never lists duplicate as a reachable target', () => {
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      expect(targets).not.toContain('duplicate')
    }
  })
})
