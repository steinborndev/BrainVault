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

- [ ] **Obsidian deep-link risk probe (do this EARLY — it gates the DoD).** The DoD requires result links to "open in Obsidian". Links are `obsidian://open?vault=<name>&file=<path>`. Obsidian here runs under **WSLg** (see memory: env-gotchas), and the dashboard opens in a browser. Confirm an `obsidian://` link actually launches the WSLg Obsidian and opens the page. If the protocol handler isn't wired across the WSLg/Windows boundary, document the finding and the fallback (e.g. `vault:`-relative path shown + copy button, or a file:// path). Determine the vault name Obsidian uses for `~/vault`.
- [ ] **F4 residual (from M2, informational):** shared `wiki/**/_index.md` / `.vault-meta/address-counter.txt` can still cross-contaminate across concurrent ingests; content pages are cleanly per-ingest revertable. No M3 action unless the History tab's "created pages" needs it.

## 1. Backend: dashboard API (SPEC.md §6.5)

- [ ] **`GET /api/v1/events` (SSE)** — the spine of the live UI: job state transitions, per-job log-line stream, and a "stats changed" signal. Add an event bus the `JobStore`/`IngestQueue` publish to on every transition + `job_logs` append; the SSE route subscribes and writes `text/event-stream`. Keep the localhost/auth middleware in front. Heartbeat/keep-alive; clean unsubscribe on disconnect.
- [ ] **`GET /api/v1/stats`** — Overview numbers: page counts by type (count `wiki/concepts|entities|sources/*.md` on disk, cached with a short TTL / invalidate on commit), 7-day metrics (ingests, failures, sources) from `jobs`, growth over time from git history (`git log` on the vault), last commits, watcher-active + queue length.
- [ ] **`POST /api/v1/jobs/:id/retry`** — re-queue a `failed` job (reset to `queued`; the runner already retries transient errors, this is the manual path). Emits an SSE update.
- [ ] **`DELETE /api/v1/jobs/:id`** — cancel a `queued` job (→ `cancelled`) or remove from queue; don't kill a running agent mid-write (or do so safely). Emits an SSE update.
- [ ] **Static serving of the built frontend** — serve `web/dist` from the same Fastify process at `/` (SPA fallback to `index.html`), so the whole app is one origin on `127.0.0.1:8420`. Use `@fastify/static`.
- [ ] Queue-reorder endpoint (§6.2 "Reihenfolge änderbar") — optional in M3; can defer if time-boxed (note it).

## 2. Frontend scaffold (SPEC.md §7)

- [ ] Scaffold `web/`: **Vite + React + TypeScript**, TanStack Query, an SSE client hook, responsive from the start (mobile viewports), **PWA-ready** (manifest + installable). No UI-framework lock-in (SPEC.md §7).
- [ ] App shell + **4-tab nav** (Übersicht, Ingestion, Query/Chat, Wartung). Query/Chat + Wartung are **stub panels** in M3 (placeholder text), wired in M4.
- [ ] API client + typed models shared with the server where practical; TanStack Query for fetches, the SSE hook for live invalidation (subscribe to `/events`, invalidate the relevant queries / append log lines).
- [ ] Dev ergonomics: Vite dev proxy to `:8420` for `/api`; `npm run build` outputs to `web/dist` for the server to serve. Add root scripts if helpful.

## 3. Tab "Übersicht" (SPEC.md §6.1)

- [ ] Page counts per type (Konzepte/Entities/Quellen) from `/stats`; growth-over-time (git history) as a small chart.
- [ ] Recently created/changed pages — **clickable `obsidian://` deep-links** (see §0 probe).
- [ ] Hot Cache (`wiki/hot.md`) rendered as markdown.
- [ ] 7-day KPIs (ingests, errors, sources); service status (watcher active, queue length, last git commits). Live-updating via SSE.

## 4. Tab "Ingestion" (SPEC.md §6.2) — the heart

- [ ] **Dropzone** (files + URLs; drop or paste a URL) → `POST /api/v1/jobs`. Multi-file drop → batch (backend already groups). Show accepted/rejected + size cap feedback.
- [ ] **Aktiv:** running jobs with the **live agent log stream** (SSE per-job log lines). This is the DoD's "live log".
- [ ] **Warteschlange:** queued jobs, cancel (DELETE); reorder if the endpoint lands.
- [ ] **Verlauf:** filter by status/type/time; per job show source, created/updated wiki pages (as obsidian:// links), duration, token/cost estimate (from `jobs` usage columns). Failed jobs show the error + **"Erneut versuchen"** (retry). `deferred` jobs (audio/video) as their own visible category.

## 5. Acceptance (DoD)

- [ ] Drop a file in the browser dropzone → job appears in **Aktiv** with a **live log** streaming via SSE → on completion it moves to **Verlauf** with links to the created pages.
- [ ] The result page links **open the pages in Obsidian** (obsidian:// deep-link, per the §0 probe — or the documented fallback).
- [ ] Overview reflects the new pages/counts without a manual refresh (SSE invalidation).
- [ ] Whole app served from `127.0.0.1:8420` (one origin), responsive on a mobile viewport.

## Findings

- (M3 findings go here)
