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

/**
 * v2 — chat (M4). The `sessions`/`messages` tables from v1 are the store; a chat session
 * additionally remembers the SDK session id of its last query run so a follow-up can
 * `resume` it and keep context (SPEC.md §5). `updated_at` gives the session list a sort key
 * that moves when a new message lands. Both columns are nullable/defaulted, so v1 rows and
 * the seeded data migrate without backfill.
 */
const V2 = `
ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;
ALTER TABLE sessions ADD COLUMN updated_at TEXT;
`

/**
 * v3 — backfill `finished_at` for jobs that stopped running but never got one (finding F2 in
 * TASKS-M5). `failed`/`deferred` were excluded from the finished-stamping set, so every
 * `finished_at`-filtered query skipped them and the Overview's 7-day "Fehler"/"deferred" KPIs
 * read 0 even with failures present. The code fix is FINISHED_STATES in db/jobs.ts; this
 * repairs the rows already written under the old behaviour so historical KPIs are correct too.
 *
 * `started_at` is the honest stamp (when the run began) and always exists for a job that
 * reached these states; `created_at` is a last-resort fallback so the column is never left null.
 */
const V3 = `
UPDATE jobs
   SET finished_at = COALESCE(started_at, created_at)
 WHERE status IN ('failed', 'deferred')
   AND finished_at IS NULL;
`

/**
 * v4 — index for the `finished_at`-filtered aggregates (`usageSince`, `countsSince`). The
 * budget check runs `usageSince` on every queue pump, so this is a hot path; without an index
 * `countsSince` scans the table.
 */
const V4 = `
CREATE INDEX idx_jobs_finished ON jobs(finished_at);
`

/**
 * v5 — dismissed domain candidates (SPEC.md §12.4 Stufe 3). The governance loop re-derives its
 * candidates from the vault on every request, so without remembering rejections it would
 * propose the same theme forever and become noise. Keyed by the candidate key (the dominant
 * tag), which the finder keeps stable across rebuilds precisely so this table stays valid.
 *
 * Operational state only: losing it costs nothing but a re-proposal (hard rule 1, SPEC.md §8).
 */
const V5 = `
CREATE TABLE domain_dismissals (
  user_id      TEXT NOT NULL DEFAULT 'local',
  key          TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`

/**
 * v6 — per-message usage (tokens/cost) on assistant messages. The chat UI shows what each
 * answer cost; before this only the LAST answer's usage was visible (returned transiently on
 * the POST /query response) and vanished on session switch/reload. Nullable — user/system
 * rows and pre-v6 history simply carry no usage.
 */
const V6 = `
ALTER TABLE messages ADD COLUMN tokens_in INTEGER;
ALTER TABLE messages ADD COLUMN tokens_out INTEGER;
ALTER TABLE messages ADD COLUMN cost_usd REAL;
`

/**
 * v7 — Telegram channel (SPEC.md §4.3): `source` gains 'telegram', and `notify_channel`
 * ('telegram:<chat_id>') records where to send the completion message, restart-safe.
 *
 * A full table rebuild, not ALTER ADD COLUMN: `source`'s CHECK constraint lists the
 * allowed values and SQLite cannot modify a CHECK in place. The rebuild follows the
 * documented procedure (create new, copy, drop old, rename) and RELIES on foreign keys
 * being OFF while migrations run (see openDb): with FK enforcement on, DROP TABLE jobs
 * would cascade-delete every job_logs row, and the RENAME would rewrite job_logs' FK to
 * point at the doomed old table. The indexes die with the old table — recreate all four.
 */
const V7 = `
CREATE TABLE jobs_v7 (
  id            TEXT PRIMARY KEY,                 -- ulid
  user_id       TEXT NOT NULL DEFAULT 'local' REFERENCES users(id),
  batch_id      TEXT,                             -- shared batches (SPEC.md §4.1)
  source        TEXT NOT NULL CHECK (source IN ('drop','watch','url','telegram')),
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
  finished_at   TEXT,
  notify_channel TEXT                             -- e.g. 'telegram:<chat_id>' (SPEC.md §4.3)
);

INSERT INTO jobs_v7
  (id, user_id, batch_id, source, type, original_name, url, sha256, status,
   raw_path, created_pages, error, attempts, tokens_in, tokens_out, cost_usd,
   created_at, started_at, finished_at)
SELECT
   id, user_id, batch_id, source, type, original_name, url, sha256, status,
   raw_path, created_pages, error, attempts, tokens_in, tokens_out, cost_usd,
   created_at, started_at, finished_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v7 RENAME TO jobs;

CREATE INDEX idx_jobs_status   ON jobs(status);
CREATE INDEX idx_jobs_batch    ON jobs(batch_id);
CREATE INDEX idx_jobs_created  ON jobs(created_at);
CREATE INDEX idx_jobs_finished ON jobs(finished_at);
`

/**
 * v8 — non-allowlisted Telegram senders, aggregated per sender id (SPEC.md §4.3/§9). The
 * journal logs only the FIRST attempt per sender (flood guard); this table keeps the live
 * count so the dashboard can show the full picture, surviving the restarts that a settings
 * change routinely triggers. Operational state only (hard rule 1) — losing it costs nothing
 * but the counters.
 */
const V8 = `
CREATE TABLE telegram_drops (
  user_id   TEXT NOT NULL DEFAULT 'local',
  sender_id INTEGER NOT NULL,
  username  TEXT,
  first_at  TEXT NOT NULL,
  last_at   TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, sender_id)
);
`

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: V1 },
  { version: 2, up: V2 },
  { version: 3, up: V3 },
  { version: 4, up: V4 },
  { version: 5, up: V5 },
  { version: 6, up: V6 },
  { version: 7, up: V7 },
  { version: 8, up: V8 },
]
