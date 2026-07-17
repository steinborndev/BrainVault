# TASKS-M1 — Pipeline

Goal (SPEC.md §10): queue, preprocessing (PDF, Office, text, image, URL), agent runner with retry/timeout, dedupe, git commits. Acceptance: 10 mixed files in `.raw` all reach `done`; no vault corruption at concurrency 2.

Work top to bottom. Check off tasks as they complete. Record findings inline under "Findings".

## 0. Carried over from M0

These are open items from `TASKS-M0.md` — not new work, but they belong here rather than in M0.

- [x] ~~Verify the language rule against a German or mixed-language source~~ — **DONE in M0** via the German Sparkassen/DekaBank PDF (`046edec`). English concept names, German terms as aliases, proper nouns kept German, quotes with notes. See TASKS-M0.md §5.3.
- [x] **Make the service commit after each successful job** (SPEC.md §3.1). **DONE** — `server/src/pipeline/git.ts` + `IngestQueue.commitStep`. One commit per successful ingest, message `ingest: <source>`, authored `vault-service <vault-service@localhost>` (matching the M0 hand-made commits). Serialized behind a mutex so concurrency-2 workers don't interleave staged changes. See Finding F3/F4.
- [x] ~~Confirm the auto-commit opt-out actually holds at runtime~~ — **DONE.** The German ingest ran with the flag in place and produced **0** `wiki: auto-commit` commits (in fact 0 commits at all). Opt-out confirmed working.
- [x] **Diagnose `scripts/detect-transport.sh`.** **DONE — root cause found and fixed.** See Finding F1.
- [x] **Re-run `server/src/cli/permprobe.ts`.** **DONE (2026-07-17), passes:** `canary outside vault: blocked` (blocked by the bubblewrap sandbox — "Read-only file system"), `claude-obsidian:wiki-ingest` present as a plugin-scoped skill, 0 hook denials (as expected — the sandbox contains Bash, not the hook). Enforcement intact after all M1 changes. `npm run permprobe` added.

## 1. Spec corrections owed — APPLIED 2026-07-17 (user-approved)

All four corrections are done and committed to `SPEC.md`/`CLAUDE.md`. Kept here for the record.

- [x] **SPEC.md §3.1 + §7 table: skill loading.** Corrected: the vault is a Claude Code plugin; `settingSources: ['project']` loads only its CLAUDE.md — skills need `plugins: [{ type: 'local', path: vaultRoot }]` + `skills: 'all'`. Measured impact: 143→55 turns.
- [x] **SPEC.md §3, §4.2: `/mnt/d` does not exist** (C/M/T available). Watch-folder default corrected to `/mnt/c/inbox`.
- [x] **SPEC.md §3 note + §11.1: Obsidian over `\\wsl$` does not open at all** (`EISDIR … watch`, won't-fix), not merely "slow". Resolved via Obsidian-in-WSLg. Locking concern on drvfs is unfounded.
- [x] **CLAUDE.md hard rule 4 reworded** to match reality: OS-sandbox-enforced write scoping; `canUseTool` is not consulted (enforcement is PreToolUse hook + sandbox with `allowUnsandboxedCommands: false`); bash denylist is defense in depth, not a `scripts/*.sh` whitelist. Points at `permprobe.ts`.

## 2. Queue and job lifecycle

- [x] SQLite schema per SPEC.md §8 (`jobs`, `job_logs`, `sessions`, `messages`, `settings`, `users`), migrations, `user_id` on every new table — `server/src/db/{migrations,index,jobs}.ts`. CHECK constraints encode the state/source/type enums; DB defaults **outside** the vault (hard rule 1). `db.test.ts`.
- [x] Job states exactly `queued | preprocessing | ingesting | done | failed | deferred | duplicate | cancelled`; log every transition to `job_logs` — `JobStore.transition` validates against a transition map and writes the log line in the same SQLite transaction. `jobs.test.ts`.
- [x] Worker pool, default concurrency 2 (SPEC.md §3.1) — `IngestQueue`, `claimNextQueued` claims atomically so two workers can't double-claim. Proven at concurrency 2 (`queue.test.ts`, `queue-integration.test.ts`).
- [x] Retry: max 2 automatic retries on transient errors (API error, timeout), then `failed` with details — `classifyFailure` + retry loop; initial + 2 retries = 3 attempts max.
- [x] Dedupe by SHA-256 against `jobs.sha256` → `duplicate` — duplicate rows kept visible; the first job owns the UNIQUE hash, dupes store `sha256 = NULL` and point at the original in a log line.
- [x] Rate-limit handling: pause the queue on a usage-limit signal, auto-resume (SPEC.md §7.1) — `pauseForRateLimit` + timer resume; a pause **refunds** the attempt so it doesn't burn a retry.
- [x] Persist the agent stream to `job_logs` — `onMessage` → `formatMessage` → `job_logs` (shared with the CLI).

## 3. Preprocessing plugin chain

- [x] `detect → normalize → manifest` chain; new types are plugins, never special cases in the core — `server/src/pipeline/preprocess/`. The core (`index.ts`) never names a type. `preprocess.test.ts`, `web-preprocess.test.ts`.
- [~] **Install the toolchain.** Split by privilege: **installed now** (no sudo) — `python-pptx`/`openpyxl`/`odfpy` (pip) for the office extractor, and `defuddle` (npm) for URL extraction. **Still missing (needs sudo apt):** `pdftotext`/`pdfinfo` (poppler-utils), `ocrmypdf` + tesseract (deu+eng), `pandoc`, `exiftool`. Run **`scripts/install-preprocessing-tools.sh`** (prompts for sudo). Until then, PDF/Office-docx/image-EXIF jobs fail with a clear "tool not installed" error; text/markdown/pptx/xlsx/URL jobs already work. See Finding F2.
- [x] PDF: text extraction; OCR fallback when yield < 100 chars/page — `plugins/pdf.ts` (requires pdftotext at runtime; OCR optional).
- [x] Office (docx/pptx/xlsx), web/URL, image (EXIF + pass image to the agent), markdown/text passthrough — `plugins/{office,image,text}.ts`, `web.ts` (URL, with egress hygiene: http/https only, SSRF guard, size cap, per-hop redirect re-validation).
- [x] Audio/video → `.raw/deferred/`, status `deferred` — `plugins/deferred.ts` + `IngestQueue.deferJob`.
- [x] Magic-byte check against disguised executables; archives not auto-extracted (CLAUDE.md hard rule 6) — `detect.assertNotExecutable` runs before any plugin (ELF/PE/Mach-O/Java); `.zip` → deferred, never extracted.

## 4. Concurrency safety

- [x] 10 mixed files → all reach `done` — **proven deterministically** in `queue-integration.test.ts` (10 files, concurrency 2, real git vault + real preprocessing + real commits, faked agent). The **real end-to-end run** (actual agent, full toolchain) is **user-gated**: `npm run pipeline -- <dir>` — needs the sudo toolchain (F2) + token budget (~5.4M input tok/ingest, shared subscription limits). See Finding F5.
- [x] No vault corruption at concurrency 2 — integration test asserts working tree clean (nothing lost), all pages in HEAD, **`git fsck` clean**, commits authored by `vault-service`. `created_pages` attribution made exact by reading it back from each commit (F3).
- [ ] Explicitly test manual Claude Code use in the vault while the pipeline runs (SPEC.md §11.5) — **OPEN**, deferred to the real run. The mechanism is the vault's per-file `wiki-lock.sh` (M0-verified sound on ext4 + drvfs); this test exercises it under real parallel agents, which only the user-gated end-to-end run does.

## Findings

**F1 — `detect-transport.sh` hang: root cause + fix.** The script hangs because `/usr/bin/obsidian` exists on this host (Obsidian via WSLg) and the script's CLI-detection block runs `obsidian --version` (line ~134); the Electron GUI ignores `--version` and launches a window instead of exiting, so the guard `if obsidian --version` never returns (confirmed: `timeout 8 obsidian --version` → exit 124). **Fix (no vault-code change, honouring hard rule 5):** the script's *freshness check* (line ~108) `cat`s an existing `<7d` `transport.json` and `exit 0`s **before** the CLI-detection block ever runs. `.vault-meta/transport.json` was simply **absent**, so every call fell through to the hang. Wrote a pinned `.vault-meta/transport.json` (`manual_override: true`, `preferred: filesystem` — correct for a headless service with no obsidian-cli). Verified: `detect-transport.sh` now returns exit 0 in <1s. `transport.json` is gitignored/host-specific, so this is config, not a repo-internals edit. **Caveat:** the pin goes stale after 7 days (mtime), after which a write-mode call would hang again — the M2 service setup should `touch` it on start, or upstream claude-obsidian should wrap the `obsidian --version` call in `timeout`. Flag for the user.

**F2 — toolchain install is privilege-split.** See §3. The apt half needs sudo and could not be installed non-interactively; `scripts/install-preprocessing-tools.sh` does it. Also corrected: the URL extractor package is now `defuddle` (the old `defuddle-cli` merged into it); binary is `defuddle`, CLI verified (`defuddle parse <file> --md`).

**F3 — `created_pages` attribution under concurrency.** First cut computed changed pages from a pre-commit `git status` snapshot; under concurrency `git add -A` can sweep in a page written *after* the snapshot, so a page could be committed with no job recording it. Fixed: `commitVault` reads `committedPages` back from the commit itself (`git show --name-only HEAD`). Every page is committed exactly once, so the union of `committedPages` across jobs attributes every page exactly once — verified in the integration test.

**F4 — shared-commit-under-mutex (known M1 limitation).** Commits are serialized by a mutex. When two jobs finish within the same commit window, the first job's `git add -A` may include the second's pages, so occasionally two ingests share one commit and the swept job's own commit is empty (recorded as "not committed" in its log). No page is ever lost and `git fsck` stays clean; only per-ingest commit *granularity* is best-effort at concurrency 2. Tightening this (commit only a job's own paths) is deferred — the per-file `wiki-lock.sh` already prevents actual page corruption.

**F5 — hot-cache refresh: note-only in M1 (CONFIRMED by user 2026-07-17).** SPEC.md §3.1 lists a per-job hot-cache refresh. M0 evidence shows the `wiki-ingest` skill *already* maintains `wiki/hot.md` as part of the ingest (M0 acceptance: "hot cache correct"). Running a *separate* refresh pass would be a second expensive agent run per job for no proven benefit. `refreshHotCache` is an injectable hook that defaults to a log note; M4 ("hot-cache refresh triggerable") can wire a real cheap trigger if one exists. User confirmed keeping the no-op hook.

**Next action (user-gated, agreed 2026-07-17):** user runs `scripts/install-preprocessing-tools.sh` (sudo); then the real 10-file end-to-end run is triggered to close M1. Until then M1 is **not** closed.
