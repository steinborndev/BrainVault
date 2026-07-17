# TASKS-M1 — Pipeline

Goal (SPEC.md §10): queue, preprocessing (PDF, Office, text, image, URL), agent runner with retry/timeout, dedupe, git commits. Acceptance: 10 mixed files in `.raw` all reach `done`; no vault corruption at concurrency 2.

Work top to bottom. Check off tasks as they complete. Record findings inline under "Findings".

## 0. Carried over from M0

These are open items from `TASKS-M0.md` — not new work, but they belong here rather than in M0.

- [x] ~~Verify the language rule against a German or mixed-language source~~ — **DONE in M0** via the German Sparkassen/DekaBank PDF (`046edec`). English concept names, German terms as aliases, proper nouns kept German, quotes with notes. See TASKS-M0.md §5.3.
- [ ] **Make the service commit after each successful job** (SPEC.md §3.1). The runner does not commit at all today; all three M0 `ingest:` commits were made by hand. The vault's own auto-commit hook is now disabled via `.vault-meta/auto-commit.disabled`, so **right now nothing commits** — this is a real gap, not a nicety. Message format `ingest: <source>`, one commit per ingest (SPEC.md §9's revert-undo depends on it).
- [x] ~~Confirm the auto-commit opt-out actually holds at runtime~~ — **DONE.** The German ingest ran with the flag in place and produced **0** `wiki: auto-commit` commits (in fact 0 commits at all). Opt-out confirmed working.
- [ ] **Diagnose `scripts/detect-transport.sh`.** It hangs past its own 120 s timeout and never returns; the M0 agent fell back to the filesystem transport and continued. Anything that later depends on transport detection will inherit this stall.
- [ ] **Re-run `server/src/cli/permprobe.ts` after any SDK upgrade or permission-wiring change.** It is the only check that can catch "the SDK stopped consulting our guard" — unit tests structurally cannot. Expect `canary outside vault: blocked` and `claude-obsidian:wiki-ingest` present.

## 1. Spec corrections owed — APPLIED 2026-07-17 (user-approved)

All four corrections are done and committed to `SPEC.md`/`CLAUDE.md`. Kept here for the record.

- [x] **SPEC.md §3.1 + §7 table: skill loading.** Corrected: the vault is a Claude Code plugin; `settingSources: ['project']` loads only its CLAUDE.md — skills need `plugins: [{ type: 'local', path: vaultRoot }]` + `skills: 'all'`. Measured impact: 143→55 turns.
- [x] **SPEC.md §3, §4.2: `/mnt/d` does not exist** (C/M/T available). Watch-folder default corrected to `/mnt/c/inbox`.
- [x] **SPEC.md §3 note + §11.1: Obsidian over `\\wsl$` does not open at all** (`EISDIR … watch`, won't-fix), not merely "slow". Resolved via Obsidian-in-WSLg. Locking concern on drvfs is unfounded.
- [x] **CLAUDE.md hard rule 4 reworded** to match reality: OS-sandbox-enforced write scoping; `canUseTool` is not consulted (enforcement is PreToolUse hook + sandbox with `allowUnsandboxedCommands: false`); bash denylist is defense in depth, not a `scripts/*.sh` whitelist. Points at `permprobe.ts`.

## 2. Queue and job lifecycle

- [ ] SQLite schema per SPEC.md §8 (`jobs`, `job_logs`, `sessions`, `messages`, `settings`, `users`), migrations, `user_id` on every new table
- [ ] Job states exactly `queued | preprocessing | ingesting | done | failed | deferred | duplicate | cancelled`; log every transition to `job_logs`
- [ ] Worker pool, default concurrency 2 (SPEC.md §3.1)
- [ ] Retry: max 2 automatic retries on transient errors (API error, timeout), then `failed` with details
- [ ] Dedupe by SHA-256 against `jobs.sha256` → `duplicate`
- [ ] Rate-limit handling: pause the queue on a usage-limit signal, auto-resume (SPEC.md §7.1). **Relevant now** — SDK runs draw from the subscription's shared limits, and one ingest cost 5.4M input tokens.
- [ ] Persist the agent stream to `job_logs` (the runner already exposes an `onMessage` sink for exactly this)

## 3. Preprocessing plugin chain

- [ ] `detect → normalize → manifest` chain; new types are plugins, never special cases in the core
- [ ] **Install the toolchain — none of it is present yet:** `pdftotext` (poppler-utils), `ocrmypdf`/tesseract (deu+eng), `pandoc`, `defuddle-cli`, `exiftool`
- [ ] PDF: text extraction; OCR fallback when yield < 100 chars/page
- [ ] Office (docx/pptx/xlsx), web/URL, image (EXIF + pass image to the agent), markdown/text passthrough
- [ ] Audio/video → `.raw/deferred/`, status `deferred`
- [ ] Magic-byte check against disguised executables; archives not auto-extracted (CLAUDE.md hard rule 6)

## 4. Concurrency safety

- [ ] 10 mixed files in `.raw` → all reach `done`
- [ ] No vault corruption at concurrency 2 — `wiki-lock.sh` is verified sound on both ext4 and drvfs (M0), but has not been exercised under real parallel agent runs
- [ ] Explicitly test manual Claude Code use in the vault while the pipeline runs (SPEC.md §11.5)

## Findings

- (M1 findings go here)
