# TASKS-TELEGRAM — Telegram bot channel (SPEC.md §4.3)

Goal (SPEC.md §4.3, amended 2026-07-20): a third input channel + status channel, primarily for the phone. **Acceptance: a PDF sent to the bot from the phone reaches `done` with zero further interaction and the bot replies with the created page titles; `/status` reports queue state; messages from senders outside the allowlist have no effect whatsoever.**

Post-M5 extension — the milestone gate does not apply, but the working agreement does: work top to bottom, check off as completed, record decisions under "Findings". Everything below runs through the EXISTING pipeline (`enqueueFile`/`enqueueUrl`/`enqueueBatch`); the bot must not grow a second ingestion path.

## 0. Spec amendment — DONE

- [x] §4.3 (channel), §8 (`source 'telegram'`, `jobs.notify_channel`), §9 (token/allowlist/egress/privacy), §12.3 (relation to the Tailnet+PWA path, `tailscale serve` preference). Committed alongside this task file.

## 1. Config & wiring

- [x] `config.ts`: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` (comma-separated numeric IDs) in the zod schema, read from the merged env (file + process, same precedence as everything else). New `Config.telegram: TelegramConfig | null` (`{ botToken, allowedUserIds }`).
- [x] **Fail-closed guard (§4.3/§9):** token set but allowlist empty/unparsable ⇒ `ConfigError` at startup (mirror the double-credential guard); non-numeric entries (usernames) rejected explicitly. `describeConfig` reports `<token redacted, N chars>` + allowlist count; allowlist WITHOUT token is inert (bot off, no error). `config.test.ts`.
- [x] `db/jobs.ts`: `JobSource` + `'telegram'` (also `web/src/api/types.ts`); `CreateJobInput.notifyChannel` persisted at create. Migration **v7**: nullable `jobs.notify_channel` — a full `jobs` TABLE REBUILD, because the v1 `source` CHECK constraint lists the allowed values and SQLite cannot alter a CHECK in place (see F1 below). Verified against a copy of the live DB: v6→v7, all rows + 238 job_logs preserved, `foreign_key_check` clean. `db.test.ts`.
- [x] `main.ts`: bot starts iff `config.telegram` is set (also in setup mode — `/status` answers there, ingests refuse), after `listen` so it logs through the app logger; budget provider shares the same `budgetStatus` module as queue + stats route. Shutdown stops the bot FIRST so no new updates reach a draining queue. `RunningService.telegram` exposed. *(Landed with §3.)*

## 2. Bot API client (`telegram/client.ts`) — DONE

- [x] Minimal hand-rolled client, `fetch`-based, no framework (decision recorded in §4.3): `getUpdates` (long poll, `timeout=50`, `allowed_updates=['message']`), `sendMessage` (link previews disabled), `getFile` + file download. Typed wire objects carry exactly the fields we consume. `fetchImpl`/`apiBase` injectable for tests.
- [x] Polling loop (`startPolling`) with exponential backoff (1 s → 60 s cap, resets on success), `retry_after` honoured on 429. **`409 Conflict` stops the loop permanently** with a log line naming the likely cause (dev instance next to systemd); same for `401` (bad token). The service keeps running. A throwing update handler is logged and the offset still advances — one poisonous update cannot wedge the loop. `stop()` aborts a hanging long poll promptly (abort-aware sleep + AbortController through fetch).
- [x] Download cap: `downloadFile` enforces the 20 MB Bot API limit twice — on `Content-Length` when present, and on actually received bytes (Telegram serves without the header too); an oversize download leaves no partial file (bounded in-memory buffering, write-on-complete). *The polite pre-check against `message.document.file_size` + the hint reply is router work (§3), where the message context lives.* `destDir` is a parameter; the router passes the upload staging dir.
- [x] Token never in logs/errors: all errors carry the METHOD NAME only, never a URL; explicit test asserts no token/URL leak across api/network/non-JSON failure paths. `telegram-client.test.ts` (15 tests).

## 3. Update router (`telegram/bot.ts`) — DONE

- [x] **Allowlist guard first:** any update without a `from.id`, or with one outside the allowlist, is dropped silently — no reply, no log (§9). Everything else is unreachable before this check.
- [x] `/status`: setup-mode flag, queue stats, job counts, budget (provider injected from main — same `budgetStatus` module as queue/stats route). `/start`+`/help`+unknown commands → help text. Replies are deliberately PLAIN TEXT (no parse_mode): job/file names are user content, and without MarkdownV2 there is nothing to escape — MarkdownV2 + escaping arrive with `format.ts` in §4 where page titles appear.
- [x] `/jobs`: last 8 jobs (status, name/url, id suffix).
- [x] Document/photo: polite pre-check on DECLARED `file_size` (> 20 MB ⇒ hint reply naming dropzone/watch folder, no `getFile` call; client cap stays the hard backstop) → download to the shared upload staging dir → `enqueueFile({ source: 'telegram', notifyChannel: 'telegram:<chat_id>' })` (existing `sanitizeOriginalName` + magic-byte classification untouched) → reply with job id; `duplicateOf` gets its own reply. Staging file removed after enqueue (queue copies into `.raw/`), mirroring the jobs route.
- [x] Photos: largest `photo` size wins, name synthesized (`photo-<suffix>.jpg`).
- [x] **Album batching:** members sharing a `media_group_id` are downloaded on arrival and collected per `(chat, group)`; the quiet window (default 2 s) resets per member; flush → ONE `enqueueBatch(…, 'telegram', { notifyChannel })` + ONE reply. `stop()` flushes pending albums instead of dropping already-downloaded members.
- [x] Lone URL → `enqueueUrl`; plain text → staged `telegram-note-*.md` file job (same treatment as dropzone paste).
- [x] **Setup mode:** `/status` reports it; every ingest path is gated with the guidance reply BEFORE any download — nothing is enqueued (the queue would never claim it).
- [x] Queue plumbing: `enqueueFile`/`enqueueBatch`/`enqueueUrl` accept and persist `notifyChannel` (opt-in, NULL otherwise). `queue.test.ts`; router covered by `telegram-bot.test.ts` (15 tests).

## 4. Completion notifications (`telegram/bot.ts` + `format.ts`)

- [ ] Subscribe to the EventBus job events; on a terminal transition (`done|failed|deferred|duplicate`) of a job with a `telegram:` notify_channel, send the outcome to that chat. `done` includes the `created_pages` **titles only — never content excerpts** (§9). `failed` includes the error line.
- [ ] Batch members notify once per batch (one message listing members + pages), not once per member.
- [ ] Restart safety: notify_channel is in the DB, so jobs that finish after a service restart still notify (the EventBus emits on transition; no catch-up scan for transitions missed WHILE down — accepted gap, note in Findings if it bites).
- [ ] `telegram/format.ts`: MarkdownV2 escaping (Telegram's escaping rules are strict — every `.`/`-`/`(` etc.), message length cap 4096 with truncation.

## 5. Tests (client mocked, like agent runs)

- [ ] Router: allowlist drop (no reply calls at all), command dispatch, setup-mode refusal, oversize refusal, duplicate reply, album batching window, URL/text classification.
- [ ] Config: fail-closed guard (token without allowlist), redaction in `describeConfig`, allowlist parsing.
- [ ] Notifications: terminal-transition → sendMessage with titles only; batch → single message; non-telegram jobs → no send.
- [ ] Format: MarkdownV2 escaping property cases, 4096 truncation.
- [ ] Client: backoff on network error, permanent stop on 409 (fake fetch).
- [ ] `npm test` green before calling this done.

## 6. Docs & live acceptance

- [ ] README section: BotFather setup (create bot, get token), finding your numeric user ID, env file entries, single-poller caveat (dev vs systemd).
- [ ] Live acceptance (record evidence here): PDF from the phone → `done` + notification with page titles; `/status` correct while a job runs; album of 2 photos → one batch, one combined run, one commit; message from a second (non-allowlisted) account → nothing happens, nothing logged above debug; oversize file → hint reply, no job.

## Findings

**F1 — better-sqlite3 v12 enables `foreign_keys` at connection open; the v7 table rebuild cascade-wiped `job_logs`. Found via dry run, fixed.** Migration v7 must rebuild `jobs` (CHECK constraint change), and under FK enforcement `DROP TABLE` performs an implicit DELETE that fires `job_logs`' `ON DELETE CASCADE`. The planned mitigation — run migrations before `openDb` switches FK on — silently did nothing, because better-sqlite3 v12 (12.11.1) turns `foreign_keys` ON **at open**, not off as raw SQLite defaults; and the unit test masked it by setting the pragma itself. A dry run against a COPY of the live DB caught it: 238 `job_logs` rows gone. Fix: `openDb` explicitly sets `foreign_keys = OFF` before migrating and ON after; regression test now goes through `openDb`'s own path on a file DB. Lesson for future migrations: any migration that drops/rebuilds a referenced table MUST be dry-run against a live-DB copy before deploy — the in-memory fixtures don't reproduce the driver's connection defaults unless the test uses `openDb` end-to-end.
