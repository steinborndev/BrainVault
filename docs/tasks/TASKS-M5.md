# TASKS-M5 — Härtung (hardening)

Goal (SPEC.md §10): **systemd autostart, error paths, cost display, Settings UI, docs.**
**Acceptance (DoD): the service survives a WSL restart (systemd user service); failed jobs are diagnosable and retryable.**

This is the last milestone. It also absorbs the carried-over items from M3/M4 (below) — most importantly the **lint async rework** (a real lint currently hangs). Read `SPEC.md` §3.1, §6.4, §7.1, §9, §12.2 before starting; the spec wins over code.

---

## Where M5 starts — full system state (M0–M4 are DONE, on `main`)

A fresh session can rely on all of this being built, tested (195 vitest tests green), and merged to `main` (pushed to github.com/steinborndev/BrainVault, private).

**Run it:** `. ~/.nvm/nvm.sh` first (node 20 via nvm). Build the SPA once: `npm run build:web` (root) → `web/dist`. Start: `VAULT_ROOT=~/vault npm start` (from `server/`) or `npm run start` (root) → serves API + SPA on one origin `http://127.0.0.1:8420`. Dev with HMR: `npm run dev:web` + `VAULT_ROOT=~/vault npm run dev:server`. Credentials load automatically from `~/.config/vault-service/env` (`CLAUDE_CODE_OAUTH_TOKEN`); `VAULT_ROOT` is NOT in that file — pass it.

**Repo layout:** `server/` (Fastify + better-sqlite3 + chokidar, TS strict ESM), `web/` (Vite + React + TS + TanStack Query, PWA), `docs/tasks/` (per-milestone), `SPEC.md` (authoritative, German), `CLAUDE.md` (hard rules). Vault is a separate repo at `~/vault` (claude-obsidian v1.9.2); its Obsidian deep-link vault name is `vault`.

**Backend surface (all under `/api/v1`, behind localhost guard + local-single-user auth):**
- Ingestion (M1/M2): `POST /jobs` (upload/url/text, multi→batch), `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/retry`, `DELETE /jobs/:id` (cancel), `DELETE /jobs[?status=]` (clear history). Queue (concurrency 2, retry×2, timeout, rate-limit pause/resume), preprocessing plugin chain, per-ingest git commit `ingest: <source>` (mutex-serialized, F4 scoping).
- Dashboard (M3): `GET /events` (SSE: job/log/stats, hijacked raw stream + heartbeat), `GET /stats` (page counts, git growth, commits, hot cache, queue/watcher).
- Query/Chat (M4): `POST /query` (read-only query-runner + citations), `GET/POST /sessions`, `GET/PATCH/DELETE /sessions/:id`.
- Maintenance (M4): `POST /maintenance/{lint,research,hot-cache}` (vault-mutating agent runs, shared commit mutex, live log on `maintenance:<kind>` bus channel).

**Enforcement (CLAUDE.md hard rule 4 — do NOT weaken):** agent runs use `RunProfile` (`pipeline/permissions.ts`, `agent-runner.ts`): `ingest` (write vault, no web), `query` (READ-ONLY — sandbox `allowWrite: []`, deny Write/Edit + web), `research` (write + web). Enforcement is the **sandbox (bubblewrap) + a PreToolUse hook**, NOT `canUseTool`. **Re-run `server/src/cli/permprobe.ts` after ANY change to the permission wiring** (expects `canary outside vault: blocked`).

**Frontend:** 4 tabs (`web/src/tabs/`): Overview, Ingestion, Chat, Maintenance — all live. Shared: SSE hook (`hooks/useEvents.ts`), live log store (`lib/logStore.ts`), `PageLink` (obsidian:// + copy fallback), `Markdown`, `Icon`. Theme-aware CSS, responsive (mobile bottom-nav), PWA (manifest + `sw.js`).

**DB (`server/src/db/`, better-sqlite3, migrations gated by `user_version`):** tables `jobs`, `job_logs`, `sessions`, `messages`, `settings`, `users`. Migration v2 added `sessions.sdk_session_id` + `updated_at`. **The `settings` table exists but is UNUSED — it's M5's store for the Settings UI.** SQLite is operational state only; losing it must never damage the vault (hard rule 1).

---

## 0. Carried over from M3/M4 (do these as part of M5 — details in TASKS-M4/M3 Findings)

- [x] **Lint async rework + hard kill (BIGGEST carryover).** DONE in code on `feat/m5-maintenance-async` (see Finding F1). (a) **Hard kill:** agent runs now spawn the SDK CLI through `Options.spawnClaudeCodeProcess` in a detached process group (`pipeline/agent-spawn.ts`) and the runner escalates timeout/abort → graceful abort → group `SIGKILL` after a 5 s grace, reaping the CLI + any stuck `bash`/`python3` descendants (generalizes to ingest — it's in `runAgent`). (b) **Async/job:** `POST /maintenance/*` returns `202 {id,channel,status}` immediately; the run executes in the background; `GET /maintenance/runs/:id` polls the result; live log still streams over `maintenance:<kind>`. Frontend Wartung tab polls via `useMaintenanceRun`. Server 198 tests green (+ new `agent-spawn` group-kill test), web builds. **Still pending (user-gated):** one real agent run that forces a long `bash sleep` to confirm the detached spawner + group-SIGKILL end-to-end, and a `permprobe` re-run (permission/spawn wiring changed).
- [ ] **`.raw/.manifest.json` commit-scoping residual.** wiki-ingest writes `.raw/.manifest.json` (delta tracker) but the ingest commit pathspec (`BOOKKEEPING_PATHS` in `pipeline/queue.ts`) doesn't stage it → `git status` in the vault stays permanently dirty. Fix: add it to `BOOKKEEPING_PATHS`, or `.gitignore` it in the vault. (A hot-cache run swept it in once, but future ingests re-dirty it.)
- [ ] **Save-to-vault** (`POST /sessions/:id/save`, SPEC §6.3 "Session in Vault sichern") — the `/save` flow, a write-enabled agent run + commit. Consider resuming the chat's `sdk_session_id` and prompting `/save`. Deferred from M4.
- [ ] **Autoresearch not yet run with a real agent** (only mocked). Verify end-to-end once (web egress path) with a small topic; watch cost.
- [ ] Minor deferred polish: inline citation-page **preview** on a chip (Chat tab); hot-cache **last-refresh timestamp** display (Maintenance tab).

## 1. systemd user service + autostart (SPEC.md §3.1) — DoD-critical

- [x] `vault-service.service` systemd **user** unit template + `scripts/install-systemd.sh`. The install script resolves the repo path and the **real node binary** (nvm's node is not on systemd's PATH) and bakes both into the unit, sets `PATH` to include the node dir + system dirs (bwrap/socat/python3), passes `VAULT_ROOT` (credential still loads from `~/.config/vault-service/env`), `Restart=on-failure`, `enable`s it, prints the `loginctl enable-linger` + start steps. Verified: installed, started via systemd, MainPID is `node dist/main.js`, `/health` 200, watcher on `/mnt/c/inbox`, clean `systemctl --user restart`.
- [x] **Gotcha resolved:** the unit runs the **built JS** as a single `node dist/main.js` process (new server `build` → `tsconfig.build.json`, and `start:prod`). Confirmed a SIGTERM reaps it cleanly and frees port 8420 — no tsx/npm wrapper, no orphan. `KillMode=control-group` also reaps any in-flight agent-run descendants with the service (complements F1).
- [x] **Queue/in-flight resume:** on start the queue reconciles jobs stranded in `preprocessing`/`ingesting` by an abrupt stop → `failed` ("interrupted by a service restart", retryable) via `JobStore.recoverInterrupted()`; `queued` jobs resume automatically; watcher re-attaches. We do NOT auto-replay an interrupted `ingesting` job (may have partially written the vault — hard rule 1); it's one-click retryable instead.
- [ ] **DoD test (user-gated):** in Windows run `wsl --shutdown`, reopen WSL, then `curl http://127.0.0.1:8420/api/v1/health` must respond WITHOUT a manual start. Requires `loginctl enable-linger "$USER"` first (so the user manager runs without an active login). Steps are printed by the install script.

## 2. Settings UI + `GET/PUT /api/v1/settings` (SPEC.md §6.4, §6.5)

- [ ] `SettingsStore` over the `settings` table (key/value). Expose the **runtime-adjustable** config: watch-folder path, concurrency, file-size limit, git-commit behavior. Read-only display of the **API-key status** (source oauth/api-key — NEVER the value; reuse `describeConfig`). Precedence vs. env/`config.ts` must be explicit and documented (env is start-time; settings are runtime overrides — decide and enforce one model).
- [ ] Settings editor in the **Wartung** tab (currently a read-only M5 placeholder note there). Validate with zod; apply live where safe (e.g. concurrency), or flag "restart required".
- [ ] Keep the localhost guard + credential rules intact (hard rules 2/3): settings must never let the bind leave localhost without an auth token, and never surface credentials.

## 3. Cost / usage display + daily budget (SPEC.md §7.1, §11.3)

- [ ] Surface per-job and aggregate token/cost from the SDK usage already stored on `jobs` (and returned by `/query`, `/maintenance/*`). In **oauth (subscription) mode** label `cost_usd` as **"Schätzwert (Abo)"** everywhere it appears (Ingestion history, Chat, Overview) — the value is an API-price equivalent, not real money. `authMode` is already returned by `/query`; expose it via `/stats` or `/health` for the whole UI.
- [ ] Configurable **daily budget** (jobs/day in oauth mode, USD in api-key mode): queue pauses when exceeded, shows it in the dashboard, resumes next day. Ties into the existing rate-limit pause/resume in `IngestQueue`.

## 4. Error paths & diagnosability (SPEC.md §10 DoD)

- [ ] Failed jobs must be **diagnosable** (full error + the persisted `job_logs` stream visible in the UI — history already has a Log toggle) and **retryable** (retry endpoint exists; confirm the flow end-to-end including batch members). Add a "copy diagnostics" affordance if useful.
- [ ] Harden the long-run/hang path from §0 (a stuck agent run must fail loudly and free the worker, not wedge it).
- [ ] Consider a "git revert this ingest" action in history (SPEC §9 undo; v1.1 note) — optional.

## 5. Dockerfile + docs (SPEC.md §12.2, §10)

- [ ] `Dockerfile` (pure Linux userland, no Windows deps) building the server + serving `web/dist`. Not used under WSL day-to-day, but required from M5 for the future always-on-host move.
- [ ] Docs: a real `README.md` (setup: vault clone, toolchain, credential, build, run, systemd), plus update `CLAUDE.md`/`SPEC.md` cross-refs if anything changed. Ensure `scripts/` setup helpers are current.

## 6. Acceptance (DoD)

- [ ] After a **WSL restart**, the service is up on `127.0.0.1:8420` without manual start (systemd user service), and in-flight/queued work resumes.
- [ ] A **failed job** shows its error + full log and can be **retried** to success from the UI.
- [ ] Settings UI reads/writes config; cost shows as "Schätzwert (Abo)" in oauth mode.
- [ ] `Dockerfile` present and builds; docs complete.
- [ ] `npm test` passes; `permprobe` re-run if permission wiring changed.

## Findings

### F1 — Lint-hang root cause + hard-kill design (SDK-abort spike, 2026-07-18)

**Root cause (confirmed, zero-token spike `scratchpad/spike-abort.mjs`):** the SDK
(`@anthropic-ai/claude-agent-sdk` v0.3.212) spawns its CLI subprocess with
`spawn(cmd, args, { stdio:['pipe','pipe','pipe'], signal, env, windowsHide:true })` —
**no `detached`** (the token `detached` does not appear anywhere in `sdk.mjs`). On
`abortController.abort()` Node's `{signal}` option sends the default `killSignal`
(SIGTERM) to the **direct CLI child only**; the SDK's own SIGTERM→SIGKILL escalation
(`sdk.mjs` ~offset 10771) and its `process.on('exit')` reaper also target only that
one PID. **Grandchildren are never process-group-killed.** So a long-running
`bash → python3` embeddings call (DragonScale semantic tiling) is orphaned by the
abort and keeps running — this is the >21-min lint "hang". The spike proved:
- Scenario A (SDK style, `spawn({signal})` → abort): child dies, **grandchild survives**.
- Scenario B (`spawn({detached:true})` → `process.kill(-pid,'SIGKILL')`): **whole tree reaped.**

**Fix lever (SDK-sanctioned):** `Options.spawnClaudeCodeProcess?: (SpawnOptions) => SpawnedProcess`
(`sdk.d.ts:2014`). `ChildProcess` already satisfies `SpawnedProcess`. Provide a custom
spawner that mirrors the default (`stdio:['pipe','pipe','pipe']`, forward `options.signal`,
same cwd/env) **plus `detached:true`** so the CLI becomes its own process-group leader,
and hand the runner the child's PID. On the hard deadline the runner escalates:
`abort()` (graceful, lets the CLI flush its result/usage) → short grace → if still alive,
`process.kill(-pid,'SIGKILL')` reaps CLI + bash + python. Track live PIDs and group-kill
them on server shutdown too (our custom spawns are NOT in the SDK's internal reaper set).
This lives in the agent runner, so it **generalizes to ingest** as required, and it
touches the permission wiring's neighbourhood → **re-run `permprobe.ts` after implementing.**

**`permprobe` re-run (2026-07-18): PASS** — after the spawn/permission wiring change, a real
agent run still gets `canary outside vault: blocked` (0 denials — the sandbox blocks the write
at the kernel level: "Read-only file system"), skills invocable. Hard rule 4 intact.

**Still needs a real (token-costing, user-gated) end-to-end check:** one run whose prompt
forces a long `bash sleep`, to confirm the custom detached spawner works with the real SDK
stream and the group-SIGKILL reaps an actual CLI-spawned grandchild. Deferred until the
implementation lands.

**Async/job model (separate, additive):** move `POST /maintenance/*` off the synchronous
`await`-the-whole-run hold (`routes/maintenance.ts:16-32`) to return `{runId, channel}`
immediately, stream the live log over the existing `maintenance:<kind>` bus, and poll a
new `GET /maintenance/runs/:id`. This frees the HTTP request + worker slot regardless of
the hard-kill; the two fixes are independent and both wanted.
