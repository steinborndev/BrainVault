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

## 3. Stage 2 — cosine rerank (local ollama) — GATED ON STAGE 1 ACCEPTED

- [ ] Embed-cache warmup in the index build: after `bm25Build()`, warm
      `.vault-meta/embed-cache.json` for changed chunks (ollama `nomic-embed-text` at
      `127.0.0.1:11434`) so query time needs no cache WRITES. Verify first what `rerank.py`
      actually writes at query time when the cache is warm; if it still writes (e.g. the query
      embedding), either (a) add exactly `.vault-meta/embed-cache.json` to the query profile's
      sandbox `allowWrite`, or (b) keep `--no-rerank` at query time and rerank is build-time
      only. Decide from evidence, record here.
- [ ] Sandbox network: the `query` profile has no egress; rerank needs `127.0.0.1:11434`. Add
      the NARROWEST possible localhost exception the SDK sandbox supports — and after ANY
      change to the permission wiring, re-run `server/src/cli/permprobe.ts` (hard rule 4);
      expected: canary outside vault still blocked, web still blocked, only the ollama port
      reachable. If the sandbox cannot scope network that narrowly, STOP and reassess (option:
      build-time-only rerank) rather than widening egress.
- [ ] Graceful degradation: ollama down ⇒ `retrieve.py` falls back to BM25 order (verify the
      no-op strategy via `rerank.py --peek`); the query must not fail or hang. Startup probes
      ollama and logs the active retrieval tier.
- [ ] Ops: document the ollama dependency (WSL host, model pull, systemd ordering) in README
      setup + troubleshooting.
- [ ] Tests: warmup invoked only for changed chunks (fake process layer); prompt drops
      `--no-rerank` iff Stage 2 active; degradation path.

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

## 5. Dashboard (Maintenance tab)

- [ ] "Retrieval index" card: provisioned yes/no (with a provision button when no), chunk
      count, index age, active tier (synthetic/BM25-only vs rerank vs contextual), last build
      outcome/duration, manual rebuild button wired to the maintenance endpoint, live via the
      existing run-registry polling + SSE stats invalidation.
- [ ] Chat: no UI change (same composer, same citation chips). Optionally show the retrieval
      tier in the per-answer usage footer for debuggability.

## 6. Docs

- [ ] README: "Hybrid retrieval (optional)" section — what it is, the three stages, what stays
      on-machine per stage, ollama setup, cost note for Stage 3, troubleshooting (stale index,
      ollama down, re-provision).
- [ ] SECURITY.md: Stage 3 changes "what leaves the box" — document the egress setting and its
      default-off.

## 7. Live acceptance

- [x] Provision Stage 1 on the live vault: 859 chunks, ~1s (F-R5).
- [x] The headline acceptance question (answer mid-page, title mismatch) — **PASSED** (F-R7). A
      buried causal claim (one vaccine's milder cold-chain requirement traced to its ionizable
      lipid's lower LNP water permeability) whose source page title names none of the query
      terms: the retrieval path answered correctly with the exact quantitative values and cited
      both the source and the synthesis page (5 chips). The A/B against legacy is honest, not a
      clean win — see F-R7.
- [ ] Post-ingest freshness: drop one file, watch the debounced `retrieve-index` run appear and
      succeed without manual action; new page's content retrievable in chat afterwards.
      *(Not yet exercised — deferred to the next real ingest.)*
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
