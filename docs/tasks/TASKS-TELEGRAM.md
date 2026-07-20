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

## 4. Completion notifications (`telegram/bot.ts` + `format.ts`) — DONE

- [x] EventBus subscription (`events` option, wired in main.ts): a `job` event with a `telegram:` notify_channel and status `done|failed|deferred` schedules a notification **one tick deferred, then re-reads the row** — the queue transitions `failed→queued` synchronously on auto-retry, so only the FINAL failure (retries exhausted) reaches the chat. `done` includes `created_pages` **titles only** (basename sans `.md`, deduped) — never paths, never content (§9); `failed` includes the error line + retry hint. *Two states from the original plan intentionally don't notify: `duplicate` never transitions (decided at creation — the router already answered it synchronously in §3), and `cancelled` is the user's own dashboard action.*
- [x] Batches notify ONCE, when the LAST member settles (`store.byBatch` — new — checked against `FINISHED_STATES`; straggler events deduped via a notified-set). One message: member lines with per-member status/error + union of page titles.
- [x] Restart safety: notify_channel is in the DB, so jobs finishing after a restart still notify. Accepted gaps, documented in code: no catch-up scan for transitions missed WHILE down, and `stop()` drops not-yet-fired notification timers.
- [x] `telegram/format.ts`: full MarkdownV2 escaping (all reserved chars, round-trip-tested), 4096 cap with truncation marker, title extraction. Sends use MarkdownV2 **with a plain-text fallback** — a notification lost to a formatting edge case is worse than an unformatted one.

## 5. Tests (client mocked, like agent runs) — DONE (landed with each module)

- [x] Router: allowlist drop (no reply calls at all), command dispatch, setup-mode refusal, oversize refusal, duplicate reply, album batching window + stop-flush, URL/text classification, staging cleanup. `telegram-bot.test.ts`.
- [x] Config: fail-closed guard (token without allowlist), non-numeric rejection, redaction in `describeConfig`, allowlist parsing. `config.test.ts` (§1).
- [x] Notifications: done → MarkdownV2 with titles only; final-failure vs auto-retry suppression; batch → single message on last-member settle with straggler dedupe; channel-less jobs silent. `telegram-bot.test.ts`.
- [x] Format: all reserved chars escaped (round-trip), 4096 truncation, outcome/batch messages. `telegram-format.test.ts`.
- [x] Client: backoff + resume, retry_after, permanent stop on 409/401, abort-prompt stop, offset acknowledgement, poisonous-update advance, download caps, token-leak guard. `telegram-client.test.ts` (§2).
- [x] `npm test` green: 411 tests across 33 files (was 336 pre-telegram).

## 6. Docs & live acceptance

- [x] README: new "Telegram bot (optional)" section (BotFather setup, numeric user id via @userinfobot, env entries, behavior + limits incl. 20 MB cap, album batching, titles-only notifications, single-poller caveat, setup mode); config table rows for both variables; Troubleshooting entry ("bot went silent": 409/401, fail-closed reminder); intro channel list + "what leaves the box" sentence updated (outbound polling of api.telegram.org). SECURITY.md: bot bullet under operational hardening (outbound-only, allowlist fail-closed + silent drop rationale, token handling, same file pipeline, titles-only messages).
- [ ] **Live acceptance — IN PROGRESS 2026-07-20.** Configured via the §7 settings UI (first attempt hit a stale server build — `dist/` predated the telegram work; `npm run build:server` + restart fixed it. Lesson: the systemd unit runs built JS, so BOTH builds must run before a live test, not just `build:web`). Migration v7 applied to the live DB on restart: `user_version 7`, all 238 job_logs rows intact (F1 fix held in production). Startup log redacts the token (`on <token redacted, 46 chars>, 1 allowlisted user(s)`).
  - [x] Bot configured via dashboard → self-restart → `/status` from the phone answers with queue/jobs/budget as expected (operator-confirmed)
  - [x] PDF from the phone → `done` + notification. Evidence: job `…DEPXBW` (source `telegram`, `notify_channel` persisted) → immediate "Queued …" reply at 09:07, ingest → `done` with 21 created/updated pages, ONE vault commit `e469a97 ingest: 01_Eichhorn_GMP_Grundlagen_final_online.pdf`, ~6.3M/51k tokens (≈$3.56 est.), no send error in the log. *Observation: `created_pages` includes the vault maintenance pages (`_index`, `index`, `hot`, `log`), which show up as noise "titles" in the message — candidate fix: filter them in format.ts (message only), pending user decision.*
  - [x] `/status` correct while a job runs — operator screenshot 09:07: `Queue: 1 running (concurrency 3)`, `Jobs: ingesting 1 · done 1`
  - [ ] Album of 2 photos → one batch, one combined run, one commit
  - [ ] Message from a second (non-allowlisted) account → nothing happens
  - [ ] Oversize file (> 20 MB) → hint reply, no job
  - [ ] Dev-instance-next-to-systemd double-poll → 409 log line, service keeps serving

## 7. Settings UI (added 2026-07-20, user request) — DONE

- [x] Spec: §4.3 amended — token + allowlist settable via dashboard, same rules as the §7.1 credential endpoint (write-only, restart activates, 409 on process-env shadowing / in-flight runs); both variables always written TOGETHER so the endpoint cannot produce the fail-closed startup state.
- [x] Server: `updateEnvFile` generalized from `writeCredentialFile` (set/remove keys, 0600, write-then-rename); `POST /api/v1/settings/telegram` (zod: token shape `\d+:[A-Za-z0-9_-]{20,}`, comma-separated numeric ids with a "not @usernames" message; normalizes id spacing) + `DELETE` (removes both = bot off); shared guard helper (process-env 409, in-flight 409) + shared systemd self-restart helper reused by the credential route; `GET /settings` readOnly gains `telegram: 'on (N allowlisted users)' | 'off'` — never the token. `api.test.ts` (7 new tests incl. token-echo and fail-closed-state checks).
- [x] Web: `TelegramSetup` card under Maintenance → Settings below the credential card (token as password field + ids field, save→restart toast→poll `/settings` until the restarted process reports the expected on/off status→reload; "Disable" with confirm); read-only status row "Telegram bot". Token cleared from component state after submit.

## Findings

**F1 — better-sqlite3 v12 enables `foreign_keys` at connection open; the v7 table rebuild cascade-wiped `job_logs`. Found via dry run, fixed.** Migration v7 must rebuild `jobs` (CHECK constraint change), and under FK enforcement `DROP TABLE` performs an implicit DELETE that fires `job_logs`' `ON DELETE CASCADE`. The planned mitigation — run migrations before `openDb` switches FK on — silently did nothing, because better-sqlite3 v12 (12.11.1) turns `foreign_keys` ON **at open**, not off as raw SQLite defaults; and the unit test masked it by setting the pragma itself. A dry run against a COPY of the live DB caught it: 238 `job_logs` rows gone. Fix: `openDb` explicitly sets `foreign_keys = OFF` before migrating and ON after; regression test now goes through `openDb`'s own path on a file DB. Lesson for future migrations: any migration that drops/rebuilds a referenced table MUST be dry-run against a live-DB copy before deploy — the in-memory fixtures don't reproduce the driver's connection defaults unless the test uses `openDb` end-to-end.
