# TASKS-M0 — Foundation

Goal (SPEC.md §10): a single PDF is ingested correctly (wiki pages + index + hot cache) via a CLI trigger of the service, and both M0 risk probes are documented. No dashboard, no watcher, no queue yet.

Work top to bottom. Check off tasks as they complete. Record findings inline under "Findings".

## 0. Environment sanity check

- [x] Verify WSL2 distro (Ubuntu 24.04 recommended): `lsb_release -a`, `uname -r` — Ubuntu 24.04.3 LTS (noble), kernel 6.6.87.2-microsoft-standard-WSL2 ✅
- [x] Node ≥ 20 via nvm: `node -v`; git present in the distro: `git --version` — git 2.43.0 ✅; nvm 0.40.1 + Node v20.20.2 / npm 10.8.2 installed ✅ (see PATH caveat under Findings)
- [x] Verify current Anthropic policy on Agent SDK use with subscriptions (SPEC.md §7.1 policy caveat): check https://support.claude.com/en/articles/15036540 and note the status under Findings

## 1. Vault setup

- [x] `git clone https://github.com/AgriciDaniel/claude-obsidian ~/vault` (pin: record the cloned commit/tag under Findings) — cloned, pinned to tag `v1.9.2` on branch `vault-main`
- [x] `cd ~/vault && bash bin/setup-vault.sh` — ran clean; created `.raw/`, `wiki/{concepts,entities,sources,meta}`, `_templates/`, wrote `.obsidian/{graph,app,appearance}.json`, downloaded Excalidraw `main.js` (~8 MB, gitignored)
- [x] Confirm Generic mode is active (`.vault-meta/mode.json` absent or `generic`); do NOT run `setup-mode.sh` — `mode.json` absent ⇒ Generic ✅; `setup-mode.sh` NOT run
- [x] Initialize/verify git in the vault; make a baseline commit — git came with the clone; baseline commit `7c0acde` ("chore: baseline after setup-vault.sh"), tree clean
- [x] ~~Open the vault in Obsidian for Windows via `\\wsl$\<distro>\home\<user>\vault`~~ — **impossible, see risk probe A.** Superseded by the decision below: Obsidian runs *inside* WSL via WSLg, opening `/home/benjamin/vault` as a local path. Task rewritten accordingly:
- [ ] Open the vault in **Obsidian for Linux inside WSL (WSLg)** at `/home/benjamin/vault`

### Risk probe A — Obsidian over \\wsl$

- [x] With the seeded vault open: measure app start, graph view open, note open/edit latency; then copy ~200 dummy .md files in and re-check — **not measurable: Obsidian never loads the vault at all** (hard error, not slowness). No latency numbers exist to collect; the 200-file step was moot.
- [x] Verdict under Findings: acceptable / borderline / unusable. If unusable, evaluate fallback `/mnt/d/vault` incl. a `wiki-lock.sh` locking test on drvfs (SPEC.md §3, §11.1) — **verdict: UNUSABLE**. Fallback evaluated; `wiki-lock.sh` passes all tests on drvfs. **Decision needed — see Findings.**

## 2. Authentication

- [x] Install Claude Code CLI in WSL if absent — installed via `npm i -g @anthropic-ai/claude-code` under nvm (**no sudo needed**), version 2.1.197 ✅
- [ ] run `claude setup-token` — **needs the user** (interactive browser OAuth flow)
- [x] Store token as `CLAUDE_CODE_OAUTH_TOKEN` in `~/.config/vault-service/env` (chmod 600) — file scaffolded, `chmod 600`, dir `chmod 700`; **token value still to be filled by the user** (see Findings)
- [x] ensure `ANTHROPIC_API_KEY` is NOT set in the environment — verified: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` are all unset, and no shell rc file references either ✅
- [ ] Smoke test: minimal Agent SDK script (`query()` with a trivial prompt) runs and returns a result — blocked on the token

## 3. Service repo scaffold

- [ ] Initialize this repo per the layout in CLAUDE.md (server/, web/ placeholder, docs/tasks/, scripts/)
- [ ] TypeScript strict + ESM config, vitest, eslint; `npm test` runs (empty suite passes)
- [ ] Config module: loads `VAULT_ROOT`, credentials env, validates with zod; implements the double-credential refusal (CLAUDE.md hard rule 3)

## 4. Minimal agent runner + CLI trigger

- [ ] Implement `server/src/pipeline/agent-runner.ts`: wraps `@anthropic-ai/claude-agent-sdk` `query()` with `cwd = VAULT_ROOT`, `settingSources: ['project']`, edit auto-accept scoped to `VAULT_ROOT`, bash whitelist (vault `scripts/*.sh`), no web tools
- [ ] System-prompt extension (constant, exported): full-automation rules (no questions; document defaults) + English-language rule (SPEC.md §3.1)
- [ ] Stream handling: persist SDK messages to stdout for now (job_logs comes in M1); capture usage (tokens) from the result message
- [ ] CLI entry: `npm run ingest -- <path-to-file>` → copies file to `VAULT_ROOT/.raw/m0-test/`, runs `ingest .raw/m0-test/<file>`
- [ ] 15-minute timeout with clean abort

## 5. End-to-end validation

- [ ] Pick a real ~10–20 page PDF (mixed English/German content is ideal) and run the CLI ingest
- [ ] Verify in the vault: source page + concept/entity pages created (8–15 expected per repo docs), `wiki/index.md` and `wiki/log.md` updated, `wiki/hot.md` refreshed, all wikilinks resolve in Obsidian
- [ ] Verify the language rule held: page names/summaries in English despite German source passages
- [ ] Commit the ingest result in the vault with message `ingest: <source>`

### Risk probe B — ingest-skill interactivity

- [ ] Note under Findings: did the run try to ask questions or stall? Did the system-prompt extension suffice, or do we need the thin auto-ingest wrapper skill (SPEC.md §11.2)? If needed, create `scripts/vault-extensions/` with the wrapper and an install script, then re-run the validation

## 6. Milestone close

- [ ] All acceptance criteria of SPEC.md §10 M0 met
- [ ] Findings section below completed; open follow-ups converted into TASKS-M1.md entries
- [ ] Tag repo `m0`

## Findings

- Policy status (task 0.3): **Checked 2026-07-17** against https://support.claude.com/en/articles/15036540. The article leads with a pause notice: "We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits." The announced separate SDK allowance (Pro $20 / Max 5x $100 / Max 20x $200 per month) remains **not active** since the 15 June pause. Consequence for this project: SPEC.md §7.1 is accurate as written — the OAuth/subscription path (`CLAUDE_CODE_OAUTH_TOKEN`) is viable for M0, and SDK ingest runs compete with interactive Claude usage for the same limits. No spec change needed; re-verify before M5 hardening.
- Environment (task 0.1/0.2): Ubuntu 24.04.3 LTS (noble) on WSL2 kernel 6.6.87.2 ✅ · git 2.43.0 ✅ · Node was absent (apt candidate 18.19.1 is too old for the ≥20 requirement), so **nvm 0.40.1 + Node v20.20.2 / npm 10.8.2 were installed** during this session ✅ · **Claude Code CLI is not installed in this distro** (needed for task 2.1 `claude setup-token`) · no preprocessing tooling yet (`pdftotext`, `pandoc`, `exiftool` all absent — M1 concern, not M0-blocking).
- **nvm/PATH caveat (relevant for M5 systemd):** nvm sources from `~/.zshrc`, so Node is only on PATH in interactive shells. Non-interactive/non-login shells (and therefore a systemd user service) will NOT find `node`. The M5 unit must set an absolute interpreter path or an explicit `Environment=PATH=`; do not rely on nvm's shell hook. Carried into TASKS-M1/M5 as a follow-up.
- Repo state: The repo root contains only `docs/` plus three orphaned `*:Zone.Identifier` files (`CLAUDE.md:Zone.Identifier`, `SPEC.md:Zone.Identifier`, `TASKS-M0.md:Zone.Identifier`) — Windows NTFS alternate-data-stream leftovers from a copy where the actual `.md` files did not land at root. `CLAUDE.md` and `SPEC.md` currently live in `docs/`, while CLAUDE.md's own layout section places them at the repo root. Also: **the repo is not git-initialized yet** (task 3.1 territory). Resolve during task 3.1.
- Vault pin (task 1.1): Cloned from https://github.com/AgriciDaniel/claude-obsidian on 2026-07-17. **Pinned to tag `v1.9.2` = commit `00213b720cdc9bb00ec8b3f88f9cc408721c37f9`** ("release: promote v1.9.2 to public canonical…", 2026-05-28), checked out on local branch `vault-main` (a branch, not detached HEAD, so service ingest commits have a base). `origin` remote kept for deliberate upgrades (SPEC.md §11.4). Note: upstream `main` (`cb93ff6`) is exactly **one** commit ahead of v1.9.2 and that commit only adds a 1280x640 social-preview asset — i.e. pinning costs us nothing functional today. Baseline commit after setup: `7c0acde`. Vault state: 50 MB, 49 `.md` files under `wiki/` (repo ships a seeded/demo wiki incl. `index.md`, `hot.md`, `log.md`).
- Risk probe A verdict: **UNUSABLE — and for a different reason than the spec anticipated.** SPEC.md §11.1 predicted a *performance* risk ("9p file access can be sluggish"). Reality is a **hard functional failure**: Obsidian for Windows refuses to load the vault at all, with `Error: EISDIR: illegal operation on a directory, watch '\\wsl.localhost\Ubuntu\home\benjamin\vault\'`. Obsidian's file watcher (Electron/Node `fs.watch` → `ReadDirectoryChangesW`) cannot watch directories over the 9p share. No latency could be measured because the app never reaches a usable state; the "+200 dummy files" step was therefore moot.
  - **Not fixable by tuning.** Confirmed as a known, won't-fix limitation: the Obsidian forum's WSL-vault thread sits in the **"Bug graveyard"** category. The same 9p watch failure hits other Electron apps (MarkText #3779, Cypress #21530). No workaround exists for Windows-side Obsidian on `\\wsl$`/`\\wsl.localhost`. Sources: https://forum.obsidian.md/t/cant-create-or-open-vault-in-wsl-folder/34688 · https://forum.obsidian.md/t/support-for-vaults-in-windows-subsystem-for-linux-wsl/8580
  - **`/mnt/d` does not exist on this machine.** Windows drives present: C (475 GB free), M (1.4 TB free), T (772 GB free); R and S are ≥98 % full. SPEC.md hardcodes `/mnt/d` twice — §4.2 (watch-folder default `/mnt/d/inbox`) and §11.1 (fallback `/mnt/d/vault`). **Both need a spec correction regardless of which option is chosen below.**
  - **drvfs locking test (`wiki-lock.sh`): PASS — the spec's locking concern is unfounded.** Tested via the script's `WIKI_LOCK_VAULT` override on `/mnt/c` (v9fs/drvfs) against an ext4 baseline. All mechanisms behave identically on both: `flock -x` mutual exclusion (fd-form, as used by `with_meta_lock`), `set -o noclobber` O_EXCL atomicity, acquire/peek/release round-trip, 8-way concurrent acquire (exactly 1 winner, 7× EX_TEMPFAIL), and age-based stale reaping. ⚠️ Method note: a first version of the probe reported flock as broken **on ext4 too** — that was a bug in the probe (mixing flock's fd-form and `-c` command-form), not a filesystem defect. Retested with the exact invocation form `wiki-lock.sh` uses. Lesson: a baseline that fails is a broken test, not a finding.
  - **drvfs performance penalty (measured, 200 small .md files):** writes 12 ms → 402 ms (**33×**), reads 7 ms → 245 ms (**35×**), `grep -rl` 3 ms → 197 ms (**65×**), git init+add+commit+status 102 ms → 2277 ms (**22×**). `find` and `stat` are ~par. So SPEC.md §3's rationale for the WSL filesystem is **half right**: the performance argument is strongly confirmed; the locking-semantics argument is not.
  - **Two viable options (decision pending, see below).** (A) Vault on a Windows drive (`/mnt/c/vault`) — Obsidian works natively, service eats the 20–65× drvfs penalty on every agent run and git commit. (B) **Obsidian inside WSL via WSLg** — vault stays on ext4, service keeps full speed, Obsidian runs as a Linux GUI app on the Windows desktop; already named as an option in SPEC.md §11.1 and the alternative Obsidian's own forum points to. Option B preserves every current spec assumption except which Obsidian binary is used; option A contradicts SPEC.md §3's core placement decision and taxes the hot path forever.
- Risk probe B verdict:
- Other:
