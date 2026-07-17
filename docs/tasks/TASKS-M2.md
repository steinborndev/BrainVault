# TASKS-M2 — Eingangskanäle (Input channels)

Goal (SPEC.md §10): watch folder (stability check, batching) + upload endpoint. **Acceptance: files dropped into the Windows watch folder (`/mnt/c/inbox`) land in the vault with zero interaction; batching within 60 s works.**

M2 stands up the Fastify server for the first time (it hosts the watcher, the queue, and the upload endpoint). SSE live-updates and the dashboard UI are M3 — keep them out of scope here, but don't wall them off.

Work top to bottom. Check off as completed; record decisions under "Findings".

## 0. Carried over from M1 (non-blocking, land them here)

- [ ] **F4 — tighten commit granularity.** At concurrency 2 a busy commit can sweep a sibling job's pages into its own commit (observed live in M1: the pptx commit contained the pdf's pages). Consequence: a `git revert` of one ingest can undo a co-committed sibling. Options: commit only a job's own touched paths, or serialize each job's agent-write+commit. Decide + implement, or consciously defer to M5 with a note.
- [x] **F1 — transport.json staleness.** DONE: `pipeline/transport.ts` `refreshTransportPin` bumps the pin's mtime; `startService` calls it on every startup, so `detect-transport.sh` never reaches its `obsidian --version` hang.

## 1. Server foundation (Fastify) — DONE

- [x] Fastify server, binds `127.0.0.1:8420` (configurable `HOST`/`PORT`). All routes under `/api/v1/`. `api/server.ts`, `main.ts`. Real boot smoke verified (`/health` responds, graceful SIGTERM shutdown).
- [x] **Localhost guard (hard rule 2 / SPEC.md §9):** `config.assertBindAllowed` refuses a non-loopback bind unless `HTTP_AUTH_MODE=token` + a token is set. `server-config.test.ts`.
- [x] Auth middleware in `local-single-user` mode (pass-through, `req.userId='local'`); `token` mode is the seam (`api/auth.ts`).
- [x] Server owns one shared `IngestQueue` + `JobStore`; graceful shutdown stops watcher + queue, closes app + DB.
- [x] `GET /api/v1/health` — queue + job-count snapshot, public (systemd probe).

## 2. Upload endpoint (SPEC.md §4.1) — DONE

- [x] `POST /api/v1/jobs` `multipart/form-data`: file upload → `enqueueFile`, 200 MB cap (`MAX_UPLOAD_BYTES`). `api/routes/jobs.ts`, `api.test.ts`.
- [x] Also accepts **text and URLs** (pasted URL → URL job; pasted text → text `.md` job).
- [x] Multiple files in one request → one **batch** (`batch_id`). `.url`/`.webloc` unwrapped to URL jobs.
- [x] No upload inspection/execution beyond the size cap; magic-byte guard + classification stay in preprocessing.
- [ ] **Batch = one combined run** is still per-file here — the combined `ingest all of these` run is §4 below.

## 3. Watch folder (SPEC.md §3.1, §4.2) — DONE (batching in §4)

- [x] `chokidar` watches `WATCH_FOLDER` (default `/mnt/c/inbox`) recursively. `pipeline/watcher.ts`.
- [x] Stability check: `awaitWriteFinish` (2 s). Dotfiles/partials ignored.
- [x] On stabilize: enqueue, then **remove from the inbox** (vault already has its copy via `enqueueFile`'s copy) — inbox kept empty, restart-safe.
- [x] Web Clipper `.md` frontmatter-URL + `.url`/`.webloc` shortcuts → URL jobs (`frontmatterUrl`, `watcher.test.ts`).

## 4. Batching (SPEC.md §4.1, §4.2) — DONE

- [x] Watch folder groups files arriving together (quiet window 3 s, hard cap 60 s) into one batch; a lone file stays a single job. `pipeline/watcher.ts`, `watcher-batch.test.ts`.
- [x] A batch is preprocessed per-file, then **one** combined `ingest all of these` run, then one commit. `IngestQueue.enqueueBatch`/`processBatch`; a batch occupies one worker slot; deferred/failed members drop out; usage split across members; transient/rate-limit retries re-run the batch. `queue.test.ts` batching block.
- [x] `batch_id` on every member; `claimNextQueued` excludes batch members; pending batches recovered after a restart (`queuedBatches`).

## 5. Acceptance

- [ ] Drop files into `/mnt/c/inbox` → they appear in the vault with **zero interaction**, watch folder emptied.
- [ ] A batch of files copied together (within 60 s) → single combined ingest, all members share a `batch_id`.
- [ ] `POST /api/v1/jobs` upload → job runs → committed.
- [ ] Server refuses to start on a non-localhost bind without auth (guard test).

## Findings

**Progress 2026-07-17:** §1 server foundation, §2 upload endpoint, §3 watch folder, **§4 batching** all DONE and committed; 167 tests green; real boot smoke passed. F1 carryover done. **Remaining M2: §0 F4 (commit granularity — real design choice, or defer to M5 with a note), §5 live acceptance (real watch-folder drop → ingest; spends tokens + mutates the vault, so user-gated).** The deterministic path (watcher → enqueueBatch → processBatch) is fully covered by tests with a faked agent; only the real-agent watch-folder run is outstanding.
