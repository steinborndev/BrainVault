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

- [x] **Lint async rework + hard kill (BIGGEST carryover).** DONE in code on `feat/m5-maintenance-async` (see Finding F1). (a) **Hard kill:** agent runs now spawn the SDK CLI through `Options.spawnClaudeCodeProcess` in a detached process group (`pipeline/agent-spawn.ts`) and the runner escalates timeout/abort → graceful abort → group `SIGKILL` after a 5 s grace, reaping the CLI + any stuck `bash`/`python3` descendants (generalizes to ingest — it's in `runAgent`). (b) **Async/job:** `POST /maintenance/*` returns `202 {id,channel,status}` immediately; the run executes in the background; `GET /maintenance/runs/:id` polls the result; live log still streams over `maintenance:<kind>`. Frontend Wartung tab polls via `useMaintenanceRun`. Server 198 tests green (+ new `agent-spawn` group-kill test), web builds. **Both follow-ups DONE:** the end-to-end kill was verified with `killprobe` (F1: 30 s timeout run, 7 descendants, none survived, ×4 reproduced) and `permprobe` re-ran PASS after the spawn/permission change.
- [x] **`.raw/.manifest.json` commit-scoping residual.** Fixed: `BOOKKEEPING_PATHS` now includes `.raw/.manifest.json` and was moved to `pipeline/git.ts` (the shared commit module) so the ingest queue and the maintenance runner can't drift apart — maintenance had the two paths duplicated as literals. Both the single-job and batch ingest pathspecs pick it up. Regression test added (`queue.test.ts`, asserts the commit pathspec). Vault is currently clean for this file (an earlier hot-cache run swept it in); the fix stops future ingests re-dirtying it.
- [x] **Save-to-vault** (`POST /sessions/:id/save`, SPEC §6.3). Resumes the chat's `sdk_session_id` and prompts `/save` under the **`ingest`** profile — the chat itself is read-only by design, so the save needs a write-enabled run to produce the page. Implemented as a new `save` kind on `MaintenanceRunner` rather than a separate module: it needs the same commit discipline, and sharing that runner's **run mutex is what stops a save interleaving with a lint** (two concurrent vault writers is exactly what the mutex prevents). Async like the other runs (202 + poll). 400 if the session never completed a query (nothing to resume). Chat tab gained an "In Vault sichern" button with the live log and resulting page links.
- [x] **Autoresearch verified end-to-end with a real agent** (2026-07-18, topic: endosomal escape of lipid nanoparticles). 10 pages created + 8 updated, committed as `8b28ca0 maintenance: research`; vault 98 → 108 pages. 4.74 M in / 53.7 k out tokens, **$3.45 estimated (Abo)**. Web egress worked (5 search angles, 8 fetches, 2 paywalled and logged). Quality note: it correctly filed a *contradiction* between a Nov 2025 ACS Nano perspective and a Sept 2025 review as unresolved instead of overwriting the vault's existing claim. **Two real bugs surfaced — see F3 and F4.**
- [x] Polish: **citation preview** — new read-only `GET /api/v1/pages?path=…` plus a `CitationChip` that keeps the obsidian:// deep link as the primary action and lazily fetches the page on expand. The path comes from agent-produced citations, i.e. attacker-adjacent input, so it is confined to `VAULT_ROOT/wiki`, must end in `.md`, and is re-checked after `realpath` (symlink escapes). Traversal attempts are covered by tests and were verified against the real vault — `../.git/config`, `/etc/passwd` and `wiki/../../.config/vault-service/env` all 400.
- [x] Polish: **hot-cache last-refresh timestamp** — `hotCacheUpdatedAt` (mtime of `wiki/hot.md`, the honest source since agent runs write it) on `/stats`, shown next to the refresh button.

## 1. systemd user service + autostart (SPEC.md §3.1) — DoD-critical

- [x] `vault-service.service` systemd **user** unit template + `scripts/install-systemd.sh`. The install script resolves the repo path and the **real node binary** (nvm's node is not on systemd's PATH) and bakes both into the unit, sets `PATH` to include the node dir + system dirs (bwrap/socat/python3), passes `VAULT_ROOT` (credential still loads from `~/.config/vault-service/env`), `Restart=on-failure`, `enable`s it, prints the `loginctl enable-linger` + start steps. Verified: installed, started via systemd, MainPID is `node dist/main.js`, `/health` 200, watcher on `/mnt/c/inbox`, clean `systemctl --user restart`.
- [x] **Gotcha resolved:** the unit runs the **built JS** as a single `node dist/main.js` process (new server `build` → `tsconfig.build.json`, and `start:prod`). Confirmed a SIGTERM reaps it cleanly and frees port 8420 — no tsx/npm wrapper, no orphan. `KillMode=control-group` also reaps any in-flight agent-run descendants with the service (complements F1).
- [x] **Queue/in-flight resume:** on start the queue reconciles jobs stranded in `preprocessing`/`ingesting` by an abrupt stop → `failed` ("interrupted by a service restart", retryable) via `JobStore.recoverInterrupted()`; `queued` jobs resume automatically; watcher re-attaches. We do NOT auto-replay an interrupted `ingesting` job (may have partially written the vault — hard rule 1); it's one-click retryable instead.
- [x] **DoD test PASSED (2026-07-18, real `wsl --shutdown`).** Boot 11:57:46 → service active 11:57:48 (MainPID 264, `node dist/main.js`), `/health` answered with no manual start; watcher re-attached to `/mnt/c/inbox`. A synthetic job left in `ingesting` across the restart was reconciled to `failed` ("interrupted by a service restart", `finished_at` stamped, recovery log line), and a retry then drove it `failed → queued → claimed → failed` with a diagnosable error — so §4's "failed jobs are diagnosable and retryable" is verified end-to-end too. `loginctl enable-linger` was set beforehand.

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

- [x] Failed jobs must be **diagnosable** (full error + the persisted `job_logs` stream visible in the UI — history already has a Log toggle) and **retryable** — verified end-to-end in the §1 WSL-restart test (retry drove `failed → queued → claimed → failed` with a clear error); batch members re-register as a pending batch on retry (`retryJob` + `reloadPendingBatches`). "Copy diagnostics" affordance: skipped as not pulling its weight — the log toggle shows the full stream.
- [x] Harden the long-run/hang path from §0 — done and VERIFIED via `killprobe` (F1): detached process group + abort→grace→group-SIGKILL escalation, generalized in `runAgent` so it covers ingest too.
- [ ] (deferred, optional — v1.1) "git revert this ingest" action in history (SPEC §9 undo). Architecture supports it (one commit per ingest); no UI yet.

## 5. Dockerfile + docs (SPEC.md §12.2, §10)

- [x] `Dockerfile` (+ `.dockerignore`): multi-stage — build SPA + server, compile prod deps in a stage that HAS a toolchain (better-sqlite3 is native; bookworm → bookworm-slim keeps the ABI valid), then a slim runtime that ships **bubblewrap + socat** (without them every agent run fails, by design) and the preprocessing toolchain. Runs non-root as a single `node dist/main.js`. Vault/DB/inbox are volumes; the localhost guard is NOT relaxed — publishing the port requires `HTTP_AUTH_MODE=token` + `HTTP_AUTH_TOKEN`, and bubblewrap needs unprivileged user namespaces (both documented).
- [x] **Image build VERIFIED** (2026-07-18, Docker Desktop 4.52 / Engine 29.0.1, linux/amd64). Builds clean (1.88 GB). Checked inside the image: `bwrap`+`socat` present (without them every agent run fails by design), all 7 preprocessing tools present, and **`better-sqlite3` loads and executes across the bookworm → bookworm-slim stage boundary** — the riskiest assumption in the multi-stage layout. Container starts as **PID 1**, serves `/api/v1/health` and the SPA (so the `rootDir: src` build layout resolves `web/dist` correctly in the image too).
- [x] **Bug found and fixed by the first real container run:** the service died at startup with `SQLITE_CANTOPEN`. `VOLUME` created `/data`, `/inbox`, `/vault` implicitly as **root**, while the container runs as uid 10001 — so it could not create `/data/jobs.db`, and Docker seeds anonymous volumes from those image directories. Fixed by creating and `chown`ing the mount points before the `VOLUME` instruction. No test could have caught this; only running the container did.
- [x] **Localhost guard verified in the container:** `HOST=0.0.0.0` without a token **refuses to start** with the SPEC §9 configuration error; with `HTTP_AUTH_MODE=token` + `HTTP_AUTH_TOKEN` it starts, returns **401** unauthenticated and serves `/health` with a bearer token.
- [ ] **Known limitation (documented in the README, not a regression):** in token mode the **browser UI is unreachable** — the auth middleware protects everything except `/api/v1/health`, including the SPA, so a browser gets 401 before it can load the page that would ask for a token. The API works fine with a bearer header. The fix is the login screen, which SPEC.md §12.1 already scopes as the auth "Ausbaustufe". `--network host` does not work around it under Docker Desktop (the container joins the Docker VM's network namespace — measured). Browser use stays on the systemd path.
- [x] Docs: a real `README.md` written from scratch (there was none) — requirements, vault clone, toolchain, credential, build/run, systemd + the WSL-restart check, the dashboard, the env-vs-settings precedence model, daily budget semantics, the security model incl. why the sandbox is the boundary and when to re-run `permprobe`, Docker with its two non-optional caveats, API surface, and troubleshooting. All commands in it were executed or resolved against the real scripts before being documented.

## 6. Acceptance (DoD)

- [x] After a **WSL restart**, the service is up on `127.0.0.1:8420` without manual start (verified 2026-07-18, 2 s after boot); `queued` work resumes and mid-flight work is reconciled to a retryable `failed`.
- [x] A **failed job** shows its error + full log and can be **retried** (verified live during the restart test: retry re-entered the pipeline and produced a clear diagnosable failure).
- [x] Settings UI reads/writes config; cost shows as "Schätzwert (Abo)" in oauth mode.
- [x] `Dockerfile` present, docs complete. `docker build` + container run were later verified (see §5 — build, guard, and PID-1 checks all passed); the earlier "UNVERIFIED" caveat here was stale.
- [x] `npm test` passes (235); `permprobe` re-run after the spawn/permission change — `canary outside vault: blocked`.

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

**VERIFIED end-to-end (2026-07-18) — `server/src/cli/killprobe.ts`, `npm run killprobe`.**
A real run with a 30 s timeout, whose prompt forces a blocking `python3 -c "time.sleep(604)"`,
returned at **32.0 s** with `timedOut: true`; **7 descendants** (CLI, bwrap, bash, python3) were
observed while it ran and **none survived**. Reproduced identically across four runs. Before the
fix that python3 would have kept running for its full 604 s.

Two things had to be learned to make the probe work, both worth keeping:
1. Under the `query` profile the agent **refuses** the blocking command — the read-only system
   prompt correctly notices it contradicts a read-only wiki query. The probe therefore uses
   `ingest`, which is also the profile the real hang occurred under. Point it at a THROWAWAY
   vault (a copy of `.claude-plugin/` + `skills/` plus an empty `wiki/`).
2. A bare `sleep` is rejected by the Claude Code CLI's own guard ("Blocked: standalone sleep …
   use Monitor with an until-loop"). A blocking `python3` is both allowed and more faithful to
   the original `bash → python3` embeddings hang.

**Side effect worth knowing:** a group-SIGKILLed run leaves bubblewrap's 0-byte read-only
bind-mount targets (`.bashrc`, `.gitconfig`, `.mcp.json`, …) plus a scaffolded `.claude/` in the
project root, because bwrap never gets to run its own cleanup. They do not appear after a
normally-completed run (the real vault has none after 8 ingests), they are never committed (the
ingest pathspec is scoped), and no vault CONTENT is touched — the probe asserts `wiki/` is
unchanged. Only a hard-killed run can leave them, and then only as untracked files.

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

### F3 — FIXED: `/autoresearch` was never a valid invocation

The first real autoresearch run failed instantly with `Unknown command: /autoresearch`. M4 shipped
`startResearch` sending the literal slash form, and **it never worked**: the vault is loaded as a
plugin (`plugins: [{type:'local', …}]`), so its `commands/` are namespaced — the bare
`/autoresearch` does not resolve. Mocked tests could not catch this; the task existed precisely
because the flow had only ever been mocked.

The **zero-token guard** in `agent-runner.ts` is what made it visible: the SDK reported the run as
`subtype: 'success'`, and without that guard it would have been recorded as a completed research
run that did nothing. It was built in M0 against auth failures and caught an unrelated class of
bug. Cost of the failure: **0 tokens**.

Fixed by spelling the flow out in the prompt (mirroring the vault's own `commands/autoresearch.md`:
load `references/program.md`, run the loop, update index/log/hot), the same natural-language style
the working lint prompt already used. That avoids depending on a namespaced command name and
respects hard rule 5 (no edits to vault internals).

### F4 — OPEN: a Bash-written/renamed page can miss the commit pathspec

The research run's **synthesis page** — the central output — was left **uncommitted** as an
untracked file. `pipeline/written-paths.ts` derives the commit pathspec from `Write`/`Edit` tool
calls only; the module documents that Bash-only writes are invisible and relies on
`BOOKKEEPING_PATHS` for the known ones. That assumption broke here: the agent wrote the page with
`Write` (path A) and then **renamed it via Bash** (`Research- …` → `Research: …`), so the staged
path no longer existed and the real one was never staged.

Not data loss — the file is on disk — but it stays unversioned and leaves `git status` dirty, and
a later scoped commit will not sweep it either. It affects ingest equally, not just maintenance.

**FIXED — with an exclusivity proof.** The first attempt bracketed each run with a
before/after `git status` diff and staged the newly-dirty wiki paths. It was reverted: at
concurrency 2 the runs overlap, so job A's bracket also captured pages job B was concurrently
writing — A committed B's page and B's own commit then found nothing. The M1 acceptance test
("one page per ingest commit") caught it immediately. Time-bracketing cannot attribute a page to
a run whenever two runs can overlap, and here they always can (ingest↔ingest at concurrency 2;
ingest↔maintenance hold separate run mutexes and share only the commit mutex).

The bracket is sound the moment exclusivity can be *proven*, so that is what was added:
`pipeline/run-registry.ts` counts runs currently able to write the vault, shared between the
ingest queue and the maintenance runner exactly like the commit mutex already is. A run may sweep
unattributed wiki changes into its commit **only while `isSoleWriter()`**; with another run in
flight the sweep is skipped and only tool-reported paths are staged. Losing a page from a commit
is visible and fixable by hand; filing it silently under the wrong job is not.

Both checks happen INSIDE the commit mutex (`buildPathspec` in `queue.ts`, and the equivalent in
`maintenance.ts`), so no run can start writing between asking the question and acting on it. The
writer registration is released on every path, including failures and retries, so the count cannot
leak and permanently disable the sweep.

Covered by `test/f4-sweep.test.ts` against a real git vault: the sweep stages a Bash-written page
when sole writer, skips it when another writer is active, and never touches files the user already
had dirty (SPEC risk 5). Plus `test/git-dirty.test.ts` for the `-z` parsing (page names with
colons and spaces must not come back quoted, or `git add` would fail on them). 248 tests green.

Residual, accepted: while two runs genuinely overlap, a Bash-written page from either still stays
untracked. It is visible in `git status` and committable by hand — which is what was done for the
autoresearch synthesis page (vault commit `3988a4e`).


---

## 7. Deep review + fix wave (2026-07-18, post-M5)

A systematic review (spec-compliance, server, frontend, open items) was run and its findings
fixed on `fix/deep-review`. Highlights — details in the two `fix:` commits:

- **Server:** SSRF DNS-rebinding fix (outbound fetches pinned to the validated address),
  `/query` concurrency cap (2, then 429), usage now ACCUMULATES across attempts (retry-then-
  success and failed batch runs no longer under-count the budget), 413 + temp cleanup for
  over-limit uploads, a failing batch member no longer strands its siblings, watch folder
  honours `maxUploadBytes` (SPEC §4.2), rate-limit pause honours a parseable reset time
  (SPEC §7.1), SSE hardening, `finished_at` index (migration v4), timing-safe token compare,
  `GET /jobs?type=` filter (SPEC §6.5), office magic-byte check un-deadened.
- **Frontend:** SSE reconnect/visibility resync (stale-dashboard fix), bounded log store with
  rowid-exact dedup, keyboard-accessible dropzone + client-side size pre-check, chat draft
  restore on error, inline rename/two-step delete instead of `window.prompt`/`confirm`,
  copy fallback for non-secure contexts, SW no longer caches errors + trims old assets +
  reloads once on controllerchange, Overview retry button, SVG icons replace emoji.
- **Spec updates (user-approved):** §4.2 now documents that disguised executables FAIL
  (security finding) rather than defer; §3.1 documents that the ingest skill maintains the
  hot cache itself (M0 evidence) — no separate refresh pass; §5 documents the built-in
  HTML-to-text fallback actually shipped.

Still deliberately open (unchanged): queue-reorder endpoint (M3 optional), git-revert button
(v1.1), token streaming for chat, login screen (SPEC §12.1 Ausbaustufe), per-job-type model
choice, multiple watch folders, live budget-pause trigger (unit-tested only).


---

## 8. Vault-Viewer + Graph-View (SPEC §12.4) — DONE (2026-07-18)

Pulled forward from the §12.5 roadmap (it was step 6) because the WSLg Obsidian graph is
unusable and the goal is to make the Obsidian app optional for everyday use.

**Server (read-only):** `pipeline/graph.ts` + `GET /api/v1/graph`; `GET /api/v1/pages` gained
`full=1`. The graph builder reuses `parseWikilinks` from `citations.ts` (so chat citations and
graph edges resolve identically) and caches per file on (mtime, size), returning the previous
graph object outright when nothing changed. Real vault: 111 nodes / 802 edges, 35 ms cold,
2 ms cached, 19 KB JSON. Covered by `test/graph.test.ts` (resolution rules + both cache layers).

**Frontend:** new `Vault` tab, hand-rolled history router (`lib/router.ts`), Canvas-2D renderer
(`components/GraphCanvas.tsx`) driven by a d3-force web worker (`lib/graphLayout.worker.ts`).
Scale decisions, deliberate because the vault keeps growing: canvas over SVG, layout off the
UI thread and cooling to a stop, label LOD by zoom + hub degree, viewport culling, local-
neighborhood mode (BFS depth 1/2) so a huge vault never has to lay out in full, and the tab is
code-split (13 kB + 16 kB worker). Only new dependency: `d3-force`.

**Four bugs the browser found that tests could not** (all fixed, see the fix commit):
1. `flex: 1` on the canvas wrapper overrode `height` in a column flex container → canvas stuck
   at min-height.
2. Fit-to-view used the absolute bounding box, so a few far-flung orphan pages shrank the
   cluster to a speck → 5th–95th percentile fit + degree-dependent centering force.
3. A global `.md { max-height: 420px; overflow: auto }` (written for the hot-cache snippet)
   silently clipped full pages to 420 px of 3026 → scoped to the embedding containers.
4. YAML frontmatter rendered as prose → now a properties panel with navigable wikilinks.

**Verified end-to-end in a real browser** (headless Chromium driving the live systemd service):
graph paints and fits, search matches, node click opens the page, wikilink navigation + browser
back, "Im Graph" focus jump, deep-link reload, no console errors, no mobile horizontal overflow,
and all four pre-existing tabs still fine under the new router.

**Operational note learned here:** `@fastify/static` is registered with `wildcard: false`, which
binds one route per file AT STARTUP. After a frontend rebuild the running service still serves
the old asset names and new hashed files 404 into the SPA fallback — **restart the service after
`npm run build:web`**. Pre-existing behaviour, not introduced by this work.


### §8 addendum — editing + Windows-first links (2026-07-18, user-requested)

The viewer is no longer read-only, and the dashboard no longer depends on `obsidian://`:

- **In-app links everywhere:** `PageLink` (used by Overview, Ingestion history, chat citation
  chips, maintenance results) now navigates to `/vault/page/…` as its primary action; the
  obsidian:// deep link became a secondary icon. This is the fix for "Windows browser can't use
  the deep links" — Windows-Obsidian cannot open a WSL vault over `\\wsl$` (M0 finding), so the
  in-app viewer is the path that works everywhere.
- **Edit + delete in the page view:** `PUT`/`DELETE /api/v1/pages`, same wiki confinement as GET.
  Every mutation is ONE git commit (`edit: <title>` / `delete: <title>`) behind the shared commit
  mutex, via the new `commitPaths()` in `pipeline/git.ts` — deliberately NOT `commitVault()`,
  whose `git add -A` fallback would sweep a concurrently running agent's half-written pages into
  the user's commit (covered by a regression test). Optimistic locking via `baseMtime` → 409.
  `gitAutoCommit=false` is honoured (write without commit, like ingest). Page creation stays
  agent-only by design.
- **Stale-links banner:** DELETE returns `staleLinks` (the page's in-degree from the shared
  GraphBuilder, computed before the unlink). The frontend accumulates these across deletions in
  a sessionStorage-backed store and shows a dismissable banner with the counter, guiding the
  user to the Wartung tab for a lint run — the vault's own mechanism for cleaning dangling
  references. Hard rule 1 and SPEC §12.4 were amended accordingly (user decision 2026-07-18).
- Verified end-to-end in a real browser against an ISOLATED throwaway instance
  (`VAULT_ROOT`/`PORT`/`DB_PATH`/`WATCH_FOLDER` env — the real vault was never touched):
  in-app links, edit→commit, 409 conflict path with reload, delete→commit, banner counter (2),
  guidance navigation, clean git history (`seed`, `edit:` ×2, `delete:`), clean tree.
  Server suite: 270 tests green (`pages-write.test.ts` added).


### §8 addendum — live graph during ingest (2026-07-19, user-requested)

The graph view now updates live while an agent writes pages — the Obsidian graph behaviour
("bubbles reorient, new links appear") the dashboard viewer had lost by being fetch-once.

- **Server signal:** `pipeline/vault-watcher.ts` — a second chokidar watcher on
  `VAULT_ROOT/wiki` (notification only; never reads or writes page content, hard rule 1
  untouched). Bursts of writes coalesce into ONE debounced (1 s) payload-less `vault` bus/SSE
  event; the commit-time `stats` event was never a substitute because it fires once at the END
  of a run, after all pages are already written. Wired in `main.ts`, closed on shutdown.
  Tests: `vault-watcher.test.ts` (ignoreInitial, burst→one event, change/unlink fire,
  non-markdown ignored, close stops publishing) + a `vault` SSE serialization case in
  `api.test.ts`.
- **Frontend plumbing:** `useEvents` invalidates `['graph']` on `vault` and on SSE reconnect
  resync. Deliberately NOT `['page-full']`: refetching an open page would refresh `baseMtime`
  under the user's editor and defeat the optimistic 409 lock.
- **The actual work — position identity.** Node positions were index-addressed, but the server
  sorts nodes by path, so ONE new page shifts every index after it — any live update would have
  scrambled the layout. Positions now live in a `Map<path, {x,y}>`; indices are translated only
  at the worker boundary.
- **Worker session protocol** (`graphLayout.worker.ts`): long-lived worker instead of
  spawn-per-layout; requests carry a generation number (stale frames are dropped), a seed
  position array, and an alpha. Ticking is timer-sliced instead of a blocking while-loop, so a
  new request interrupts a cooling layout immediately. Small diffs reheat at alpha 0.3 (gentle
  reorientation); >20 % never-placed nodes restart cold at alpha 1. New nodes are seeded at
  their placed neighbors' centroid (golden-angle offset against stacking) and flash for ~1.6 s.
- **Camera discipline:** auto-fit happens ONLY on the very first finished layout. This also
  fixes a pre-existing annoyance: every page save/delete used to relayout from scratch and yank
  a panned/zoomed user back to fit. Side effect of path-keyed positions: filter chips and
  local-mode toggles now keep the layout instead of re-dealing it.
- Structural-identity skip (paths + edges unchanged → no repost) keeps mtime-only refetches and
  StrictMode's second effect pass from re-settling; the last layout is replayed into a
  recreated worker (StrictMode terminates the first one in dev).
- Also corrected here: a stale comment claiming positions "carry over by index" — they never did.
- **Verified:** server suite 292 tests green; web typecheck + build clean; live probe against
  the running systemd service — an mtime touch on a wiki page produced exactly one
  `event: vault` / `data: {}` on the SSE wire (debounce confirmed live).
