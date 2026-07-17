import { describe, it, expect } from 'vitest'
import { openDb, migrate, defaultDbPath, nowIso, MEMORY_DB } from '../src/db/index.js'
import { MIGRATIONS } from '../src/db/migrations.js'

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
