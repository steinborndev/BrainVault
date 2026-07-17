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
- [ ] **Save-to-vault** — `POST /api/v1/sessions/:id/save` (the `/save` flow, write-enabled + commit). **Not built yet** (§6.3 "Session in Vault sichern").
- [x] Streaming decision: **request/response for the first cut** (fully testable, meets the DoD "returns cited pages"); token/turn streaming layered on with the Chat UI (reusing the SSE approach). Documented in `routes/query.ts`.

## 2. Backend: maintenance (SPEC.md §6.4, §6.5)

- [ ] **`POST /api/v1/maintenance/lint`** — runs `lint the wiki` as a (write-enabled) agent run; the skill writes `wiki/meta/lint-report-YYYY-MM-DD.md`. Parse that report into structured JSON (orphans, dead links, stale claims, missing cross-links, `[!contradiction]` finds), each with a page link. Commit the report. Return structured result + report path. Live log via SSE.
- [ ] **`POST /api/v1/maintenance/research`** — body `{ topic }`. Runs `/autoresearch <topic>` with **web egress explicitly enabled** (the one flow allowed web, CLAUDE.md hard rule 4). Live progress (rounds, sources) via SSE; result pages linked; commit.
- [ ] **`POST /api/v1/maintenance/hot-cache`** — manual hot-cache refresh (`update hot cache` agent run or the repo's refresh); record + expose last-refresh time. Overview already renders `wiki/hot.md`.
- [ ] These are agent runs that mutate the vault — route them through the **same queue/commit discipline** as ingest (one writer, per-run commit scoping, F4) rather than a second uncontrolled writer. Decide: queue job types vs. a parallel "maintenance run" lane. Document.

## 3. Frontend: Query/Chat tab (SPEC.md §6.3)

- [ ] Replace `ChatStub`: chat UI against `/query`. Streaming answer, markdown-rendered.
- [ ] **Citations as clickable chips** — obsidian:// deep-link + copy fallback (reuse `PageLink`) + inline page preview on hover/expand. **This is the DoD.**
- [ ] Multiple named sessions (list/switch/rename/new/delete); session persistence via the sessions API.
- [ ] "Session in Vault sichern" button → `POST /sessions/:id/save`; show the resulting page link.

## 4. Frontend: Wartung tab (SPEC.md §6.4)

- [ ] Replace `MaintenanceStub`: **Lint** button → run → structured report view (grouped findings, page links). Optional last-report display.
- [ ] **Autoresearch**: topic input → run with live progress log → linked result pages.
- [ ] **Hot Cache**: manual refresh button + last-refresh timestamp.
- [ ] Settings is **M5** — at most a read-only status line here, no editor.

## 5. Acceptance (DoD)

- [ ] Ask a question in the Chat tab → a synthesized answer with **clickable citation chips** that open the cited vault pages in Obsidian (or copy-path fallback), context preserved across follow-ups in a session.
- [ ] Trigger **Lint** → a **structured** report (orphans / dead links / stale / missing cross-links / contradictions) with per-finding page links.
- [ ] **Autoresearch** and **Hot-Cache refresh** are triggerable from the UI with live feedback.
- [ ] `npm test` passes (query-runner mocked like the ingest runner; citation parsing, session/message store, report parsing get unit tests).

## Open decisions / risks (resolve as they come up)

- **Read-only enforcement for query** must be as real as the ingest sandbox: the query-runner must not let `wiki-query`'s "file the answer back" behavior write to the vault (chat is read-only; saving is the explicit `/save` action). Verify with a probe like `permprobe`.
- **Citation fidelity**: `[[Page]]` parsing + path resolution is heuristic; unresolved links must degrade to plain text, never a broken link.
- **Maintenance runs share the vault writer** — do not introduce a second uncommitted writer; reuse the queue/commit mutex.
- **Cost**: query/lint/research are real agent runs (tokens). Surface usage like ingest; consider a lighter model for quick queries (SPEC.md §11.6, deferred).

## Findings

- (M4 findings go here)
