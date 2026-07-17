/**
 * Schema migrations for the operational database (SPEC.md §8).
 *
 * SQLite holds ONLY operational state. The vault is the single source of truth for
 * knowledge; losing this DB must never damage the vault, and the statistics it holds
 * are rebuildable from the filesystem + git (SPEC.md §8, hard rule 1). That is why
 * nothing here mirrors vault content — only jobs, logs, chat sessions and settings.
 *
 * Migrations are applied in order and gated by `PRAGMA user_version`, so re-opening an
 * existing DB is a no-op. Never edit a shipped migration's SQL — add a new one. The
 * only exception is pre-release (version 1 has not been deployed anywhere yet).
 */

export interface Migration {
  readonly version: number
  readonly up: string
}

/**
 * v1 — the full M1 schema. CHECK constraints encode the closed vocabularies from
 * SPEC.md §8 (job states, source/type enums) so a bad transition fails at the DB
 * boundary rather than silently persisting. Every table that the multi-user work
 * (SPEC.md §12.1) will scope carries `user_id` now, defaulting to the seeded 'local'.
 */
const V1 = `
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  token_hash TEXT,
  role       TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL
);

-- The v1 single-user seed. All operational rows reference this until multi-user lands.
INSERT INTO users (id, name, role, created_at)
VALUES ('local', 'local', 'owner', '1970-01-01T00:00:00.000Z');

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,                 -- ulid
  user_id       TEXT NOT NULL DEFAULT 'local' REFERENCES users(id),
  batch_id      TEXT,                             -- shared batches (SPEC.md §4.1)
  source        TEXT NOT NULL CHECK (source IN ('drop','watch','url')),
  type          TEXT NOT NULL CHECK (type IN ('pdf','office','web','image','text','av','other')),
  original_name TEXT,
  url           TEXT,
  sha256        TEXT UNIQUE,                      -- dedupe (SPEC.md §3.2)
  status        TEXT NOT NULL CHECK (status IN (
                  'queued','preprocessing','ingesting','done',
                  'failed','deferred','duplicate','cancelled')),
  raw_path      TEXT,                             -- .raw/<job-id>/
  created_pages TEXT,                             -- JSON array of wiki pages created/updated
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);

CREATE INDEX idx_jobs_status   ON jobs(status);
CREATE INDEX idx_jobs_batch    ON jobs(batch_id);
CREATE INDEX idx_jobs_created  ON jobs(created_at);

CREATE TABLE job_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts      TEXT NOT NULL,
  level   TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message TEXT NOT NULL
);

CREATE INDEX idx_job_logs_job ON job_logs(job_id, id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT 'local' REFERENCES users(id),
  title      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content    TEXT NOT NULL,
  citations  TEXT,                                -- JSON array of vault-page citations
  ts         TEXT NOT NULL
);

CREATE INDEX idx_messages_session ON messages(session_id, id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

export const MIGRATIONS: readonly Migration[] = [{ version: 1, up: V1 }]
