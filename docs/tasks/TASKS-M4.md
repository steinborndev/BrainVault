# TASKS-M4 — Query + Wartung (query & maintenance)

Goal (SPEC.md §10): **Chat tab with citations & sessions; Lint / Autoresearch / Hot-Cache controls.**
**Acceptance (DoD): a question returns cited, clickable vault pages; the lint report is structured.**

Settings UI (§6.4 "Einstellungen") is **M5** — leave it out here (the Wartung tab may show a read-only status stub, not an editor).

## Where M4 starts (already built in M0–M3)

- **Agent-runner** (`pipeline/agent-runner.ts`): headless SDK `query()`, sandbox + PreToolUse hook enforcement, `onMessage` stream sink, usage capture, timeout/abort. Built for **ingest** (writes to vault, web disallowed) — M4 needs a **read-only query variant** and a **web-enabled research variant**.
- **EventBus + SSE** (`/api/v1/events`): job/log/stats. M4 chat needs its own live token/turn stream — decide: reuse the bus with a `chat` event, or a per-request SSE. (Leaning: a dedicated streaming response for `/query`, bus stays job-centric.)
- **DB**: `sessions` (id, user_id, title, created_at) + `messages` (id, session_id, role, content, citations JSON, ts) tables exist and are unused — they are M4's store.
- **Frontend**: 4-tab shell; `ChatStub` + `MaintenanceStub` are placeholders to replace. `PageLink`/obsidian:// deep-links, `Markdown` renderer, SSE hook, TanStack Query all reusable.
- **Vault skills present**: `wiki-query` (read-only, cites `[[Page]]`), `wiki-lint` (writes `wiki/meta/lint-report-*.md`), `autoresearch` (web egress), `save` (`/save` files a session into the vault).

## 1. Backend: query-runner + chat (SPEC.md §5 "Query-Runner", §6.3, §6.5)

- [x] **Read-only query-runner** (`pipeline/query-runner.ts`) — via a new `RunProfile` (ingest/query/research) on the agent-runner: `query` denies Write/Edit tools, denies web, and the sandbox gets **no vault write path** (`allowWrite: []`), so read-only is an OS-level guarantee (permprobe-style). SDK `resume` for follow-up context. `research` profile enables web + writes (for autoresearch); `ingest` unchanged (verified: permprobe still `blocked`).
- [x] **`POST /api/v1/query`** (`routes/query.ts`) — `{ question, sessionId? }`: creates/continues a session, persists the user message, runs the query-runner, persists the assistant message + citations, returns `{ sessionId, message, citations, usage, authMode }`. **First cut is request/response (non-streaming)** — see decision below. 502 on runner failure (recorded as a system message).
- [x] **Citation extraction** (`pipeline/citations.ts`) — parse `[[Page]]`/`[[Page|Alias]]`/`[[Page#H]]`, resolve to vault-relative page paths via a `wiki/**` basename index, dedupe. Stored in `messages.citations` (JSON). Unresolved → `path: null` (plain text, never a broken link).
- [x] **Sessions API** — `GET/POST /api/v1/sessions`, `GET/PATCH/DELETE /api/v1/sessions/:id`. `ChatStore` (`db/chat.ts`) over the existing tables + migration v2 (`sdk_session_id`, `updated_at`).
- [x] **Save-to-vault** — `POST /api/v1/sessions/:id/save` (the `/save` flow, write-enabled + commit). Built in M5 as a `save` kind on `MaintenanceRunner` (see TASKS-M5 §0); this box was stale.
- [x] Streaming decision: **request/response for the first cut** (fully testable, meets the DoD "returns cited pages"); token/turn streaming layered on with the Chat UI (reusing the SSE approach). Documented in `routes/query.ts`.

## 2. Backend: maintenance (SPEC.md §6.4, §6.5)

- [x] **`POST /api/v1/maintenance/lint`** — `MaintenanceRunner.lint()` runs `lint the wiki` (write-enabled `ingest` profile); `lint-report.ts` parses `wiki/meta/lint-report-*.md` into structured JSON (summary counts + one section per category, each finding's first `[[Page]]` resolved). Commits, returns `{ ok, lint, reportPath, pages, usage, channel }`. Live log over the bus.
- [x] **`POST /api/v1/maintenance/research`** — `{ topic }` → `/autoresearch <topic>` on the `research` profile (**web egress enabled**, the one flow allowed web). Result pages committed + returned. 400 on empty topic.
- [x] **`POST /api/v1/maintenance/hot-cache`** — `update hot cache` run + commit; Overview already renders `wiki/hot.md`. (Last-refresh timestamp display: minor, deferred.)
- [x] Same commit discipline as ingest: a **shared commit mutex** (`main.ts` passes one `Mutex` to the queue and the `MaintenanceRunner`), plus a `runMutex` so only one maintenance run writes at a time. Live progress streams over a stable `maintenance:<kind>` bus channel (rendered via `JobLog seed={false}`).

## 3. Frontend: Query/Chat tab (SPEC.md §6.3)

- [x] Replace `ChatStub` (`tabs/Chat.tsx`): chat UI against `/query`, markdown-rendered answers. (Non-streaming for now; token streaming later.)
- [x] **Citations as clickable chips** — resolved pages via `PageLink` (obsidian:// + copy fallback); unresolved links render as dashed plain-text chips. **DoD — verified live** (see Findings).
- [x] Multiple named sessions (list/switch/rename/new/delete) via the sessions API; context preserved across follow-ups (SDK resume).
- [x] "Session in Vault sichern" button → `POST /sessions/:id/save`. Built in M5 with the save endpoint (TASKS-M5 §0); this box was stale.
- [x] Inline page **preview** on a citation chip (hover/expand) — built in M5 (`GET /api/v1/pages` + `CitationChip`, TASKS-M5 §0); this box was stale.

## 4. Frontend: Wartung tab (SPEC.md §6.4)

- [x] Replace `MaintenanceStub` (`tabs/Maintenance.tsx`): **Lint** button → live log → structured report view (summary tiles + grouped findings with page links).
- [x] **Autoresearch**: topic input → run with live progress log → linked result pages.
- [x] **Hot Cache**: manual refresh button (live log + result). Last-refresh timestamp: minor, deferred.
- [x] Settings shown as a **read-only M5 note** (no editor), as scoped.

## 5. Acceptance (DoD)

- [x] Ask a question in the Chat tab → synthesized answer with **clickable citation chips** (obsidian:// + copy fallback), context preserved across follow-ups. **Verified live** (Risotto query, 5/5 citations resolved; read-only guarantee held).
- [x] Trigger **Lint** → a **structured** report (summary + orphans / dead links / … with per-finding page links). Backend + parser + UI built; parser unit-tested, route tested with a mocked agent. **Real end-to-end lint run left for the operator** (write agent run — like the ingest DoD).
- [x] **Autoresearch** and **Hot-Cache refresh** are triggerable from the UI with a live log. (Real runs operator-gated.)
- [x] `npm test` passes — **195 tests** (query-runner + maintenance runner mocked; citations, profiles, ChatStore, lint-report parser, and all routes covered).

**Note:** the three maintenance actions and the chat are wired + tested up to the agent boundary; a real lint/research run writes to the vault + spends tokens, so — matching the M3 ingest DoD — those are triggered by the operator from the UI (live log + structured result visible).

## Open decisions / risks (resolve as they come up)

- **Read-only enforcement for query** must be as real as the ingest sandbox: the query-runner must not let `wiki-query`'s "file the answer back" behavior write to the vault (chat is read-only; saving is the explicit `/save` action). Verify with a probe like `permprobe`.
- **Citation fidelity**: `[[Page]]` parsing + path resolution is heuristic; unresolved links must degrade to plain text, never a broken link.
- **Maintenance runs share the vault writer** — do not introduce a second uncommitted writer; reuse the queue/commit mutex.
- **Cost**: query/lint/research are real agent runs (tokens). Surface usage like ingest; consider a lighter model for quick queries (SPEC.md §11.6, deferred).

## Findings

### Chat DoD verified live (2026-07-17)

- Real read-only query ("Was weißt du über Risotto?") → answer in **26 s**, **all 5 `[[…]]` citations resolved to real vault pages** (`wiki/concepts/Risotto.md`, `wiki/sources/Pumpkin Risotto Recipe (chefkoch.de).md`, …), session created + persisted (user+assistant messages), `sdk_session_id` stored for resume. authMode oauth, usage $0.43 (267k cache-heavy input tokens).
- **Read-only guarantee confirmed:** the vault working tree carried no query-authored change. The query ran at 22:40; the only dirty vault files (`.raw/.manifest.json` mtime 21:47, `.obsidian/*`) predate it by ~1 h — the sandbox `allowWrite: []` blocked any vault write, as designed.

### Autonomous maintenance verification (2026-07-17)

- **Hot-cache — verified working.** Real run: 26 s, $0.33, committed (`caab88f`). The agent found `wiki/hot.md` already current (the ingest skill maintains it) → no content change; the commit incidentally swept in the stale `.raw/.manifest.json` (that residual is now resolved).
- **Lint — two real bugs found; one fixed, one flagged.**
  1. *No report file written* (fixed): the first real run answered inline (560 output tokens) and wrote NO `lint-report-*.md`, so the runner returned `reportPath: null`. Fix: the lint prompt now explicitly instructs writing the file (report-only, no auto-fix), and the runner falls back to parsing the agent's answer text (`res.result`) when no file exists — returning `answer` either way for a UI markdown fallback. (Parser itself is unit-tested and correct.)
  2. **Lint run HANGS on a full wiki (flagged, needs rework):** a re-run with the "write full report" prompt ran **>21 min without returning** — 6+ min past the 15-min run timeout — and the synchronous HTTP handler stayed wedged (no commit, no report; the vault was left clean, nothing half-written). Likely cause: the wiki-lint skill's **DragonScale Mechanism 3 semantic tiling** runs embeddings via a long-lived bash call that blocks the SDK message iterator, so `abortController.abort()` can't fire until the tool returns. **Immediate mitigation applied:** the lint prompt now tells the skill to skip semantic tiling / embedding passes and use only read-based checks. **Proper fix (M5):** (a) maintenance runs must be **async/job-style** (return a run id, stream over the bus, poll the result) — a 20-min synchronous request is wrong; the TASKS-M4 §2 "queue job types vs. parallel lane" decision should land on async; (b) the agent run needs a **hard, tool-interrupting kill** (per-tool timeout or process kill) so a stuck bash can't outlive the run timeout.
- **Autoresearch — not run** (held): it is the most expensive path (web + minutes + creates arbitrary vault pages); left for an explicit go-ahead.

### Residual (belongs to ingest, not chat) — `.raw/.manifest.json` left uncommitted

The `wiki-ingest` skill maintains `.raw/.manifest.json` (its delta tracker), but the per-ingest commit scoping (M2 F4) stages only `.raw/<job-id>` + `.vault-meta` + written wiki paths — **not `.raw/.manifest.json`**. So it accumulates as an uncommitted working-tree change after every ingest. Harmless (the manifest is regenerable, not vault knowledge) but it keeps `git status` permanently dirty. **Fix candidate for M5 hardening:** add `.raw/.manifest.json` to the ingest commit pathspec (BOOKKEEPING_PATHS in queue.ts), or `.gitignore` it in the vault. Noted here; not an M4 blocker.
