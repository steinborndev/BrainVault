/**
 * Chat store: the domain layer over the `sessions` and `messages` tables (SPEC.md §8, §6.3).
 *
 * A chat session groups a conversation with the read-only query runner. Each session also
 * remembers the SDK session id of its last query run so a follow-up resumes it and keeps
 * context (SPEC.md §5). Messages carry the answer text plus a JSON array of resolved page
 * citations (the clickable chips — the M4 DoD). Like everything in SQLite this is
 * operational state only; losing it never touches the vault (hard rule 1).
 */

import { ulid } from 'ulid'
import type { Db } from './index.js'
import { nowIso } from './index.js'
import type { Citation } from '../pipeline/citations.js'

export type MessageRole = 'user' | 'assistant' | 'system'

export interface SessionRow {
  id: string
  user_id: string
  title: string | null
  sdk_session_id: string | null
  created_at: string
  updated_at: string | null
}

export interface MessageRow {
  id: number
  session_id: string
  role: MessageRole
  content: string
  /** JSON array of Citation, or null. */
  citations: string | null
  ts: string
}

/** A session plus lightweight list metadata (message count, last activity). */
export interface SessionSummary extends SessionRow {
  message_count: number
  last_ts: string | null
}

export class ChatStore {
  constructor(private readonly db: Db) {}

  createSession(input: { title?: string; userId?: string } = {}): SessionRow {
    const id = ulid()
    const now = nowIso()
    this.db
      .prepare('INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.userId ?? 'local', input.title ?? null, now, now)
    return this.getSessionOrThrow(id)
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
  }

  getSessionOrThrow(id: string): SessionRow {
    const s = this.getSession(id)
    if (s === undefined) throw new Error(`no such session: ${id}`)
    return s
  }

  /** Sessions for a user, most-recently-active first, with message count + last activity. */
  listSessions(userId = 'local'): SessionSummary[] {
    return this.db
      .prepare(
        `SELECT s.*,
                COUNT(m.id)  AS message_count,
                MAX(m.ts)    AS last_ts
           FROM sessions s
           LEFT JOIN messages m ON m.session_id = s.id
          WHERE s.user_id = ?
          GROUP BY s.id
          ORDER BY COALESCE(s.updated_at, s.created_at) DESC`,
      )
      .all(userId) as SessionSummary[]
  }

  renameSession(id: string, title: string): SessionRow {
    this.db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), id)
    return this.getSessionOrThrow(id)
  }

  /** Records the SDK session id so the next question in this chat can resume it. */
  setSdkSessionId(id: string, sdkSessionId: string): void {
    this.db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id)
  }

  /** Deletes a session and its messages (FK ON DELETE CASCADE). Returns true if one went. */
  deleteSession(id: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0
  }

  addMessage(input: {
    sessionId: string
    role: MessageRole
    content: string
    citations?: readonly Citation[]
  }): MessageRow {
    const ts = nowIso()
    const info = this.db
      .prepare('INSERT INTO messages (session_id, role, content, citations, ts) VALUES (?, ?, ?, ?, ?)')
      .run(
        input.sessionId,
        input.role,
        input.content,
        input.citations && input.citations.length > 0 ? JSON.stringify(input.citations) : null,
        ts,
      )
    // Bump the session's activity so the list re-sorts to the top.
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(ts, input.sessionId)
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid) as MessageRow
  }

  messages(sessionId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as MessageRow[]
  }
}
