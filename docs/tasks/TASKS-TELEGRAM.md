# TASKS-TELEGRAM — Telegram bot channel (SPEC.md §4.3)

Goal (SPEC.md §4.3, amended 2026-07-20): a third input channel + status channel, primarily for the phone. **Acceptance: a PDF sent to the bot from the phone reaches `done` with zero further interaction and the bot replies with the created page titles; `/status` reports queue state; messages from senders outside the allowlist have no effect whatsoever.**

Post-M5 extension — the milestone gate does not apply, but the working agreement does: work top to bottom, check off as completed, record decisions under "Findings". Everything below runs through the EXISTING pipeline (`enqueueFile`/`enqueueUrl`/`enqueueBatch`); the bot must not grow a second ingestion path.

## 0. Spec amendment — DONE

- [x] §4.3 (channel), §8 (`source 'telegram'`, `jobs.notify_channel`), §9 (token/allowlist/egress/privacy), §12.3 (relation to the Tailnet+PWA path, `tailscale serve` preference). Committed alongside this task file.

## 1. Config & wiring

- [ ] `config.ts`: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` (comma-separated numeric IDs) in the zod schema, read from the merged env (file + process, same precedence as everything else). New optional `Config.telegram: { token, allowedUserIds }`.
- [ ] **Fail-closed guard (§4.3/§9):** token set but allowlist empty/unparsable ⇒ `ConfigError` at startup (mirror the double-credential guard). Neither value may ever appear in logs; `describeConfig` reports the token as `<redacted, N chars>` and the allowlist as a count.
- [ ] `db/jobs.ts`: extend `JobSource` with `'telegram'`. Migration **v7**: nullable `jobs.notify_channel` (`'telegram:<chat_id>'`). Losing the DB still cannot damage the vault — the column is operational state only (hard rule 1).
- [ ] `main.ts`: start the bot iff `config.telegram` is set, symmetric to the watcher; graceful shutdown stops the polling loop before the queue closes. The bot also starts in **setup mode** (reduced behavior, §4 below).

## 2. Bot API client (`telegram/client.ts`)

- [ ] Minimal hand-rolled client, `fetch`-based, no framework (decision recorded in §4.3): `getUpdates` (long poll, `timeout=50`, `allowed_updates=['message']`), `sendMessage`, `getFile` + file download. Typed results for exactly the fields we consume.
- [ ] Polling loop with error backoff (network errors: exponential, capped; resume automatically). **`409 Conflict` (second poller on the same token) stops the loop permanently** with a clear log line naming the likely cause (dev instance next to systemd) — the service itself keeps running.
- [ ] Download guard: check `file_size` from the message BEFORE `getFile`; > 20 MB (Bot API hard limit) ⇒ no download, reply with a hint pointing at dropzone/watch folder (§4.3). Downloads stream to the upload staging dir (`os.tmpdir()/vault-service-uploads`, same as the jobs route), never into the vault.
- [ ] The token appears in URLs (`/bot<token>/…`) — ensure no request URL is ever logged; log method names only.

## 3. Update router (`telegram/bot.ts`)

- [ ] **Allowlist guard first:** any update whose `from.id` is not allowlisted is dropped silently — no reply, no log above debug level (§9). Everything else is unreachable before this check.
- [ ] `/status`: setup mode flag, queue stats (`queue.stats()`), job counts (`store.counts()`), budget status — the health/stats data, formatted (§5).
- [ ] `/jobs`: last N jobs (id-prefix, name, status, relative time).
- [ ] Document/photo message: download (§2) → `queue.enqueueFile({ source: 'telegram', originalName })` (existing `sanitizeOriginalName` + magic-byte classification apply untouched) → immediate reply with job id; `duplicateOf` gets its own reply text. Persist `notify_channel = 'telegram:<chat_id>'` on the created job.
- [ ] Photos arrive as `photo` size arrays without filename — pick the largest size, synthesize a name (`photo-<ulid>.jpg`).
- [ ] **Album batching:** messages sharing a `media_group_id` are collected (quiet window, ~2 s — Telegram delivers album parts as separate updates) and enqueued via `enqueueBatch` as ONE batch, mirroring multi-drop §4.1.
- [ ] URL message → `enqueueUrl`; plain text → text job (same treatment as dropzone paste in `routes/jobs.ts`).
- [ ] **Setup mode:** `/status` answers with a "setup mode, no credential" notice; ingest attempts are rejected with the same hint (mirror of the jobs route's 503) — nothing is enqueued, because the queue would never claim it.

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

*(none yet)*
