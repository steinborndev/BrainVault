/**
 * Dismissed domain candidates (SPEC.md §12.4 Stufe 3).
 *
 * The candidate finder re-derives its proposals from the vault on every request — it holds no
 * state of its own, which is what makes it cheap and deterministic. The consequence is that a
 * rejected proposal would come straight back on the next load, so the ONE thing that must
 * persist is the user's "no". That is this table.
 *
 * Operational state only: dropping the DB re-proposes a dismissed theme, which costs a click.
 * It can never damage the vault (hard rule 1, SPEC.md §8).
 */

import type { Db } from './index.js'

const DEFAULT_USER = 'local'

export interface Dismissal {
  readonly key: string
  readonly dismissedAt: string
}

/**
 * What the routes actually depend on. Keeping it an interface lets the API be constructed
 * without a database (tests, and any future context that has no SQLite handle) while the real
 * service passes the persistent store.
 */
export interface DismissalStore {
  keys(): Set<string>
  list(): Dismissal[]
  dismiss(key: string): void
  restore(key: string): void
}

/** Non-persistent fallback: dismissals last as long as the process. */
export class MemoryDismissalStore implements DismissalStore {
  private readonly entries = new Map<string, string>()

  keys(): Set<string> {
    return new Set(this.entries.keys())
  }
  list(): Dismissal[] {
    return [...this.entries.entries()]
      .map(([key, dismissedAt]) => ({ key, dismissedAt }))
      .sort((a, b) => b.dismissedAt.localeCompare(a.dismissedAt))
  }
  dismiss(key: string): void {
    if (!this.entries.has(key)) this.entries.set(key, new Date().toISOString())
  }
  restore(key: string): void {
    this.entries.delete(key)
  }
}

export class DomainDismissalStore implements DismissalStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string = DEFAULT_USER,
  ) {}

  /** Candidate keys currently suppressed — the set the finder filters against. */
  keys(): Set<string> {
    const rows = this.db
      .prepare('SELECT key FROM domain_dismissals WHERE user_id = ?')
      .all(this.userId) as Array<{ key: string }>
    return new Set(rows.map((r) => r.key))
  }

  /** Newest first, for a "dismissed" list the user can undo from. */
  list(): Dismissal[] {
    const rows = this.db
      .prepare('SELECT key, dismissed_at FROM domain_dismissals WHERE user_id = ? ORDER BY dismissed_at DESC')
      .all(this.userId) as Array<{ key: string; dismissed_at: string }>
    return rows.map((r) => ({ key: r.key, dismissedAt: r.dismissed_at }))
  }

  /** Idempotent: dismissing an already-dismissed key keeps the original timestamp. */
  dismiss(key: string): void {
    this.db
      .prepare(
        'INSERT INTO domain_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING',
      )
      .run(this.userId, key, new Date().toISOString())
  }

  /** Brings a dismissed candidate back into consideration. */
  restore(key: string): void {
    this.db.prepare('DELETE FROM domain_dismissals WHERE user_id = ? AND key = ?').run(this.userId, key)
  }
}
