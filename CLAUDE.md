# CLAUDE.md — vault-service

## What this project is

A local ingestion service + web dashboard on top of a claude-obsidian vault (v1.9.2, Generic mode). It watches a folder and accepts drag-and-drop uploads, preprocesses material (PDF, Office, web, images, text), and runs headless Claude Agent SDK sessions that execute the vault's `ingest` skill fully automatically. A React dashboard (4 tabs: Overview, Ingestion, Query/Chat, Maintenance) exposes status, queue, chat with citations, and maintenance actions.

**The authoritative specification is `SPEC.md` in this repo. Read it before any non-trivial task. When code and spec disagree, the spec wins; when you believe the spec is wrong, say so and ask before deviating.**

## Repo layout

```
vault-service/
├── SPEC.md                 # authoritative spec (do not edit without being asked)
├── CLAUDE.md               # this file
├── docs/tasks/             # per-milestone task lists (TASKS-M0.md, …)
├── server/                 # Fastify backend, TypeScript
│   ├── src/api/            # routes under /api/v1, auth middleware
│   ├── src/pipeline/       # watcher, queue, preprocessing plugins, agent runner
│   ├── src/db/             # better-sqlite3 schema + migrations
│   └── test/
├── web/                    # React + Vite + TypeScript frontend (responsive, PWA-ready)
└── scripts/                # setup + dev helpers
```

The vault itself lives OUTSIDE this repo (default `~/vault`, a claude-obsidian clone). Its path is a configuration value (`VAULT_ROOT`). Never hardcode it; pass it through explicitly (multi-vault support is a planned extension, see SPEC.md §12.1).

## Hard rules

1. **Vault integrity first.** The service writes to the vault only through agent runs, git commits, and **user-initiated page edits/deletes via `PUT`/`DELETE /api/v1/pages`** (added 2026-07-18, SPEC.md §12.4) — and every such mutation IS one immediate git commit behind the shared commit mutex, so it stays versioned and revertable and can never interleave with an agent commit. Never delete or rewrite vault content from *pipeline* code. SQLite holds operational state only; losing the DB must never damage the vault (SPEC.md §8).
2. **Localhost guard.** Server binds `127.0.0.1` by default. If bind ≠ localhost and no auth mode with a token/password is active, refuse to start (SPEC.md §9). Do not weaken this.
3. **Credentials** (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) live only in the service environment. Never in the repo, logs, frontend, or SQLite. Refuse to start if both are set (SPEC.md §7.1).
4. **Agent run permissions** (wording corrected from M0 evidence — read this before touching the runner's permission wiring):
   - **The hard, load-bearing guarantees:** writes confined to `VAULT_ROOT` (plus the sandbox's default temp allowlist), and no web egress in ingest runs (web only in the autoresearch flow). These are enforced at the OS level by the Agent SDK's `sandbox` (bubblewrap on Linux): `sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: [VAULT_ROOT] } }`. Deps: `bubblewrap` + `socat`.
   - **`canUseTool` is NOT the enforcement point — it was measured to be invoked zero times by this SDK.** Tool-level policy runs through a **`PreToolUse` hook**; the sandbox is what actually contains Bash. Do not "simplify" enforcement back to `canUseTool` or `permissionMode: 'acceptEdits'`. Do not set `allowUnsandboxedCommands: true` — the Bash tool ships a `dangerouslyDisableSandbox` escape hatch that is otherwise permitted by default, which makes the sandbox decorative.
   - **The bash denylist is defense in depth, not a hard boundary, and NOT a `scripts/*.sh` whitelist.** A scripts-only whitelist would block a real ingest (of 68 bash calls in the validated M0 run, 14 were `find`/`ls`/`cat`/`python3`). Deciding what an arbitrary shell string writes is not tractable; the sandbox, not the denylist, is what protects the vault.
   - **After any SDK upgrade or change to the permission wiring, re-run `server/src/cli/permprobe.ts`.** It is the only check that catches "the SDK stopped consulting our guard" — unit tests structurally cannot. Expect `canary outside vault: blocked`.
5. **Do not modify the cloned claude-obsidian repo internals.** Extensions to its behavior go through documented mechanisms only: the system-prompt extension in the agent runner, or a thin wrapper skill added to the vault (tracked in this repo under `scripts/vault-extensions/` and installed by a setup script). Both mechanisms are now in use: `RunAgentOptions.systemPromptExtra` carries the domain registry into every vault-writing run, and `scripts/vault-extensions/domains.md` is its seed page (installed by `scripts/install-domain-registry.sh`). Once installed, the VAULT's copy is the source of truth — the service only reads it.
6. Incoming files are never executed; magic-byte check against disguised executables; archives are not auto-extracted (v1).

## Conventions

- Node ≥ 20 LTS, TypeScript strict, ESM. Backend: Fastify, better-sqlite3, chokidar, zod. Frontend: React + Vite, TanStack Query, SSE (no WebSockets).
- All endpoints under `/api/v1/`, behind the auth middleware (v1 mode: `local-single-user`, pass-through). All new tables carry `user_id` (default `'local'`).
- Job lifecycle states are exactly: `queued | preprocessing | ingesting | done | failed | deferred | duplicate | cancelled` (SPEC.md §8). Log every transition to `job_logs`.
- Preprocessing is a plugin chain (`detect → normalize → manifest`); new source types (e.g. future audio transcription) are added as plugins, never as special cases in the pipeline core.
- Agent-run language rule: all wiki content in English regardless of source language; verbatim quotes keep their original language with a language note; check existing English concept names before creating new concept pages (SPEC.md §3.1).
- Tests: pipeline logic (queue transitions, dedupe, preprocessing, guards) gets unit tests; agent runs are mocked in tests. `npm test` must pass before a milestone is called done.
- Commits: conventional style (`feat:`, `fix:`, `test:`, `docs:`), small and scoped. Do not commit generated artifacts.

## Working agreement

- Work milestone by milestone (M0–M5, SPEC.md §10). Each milestone's task list lives in `docs/tasks/`. Do not start Mn+1 while Mn acceptance criteria are unmet.
- At the start of a session, read the current milestone's task file and report which tasks are open before coding.
- When a task reveals a spec gap or a wrong assumption (e.g. the ingest skill behaves differently than expected), stop, document the finding in the task file, propose a resolution, and ask.
- Findings from the two M0 risk probes (Obsidian `\\wsl$` performance; ingest-skill interactivity) must be written down in `docs/tasks/TASKS-M0.md` — they decide follow-up work.

## Definition of Done (summary, details in SPEC.md §10)

- **M0:** one PDF ingested end-to-end via a CLI trigger; pages + index + hot cache correct; both risk probes documented.
- **M1:** 10 mixed files in `.raw` all reach `done`; no vault corruption at concurrency 2; retries/timeouts/dedupe work.
- **M2:** files dropped into the Windows watch folder land in the vault with zero interaction; batching within 60 s works.
- **M3:** browser drop → live log via SSE → resulting page links open in Obsidian.
- **M4:** chat answers cite clickable vault pages; lint report is structured; autoresearch and hot-cache refresh triggerable.
- **M5:** survives WSL restart via systemd user service; failed jobs diagnosable and retryable; settings UI; Dockerfile present; docs complete.
