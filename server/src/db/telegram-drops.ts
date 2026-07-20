/**
 * Dropped non-allowlisted Telegram senders, aggregated per sender id (SPEC.md §4.3/§9,
 * migration v8). The journal warns once per sender; this store counts every attempt so the
 * Maintenance card can show who is knocking — including the operator's own mistyped id.
 * Never stores message content.
 */

import type { Db } from './index.js'
import { nowIso } from './index.js'

export interface TelegramDropRow {
  readonly sender_id: number
  readonly username: string | null
  readonly first_at: string
  readonly last_at: string
  readonly count: number
}

export class TelegramDropStore {
  constructor(private readonly db: Db) {}

  /** Records one dropped message. Upserts: later usernames win (they are mutable). */
  record(senderId: number, username?: string): void {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO telegram_drops (user_id, sender_id, username, first_at, last_at, count)
         VALUES ('local', @sender_id, @username, @now, @now, 1)
         ON CONFLICT (user_id, sender_id) DO UPDATE SET
           count = count + 1,
           last_at = @now,
           username = COALESCE(@username, username)`,
      )
      .run({ sender_id: senderId, username: username ?? null, now })
  }

  /** Most recently active first. */
  list(limit = 50): TelegramDropRow[] {
    return this.db
      .prepare(
        `SELECT sender_id, username, first_at, last_at, count
           FROM telegram_drops ORDER BY last_at DESC LIMIT ?`,
      )
      .all(limit) as TelegramDropRow[]
  }
}
