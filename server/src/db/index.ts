/**
 * Operational database: opens the SQLite file, applies migrations, hands back a
 * ready connection. Everything operational (jobs, logs, chat, settings) lives here;
 * the vault stays the single source of truth for knowledge (SPEC.md §8).
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { MIGRATIONS } from './migrations.js'

export type Db = Database.Database

/** In-memory sentinel accepted by better-sqlite3 — used by tests, never persisted. */
export const MEMORY_DB = ':memory:'

/**
 * Default DB location: under XDG data home, OUTSIDE the vault and outside this repo.
 * Keeping it out of the vault is not cosmetic — hard rule 1 requires that losing the
 * DB cannot damage the vault, and colocating them invites a careless `rm -rf`.
 */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DB_PATH']?.trim()
  if (explicit) return explicit
  const dataHome = env['XDG_DATA_HOME']?.trim() || path.join(os.homedir(), '.local', 'share')
  return path.join(dataHome, 'vault-service', 'jobs.db')
}

/** Applies any migrations newer than the file's `user_version`, in one transaction each. */
export function migrate(db: Db): void {
  for (const migration of MIGRATIONS) {
    const current = db.pragma('user_version', { simple: true }) as number
    if (current >= migration.version) continue
    // Each migration is atomic: either the whole DDL lands and the version bumps, or
    // neither does. `user_version` cannot be bound as a parameter, hence the literal —
    // migration.version is an integer constant from our own array, never user input.
    const apply = db.transaction(() => {
      db.exec(migration.up)
      db.pragma(`user_version = ${migration.version}`)
    })
    apply()
  }
}

export interface OpenDbOptions {
  /** Skip migrations (used only when a caller wants a raw handle). Defaults to false. */
  readonly skipMigrations?: boolean
}

/**
 * Opens (creating if needed) the DB at `dbPath`, sets the durability/concurrency
 * pragmas the worker pool relies on, and migrates to the latest schema.
 *
 * WAL + a busy timeout matter here specifically: M1 runs agent jobs at concurrency 2
 * and the pipeline writes job_logs from multiple workers. WAL lets readers proceed
 * during writes; busy_timeout makes a contended write wait briefly instead of throwing
 * SQLITE_BUSY.
 */
export function openDb(dbPath: string = defaultDbPath(), options: OpenDbOptions = {}): Db {
  if (dbPath !== MEMORY_DB) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  }
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  // Migrations run with foreign_keys OFF (SQLite's documented order for table rebuilds):
  // v7 drops and recreates `jobs`, and under FK enforcement DROP TABLE performs an
  // implicit DELETE that cascade-wipes job_logs (observed live on a DB copy). The OFF
  // must be EXPLICIT — better-sqlite3 v12 turns foreign_keys on at connection open, so
  // relying on "SQLite defaults to off" silently re-enables the cascade. The pragma is
  // a no-op inside a transaction, so it cannot live in the migration SQL itself.
  db.pragma('foreign_keys = OFF')
  if (!options.skipMigrations) migrate(db)
  db.pragma('foreign_keys = ON')
  return db
}

/** ISO-8601 UTC timestamp, the one format used for every `*_at`/`ts` column. */
export function nowIso(): string {
  return new Date().toISOString()
}
