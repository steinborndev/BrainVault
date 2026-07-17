import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventBus, type BusEvent } from '../src/pipeline/events.js'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { pageCounts, recentPages, readHotCache } from '../src/pipeline/vault-stats.js'

describe('EventBus', () => {
  it('fans out to subscribers and stops after unsubscribe', () => {
    const bus = new EventBus()
    const seen: BusEvent[] = []
    const off = bus.subscribe((e) => seen.push(e))
    bus.publish({ kind: 'stats' })
    off()
    bus.publish({ kind: 'stats' })
    expect(seen).toHaveLength(1)
    expect(bus.size).toBe(0)
  })

  it('a throwing listener never breaks the publisher', () => {
    const bus = new EventBus()
    const seen: BusEvent[] = []
    bus.subscribe(() => {
      throw new Error('dead socket')
    })
    bus.subscribe((e) => seen.push(e))
    expect(() => bus.publish({ kind: 'stats' })).not.toThrow()
    expect(seen).toHaveLength(1)
  })
})

describe('JobStore → bus', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(MEMORY_DB)
  })
  afterEach(() => db.close())

  it('publishes a job event on transition and a log event on log', () => {
    const bus = new EventBus()
    const events: BusEvent[] = []
    bus.subscribe((e) => events.push(e))
    const store = new JobStore(db, bus)

    const { job } = store.create({ source: 'drop', type: 'text', originalName: 'a.md' })
    store.transition(job.id, 'cancelled', { log: 'bye' })

    const jobEvents = events.filter((e) => e.kind === 'job')
    const logEvents = events.filter((e) => e.kind === 'log')
    expect(jobEvents.some((e) => e.kind === 'job' && e.job.status === 'cancelled')).toBe(true)
    expect(logEvents.some((e) => e.kind === 'log' && e.log.jobId === job.id)).toBe(true)
  })
})

describe('vault-stats page counts', () => {
  let vault: string
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-stats-'))
    fs.mkdirSync(path.join(vault, 'wiki', 'concepts'), { recursive: true })
    fs.mkdirSync(path.join(vault, 'wiki', 'entities'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'one.md'), '# one')
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'two.md'), '# two')
    fs.writeFileSync(path.join(vault, 'wiki', 'entities', 'e.md'), '# e')
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'ignore.txt'), 'not md')
    fs.writeFileSync(path.join(vault, 'wiki', 'hot.md'), '# hot cache')
  })
  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }))

  it('counts markdown pages per dir, lists recent, reads hot cache', () => {
    const counts = pageCounts(vault)
    expect(counts.byDir['concepts']).toBe(2)
    expect(counts.byDir['entities']).toBe(1)
    expect(counts.total).toBe(3)

    const recent = recentPages(vault, 5)
    expect(recent.length).toBe(3)
    expect(recent.every((p) => p.path.startsWith('wiki/') && p.path.endsWith('.md'))).toBe(true)

    expect(readHotCache(vault)).toContain('hot cache')
  })
})
