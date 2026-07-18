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
- [x] **`.raw/.manifest.json` commit-scoping residual.** Fixed: `BOOKKEEPING_PATHS` now includes `.raw/.manifest.json` and was moved to `pipeline/git.ts` (the shared commit module) so the ingest queue and the maintenance runner can't drift apart — maintenance had the two paths duplicated as literals. Both the single-job and batch ingest pathspecs pick it up. Regression test added (`queue.test.ts`, asserts the commit pathspec). Vault is currently clean for this file (an earlier hot-cache run swept it in); the fix stops future ingests re-dirtying it.
- [x] **Save-to-vault** (`POST /sessions/:id/save`, SPEC §6.3). Resumes the chat's `sdk_session_id` and prompts `/save` under the **`ingest`** profile — the chat itself is read-only by design, so the save needs a write-enabled run to produce the page. Implemented as a new `save` kind on `MaintenanceRunner` rather than a separate module: it needs the same commit discipline, and sharing that runner's **run mutex is what stops a save interleaving with a lint** (two concurrent vault writers is exactly what the mutex prevents). Async like the other runs (202 + poll). 400 if the session never completed a query (nothing to resume). Chat tab gained an "In Vault sichern" button with the live log and resulting page links.
- [ ] **Autoresearch not yet run with a real agent** (only mocked). Verify end-to-end once (web egress path) with a small topic; watch cost.
- [x] Polish: **citation preview** — new read-only `GET /api/v1/pages?path=…` plus a `CitationChip` that keeps the obsidian:// deep link as the primary action and lazily fetches the page on expand. The path comes from agent-produced citations, i.e. attacker-adjacent input, so it is confined to `VAULT_ROOT/wiki`, must end in `.md`, and is re-checked after `realpath` (symlink escapes). Traversal attempts are covered by tests and were verified against the real vault — `../.git/config`, `/etc/passwd` and `wiki/../../.config/vault-service/env` all 400.
- [x] Polish: **hot-cache last-refresh timestamp** — `hotCacheUpdatedAt` (mtime of `wiki/hot.md`, the honest source since agent runs write it) on `/stats`, shown next to the refresh button.

## 1. systemd user service + autostart (SPEC.md §3.1) — DoD-critical

- [x] `vault-service.service` systemd **user** unit template + `scripts/install-systemd.sh`. The install script resolves the repo path and the **real node binary** (nvm's node is not on systemd's PATH) and bakes both into the unit, sets `PATH` to include the node dir + system dirs (bwrap/socat/python3), passes `VAULT_ROOT` (credential still loads from `~/.config/vault-service/env`), `Restart=on-failure`, `enable`s it, prints the `loginctl enable-linger` + start steps. Verified: installed, started via systemd, MainPID is `node dist/main.js`, `/health` 200, watcher on `/mnt/c/inbox`, clean `systemctl --user restart`.
- [x] **Gotcha resolved:** the unit runs the **built JS** as a single `node dist/main.js` process (new server `build` → `tsconfig.build.json`, and `start:prod`). Confirmed a SIGTERM reaps it cleanly and frees port 8420 — no tsx/npm wrapper, no orphan. `KillMode=control-group` also reaps any in-flight agent-run descendants with the service (complements F1).
- [x] **Queue/in-flight resume:** on start the queue reconciles jobs stranded in `preprocessing`/`ingesting` by an abrupt stop → `failed` ("interrupted by a service restart", retryable) via `JobStore.recoverInterrupted()`; `queued` jobs resume automatically; watcher re-attaches. We do NOT auto-replay an interrupted `ingesting` job (may have partially written the vault — hard rule 1); it's one-click retryable instead.
- [ ] **DoD test (user-gated):** in Windows run `wsl --shutdown`, reopen WSL, then `curl http://127.0.0.1:8420/api/v1/health` must respond WITHOUT a manual start. Requires `loginctl enable-linger "$USER"` first (so the user manager runs without an active login). Steps are printed by the install script.

## 2. Settings UI + `GET/PUT /api/v1/settings` (SPEC.md §6.4, §6.5)

- [x] `SettingsStore` (`db/settings.ts`) over the `settings` table. Settable keys exactly per SPEC §6.4: `watchFolder`, `concurrency`, `maxUploadBytes`, `gitAutoCommit`. **Precedence model decided and enforced in one place:** env/env-file = start-time **baseline**, the table = runtime **overrides**, `effective = override ?? baseline`; writing `null` clears an override. A malformed/out-of-range stored row is ignored (falls back to baseline) rather than blocking startup.
- [x] `GET/PUT /api/v1/settings` returning `{effective, baseline, overrides, readOnly, restartRequiredKeys}` (+ `pendingRestart` on PUT). Read-only block exposes the **API-key status only** (`authMode`, `credentialSource`) — never the value.
- [x] Settings editor in the **Wartung** tab (`components/SettingsEditor.tsx`) replacing the placeholder: per-field "geändert"/"Neustart nötig" tags, per-field reset-to-baseline, dirty-tracking save, responsive.
- [x] **Live vs restart:** `concurrency` applies live (`IngestQueue.setConcurrency`) and `gitAutoCommit` is read through a provider on every commit (no restart); `watchFolder`/`maxUploadBytes` bind at startup and are honestly flagged `restart required` instead of pretending they applied.
- [x] Hard rules intact: the zod schema is `.strict()`, so `host`/`port`/any credential key is a **400**, not a silent no-op — the bind can never leave localhost via settings and no credential is ever stored in or returned from SQLite. Covered by tests.
- [x] Verified end-to-end against the running systemd service: GET, live concurrency change (reflected in `/health`), `pendingRestart` for a restart-bound key, 400 on forbidden keys, override persistence across a restart, and clean reset back to baseline. 215 server tests green.

## 3. Cost / usage display + daily budget (SPEC.md §7.1, §11.3)

- [x] Aggregate usage: new `JobStore.usageSince()` (tokens in/out, cost, ingest count) surfaced on `/stats` as `usage.today` / `usage.last7d`, plus `authMode` for the whole UI. Overview gained a "Kosten (7 T.)" tile; Chat now renders the per-answer usage the server had always returned but nothing displayed.
- [x] "Schätzwert (Abo)" marking centralised in `components/Cost.tsx` (`Cost`/`CostFootnote`) so the caveat can't be forgotten at a call site — applied in Overview, the Ingestion history (`JobCard`) and Chat. In api-key mode the marking disappears automatically.
- [x] Configurable **daily budget** via settings (`dailyBudget`, live-applied). Unit follows the auth mode per SPEC §7.1: **ingests/day in oauth**, **USD/day with an API key** — decided once in the new `pipeline/budget.ts`, which both the queue's pause decision and the dashboard's display read, so they cannot disagree. Queue pauses before claiming (in-flight runs always finish, so a budget overshoots by at most the runs already started) and auto-resumes at the next local midnight, reusing the rate-limit pause machinery. `queue.pauseReason` (`rate-limit` | `budget` | null) now distinguishes the two in the UI; Overview shows a budget bar.
- [x] Verified live against the running service: `/stats` reports real usage (9 ingests / 24.9M tokens / $13.72 est. over 7 d, unit `jobs` in oauth), budget round-trips live with no restart, `dailyBudget: 0` is a 400. **The pause path itself is covered by unit tests only** — triggering it live would need real ingests (today's usage was 0).

## 4. Error paths & diagnosability (SPEC.md §10 DoD)

- [ ] Failed jobs must be **diagnosable** (full error + the persisted `job_logs` stream visible in the UI — history already has a Log toggle) and **retryable** (retry endpoint exists; confirm the flow end-to-end including batch members). Add a "copy diagnostics" affordance if useful.
- [ ] Harden the long-run/hang path from §0 (a stuck agent run must fail loudly and free the worker, not wedge it).
- [ ] Consider a "git revert this ingest" action in history (SPEC §9 undo; v1.1 note) — optional.

## 5. Dockerfile + docs (SPEC.md §12.2, §10)

- [x] `Dockerfile` (+ `.dockerignore`): multi-stage — build SPA + server, compile prod deps in a stage that HAS a toolchain (better-sqlite3 is native; bookworm → bookworm-slim keeps the ABI valid), then a slim runtime that ships **bubblewrap + socat** (without them every agent run fails, by design) and the preprocessing toolchain. Runs non-root as a single `node dist/main.js`. Vault/DB/inbox are volumes; the localhost guard is NOT relaxed — publishing the port requires `HTTP_AUTH_MODE=token` + `HTTP_AUTH_TOKEN`, and bubblewrap needs unprivileged user namespaces (both documented).
- [ ] ⚠️ **The image build is UNVERIFIED** — Docker is not installed in the dev WSL distro, so `docker build` was never run. What *was* verified: the build steps mirror the working local ones (`npm ci`, `npm run build`, `node dist/main.js`), and `src/` imports no devDependency, so `npm ci --omit=dev` is safe. Treat the first build as untested; this is the one open item in §5.
- [x] Docs: a real `README.md` written from scratch (there was none) — requirements, vault clone, toolchain, credential, build/run, systemd + the WSL-restart check, the dashboard, the env-vs-settings precedence model, daily budget semantics, the security model incl. why the sandbox is the boundary and when to re-run `permprobe`, Docker with its two non-optional caveats, API surface, and troubleshooting. All commands in it were executed or resolved against the real scripts before being documented.

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

### F2 — PRE-EXISTING BUG: the Overview's 7-day "Fehler"/"deferred" KPIs are always 0

Found while building the usage aggregate (§3), **not introduced by M5**. `JobStore.countsSince()`
filters `WHERE finished_at IS NOT NULL`, but `TERMINAL_STATES` (which drives `set_finished` in
`transition()`) is only `done | duplicate | cancelled` — `failed` and `deferred` are excluded
because a failed job is *retryable*. So neither ever gets a `finished_at`, and
`kpis7d.failures` / `kpis7d.deferred` on the Overview are **hard-wired to 0 even when failures
exist**. Verified empirically: with one done + one failed + one deferred job, `countsSince`
returns `{ done: 1 }`.

This directly undercuts the M5 §4 DoD ("failed jobs are diagnosable") — the dashboard's headline
failure count lies. `usageSince()` sidesteps it with `COALESCE(finished_at, started_at,
created_at)`, but that is a workaround, not the fix.

**FIXED.** The code conflated two concepts in one constant — and `TERMINAL_STATES` was in fact
used *only* for the finished-stamping, never for transition legality (that comes from
`ALLOWED_TRANSITIONS`). Split them:
- `TERMINAL_STATES` = "no transition is legal" → stays `done | duplicate | cancelled` (retry from
  `failed`/`deferred` must remain legal).
- new `FINISHED_STATES` = "the run stopped" → adds `failed | deferred`, used for `set_finished`.

A retry already clears `finished_at` when moving back to `queued`, so this stays consistent
(covered by a regression test). Migration **v3** backfills `finished_at = COALESCE(started_at,
created_at)` for rows written under the old behaviour, so historical KPIs are right too, and
`usageSince` dropped its COALESCE workaround.

Verified on the real database: `user_version` 2 → 3, the existing failed job was backfilled, and
`/stats` `kpis7d.failures` went **0 → 1** (`usage.last7d.ingests` 9 = 8 done + 1 failed).

**Async/job model (separate, additive):** move `POST /maintenance/*` off the synchronous
`await`-the-whole-run hold (`routes/maintenance.ts:16-32`) to return `{runId, channel}`
immediately, stream the live log over the existing `maintenance:<kind>` bus, and poll a
new `GET /maintenance/runs/:id`. This frees the HTTP request + worker slot regardless of
the hard-kill; the two fixes are independent and both wanted.
