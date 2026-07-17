# TASKS-M3 — Dashboard-Kern (dashboard core)

Goal (SPEC.md §10): tabs **Übersicht** + **Ingestion**, **SSE live updates**, **dropzone**.
**Acceptance (DoD): a browser drop → live log via SSE → the resulting page links open in Obsidian.**

Chat (§6.3) and Maintenance (§6.4) are M4 — build the 4-tab shell in M3 but leave those two as stubs. Settings UI is M5. Keep them out of scope here, don't wall them off.

## Where M3 starts (already built in M0–M2)

- **Backend server exists** (`server/src/api/`, `main.ts`): Fastify on `127.0.0.1:8420`, `/api/v1`, localhost guard, `local-single-user` auth middleware (`req.userId='local'`), one shared `IngestQueue` + `JobStore`, graceful shutdown. Run it with `npm start` (or `npm run dev`) from `server/`.
- **Endpoints present:** `GET /api/v1/health` (queue + job counts), `POST /api/v1/jobs` (multipart upload / pasted url / text; multi-file → batch), `GET /api/v1/jobs?status=&limit=`, `GET /api/v1/jobs/:id` (job + logs).
- **Queue/runner:** batching, retry/timeout/rate-limit, per-ingest commit scoping (F4), `job_logs` holds the persisted agent stream per job (the runner's `onMessage` sink already writes every line). `store.counts()`, `store.recent()` exist.
- **Frontend does NOT exist yet** — `web/` is empty. This is the bulk of M3.
- **DB tables** (SPEC.md §8): `jobs`, `job_logs`, `sessions`, `messages`, `settings`, `users` — `sessions`/`messages` feed M4 chat, not M3.

## 0. Carried over / cross-cutting

- [x] **Obsidian deep-link risk probe — RESOLVED (see Findings §Deep-link probe).** `obsidian://open?vault=vault&file=<path-without-.md>` works: the WSLg-native Obsidian is registered as the `x-scheme-handler/obsidian` handler and receives the callback. Vault name is **`vault`** (folder basename; no custom name registered). Fallback (copy vault-relative path) is built into every page link for the Windows-browser case.
- [ ] **F4 residual (from M2, informational):** shared `wiki/**/_index.md` / `.vault-meta/address-counter.txt` can still cross-contaminate across concurrent ingests; content pages are cleanly per-ingest revertable. No M3 action unless the History tab's "created pages" needs it.

## 1. Backend: dashboard API (SPEC.md §6.5)

- [x] **`GET /api/v1/events` (SSE)** — `EventBus` (`pipeline/events.ts`); `JobStore` publishes `job` on transition + `log` on append, queue publishes `stats` on commit. Route `routes/events.ts` (hijacked raw stream, `retry:`, greeting, 15 s heartbeat, clean unsubscribe on `close`). Behind the auth middleware.
- [x] **`GET /api/v1/stats`** — `routes/stats.ts` + `pipeline/vault-stats.ts`: page counts by dir, 7-day KPIs (`store.countsSince`), git growth + last commits, recently-changed pages, hot cache, queue/watcher. 5 s TTL cache, invalidated on the bus `stats` event.
- [x] **`POST /api/v1/jobs/:id/retry`** — `queue.retryJob` (failed/deferred → queued, re-registers batch members); 404/409 handled. Emits SSE via the transition.
- [x] **`DELETE /api/v1/jobs/:id`** — cancels a `queued` job (→ `cancelled`); a running job returns 409 (never killed mid-write). Emits SSE via the transition.
- [x] **Static serving of the built frontend** — `@fastify/static` serves `web/dist`; SPA fallback to `index.html` for non-`/api/*` paths, JSON 404 for unknown API routes. One origin on `127.0.0.1:8420`.
- [~] Queue-reorder endpoint (§6.2 "Reihenfolge änderbar") — **deferred** (optional in M3). See Findings.

## 2. Frontend scaffold (SPEC.md §7)

- [x] Scaffold `web/`: **Vite + React + TS**, TanStack Query, SSE hook (`hooks/useEvents.ts`), responsive (mobile bottom-nav), **PWA** (manifest + `sw.js`). Hand-rolled CSS, no UI-framework lock-in.
- [x] App shell + **4-tab nav** (`App.tsx`). Query/Chat + Wartung are stub panels (`tabs/Stubs.tsx`), wired in M4.
- [x] Typed API client (`api/client.ts` + `api/types.ts`); TanStack Query for fetches; SSE hook invalidates queries + appends log lines (`lib/logStore.ts`).
- [x] Dev proxy `/api` → `:8420` (SSE-safe); `npm run build:web` → `web/dist`. Root scripts: `dev:server`, `dev:web`, `build:web`, `start`.

## 3. Tab "Übersicht" (SPEC.md §6.1)

- [x] Page counts per type from `/stats`; growth-over-time as an SVG chart (`components/GrowthChart.tsx`).
- [x] Recently created/changed pages — clickable `obsidian://` deep-links (`components/PageLink.tsx`, copy fallback).
- [x] Hot Cache (`wiki/hot.md`) rendered via a small safe markdown renderer (`components/Markdown.tsx`).
- [x] 7-day KPIs + service status (watcher, queue length, last commits). Live-updating via SSE query invalidation.

## 4. Tab "Ingestion" (SPEC.md §6.2) — the heart

- [x] **Dropzone** (`components/Dropzone.tsx`): files + URL/text, drop or paste → `POST /api/v1/jobs`; multi-file → batch; accepted/duplicate/error toast (size cap surfaces as 413 toast — see Findings).
- [x] **Aktiv:** running jobs with the live agent log stream (`components/JobLog.tsx` + `useJobLog`, seeded then SSE-appended). The DoD's "live log".
- [x] **Warteschlange:** queued jobs, cancel (DELETE). Reorder deferred (endpoint not built).
- [x] **Verlauf:** filter by status; per job: source, created pages (obsidian:// links), duration, tokens/cost; failed/deferred show error + **"Erneut versuchen"**; `deferred` has its own filter chip.

## 5. Acceptance (DoD)

- [x] Drop a file in the browser dropzone → **Aktiv** with a live SSE log → on completion moves to **Verlauf** with created-page links. **PASSED live 2026-07-17:** `Linseneintopf.pdf` dropped in the browser → 155 log lines streamed live via SSE → `done` after 47 turns → 9 created pages, commit `07493983 ingest: Linseneintopf.pdf`, Overview 94→96 pages with no manual refresh ($1.99 / 3.6M cache-heavy input tokens, shown in the UI).
- [x] Result page links **open in Obsidian** — obsidian:// handoff confirmed under WSLg (vault name `vault`); copy-path fallback for the Windows-browser case (§0 Findings).
- [x] Overview reflects new pages/counts without a manual refresh — SSE `stats`/`job` events invalidate the `['stats']`/`['jobs']` queries (wired + unit-covered; visually confirmed once the real run lands).
- [x] Whole app served from `127.0.0.1:8420` (one origin) — live-verified; responsive with a mobile bottom-nav.

## Findings

### Deep-link probe (§0, gates the DoD) — WORKS under WSLg, with a documented caveat

- Obsidian runs as a **native Linux app under WSLg** (`/usr/bin/obsidian`, `/opt/Obsidian`).
- The `obsidian://` scheme handler **is registered**: `xdg-mime query default x-scheme-handler/obsidian` → `obsidian.desktop`. A `xdg-open "obsidian://…"` (what a Linux/WSLg browser does on click) launches Obsidian, which logged `Received callback URL obsidian://open?vault=vault&file=wiki/concepts/Bank%20Resolution%20and%20Bail-in` — i.e. it accepted the deep-link and resolved the page. (A `GPU process isn't usable` FATAL appears in the log; that's a WSLg software-WebGL quirk, unrelated to the URL handoff, which completes before it.)
- **Vault name = `vault`.** `~/.config/obsidian/obsidian.json` registers `~/vault` with no explicit name, so Obsidian uses the folder basename. Exposed by the server as `stats.vaultName` (env override: `OBSIDIAN_VAULT_NAME`).
- **Link format:** `obsidian://open?vault=vault&file=<vault-relative path, WITHOUT .md, URL-encoded>`.
- **Caveat / boundary (CORRECTED after a live click 2026-07-17):** the deep-link only reaches the **WSLg Linux Obsidian** when the dashboard is opened in a **WSLg/Linux browser** (obsidian:// → `xdg-open` → the Linux app). If clicked from a **Windows** browser (via WSL localhost forwarding), Windows routes obsidian:// to **Windows Obsidian**, which then **fails to open the WSL vault** with exactly `EISDIR: illegal operation on a directory, watch '\\wsl.localhost\Ubuntu\home\benjamin\vault\'`. This is *not* a missing handler — it is the SPEC.md §3/§11 M0 finding: Windows Obsidian cannot watch a vault over the 9p `\\wsl$` share (Obsidian won't-fix). So the chosen setup stands: **run the WSLg Linux Obsidian and open the dashboard in a WSLg/Linux browser** for one-click links. **Mitigation for the Windows-browser case:** every page link ships a **copy-vault-path button** (paste into the WSLg Obsidian quick-switcher). Longer term this friction disappears if an in-dashboard page/graph viewer subsumes browsing (see M3 follow-up note below).

### Build/verify state (2026-07-17)

- **Backend:** event bus + SSE `/events`, `/stats`, `POST /jobs/:id/retry`, `DELETE /jobs/:id`, and `@fastify/static` SPA serving are done. `npm test` (server) = **183 passing** (added SSE/retry/cancel/stats/bus tests). Live-verified against the real `~/vault`: `/stats` returns 94 pages, real byDir counts, 8 commits, hot cache (29 KB); `/health`; SSE streams `retry:`+greeting+heartbeat; SPA + hashed assets + manifest + `sw.js` all served from `127.0.0.1:8420` with correct content-types; unknown `/api/*` → JSON 404; unknown non-API path → `index.html` (SPA fallback).
- **Frontend:** Vite+React+TS, TanStack Query, SSE hook, PWA (manifest + service worker), 4-tab shell (Übersicht/Ingestion live; Query/Chat + Wartung as stubs). `npm run build` + `tsc --noEmit` clean for both workspaces.
- **NOT yet exercised (user-gated):** a **real end-to-end ingest** (browser drop → real agent run → pages committed to `~/vault`). It spends tokens and writes to the vault, so it's left for the operator to run/authorize, matching the M1 pattern. Everything up to the agent boundary is verified; the SSE live-log path itself is covered by `api.test.ts`.

### How to run the dashboard

```
# 1) build the frontend (once, or after web/ changes)
npm run build:web
# 2) start the service (serves API + SPA on one origin)
VAULT_ROOT=~/vault npm start          # → http://127.0.0.1:8420
#   (dev with HMR instead: npm run dev:web  +  VAULT_ROOT=~/vault npm run dev:server)
```

Open `http://127.0.0.1:8420` in a **WSLg/Linux browser** for one-click obsidian:// links; a Windows browser works too but uses the copy-path fallback.

### Added after M3 sign-off (small, user-requested)

- **Clear history ("Verlauf leeren").** `DELETE /api/v1/jobs[?status=]` + `store.clearHistory()`. Removes at-rest jobs (done/failed/deferred/duplicate/cancelled); active jobs (queued/preprocessing/ingesting) are never touched, and the vault + created pages are untouched (operational rows only, hard rule 1). The UI button respects the active filter chip (clear all, or just "Fehler", etc.) with a confirm. `job_logs` cascade. Covered by an api test.

### M3 follow-up: in-dashboard page/graph viewer (roadmap candidate)

The obsidian:// cross-boundary friction (Windows browser → Windows Obsidian → EISDIR) and the WSLg graph-view GPU stutter (SPEC.md §11) both point the same way: a **read-only page + graph viewer inside the dashboard** would let the operator browse/inspect the wiki without the Obsidian app at all. The vault stays the source of truth (Obsidian-flavored markdown + wikilinks + git — the "backend format"); Obsidian-the-app becomes optional. Wikilinks are fully parseable, so a graph is tractable. **Not scoped in M0–M5** — flagged for a product decision / SPEC §12 extension.

### Deferred within M3 (noted, not blocking)

- **Queue-reorder endpoint** (§1, §6.2 "Reihenfolge änderbar") — explicitly optional in M3; not built. Cancel (DELETE) is in.
- **Upload size-cap feedback** is reactive: the client surfaces the server's 413 as an error toast rather than pre-checking the byte cap (the cap isn't exposed to the client). Fine for M3; could expose `maxUploadBytes` via `/health` later.
- **SSE under future `token` auth mode:** `EventSource` can't send a bearer header, so a query-param token would be needed. v1 ships only `local-single-user` (pass-through), so N/A now — noted in `routes/events.ts`.
