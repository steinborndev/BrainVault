# TASKS-M2 — Eingangskanäle (Input channels)

Goal (SPEC.md §10): watch folder (stability check, batching) + upload endpoint. **Acceptance: files dropped into the Windows watch folder (`/mnt/c/inbox`) land in the vault with zero interaction; batching within 60 s works.**

M2 stands up the Fastify server for the first time (it hosts the watcher, the queue, and the upload endpoint). SSE live-updates and the dashboard UI are M3 — keep them out of scope here, but don't wall them off.

Work top to bottom. Check off as completed; record decisions under "Findings".

## 0. Carried over from M1 (non-blocking, land them here)

- [x] **F4 — tighten commit granularity. DONE.** Each ingest now stages only its OWN paths (not `git add -A`): the paths the agent wrote — observed from its Write/Edit/MultiEdit tool calls in the message stream (`pipeline/written-paths.ts`) — plus the job's `.raw/<id>/` and `.vault-meta`. `commitVault` gained a `pathspec` option with a `git add -A` fallback (if a targeted stage matches nothing, so the tree never keeps changes). Proven deterministically (`queue-integration.test.ts`): 10 files @ concurrency 2 → 10 commits, each with exactly its own page; reverting one removes only that page. **Residual (best-effort, documented):** files edited by BOTH concurrent jobs — shared `wiki/**/_index.md`, `.vault-meta/address-counter.txt` — can still cross-contaminate on those specific files (regenerable/idempotent); the substantive content pages are cleanly per-ingest revertable. A real concurrent 2-file run should confirm the real vault's tree stays clean (the fallback guards it, but worth a live check in M5).
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

## 5. Acceptance — PASSED (live 2026-07-17)

- [x] Drop files into `/mnt/c/inbox` → they appear in the vault with **zero interaction**, watch folder emptied. Verified live: two notes dropped, watcher (polling) took them, both reached `done`, inbox empty, no manual steps.
- [x] A batch of files copied together → single combined ingest, all members share a `batch_id`. Verified: both notes shared batch `01KXRNEWV6…`, ONE combined run, ONE commit `ingest: espresso-basics.md, milk-steaming.md` with cross-referenced concept pages (Espresso ↔ Milk Steaming). Usage split (~919k each).
- [x] `POST /api/v1/jobs` upload → job runs → committed. Covered by `api.test.ts` (real listen + fetch, faked agent) end-to-end.
- [x] Server refuses to start on a non-localhost bind without auth. `server-config.test.ts` (`assertBindAllowed`).
- [x] **Bonus, confirmed live:** F4 scoping held on the real vault — the ingest commit contained only its pages + `.raw`, NOT the concurrently-modified `.obsidian/workspace.json`. Vault `git fsck` clean.

## Findings

**F5 — chokidar needs polling on `/mnt/c` (9p/drvfs). Found live, fixed.** The Windows watch folder `/mnt/c/inbox` is a **9p** mount (newer WSL2; drvfs on older). inotify events do NOT propagate from the Windows side, so chokidar's default (native events) saw **nothing** — files sat in the inbox untouched. Fix: `usePolling: true` (interval 500 ms) auto-enabled for `/mnt/` paths, overridable via `WATCH_POLLING=true|false`. Re-tested live → the watcher picked the files up and the batch ran. This is the same class of WSL/`\\wsl$` gotcha noted in M0; polling is the standard remedy for 9p/drvfs. Trade-off: polling has a small CPU cost and a poll-interval latency, acceptable for an inbox. (ext4 watch folders keep native events.)

**M2 COMPLETE 2026-07-17.** §1 server foundation, §2 upload endpoint, §3 watch folder, §4 batching, §5 live acceptance all DONE; carryovers F1 (transport pin) + F4 (per-ingest commit scoping) resolved; F5 (chokidar polling on 9p) found live and fixed. 175 tests green; live watch-folder drop → batched combined ingest → single scoped commit, vault fsck clean.
