# TASKS-M2 — Eingangskanäle (Input channels)

Goal (SPEC.md §10): watch folder (stability check, batching) + upload endpoint. **Acceptance: files dropped into the Windows watch folder (`/mnt/c/inbox`) land in the vault with zero interaction; batching within 60 s works.**

M2 stands up the Fastify server for the first time (it hosts the watcher, the queue, and the upload endpoint). SSE live-updates and the dashboard UI are M3 — keep them out of scope here, but don't wall them off.

Work top to bottom. Check off as completed; record decisions under "Findings".

## 0. Carried over from M1 (non-blocking, land them here)

- [ ] **F4 — tighten commit granularity.** At concurrency 2 a busy commit can sweep a sibling job's pages into its own commit (observed live in M1: the pptx commit contained the pdf's pages). Consequence: a `git revert` of one ingest can undo a co-committed sibling. Options: commit only a job's own touched paths, or serialize each job's agent-write+commit. Decide + implement, or consciously defer to M5 with a note.
- [ ] **F1 — transport.json staleness.** The pinned `.vault-meta/transport.json` (filesystem) that stops `detect-transport.sh` hanging goes stale after 7 days (mtime), after which a write-mode call hangs again. The M2 server startup should `touch` it (or refresh the pin) so the service stays hang-proof across restarts.

## 1. Server foundation (Fastify)

- [ ] Fastify server, binds `127.0.0.1:8420` (configurable `HOST`/`PORT`). All routes under `/api/v1/`.
- [ ] **Localhost guard (hard rule 2 / SPEC.md §9):** if bind ≠ localhost and no auth mode with a token/password is active → refuse to start. Do not weaken.
- [ ] Auth middleware in `local-single-user` mode (pass-through, everything allowed); the seam where a token/password mode plugs in later. `user_id` defaults to `'local'`.
- [ ] Server owns one shared `IngestQueue` + `JobStore` (single DB) and starts it; graceful shutdown drains/stops the queue.
- [ ] Health/status endpoint (`GET /api/v1/health`) for the systemd unit (M5) and smoke checks.

## 2. Upload endpoint (SPEC.md §4.1)

- [ ] `POST /api/v1/jobs` `multipart/form-data`: file upload → temp → `enqueueFile`. Limit 200 MB/file (configurable `MAX_UPLOAD_BYTES`).
- [ ] Also accept **text and URLs** in the same endpoint (a pasted URL starts a URL job; pasted text becomes a text job).
- [ ] Multiple files in one request → one **batch** (`batch_id`).
- [ ] Never execute uploads; the existing magic-byte guard runs in preprocessing (hard rule 6). Reject nothing at upload beyond the size cap — let the pipeline classify/defer.

## 3. Watch folder (SPEC.md §3.1, §4.2)

- [ ] `chokidar` watches the configured folder (`WATCH_FOLDER`, default `/mnt/c/inbox`) recursively.
- [ ] Stability check: `awaitWriteFinish` (2 s unchanged size) so half-copied files are never ingested.
- [ ] On stabilize: **move** the file into the vault `.raw/` staging (watch folder = inbox, gets emptied; prevents re-processing after a restart), then enqueue.
- [ ] Web Clipper `.md` special case: frontmatter-URL `.md` files are treated as a web source (SPEC.md §4.2) — reuse the shortcut/URL path.

## 4. Batching (SPEC.md §4.1, §4.2)

- [ ] Watch folder: files arriving within **60 s** of each other are grouped into one batch.
- [ ] A batch is preprocessed per-file, then ingested with **one** combined `ingest all of these`-style run so the agent can cross-reference (repo batch behaviour). Needs queue support for a batch job over N artifacts.
- [ ] Batch is visible as such in the DB (`batch_id` on every member).

## 5. Acceptance

- [ ] Drop files into `/mnt/c/inbox` → they appear in the vault with **zero interaction**, watch folder emptied.
- [ ] A batch of files copied together (within 60 s) → single combined ingest, all members share a `batch_id`.
- [ ] `POST /api/v1/jobs` upload → job runs → committed.
- [ ] Server refuses to start on a non-localhost bind without auth (guard test).

## Findings

- (M2 findings go here)
