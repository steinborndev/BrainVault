/**
 * Per-area maintenance state (SPEC.md §12.7 Stufe b): when did the last run of each
 * maintenance kind settle, and how did it go. The runner's own run history is a bounded
 * in-memory map that dies with the process — this table is what makes "zuletzt erledigt"
 * and the dashboard's "what's due" head restart-proof.
 *
 * One row per (user, kind), upserted on every settle. Kinds whose outcome already lives in
 * the vault (lint report file, hot.md mtime, index artifacts) keep those vault facts as the
 * primary source — this store fills the gaps (tag-fix, domain-backfill, …) and records
 * failure outcomes, which no vault fact captures.
 *
 * Operational state only (hard rule 1): losing it costs a "never ran" display until the
 * next run. It can never damage the vault.
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export interface MaintenanceAreaState {
  readonly kind: string
  readonly runId: string
  readonly ok: boolean
  readonly pages: number
  readonly error: string | null
  readonly finishedAt: string
}

/**
 * What the runner and the route depend on. An interface so the runner stays constructible
 * without a database (tests, and the memory fallback below).
 */
export interface MaintenanceStateStore {
  record(entry: MaintenanceAreaState): void
  list(): MaintenanceAreaState[]
}

/** Non-persistent fallback: state lasts as long as the process (parity with the run map). */
export class MemoryMaintenanceStateStore implements MaintenanceStateStore {
  private readonly entries = new Map<string, MaintenanceAreaState>()

  record(entry: MaintenanceAreaState): void {
    this.entries.set(entry.kind, entry)
  }
  list(): MaintenanceAreaState[] {
    return [...this.entries.values()].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
  }
}

export class SqliteMaintenanceStateStore implements MaintenanceStateStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  /** Upsert: the newest settle per kind wins — this is state, not history (the vault git log is). */
  record(entry: MaintenanceAreaState): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_state (user_id, kind, run_id, ok, pages, error, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind) DO UPDATE SET
           run_id = excluded.run_id, ok = excluded.ok, pages = excluded.pages,
           error = excluded.error, finished_at = excluded.finished_at`,
      )
      .run(this.userId, entry.kind, entry.runId, entry.ok ? 1 : 0, entry.pages, entry.error, entry.finishedAt)
  }

  /** All areas, newest settle first. */
  list(): MaintenanceAreaState[] {
    const rows = this.db
      .prepare(
        'SELECT kind, run_id, ok, pages, error, finished_at FROM maintenance_state WHERE user_id = ? ORDER BY finished_at DESC',
      )
      .all(this.userId) as Array<{
      kind: string
      run_id: string
      ok: number
      pages: number
      error: string | null
      finished_at: string
    }>
    return rows.map((r) => ({
      kind: r.kind,
      runId: r.run_id,
      ok: r.ok === 1,
      pages: r.pages,
      error: r.error,
      finishedAt: r.finished_at,
    }))
  }
}
