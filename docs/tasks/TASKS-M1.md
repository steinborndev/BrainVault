# TASKS-M1 — Pipeline

Goal (SPEC.md §10): queue, preprocessing (PDF, Office, text, image, URL), agent runner with retry/timeout, dedupe, git commits. Acceptance: 10 mixed files in `.raw` all reach `done`; no vault corruption at concurrency 2.

Work top to bottom. Check off tasks as they complete. Record findings inline under "Findings".

## 0. Carried over from M0

These are open items from `TASKS-M0.md` — not new work, but they belong here rather than in M0.

- [ ] **Verify the language rule against a German or mixed-language source** (M0 task 5.3, never validated). The M0 PDF was English-only, so "English page names despite German source passages" was never exercised. Check: page/concept names in English, verbatim German quotes retained with a language note, and no de/en duplicate concept created (the canonical failure: a new "Zinseszins" page next to an existing "Compound Interest"). This is the one M0 acceptance item that is untested rather than passing.
- [ ] **Make the service commit after each successful job** (SPEC.md §3.1). The runner does not commit at all today; both M0 `ingest:` commits were made by hand. The vault's own auto-commit hook is now disabled via `.vault-meta/auto-commit.disabled`, so **right now nothing commits** — this is a real gap, not a nicety. Message format `ingest: <source>`, one commit per ingest (SPEC.md §9's revert-undo depends on it).
- [ ] **Confirm the auto-commit opt-out actually holds at runtime.** The flag is in place and the vault hook's own code reads it, but no ingest has run since it was created. Expect zero `wiki: auto-commit` commits on the next run.
- [ ] **Diagnose `scripts/detect-transport.sh`.** It hangs past its own 120 s timeout and never returns; the M0 agent fell back to the filesystem transport and continued. Anything that later depends on transport detection will inherit this stall.
- [ ] **Re-run `server/src/cli/permprobe.ts` after any SDK upgrade or permission-wiring change.** It is the only check that can catch "the SDK stopped consulting our guard" — unit tests structurally cannot. Expect `canary outside vault: blocked` and `claude-obsidian:wiki-ingest` present.

## 1. Spec corrections owed (M0 evidence, SPEC.md is authoritative so these need the user's sign-off)

- [ ] **SPEC.md §3.1 is wrong about skill loading.** It states `settingSources: ['project']` is what loads the claude-obsidian skills. It is not: the vault is a Claude Code *plugin* (`.claude-plugin/plugin.json`), its `skills/` directory is not a location the CLI scans, and with `settingSources` alone the agent saw only the CLI's bundled skills and improvised from `SKILL.md`. Correct mechanism: `plugins: [{ type: 'local', path: vaultRoot }]` + `skills: 'all'`. Measured impact of the fix: 143→55 turns, 12.7M→5.4M tokens, 13→15 pages.
- [ ] **SPEC.md §4.2 and §11.1 hardcode `/mnt/d`, which does not exist on this machine.** Watch-folder default `/mnt/d/inbox` and fallback `/mnt/d/vault`. Available drives: C (475 GB free), M (1.4 TB), T (772 GB); R and S are ≥98 % full. M2 needs a real default before the watcher is built.
- [ ] **SPEC.md §11.1's Obsidian risk is refuted as written.** It predicted 9p *slowness*; reality is that Obsidian for Windows cannot open a WSL vault at all (`EISDIR … watch`, won't-fix). Resolved by running Obsidian inside WSL via WSLg. Also: the section's locking concern is unfounded — `wiki-lock.sh` passes every test on drvfs.
- [ ] **CLAUDE.md hard rule 4 needs rewording.** "bash restricted to a whitelist of the vault's `scripts/*.sh`" is not what we do, and not what the ingest permits: 14 of 68 bash calls in the validated run were `find`/`ls`/`cat`/`python3`. Decided wording: vault-write scoping and no-web-egress are the hard guarantees (now OS-enforced via bubblewrap); the bash denylist is defense in depth.

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
