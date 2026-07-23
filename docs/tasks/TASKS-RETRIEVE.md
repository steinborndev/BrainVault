# TASKS-RETRIEVE — hybrid retrieval for query & research (vault `wiki-retrieve` skill)

Goal: replace the page-granular `hot → index → pages` query read path with the vault's shipped
chunk-level retrieval stack (`skills/wiki-retrieve`: contextual prefix + BM25 + optional cosine
rerank), provisioned and kept fresh by the service. **Acceptance: with the index provisioned, a
chat question whose answer lives in a single passage of a page whose TITLE does not match the
question is answered correctly with the right citation; the query run's log shows a
`retrieve.py` invocation; the index is rebuilt automatically after ingests with no manual
action; with the egress setting off, no vault content leaves the machine during index builds;
`npm test` green.**

Post-M5 extension — the milestone gate does not apply, but the working agreement does: work top
to bottom, check off as completed, record decisions under "Findings". Staged rollout is part of
the design: Stage 1 (BM25-only, zero new dependencies) must be live and accepted before Stage 2
(ollama rerank), and Stage 2 before Stage 3 (LLM contextual prefixes, egress-gated).

## 0. Spec & rules amendment — DONE (user sign-off 2026-07-23)

- [x] SPEC.md: new **§12.6 "Hybrides Retrieval auf Chunk-Ebene"** — three stages (each gated on
      the previous one's acceptance), the deterministic-pipeline-step clarification, the
      no-versioning decision, and the freshness contract (debounced `retrieve-index` run,
      manual `POST /api/v1/maintenance/retrieve-index`).
- [x] CLAUDE.md hard rule 1: sanctioned exception added (2026-07-23, references SPEC.md §12.6) —
      pipeline code may run the vault's own deterministic index scripts as child processes for
      the derived `.vault-meta/{chunks,bm25,embed-cache.json}` artifacts only; wiki content
      stays agent-run-only.
- [x] Decided & verified: index artifacts stay OUT of vault git history via
      `VAULT_ROOT/.git/info/exclude` (repo-local, hard rule 5 safe). Verified against REAL git
      (see Findings F-R1): both the pathspec staging (`BOOKKEEPING_PATHS` stages `.vault-meta`
      on EVERY commit) and the legacy `git add -A` path skip excluded untracked files, and
      `git status --untracked-files=all` (the `dirtyPaths` F4 bracketing) does not list them.

## 1. Indexer plumbing (`pipeline/retrieve-index.ts`) — DONE 2026-07-23

- [x] New module `pipeline/retrieve-index.ts` wrapping the vault scripts as child processes
      (no LLM, no agent run): `buildRetrieveIndex()` runs `python3 scripts/contextual-prefix.py
      --all` (NO `--allow-egress` ⇒ tier-3 synthetic prefix; credentials additionally STRIPPED
      from the child env as belt-and-braces, F-R2) then `python3 scripts/bm25-index.py build`.
      cwd = `VAULT_ROOT`, timeouts 15 min / 5 min, `shell: false`, non-zero exit ⇒ typed error
      with a stderr tail, never crashes the service.
- [x] Provisioning folded into the first build (simpler than a separate path): every
      `buildRetrieveIndex()` idempotently writes the `.git/info/exclude` entries and creates
      `.vault-meta/{chunks,bm25}/` before running — the POST is provision-if-needed. The
      interactive `bin/setup-retrieve.sh` is deliberately NOT shelled out to (consent prompt
      would hang headless).
- [x] Feature detection `isRetrieveProvisioned()` mirroring the skill's canonical check, plus
      `hasRetrieveScripts()` (pre-v1.7 clone → `RetrieveScriptsMissingError` → 409 at the route,
      checked synchronously before a run is registered).
- [x] Freshness: new maintenance kind `retrieve-index` on the `MaintenanceRunner` — the one
      DETERMINISTIC kind: no agent, no credential (works in setup mode), no commit, tracked in
      the same run map/poll routes as agent runs, live log on `maintenance:retrieve-index`.
      Deviation from the sketch, recorded as F-R3: it takes NEITHER the run mutex NOR the
      commit mutex — its own `indexMutex` serializes builds against each other only.
      Triggered (a) manually via `POST /api/v1/maintenance/retrieve-index` (202, not gated on
      the credential), (b) by `startRetrieveIndexScheduler` in main.ts: job `done` events reset
      a quiet window (default 5 min), one rebuild per window, provisioning checked at FIRE time
      so the first manual build arms the automation without a restart.
- [x] Stats: `GET /api/v1/maintenance/retrieve-index` → `{ scriptsPresent, provisioned,
      chunkCount, indexBuiltAt }` (cheap fs walk; last build outcome/duration comes from the
      run history like every other kind). Active-tier display deferred to §3 where a second
      tier first exists.
- [x] Tests (`test/retrieve-index.test.ts`, 17 tests): exclude idempotence + append-to-existing
      + no-git no-op; detection lifecycle; builder order/args/no-egress-flag, chunk count,
      missing-scripts + failing-script errors; scheduler debounce burst→1, window reset,
      non-done/unprovisioned inertia, close-cancels, throwing-start contained; runner kind
      settles done/error, fires `onRunSettled`, throws synchronously without scripts,
      serializes concurrent builds. Suite: 531 tests / 39 files green; typecheck + lint clean.

## 2. Stage 1 — BM25-only query path — DONE 2026-07-23

- [x] `querySystemPrompt(vaultRoot)` in `pipeline/system-prompt.ts` resolves the read path per
      run: provisioned ⇒ "run `python3 scripts/retrieve.py "<question>" --top 5 --no-rerank`
      first, read ONLY the candidates, fall back to the legacy order if it fails"; unprovisioned
      ⇒ the legacy prompt byte-for-byte (`QUERY_SYSTEM_PROMPT` kept as that constant). Wired in
      `agent-runner.ts` (`profile === 'query'` branch). `--no-rerank` pinned — stage 1 adds no
      ollama dependency and no cache writes, so the read-only query sandbox is untouched.
- [x] Live verify — the retrieval mechanism runs and the sandbox allows it (see F-R5). The
      real vault provisioned to **859 chunks** via `POST /maintenance/retrieve-index`;
      `retrieve.py --no-rerank` returns valid JSON (`strategy: bm25-only`, 20 BM25 hits →
      top-5 candidates with `absolute_path`), exit 0. `python3` + unrestricted reads under the
      `query` profile were already M0-validated, so the sandbox permits the call.
- [x] Baseline + comparison measured on the live vault (F-R6). Recorded under Findings; the
      honest read is that single-shot `tokensIn` is confounded by prompt-cache dominance and is
      NOT a clean receipt — cost fell on all three questions, but the real value case rests on
      retrieval quality, which needs the mid-page/title-mismatch acceptance question (§7), not
      token counting.
- [ ] Research/autoresearch: no code change expected — `autoresearch` feature-detects the skill
      itself. Verify one research run picks it up (log evidence). *(Deferred to the next research
      run — not exercised in this pass; the query path was the §2 focus.)*
- [x] Tests: `querySystemPrompt` emits the retrieval block iff provisioned, legacy byte-for-byte
      otherwise, `--no-rerank` present, read-only contract preserved (`test/retrieve-index.test.ts`,
      +2 tests → 533 total green; typecheck + lint clean; server rebuilt + service restarted).

## 3. Stage 2 — cosine rerank, SERVICE-SIDE — DONE 2026-07-23

**Redesigned before implementation (F-R9, user decision): the two sandbox exceptions this
section originally called for are NOT needed and were NOT made.** Retrieval moved out of the
agent entirely — the service runs `retrieve.py` itself, before the agent starts, and hands the
agent ranked PAGES on the prompt. The read-only `query` profile is byte-for-byte unchanged.

- [x] ~~Embed-cache warmup / sandbox `allowWrite` exception~~ — **not needed.** `rerank.py`
      writes `.vault-meta/embed-cache.json` at query time and always will (the cache key is
      `model:body_hash`, so the QUERY embedding is a guaranteed miss every time — warmup cannot
      remove it). Since retrieval now runs in the service process, that write is simply an
      ordinary service write to derived, git-excluded state, exactly like the index build.
- [x] ~~Sandbox localhost/network exception for ollama~~ — **not made, and must not be.** The
      ollama API is UNAUTHENTICATED and far wider than "embed this string": `/api/pull` fetches
      models from the internet, `/api/create`/`/api/delete` mutate them, `/api/generate` runs
      inference. Opening it to a sandboxed run would hand a prompt-injected agent an indirect
      egress channel — precisely what the no-egress profile exists to prevent. The service talks
      to ollama; the sandbox never does.
- [x] `retrieveCandidates()` (`pipeline/retrieve-index.ts`): runs `python3 scripts/retrieve.py
      "<q>" --top N` via the same injectable `ProcessRunner` seam as the index build; parses
      STDOUT ONLY (stderr carries "bm25: N hits", F-R5); collapses multi-chunk hits to their
      page keeping best rank; caps the question at 1000 chars before argv; returns
      `{candidates, strategy}` and degrades to empty on ANY failure (unprovisioned, script
      error, bad JSON) — a query must never fail because retrieval did.
- [x] Prompt: `QUERY_SYSTEM_PROMPT` is static again (no `retrieve.py` instruction at all) and
      names both read paths; per-question hits render as a `<retrieved_context>` block appended
      to the question (`renderRetrievalBlock`). Ranked starting point, explicitly NOT an
      exclusive whitelist — a hard "only these" would turn a retrieval miss into a false "not in
      the vault" answer.
- [x] `runQuery` performs retrieval then calls `runAgent`; `onRetrieval` callback lets the route
      log the engaged tier. Retriever injectable so tests never spawn python.
- [x] Graceful degradation: ollama down ⇒ `retrieve.py` returns `noop-no-ollama` and falls back
      to BM25 order (verified via `rerank.py --peek` before install); retrieval failure ⇒ empty
      block ⇒ legacy read path. The query neither fails nor hangs.
- [x] Ops: ollama installed userspace (no sudo on this host) as systemd --user
      `ollama.service`, loopback-only, lingering on. See F-R10.
- [x] Tests (+11 → 544 green): `retrieveCandidates` ranking/dedupe/argv-shape/truncation/three
      degradation paths; prompt has no `retrieve.py` and renders empty for no hits; `runQuery`
      appends the block, leaves the question untouched on empty, and — the load-bearing one —
      asserts the run still carries `sandbox.enabled === true` and
      `allowUnsandboxedCommands === false` with the static system prompt.
- [x] Sandbox-unchanged proof: `permissions.ts` untouched (`git diff --quiet`), and the
      `agent-runner.ts` diff contains no `sandbox`/`network`/`allowWrite`/`allowUnsandboxed`/
      `WEB_TOOLS`/`disallowedTools` line — only the prompt-constant swap. **No permprobe run was
      required because no permission wiring changed** (hard rule 4 triggers on SDK upgrades and
      permission-wiring changes; this was neither).
- [x] Live: the §7 acceptance question answered correctly with the exact figures and 4
      citations; journal shows `[query] retrieval: 5 page(s),
      strategy=bm25+rerank:cosine:nomic-embed-text`.

## 3b. Findings from the stage-2 redesign

- **F-R9 (2026-07-23) — the sandbox exceptions were an artifact of the §2 design, not a
  requirement of retrieval.** §2 shipped "the agent runs `retrieve.py` itself", which dragged
  everything the script needs *into* the read-only sandbox (ollama network + embed-cache write).
  Moving the call into the SERVICE removes both needs at zero cost to sandbox strictness — and
  is strictly better on two other axes: (1) retrieval becomes DETERMINISTIC (the agent no longer
  decides whether to retrieve, which was the F-R7 variance problem), and (2) it reuses the
  §12.6-sanctioned "service runs the vault's deterministic scripts" mechanism already used for
  the index build. Lesson worth keeping: when a capability seems to require loosening a
  boundary, check whether the work can move to the trusted side of it instead.
- **F-R10 (2026-07-23) — ollama install notes (this host).** No passwordless sudo, so the
  official `curl | sudo sh` installer is unusable here. Installed userspace instead: the release
  asset format changed to `.tar.zst` (the old `ollama.com/download/*.tgz` endpoint now 404s),
  and no `zstd` binary exists on the host, so extraction went through the pip `zstandard` module
  into `~/.local` (bin+lib siblings — the binary finds `../lib/ollama` on its own). Runs as
  systemd --user `ollama.service` with `OLLAMA_HOST=127.0.0.1:11434` (loopback-only by
  construction, not just by default), enabled, lingering on so it survives a WSL restart like
  vault-service. Model: `nomic-embed-text` (274 MB), CPU-only is fast enough for one query
  embedding plus cached chunk embeddings.

## 4. Stage 3 — LLM contextual prefixes (egress, opt-in) — GATED ON STAGE 2 ACCEPTED

- [ ] New setting `retrievePrefixEgress` (default OFF) in `settings` (route + zod + UI toggle
      in `SettingsEditor`). Consent copy must say plainly: wiki page bodies are sent to the
      Anthropic API during index builds. This mirrors the vault's own `--allow-egress` gate —
      the service must not silently widen it.
- [ ] When ON, the index build passes `--allow-egress` and provides the credential to the
      script env (tier 1 needs `ANTHROPIC_API_KEY`; under OAuth-only auth tier 2 uses the
      `claude` CLI — verify which tier engages per auth mode, record here). Credential handling
      per hard rule 3: env only, never logged, never in SQLite.
- [ ] One-time `--rebuild` after first enable (synthetic prefixes ⇒ real prefixes), surfaced as
      an explicit button with the cost note (~$12 / 1,000 documents one-time, incremental
      after — from the skill's cost section).
- [ ] Tests: flag plumbing (egress flag reaches the process layer iff setting on), settings
      route validation, no credential in captured logs.

## 5. Dashboard (Maintenance tab) — DONE 2026-07-23

- [x] "Retrieval index" card (`web/src/tabs/Maintenance.tsx`, `RetrievalIndexCard`): three
      states off `GET /maintenance/retrieve-index` — scripts absent (pre-v1.7 vault → explains,
      no button), not provisioned (Build index button), provisioned (chunk count + built-at via
      `timeAgo`, Rebuild button). Rebuild uses `useMaintenanceRun(api.retrieveIndex)` with the
      live `maintenance:retrieve-index` JobLog; on settle it invalidates the status query. Placed
      left column after Hot cache. `api.retrieveIndexStatus`/`api.retrieveIndex` +
      `RetrieveIndexStatus` type + `MaintenanceKind` extension added to the web client.
      Active-tier display intentionally omitted until §3 adds a second tier. web typecheck +
      build clean; card verified present in the served bundle.
- [x] Chat: no UI change (same composer, same citation chips), as designed.

## 6. Docs — DONE 2026-07-23

- [x] README: new "Hybrid retrieval (optional)" subsection under the dashboard section — what it
      is, on-machine build, auto-rebuild after ingests, the Maintenance card, and a note that
      rerank + LLM prefixes are gated follow-ups (the latter the only off-machine step, default
      off). Maintenance-tab bullet + API list updated with the two `retrieve-index` endpoints.
- [x] SECURITY.md: operational-hardening bullet — index build is fully on-machine (never
      `--allow-egress`, credential stripped from the child env), derived data under `.vault-meta`
      excluded from git, and the planned stages' egress posture (loopback-only rerank; LLM
      prefixes behind an explicit default-off setting).

## 7. Live acceptance

- [x] Provision Stage 1 on the live vault: 859 chunks, ~1s (F-R5).
- [x] The headline acceptance question (answer mid-page, title mismatch) — **PASSED** (F-R7). A
      buried causal claim (one vaccine's milder cold-chain requirement traced to its ionizable
      lipid's lower LNP water permeability) whose source page title names none of the query
      terms: the retrieval path answered correctly with the exact quantitative values and cited
      both the source and the synthesis page (5 chips). The A/B against legacy is honest, not a
      clean win — see F-R7.
- [x] Post-ingest freshness — **PASSED live** (F-R8). A throwaway text-note ingest reached
      `done`; ~5 min later the debounced `retrieve-index` run fired on its own (0 → 1 runs,
      859 → 860 chunks, run settled `done`), no manual action. Test artifacts reverted from the
      vault afterwards (two `git revert` commits — the agent correctly created NO wiki page for a
      note it judged valueless, so only `.raw/` + `log.md` had to be undone).
- [x] Token/latency delta vs the §2 baseline recorded under Findings (F-R6) — confounded, not a
      receipt.
- [x] `npm test` green: 533 tests / 39 files. typecheck + lint clean.

## Findings

- **F-R1 (2026-07-23) — the exclude entries are load-bearing, not hygiene.** `BOOKKEEPING_PATHS`
  in `pipeline/git.ts` stages `.vault-meta` with EVERY vault commit, and `dirtyPaths` brackets
  runs with `git status --untracked-files=all`. Without the `.git/info/exclude` entries, every
  index rebuild would bleed into the next ingest/maintenance commit and pollute the F4 sweep.
  Verified against a real throwaway git repo: with the entries present, `git add -- .vault-meta`
  staged only a non-excluded file (`transport.json`), and `status --untracked-files=all` listed
  none of the index artifacts.
- **F-R2 (2026-07-23) — double egress lock on index builds.** Stage 1 never passes
  `--allow-egress` (the script's `pick_prefix_tier()` then returns synthetic regardless of
  credentials), AND the builder strips `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` from the
  child env, so even a future vault version with different gating defaults could not phone home.
  §3 will relax exactly one of these, behind the explicit setting.
- **F-R3 (2026-07-23) — mutex decision.** `retrieve-index` runs on its own `indexMutex`, not the
  run mutex or commit mutex: it writes only excluded, untracked, derived artifacts (nothing to
  commit, nothing another writer could mis-attribute), and parking it behind a 15-min agent run
  would only delay freshness. A rebuild racing a concurrent ingest can at worst chunk a
  half-written page — self-healing, since that ingest's own `done` event schedules the next
  debounced rebuild.
- **F-R4 (2026-07-23) — run-registry wording in the §1 sketch was ambiguous.** The codebase has
  two "registries": `RunRegistry` (F4 sole-writer tracking) and the runner's in-memory run map
  (what the poll routes serve). `retrieve-index` uses only the latter — it never writes wiki
  content, so it must NOT count as a vault writer in `RunRegistry` (it would suppress the F4
  sweep of a genuinely sole agent writer).
- **F-R5 (2026-07-23) — mechanism verified end to end on the real vault.** Provisioning the live
  245-page vault produced **859 chunks** in ~1s (synthetic tier-3 prefix = title + first
  paragraph, pure string ops — the sub-second time is expected, not a bug). `.git/info/exclude`
  holds all three entries and `git status --untracked-files=all` lists none of the 859 chunk
  files / bm25 index (F-R1 confirmed live). `retrieve.py "<q>" --top 5 --no-rerank` returns
  well-formed JSON (`strategy: bm25-only`, "bm25: 20 hits" on stderr, 5 candidates each with
  `absolute_path`), exit 0. Gotcha for future probing: retrieve.py prints a progress line to
  STDERR, so `2>&1 | json` corrupts the parse — read stdout alone.
- **F-R6 (2026-07-23) — token A/B is confounded; cost fell modestly; quality is the real test.**
  Same 3 questions, legacy path (old build, index absent) vs retrieval path (provisioned), one
  shot each. tokensIn/tokensOut/costUSD/wall:
  - Q1: 132385/584/$0.3082/12.9s → 131973/489/**$0.1595**/11.1s (2 citations)
  - Q2: 166914/2730/$0.3386/31.3s → 251545/1948/**$0.2712**/34.9s (6 citations; tokensIn ROSE)
  - Q3: 129778/832/$0.1203/14.6s → 86089/291/**$0.0964**/9.3s (0 citations)
  `tokensIn` is dominated by prompt-cache reads of the system prompt + the vault's plugin/skill
  definitions (`skills: 'all'`), a ~100k+ floor that swamps the page-read difference and even
  moves the wrong way (Q2). Cost dropped on all three (output-token + non-cached-input driven),
  but with n=1 and that confound this is NOT a clean value receipt. The load-bearing evidence is
  the retrieval-quality acceptance question in §7 (answer in a mid-page passage of a
  title-mismatched page), which token counting cannot capture. Do NOT cite F-R6 as "retrieval is
  cheaper" without the §7 quality result and a multi-run measurement.
- **F-R7 (2026-07-23) — §7 acceptance PASSED; the real value is reliability, not a per-answer
  win.** Test question: a buried mid-page causal claim (milder cold-chain storage of one mRNA
  vaccine <- its ionizable lipid's lower LNP water permeability) whose source page title contains
  none of {the two vaccine brand names, "cold-chain", "storage", "vaccine"}. Method: same live
  service, index present vs the bm25 `index.json` renamed aside (flips `isRetrieveProvisioned`
  per run -> legacy prompt), restored after.
  - Retrieval path (1 run): fully correct — exact coefficients (7.98 vs 1.58 x10^-4 cm/s), the
    packing-geometry mechanism, the caveat that it is a simulation-proposed cause, and the
    escape/storage trade-off; cited the source paper AND the synthesis concept page (5 chips).
  - Legacy path (2 runs, NON-DETERMINISTIC): run 1 was a total false negative — the agent read
    hot.md + index and concluded "this vault does not contain mRNA/LNP content" (it richly does:
    a whole mRNA-delivery cluster), 0 citations, gave up. Run 2 succeeded well (found the source,
    8 citations).
  - Honest reading: the literal acceptance criterion (retrieval answers correctly with the right
    citation) is met. The A/B is NOT "legacy always fails" — it is that legacy is high-variance,
    gambling on whether the agent decides to drill past the hot-cache/index scan into buried
    pages, and can wrongly report absent content. Retrieval removes that gamble by seeding the
    agent with the right pages deterministically via `retrieve.py`. Value = reliability /
    reduced false-negative risk, demonstrated by example (n small), not a guaranteed better
    single answer. A statistically solid claim needs a labeled question set run many times.
- **F-R8 (2026-07-23) — post-ingest freshness verified live.** Enqueued a throwaway text note;
  it reached `done`, and ~5 min later (the scheduler's default quiet window) the debounced
  `retrieve-index` run fired automatically without any manual trigger — retrieve-index run count
  0 → 1, chunk count 859 → 860, run `done`. Cleanup note: the ingest agent judged the note to
  have no lasting value and created NO wiki page (correct), so the footprint was only `.raw/`
  manifests + `log.md` appends; reverted with two `git revert` commits. Unrelated observation
  surfaced during cleanup (NOT caused by this work, pre-dates the session — mtime 12:33): the
  vault working tree carries uncommitted pages from an earlier cursor.com blog ingest (untracked
  wiki/concepts + wiki/entities + the source page, plus modified index.md/_index.md). Flagged to
  the operator; left untouched — sweeping unrelated pages into a commit is exactly what the
  pathspec-strict commit rules forbid.
