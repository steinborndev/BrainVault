import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, migrate, defaultDbPath, nowIso, MEMORY_DB } from '../src/db/index.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { JobStore } from '../src/db/jobs.js'

const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version

describe('openDb', () => {
  it('creates the full schema and seeds the local user', () => {
    const db = openDb(MEMORY_DB)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toEqual(
      expect.arrayContaining(['jobs', 'job_logs', 'sessions', 'messages', 'settings', 'users']),
    )
    const user = db.prepare("SELECT id, role FROM users WHERE id='local'").get()
    expect(user).toEqual({ id: 'local', role: 'owner' })
  })

  it('sets user_version to the latest migration', () => {
    const db = openDb(MEMORY_DB)
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST)
  })

  it('enables foreign keys and WAL is unavailable in memory (falls back gracefully)', () => {
    const db = openDb(MEMORY_DB)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })
})

describe('migrate', () => {
  it('is idempotent — re-running applies nothing', () => {
    const db = openDb(MEMORY_DB)
    const before = db.prepare('SELECT count(*) c FROM users').get() as { c: number }
    migrate(db)
    const after = db.prepare('SELECT count(*) c FROM users').get() as { c: number }
    expect(after.c).toBe(before.c) // seed not duplicated
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST)
  })
})

describe('v7 — telegram channel (SPEC.md §4.3)', () => {
  it('accepts source "telegram" and persists notify_channel through JobStore', () => {
    const db = openDb(MEMORY_DB)
    const store = new JobStore(db)
    const { job } = store.create({
      source: 'telegram',
      type: 'pdf',
      originalName: 'phone.pdf',
      notifyChannel: 'telegram:424242',
    })
    expect(job.source).toBe('telegram')
    expect(job.notify_channel).toBe('telegram:424242')
    // Non-telegram jobs simply carry none.
    const { job: plain } = store.create({ source: 'drop', type: 'text' })
    expect(plain.notify_channel).toBeNull()
  })

  it('rebuilds the jobs table on upgrade WITHOUT losing rows or their logs', () => {
    // A pre-v7 database with live data: apply migrations 1..6 only, then write a job
    // and its log line exactly as an old deployment would have left them.
    const db = openDb(MEMORY_DB, { skipMigrations: true })
    // openDb enables foreign_keys even on a raw handle; replaying migrations manually
    // needs the same off-state a real migrating open has, or v7's DROP TABLE cascades.
    db.pragma('foreign_keys = OFF')
    for (const m of MIGRATIONS.filter((m) => m.version <= 6)) {
      db.exec(m.up)
      db.pragma(`user_version = ${m.version}`)
    }
    db.prepare(
      `INSERT INTO jobs (id, source, type, status, sha256, created_at)
       VALUES ('old1', 'drop', 'pdf', 'done', 'hash-1', ?)`,
    ).run(nowIso())
    db.prepare(
      `INSERT INTO job_logs (job_id, ts, level, message) VALUES ('old1', ?, 'info', 'kept')`,
    ).run(nowIso())

    migrate(db)
    db.pragma('foreign_keys = ON')

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST)
    const job = db.prepare("SELECT * FROM jobs WHERE id = 'old1'").get() as Record<string, unknown>
    expect(job['sha256']).toBe('hash-1')
    expect(job['notify_channel']).toBeNull()
    // The v7 rebuild drops the old table — under FK enforcement that would have
    // cascade-deleted this row (the reason migrations run with foreign_keys off).
    const log = db.prepare("SELECT message FROM job_logs WHERE job_id = 'old1'").get()
    expect(log).toEqual({ message: 'kept' })
    // The rebuilt table enforces the widened CHECK and the FK still points at it.
    expect(() =>
      db
        .prepare(`INSERT INTO jobs (id, source, type, status, created_at) VALUES ('t1','telegram','pdf','queued',?)`)
        .run(nowIso()),
    ).not.toThrow()
    expect(() =>
      db
        .prepare(`INSERT INTO jobs (id, source, type, status, created_at) VALUES ('x1','carrier-pigeon','pdf','queued',?)`)
        .run(nowIso()),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare(`INSERT INTO job_logs (job_id, ts, level, message) VALUES ('missing', ?, 'info', 'orphan')`).run(nowIso()),
    ).toThrow(/FOREIGN KEY/)
  })

  it('preserves job_logs when the upgrade runs through openDb itself (the real path)', () => {
    // Regression guard for the masked variant of the cascade bug: better-sqlite3 v12
    // enables foreign_keys AT OPEN, so openDb must explicitly switch it off before
    // migrating — the manual-replay test above sets the pragma itself and would not
    // catch openDb forgetting to. Found live: a dry run on a copy of the real DB
    // wiped all 238 job_logs rows. Needs a file DB — :memory: cannot be reopened.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-db-test-'))
    const file = path.join(dir, 'jobs.db')
    try {
      const seed = openDb(file, { skipMigrations: true })
      seed.pragma('foreign_keys = OFF')
      for (const m of MIGRATIONS.filter((m) => m.version <= 6)) {
        seed.exec(m.up)
        seed.pragma(`user_version = ${m.version}`)
      }
      seed.prepare(
        `INSERT INTO jobs (id, source, type, status, created_at) VALUES ('old1','drop','pdf','done',?)`,
      ).run(nowIso())
      seed.prepare(`INSERT INTO job_logs (job_id, ts, level, message) VALUES ('old1', ?, 'info', 'kept')`).run(nowIso())
      seed.close()

      const db = openDb(file)
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST)
      expect((db.prepare('SELECT count(*) c FROM job_logs').get() as { c: number }).c).toBe(1)
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      db.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recreates all four jobs indexes after the rebuild', () => {
    const db = openDb(MEMORY_DB)
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(indexes).toEqual(['idx_jobs_batch', 'idx_jobs_created', 'idx_jobs_finished', 'idx_jobs_status'])
  })
})

describe('schema constraints', () => {
  const insertJob = (db: ReturnType<typeof openDb>, status: string, extra: Record<string, unknown> = {}) => {
    const row = {
      id: (extra['id'] as string) ?? 'j1',
      source: 'drop',
      type: 'pdf',
      status,
      sha256: (extra['sha256'] as string) ?? null,
      created_at: nowIso(),
    }
    db.prepare(
      `INSERT INTO jobs (id, source, type, status, sha256, created_at)
       VALUES (@id, @source, @type, @status, @sha256, @created_at)`,
    ).run(row)
  }

  it('rejects an unknown job status', () => {
    const db = openDb(MEMORY_DB)
    expect(() => insertJob(db, 'bogus')).toThrow(/CHECK constraint/i)
  })

  it('accepts every valid job status', () => {
    const db = openDb(MEMORY_DB)
    const states = [
      'queued',
      'preprocessing',
      'ingesting',
      'done',
      'failed',
      'deferred',
      'duplicate',
      'cancelled',
    ]
    for (const [i, s] of states.entries()) {
      expect(() => insertJob(db, s, { id: `j${i}` })).not.toThrow()
    }
  })

  it('enforces sha256 uniqueness for dedupe', () => {
    const db = openDb(MEMORY_DB)
    insertJob(db, 'queued', { id: 'a', sha256: 'deadbeef' })
    expect(() => insertJob(db, 'queued', { id: 'b', sha256: 'deadbeef' })).toThrow(/UNIQUE/i)
  })

  it('cascades job_logs deletion with the job', () => {
    const db = openDb(MEMORY_DB)
    insertJob(db, 'queued', { id: 'a' })
    db.prepare('INSERT INTO job_logs (job_id, ts, message) VALUES (?,?,?)').run('a', nowIso(), 'hi')
    db.prepare('DELETE FROM jobs WHERE id=?').run('a')
    const logs = db.prepare('SELECT count(*) c FROM job_logs').get() as { c: number }
    expect(logs.c).toBe(0)
  })

  it('rejects a job_log for a nonexistent job (FK)', () => {
    const db = openDb(MEMORY_DB)
    expect(() =>
      db.prepare('INSERT INTO job_logs (job_id, ts, message) VALUES (?,?,?)').run('ghost', nowIso(), 'x'),
    ).toThrow(/FOREIGN KEY/i)
  })
})

describe('defaultDbPath', () => {
  it('honours DB_PATH when set', () => {
    expect(defaultDbPath({ DB_PATH: '/custom/jobs.db' })).toBe('/custom/jobs.db')
  })

  it('falls back to XDG_DATA_HOME', () => {
    expect(defaultDbPath({ XDG_DATA_HOME: '/data' })).toBe('/data/vault-service/jobs.db')
  })

  it('never places the DB inside a vault path by default', () => {
    const p = defaultDbPath({ HOME: '/home/x' })
    expect(p).toContain('vault-service')
    expect(p).not.toContain('/vault/')
  })
})
