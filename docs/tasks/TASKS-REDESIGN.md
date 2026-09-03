# Tasks: Dashboard redesign (sidebar shell, 8 areas)

Source of truth for scope: the approved clickable mockup (artifact "LibrisVault Redesign",
2026-08-23) and the frontend deep-review findings (artifact "LibrisVault Frontend Review").
The review's invariants section lists what must NOT change (SSE data layer, status color
pairs, research violet, armed two-step destructives, 12.7 three-layer model, run-plan
preview, graph engine, PageLink triple action, cost estimate discipline, answer-of-record
chat, mounted-but-hidden screens, everything-is-a-commit messaging).

Structure change vs SPEC.md section 6 (five tabs): the dashboard moves to a sidebar shell
with Home / Library / Graph / Research / Inbox / Health / Settings. SPEC.md is NOT edited
as part of this work; a spec amendment is proposed separately once the redesign lands.

## Phase 1: foundation (shell + design system)

- [x] Self-hosted fonts via @fontsource (Bricolage Grotesque display, Instrument Sans UI,
      IBM Plex Mono data); no CDN, PWA stays offline-capable
- [x] styles.css: new token values (night-blue ground, gold brand accent, kept semantic
      pairs), type scale tokens, keep existing token NAMES so current component styles
      keep working; add sidebar/topbar/palette/drawer primitives; remove topbar-tabs and
      bottomnav styles once App.tsx switches
- [x] App.tsx: sidebar shell (groups Knowledge / Work / System), slim topbar (context,
      global search button, live pill), screens stay mounted-but-hidden
- [x] Routing: / (home), /library, /graph, /page/<path>, /research, /inbox, /health,
      /settings; legacy redirects /ingestion, /maintenance, /wartung, /chat, /vault,
      /vault/page/<path>
- [x] Command palette (Ctrl+K): pages from the graph query, actions, navigation
- [x] Window-level drop overlay: drop anywhere ingests (reuses Dropzone submit path)

## Phase 2: Inbox (from Ingestion)

- [x] Intake card: dropzone + link/note with optional title + visible channels line
      (watch folder path, telegram state)
- [x] History as compact table rows; job drawer (GET /jobs/:id) with commit, sha256,
      batch, exact timestamps, full log, retry/revert
- [x] Honest counts from stats.jobs (all-time per status) + "showing N stored"
- [x] Fix: clear-history armed count must match what is deleted (scope deletion to the
      shown filter+search, or count honestly)
- [x] Fix: cancel/retry mutations surface errors
- [x] Queue pause reason shown on the inbox itself

## Phase 3: Home (from Overview)

- [x] Now band: active runs (ingest/research/maintenance), health summary, channels
- [x] Stat tiles navigate (failures -> inbox failed filter, pages -> library, gaps ->
      graph, cost -> settings budget)
- [x] Unified activity feed: jobs + commits + maintenance state + edits as one stream,
      each event with commit hash and page chips; filter chips
- [x] Most wanted pages (top gaps) with research handoff
- [x] Growth chart: zero-based scale, no preserveAspectRatio distortion
- [x] Remove the redundant status strip (live pill popover is the single home)

## Phase 4: Health + Settings (split Maintenance)

- [x] Settings screen: intake channels, pipeline, account (credential), service
      read-only block; setup mode lands here; app banner points here
- [x] Health screen: status head (due/soon/healthy, What/Why/Cost), areas as
      accordion cards, guided run entry
- [x] Lint evidence inline: render the persisted lint report summary in the area card
      so "Fix safe findings" shows what bounds it
- [x] Last-run receipts per area from maintenance_state (time, ok/failed, pages)
- [x] Guided run: keep context (rail with steps + accumulated commits), re-derive
      step data after each dependency settles (invalidate graph/candidates between steps)
- [x] Fix: "Start guided run" only rendered when buildRunPlan is non-empty
- [x] Fix: status model error state (failed input query -> error + retry, not
      forever-"Checking")

## Phase 5: Research

- [x] Two-lane rail: conversations + research runs (running state from
      useMaintenanceRun, last settled runs from maintenance_state)
- [x] Run detail view separate from conversation threads
- [x] Compact composer: one plan line (lens, deterministic title, fetch cap, 1 commit),
      lens picker in a popover
- [x] Gap prefill passes a clean topic (page name), instructions no longer pollute the
      lens title
- [x] Fix: first-turn streaming (client request id as stream key; small server change
      in query route)
- [x] Fix: auto-scroll while streaming
- [ ] Cancelable asks/research - NOT done: neither `/query` nor the maintenance runner
      exposes an abort today, so this needs a server change (a run-scoped cancel token)
      before the UI can offer it honestly

## Phase 6: Library + Graph + Page (split Vault)

- [x] Library screen: filterable/sortable page table from graph data (type, domain,
      health badges orphan/stub, updated), row actions (focus in graph, obsidian, copy)
- [x] Graph: explorer panel docks (canvas makes room) instead of overlaying search;
      one Filter band (types + domains); health entry point in the stats area
- [x] Search: debounce, no camera refit per keystroke
- [x] Page view: one back model (breadcrumb back = Esc destination), dirty guard on
      the editor (visible badge + confirm on leave)
- [x] Type lens colors decoupled from semantic ok/warn/err tokens

## Phase 7: server support (small, additive)

- [x] Persist duplicateOf on job rows (migration) + link duplicate -> original in the
      drawer
- [x] Stream key for first-turn chat (accept client requestId in POST /query, publish
      deltas under it)

## Phase 8: polish + docs

- [x] Em-dash sweep across all UI strings (hyphens per project rule)
- [x] A11y: visible focus on the pill/overlay inputs, one `h1` (the topbar screen name),
      `<nav aria-label>` landmarks, `aria-current="page"` on the active item. Still open:
      keyboard traversal of graph nodes and focus management in popovers/menus
- [x] Update web/DESIGN.md to the new system
- [x] PWA manifest/theme-color aligned with new tokens
- [x] npm test green (server + web), build clean, Playwright click-through screenshots


## Status 2026-08-23

Phases 1-8 implemented on `feat/dashboard-redesign` (7 commits). Verified against the live
service: 567 server + 73 web tests green, clean typecheck and build, no console errors
across 14 screen loads (7 screens x 2 themes), migration v11 applied to the live DB with
all 79 job rows intact.

Deliberately left open:
- Cancelable asks/research (needs a server-side abort first, see phase 5).
- Graph keyboard traversal and popover focus management (the pre-existing a11y gap; the
  Esc ladder and `/` focus behaviour are unchanged).
- A SPEC.md amendment for the shell change (§6 still describes five tabs). Proposed
  separately rather than edited unasked - the spec is authoritative and the redesign
  changes its structure section.


## Follow-up 2026-08-23: two-level graph layout

Reported: clusters visibly overlap in the graph view. Root cause (measured on the live
vault, not guessed): the layout compacted each domain toward its own MOVING centroid and
left separation to charge repulsion, but 97% of the visible edges are domain-internal, so
the graph is ~17 near-disconnected components with no link forces between them, and
`forceManyBody.distanceMax(600)` truncates repulsion at a range smaller than the biggest
blob (322 pages, 46% of the graph) is wide. Nothing forbade two domains from occupying the
same space.

Implemented variant B, a two-level layout (`web/src/lib/graphForces.ts`):
- Level 1 `computeGroupSlots`: one disc per domain, radius ∝ √members, packed with a
  collide constraint plus an inward pull (circle packing). Ring seed ordered by a greedy
  walk along the strongest bridges, because once the packing is tight the bridge springs
  can no longer pull tangent discs closer - adjacency has to be decided in the ORDER.
- Level 2 `forceGroupSlot` + `seedGroupPositions`: pages are pulled toward their domain's
  assigned slot (not a floating centroid), seeded inside it on a sunflower spiral, and held
  by a soft containment wall at the slot edge.
- `CROSS_GROUP_STRENGTH` 0.1 -> 0.02: level 1 owns inter-domain placement now, so the
  node-level cross-domain spring only has to nudge a bridging page toward the border.

Measured (707 visible nodes / 3950 edges, and the 732/7603 system-pages view):

| view | pages inside a foreign domain, before | after |
|---|---|---|
| default (system hidden) | 174 / 707 (24.6%) | 0 (0.0%) |
| system pages shown | 510 / 732 (69.7%) | 0 (0.0%) |

Overlapping domain pairs: 14 -> 0 and 43 -> 0. 12 new unit tests, including the
disjointness guarantee itself.


## Phase 9: panel rework (2026-08-24)

Source of truth: the clickable mockup "LibrisVault Redesign" (artifact, revised 2026-08-24)
and the operator's review of it. Scope is structure and priority, not a new visual system -
the tokens, the semantic colour pairs and the SSE data layer are untouched.

- [x] Sidebar: Inbox above Research (what arrived outranks what you go looking for)
- [x] System: `.linkish` and `.linklike` folded into one primitive; `[hidden]` restated
      with `!important` so a `hidden` prop is not silently beaten by a class-level
      `display` (it was, on every button and badge in the sheet)
- [x] Home: the intake composer moves to the top and becomes the first thing on the screen.
      It stands down to one row while the queue is busy (`Dropzone compact`), and a manual
      expand wins until the queue drains
- [x] Home: "In flight" section - running + queued jobs, from every channel. The Inbox
      folded in; the Inbox screen keeps the full record and the depth (log, revert)
- [x] Home: the NOW band is gone. Its three cells said what In flight now says properly,
      what the intake card already shows (channels), and what the new state line carries
      (health)
- [x] Home: cost tile removed - a budget concern, not a daily signal, and the one tile
      nobody acted on from here. Four tiles left, all doors
- [x] Graph: the two toolbar tiers and their dropdowns replaced by a standing left panel.
      Every parameter visible at once; the canvas keeps its full height
- [x] Graph: colour lens as a radio list, three primary axes standing (domain, authority,
      recency), the three diagnostics folded. Each description says what the COLOUR means,
      in one line, in the same grammar
- [x] Graph: Include (system pages, gaps) folded under Overlays. Both folds show what is
      switched on inside them when collapsed, and open themselves when it is
- [x] Graph: fullscreen - the canvas plus the lens and the way out. Esc leaves it first
- [x] Graph: one context line replaces the stats corner, saying in words what is in scope
      ("715 of 740 pages and 4013 links - the whole vault"). A shrinking count cannot tell
      a domain filter from a type filter from a search

Two defects found while verifying against the live service:

**F1 - the canvas computed its own height from a constant.** `.graph-canvas-wrap` was
`height: calc(100vh - 216px)`, where 216px was the height of the toolbar tiers the panel
replaced. It under-sized the canvas by ~100px (782 -> 882 measured at 1680x1000) and in
fullscreen subtracted chrome that is not on screen at all (782 -> 978). The height chain
now flexes end to end (`.screen.flush` -> `.lane` -> `.vault-graph` -> `.graph-workspace`
-> `.graph-main` -> `.graph-stage` -> `.graph-canvas-wrap`), so no constant is involved.

**F2 - Escape was swallowed in fullscreen.** The graph's key handler guards on
`rootRef.current.offsetParent === null` to mean "this screen is hidden". A
`position: fixed` element reports `offsetParent === null`, which is exactly what fullscreen
makes the graph - so the one state where Escape is the only way out was the one state where
it did nothing. The guard now measures box size instead.

Verified: 567 server + 88 web tests green, clean typecheck and build, 0 console errors
across 10 screen loads (5 screens x 2 themes) against the live service, fullscreen entered
and left by keyboard.


## Phase 10: density pass (2026-08-24)

Second review round on the mockup, then implemented. Structure and density only - no new
tokens, no data-layer change.

- [x] Sidebar: Graph above Library; the global search trigger leaves the topbar (Ctrl+K
      still opens the palette - the button was 260px of permanent reminder)
- [x] Home: stat tiles 119px -> 90px. Two things each cost a row in all four tiles: the
      sparkline sat absolutely in space the padding had to leave free, and `.goto`
      reserved 23px to render at opacity 0. The sparkline is in the flow beside the
      number now, and `.goto` shares the caption row with `.sub` (they swap on hover)
- [x] Home: Activity is bounded and scrolls. In a plain grid the taller column sets the
      row and Activity is always the taller one - measured, the feed ran 1040px past the
      side rail. Its column is now an empty relative box with the card laid over it, so
      the rail sets the height (verified flush to the pixel, 4890px of feed in 622px)
- [x] Graph: the context row above the canvas is gone. Fit, the scope line, the search,
      the shortcut tip and Fullscreen share one bar ON the canvas (`GraphCanvas` grew a
      `barExtra` slot). The -/+ buttons are gone; the tip documents Ctrl+wheel and drag
- [x] Graph: six lens pills replace the three-row radio list plus its fold. The hint line
      below them is FIXED height and one line - it sits above the rest of the panel, so a
      description that wrapped for some lenses would shift everything below it on hover
      (verified: 16px and a constant panel offset across all six)
- [x] Graph: entering or leaving fullscreen re-frames, via the fitKey - which also clears
      `userMoved`, so a graph the user had panned is re-framed too instead of staying
      parked off-screen (verified 1190 -> 1658 -> 1190px, symmetric margins throughout)
- [x] Library: the graph's panel, with the same two scope filters in the same order
      (page types, then domains), then the table's own options as pills with the same
      hover hints. `System` became the fourth option of All pages / Orphans / Stubs
      rather than a separate toggle - it was always a subset, not a second axis, so the
      other three now never show system pages

Verified against the live service: 567 server + 88 web tests green, clean typecheck and
build, 0 console errors across 10 screen loads (5 screens x 2 themes).


## Phase 6: rework pass (2026-08-25)

Source of truth: the approved clickable mockup ("LibrisVault UI Rework", 2026-08-24), six
points raised against the shipped redesign.

### 1 - Agent runs are visible from everywhere, not just where they were started

- [x] `MaintenanceRun` carries `label` (the research topic) and `profileKey` (the lens).
      The kind alone says "research"; the run record now says what it is researching, which
      is what Home, the sidebar and the inbox need to name it.
- [x] `useActiveRuns` (new): polls `GET /api/v1/maintenance/runs`, an endpoint that already
      existed and that the web client had never called. Run state used to live only in the
      starting screen's `useMaintenanceRun` hook, so a research run was invisible on every
      other screen and gone entirely after a reload while the server kept running it.
- [x] Home's "In flight" merges maintenance runs with the ingest queue; the inbox shows them
      as live rows; the sidebar gets a violet Research badge (colour says WHICH kind of work
      is running, the number says how much).

### 2 - Home fits on one screen at any window height

- [x] Home became a `flush` screen: four fixed rows plus one filling row whose two columns
      scroll inside themselves. Previously a document that grew past the viewport with a
      fixed `min-height: 340px` guess for the activity row.
- [x] Trims that bought the budget: intake band 190px to ~110px (grid, icon beside the text),
      tiles three lines to one (~45px each), in flight collapses to one line while idle
      (~70px), hot cache off Home entirely.
- [x] The hot cache's CONTENT moved to the Health card that already owns its refresh button;
      Home's state line carries its freshness in four words. It was a maintenance artifact
      occupying the landing screen with a panel you had to scroll past.
- [x] Verified on the live service at 1500x940: screen scrollHeight == clientHeight, no page
      scroll, both inner columns scrolling on their own.

### 3 - The graph's shortcut panel is readable again

- [x] ROOT CAUSE: the rule that flipped the tooltip downward keyed off `.gtopline`, a wrapper
      the density pass (83acfeb) deleted. The selector silently stopped matching, so the panel
      fell back to opening UPWARD - out of a box with `overflow: hidden`, at the top of the
      screen. Dead CSS is not harmless; this one took a whole panel off-screen.
- [x] Replaced by `components/Shortcuts.tsx`: a real popover, right-anchored under the bar,
      372px wide, click-to-pin, Escape closes (and stops propagation so it does not also back
      the graph out of a focus). Opening downward is structural here, so it belongs to the
      component's own class rather than to an override on a generic tooltip.
- [x] Verified: popover box fully inside the canvas box on the live service.

### 4 - Panel and box start and end on the same two lines

- [x] The WORKSPACE owns the padding now, not the columns. The graph canvas padded itself
      (`.graph-stage`) while the panel ran edge to edge; the library's toolbar sat inside the
      right column and pushed the table down by its own height. Neither could ever line up.
- [x] Shared `.ws-bar` row spanning both columns (library search/scope, inbox search/actions,
      the graph's cluster and focus bars), reserved only when a bar is actually rendered.
- [x] Verified on the live service, panel vs box bounding boxes: graph 64/785 = 64/785,
      library 103/785 = 103/785, inbox 106/785 = 106/785.

### 5 - Inbox redesign

- [x] One table instead of Active / Queue / History stacked: in-flight rows ride at the top,
      tinted, with their phase inline, so a job moves DOWN into history instead of jumping
      between sections. Maintenance runs appear there too.
- [x] The filter panel replaces the wrapping chip row: state with all-time counts, channel,
      time range, plus the queue's state and the reason it is paused.
- [x] No second drop hero - Home owns intake, "Add" goes there. Batch grouping survived the
      move as a header row with cancel-all; `components/JobCard.tsx` is deleted with the card
      list it belonged to.
- [x] NOT built: a manual pause/resume control. The mockup showed one, but the queue only
      pauses itself (budget, rate limit) and there is no endpoint - a button would have
      promised a feature that does not exist. The panel states the queue's condition instead.

### 6a - Research progress

- [x] `lib/researchProgress.ts`: derives five real steps, live counters and a "doing now"
      line from the log the run already streams. No new endpoint - the agent's tool calls
      ARE the progress signal, they were just never read as one.
- [x] DESIGN RULE: every number is counted, never estimated. Only "Read sources" gets a bar,
      because the lens declares its fetch cap before the run starts and is the one phase with
      a real denominator. A global percentage would be invented.
- [x] Known limitation: maintenance logs stream but are not persisted, so a reload mid-run
      starts from an empty buffer and the steps re-fill within seconds. Persisting them is a
      separate change.
- [x] 13 unit tests including the formatter's 160-char truncation of tool input (the log
      frequently carries invalid JSON, so the parser reads fields out of raw text).

### 6b - The lint badge contradicted what the user had just done

- [x] FINDING, two defects, the second the more serious:
      1. `deriveMaintenanceStatus` dated the lint area from ONE thing - the newest
         `wiki/meta/lint-report-YYYY-MM-DD.md` file name. The run record was never consulted.
      2. The lint run of 2026-08-23T20:43:41Z settled `ok` with `pages: 0` and wrote NO
         report: no August report on disk, no lint commit in the vault git log. The status
         head therefore reported "last report is 31 days old" while the activity feed
         announced "Lint report written" in the same session. The badge was right about the
         vault and wrong about the user.
- [x] RESOLUTION (three parts, all landed):
      - `MaintenanceRunner`: a lint whose report is not newer than the run's own start settles
        as FAILED. The report IS the deliverable - lint-fix is bounded by it, and the status
        model dates the area from it. Measured against the run start so an old report can
        never stand in for a run that produced nothing.
      - The status model takes `lastLintRun` alongside `lintReport` and distinguishes three
        outcomes: ran + report = healthy, ran + no report = DUE ("Lint ran, but wrote no
        report"), nothing recent = the report's own age decides, as before. Report and run are
        compared as calendar days with a day of slack, because the report's date comes from a
        file name (midnight) while the run carries an instant.
      - `runTitle(kind, ok)` names what a run PRODUCED rather than whether it threw, so the
        feed and the Health run list say "Lint finished, no report written".
- [x] Verified on the live service: the Health head now reads "Lint ran, but wrote no report
      - Lint ran in the last 24 hours but left no report in wiki/meta/ - the newest one there
      is 31 days old", severity due, badge 1.
- [x] OPEN: why the agent exited without writing the report is not diagnosed. The run will now
      surface as failed instead of silently succeeding, which is the precondition for finding
      out. Worth watching on the next lint.

Verified: 571 server + 105 web tests green (4 + 17 new), clean typecheck and build, live
service restarted and all six screens checked against the running instance.


## Phase 7: two vault-integrity findings (2026-08-25)

Both surfaced by the lint check from Phase 6 firing on a real run. Neither was a UI problem.

### Finding 1 - pages accumulate outside the vault's git history

**Evidence.** 752 wiki pages on disk, 727 in git. 24 pages plus one modified page had sat
outside history for a month. All 24 shared one mtime to the millisecond, falling between two
maintenance commits - a bulk write, not page-by-page agent writes. The one modified page's
diff carried changes from BOTH surrounding runs, and neither commit picked it up.

**Root cause.** Finding F4's documented half. The commit pathspec comes from a run's
Write/Edit tool calls, so pages an agent creates with Bash are invisible to it. The sweep
that catches those (`newWikiPaths`) is deliberately skipped whenever a run cannot prove it
was the sole writer, because misattribution is worse than omission. That trade-off is sound
and rests on one line in the code:

>   "Losing a page from a commit is visible and fixable"

Nothing made it visible. And "not the sole writer" is the NORMAL case, not the exception:
concurrency is 3, and the batch that produced these pages started EIGHT ingests within 500ms
of each other.

- [x] `unversionedWikiPages()` compares disk against git (one `git status`, ~8ms on 750
      pages), exposed on `/stats` and derived into a `due` status item + a Health card.
      Read-only: committing them needs a decision about what they are, which the service
      cannot make - the action is deliberately a separate step (A2, not built).
- [x] Reconcile-on-idle (`pipeline/reconcile.ts`). The attribution rule is not relaxed; the
      pass waits for the moment it becomes trivial. Attribution is impossible only while runs
      OVERLAP - once the writer count returns to zero nothing is writing, and whatever is
      still dirty can only be a leftover. `RunRegistry` now brackets the whole busy period
      (the first writer donates its F4 baseline, the last writer to leave announces it), so
      the pass commits the remainder without ever guessing which job a page belonged to.
      Bounded the same way the per-run sweep is: only `wiki/**`, only what became dirty
      during the period (so a user edit already in progress is excluded, SPEC §11.3 risk 5),
      explicit pathspec, behind the shared commit mutex, honouring `gitAutoCommit`, and the
      writer count is re-checked INSIDE the mutex rather than at the edge that scheduled it.
      Residual exposure, stated rather than hidden: a page the user edits in Obsidian DURING
      a busy period is indistinguishable from a Bash-written one and will be committed - the
      same exposure the per-run sweep already accepts, over a longer window, and the two
      outcomes are not symmetric (one labelled revertable commit versus knowledge silently
      absent from history).
      Proven end to end in `queue-integration.test.ts`: four ingests at concurrency 2, each
      agent writing one reported and one unreported page, so no run is ever the sole writer
      and every per-run sweep sits out. The unreported pages are committed. That assertion
      fails with the pass disabled.
- [ ] OPEN: the 27 pages currently outside history still need committing (a vault-history
      decision, left to the user).

### Finding 2 - the lint run did the work and produced no report

**Evidence.** The run committed `.vault-meta/lint_scan.py` (254 lines) and
`.vault-meta/lint_scan_out.json` (472 KB) - a complete, correct scan of 755 pages - and no
report. The last lint that worked (a month earlier, ~500 pages) wrote a 104-line report and
nothing else.

**Root cause.** Scale changed the strategy. Past ~750 pages the agent reaches for a scanner
instead of reading page by page, which is the better engineering call - and then it is
holding 472 KB it cannot read back into context to render the report from. The prompt did
not forbid the scanner: "use only the read-based checks (Read/Grep/Glob)" was attached to
the semantic-tiling sentence and read as scoped to it.

- [x] The prompt now steers the scripting path instead of leaving it ambiguous: script the
      scan if you like, but the SCRIPT emits the finished report. That removes the read-back
      rather than asking the agent to be careful about it. Intermediate output has a pinned
      home at `.vault-meta/lint-scan.json`.
- [x] `startLintReport()` renders from a scan a previous run left behind - the cheap half of
      a lint without repeating the expensive half. Refuses when nothing is newer than the
      current report, same shape as `startLintFix` refusing without one. Used to recover this
      run's findings without re-scanning.
- [x] Agent scratch stays out of vault history: `.vault-meta/*.py` and the lint-scan paths
      join the retrieval artifacts in `.git/info/exclude`, applied at STARTUP rather than at
      first index build (an agent can leave scratch long before one). The mechanism moved to
      `pipeline/vault-excludes.ts`. Note the limit - excludes only affect untracked files.
- [ ] OPEN: `lint_scan.py` and `lint_scan_out.json` are already committed and stay until
      someone removes them deliberately (a vault-history decision).
- [ ] OPEN: maintenance run logs stream but are never persisted, and the in-memory registry
      dies with the service - so this diagnosis had to be reconstructed from vault reflog and
      file mtimes. A separate table, not a `job_logs` piggyback: that table's `job_id` has a
      `REFERENCES jobs(id)` the FK-off setting currently masks.

### Corrected while verifying

The lint verdict keyed on the run's exit status AND its artifact, so after the report was
recovered the card read "Lint ran, but wrote no report - the newest one there is 0 days old".
The artifact alone decides now: a covering report is healthy however it got there, and the
failed run stays visible on its own in the run history.

## Phase 8: the ingest commit that lost a race with our own status poll (2026-08-26)

Surfaced the day after Phase 7 shipped, by the reconcile pass firing with a suspiciously
round number: `reconcile: 13 page(s) left uncommitted` - an entire ingest, not the one or
two leftovers the pass exists for.

**Evidence.** No `ingest: <source>` commit in the vault for that job; `commit_hash` and
`created_pages` NULL on the job row; the reconcile commit timestamped the same second. The
job log has both halves:

```
staging 13 page(s) the tool stream did not report (F4)
git commit failed: fatal: Unable to create '<vault>/.git/index.lock': File exists.
```

So the per-run sweep worked - this run WAS the sole writer - and the commit still did not
happen.

**Root cause.** `.git/index.lock` contention with our own read. `queue.ts` transitions the
job to `done` and then commits:

```
this.store.transition(job.id, 'done', …)   // publishes the SSE tick
const committed = await this.commitStep(…) // git add, milliseconds later
```

Every open dashboard refetches `['stats']` on that tick, and `/api/v1/stats` calls
`unversionedWikiPages()` - a `git status` OUTSIDE the commit mutex. A plain `git status` is
not a pure read: it refreshes the index and writes it back, holding `.git/index.lock` while
it does. The commit mutex serializes every WRITE the service makes and never covered this
one read, so the window opened on every single ingest completion and closed only when no
dashboard was watching. Measured on a 400-file repo: the index mtime moves after a plain
`git status` and does not move with `--no-optional-locks`.

Worth stating: the Phase 7 net did its job - the wiki pages were committed seconds later and
no knowledge was lost. What the net does not cover is everything outside `wiki/**`, so the
run's `.raw/` payload stayed untracked, and the job lost its revert anchor.

- [x] `gitRead()` for the status calls that run outside the mutex (`dirtyPaths`,
      `unversionedWikiPages`): `--no-optional-locks` makes git skip the index write-back, so
      a read cannot take the lock. Identical output, only the write is skipped.
- [x] `git()` retries on lock contention (3 attempts, 120/240/360 ms). The vault is a shared
      DIRECTORY, not just our repo - Obsidian's git plugin or a terminal can hold the lock
      too, and our mutex will never cover those. Safe for every command including `commit`,
      because git bails before doing any work when it cannot take the lock; bounded, so a
      lock left by a crashed git still surfaces as the same failure it does today.
- [x] Pinned in `git-dirty.test.ts` against a real repo: a read leaves the index mtime
      untouched, a plain `git status` moves it (the control), a write survives a lock held
      for 150 ms, and a lock that never clears still fails. The first and third fail with
      the fix backed out.
- [x] The orphaned `.raw/` payload committed to the vault by hand.
- [x] `.raw/deferred/` joins the vault excludes (`DEFERRED_EXCLUDE_ENTRIES`). The rest of
      `.raw/` is tracked on purpose - a commit captures the original source next to the pages
      made from it - but the waiting room is the exception, because of what puts things
      there: audio/video awaiting transcription, unextracted archives, and PDFs too large to
      OCR. Large by the very criteria that park them. This vault held one 179 MB textless
      851-page scan (`Print To PDF`, ~1 char/page), dropped 2026-07-24, whose job row had
      since been cleared from history - so nothing pointed at it and nothing would ever have
      cleaned it up. Deleted after confirming it had never been committed and that the
      material had been re-dropped in parts, which the deferral message had advised.
      A deferred payload is not lost by this: when one is actually processed it is re-dropped
      and lands in its own committed `.raw/<job-id>/`.
- [x] The four `.raw/<ulid>/` directories of non-`done` jobs still on disk (three failed,
      one deferred) were deleted after checking what each held: an expired signed download
      URL, a page with no extractable content, an orphan whose job row had been cleared, and
      one whose preprocessing HAD succeeded and whose agent run died on a usage limit - that
      last one traded a reusable normalized artifact for a re-fetch, which the user chose
      knowingly.
- [ ] OPEN: what happens to a failed job's `.raw/` payload is still not a stated rule. It is
      never committed (no successful ingest, no commit) and nothing ever removes it, so it
      accumulates - and a payload can outlive its job row, at which point nothing in the
      dashboard points at it. Deleting one also silently changes what a retry does: with the
      manifest present preprocessing is skipped and reused, without it the source is fetched
      again, which for a signed or expiring URL means the retry cannot work at all.

## Phase 9: second pass - five screens, tabs in the header (2026-08-25)

Scope from the approved clickable mockup ("LibrisVault Tab Shell", the B variant of two
drafts). Four complaints drove it, all of them structural rather than cosmetic:

1. Home and the Inbox described the same events twice, in two different vocabularies.
2. Home did not use the workspace layout Library and Graph had settled on.
3. Research had no structure, was empty whenever no run was in flight, and starting a run
   meant opening a popover and scrolling it to reach the lens.
4. Health and Settings were two nearly empty screens.

Nothing here needed a server change. Every number the new sections show was already being
collected and simply never added up anywhere.

- [x] **Shell.** Navigation moves into the header row as browser-style tabs (Home,
      Research, Graph, Library, System); the 216px sidebar is gone and every workspace is
      that much wider (`.lane.wide` 1620 → 1800). The active tab is painted in the screen
      ground and overlaps the header's bottom border, so it reads as the surface you are on.
      Watcher/page-count move to the right of the tab row; they hide below 1240px.
- [x] **Routes.** `/`, `/research`, `/graph`, `/library`, `/system`. Legacy prefixes
      redirect: `/inbox` and `/ingestion` → `/` (with their query string, so
      `?filter=failed` still lands), `/health`, `/maintenance`, `/wartung`, `/settings` →
      `/system`. Palette actions follow, plus two deep links (usage, vault stats).
- [x] **Home = the Inbox, plus intake and five numbers.** One control column (intake,
      search, kind/state/channel/time filters, queue state) and one table: in-flight rows
      tinted at the top, settled below. `lib/activity.ts` merges jobs, live runs, per-kind
      settles and the commits nothing else explains into one model, with the join rules the
      old feed had (a commit a job claims, or one within 90s of a settle, is not also an
      edit). Tested.
- [x] **What Home gave up:** growth chart, pages-by-type, hot-cache line, most-wanted list.
      The first two are vault statistics (System → Vault stats), the last is a research
      backlog (Research).
- [x] **Research.** Lens is a standing radio group in the control column - it greys out in
      Ask mode, because a lens only shapes a run (sources, fetch budget, title suffix).
      Research is the default mode. The screen opens on the run history plus the vault's own
      backlog instead of on nothing.
- [x] **Run history without a schema change.** `lib/researchRuns.ts` merges three sources:
      the in-memory run records (complete, but evicted), the restart-proof settle record
      (which is how a FAILED run survives at all), and the synthesis pages in the graph,
      whose deterministic `Research: <topic><lens suffix>` titles parse back into topic and
      lens and are dated by mtime. A page is dropped when a run record already claims it.
      Tested.
- [x] **System = Health + Settings**, five sections in the control column: status & checks
      (the existing maintenance head and tools), usage & cost, vault stats, service &
      config, integrations. `SettingsEditor` takes a `section` prop; `Maintenance` takes
      `showRunHistory` (off here - the last-settle rows live in the control column).
- [x] **Usage & cost** finally shows what the service records: spend today and over 7 days,
      tokens in/out, the daily budget as a meter, spend per channel and the most expensive
      runs (`lib/usage.ts`, tested).
- [x] **Vault stats:** pages, links, orphans, stubs, gaps, unfiled, growth, pages by type,
      retrieval index, pages outside git, domain split.
- [x] Dead code out: `tabs/Ingestion.tsx` and `tabs/Settings.tsx` are gone, the Dropzone
      lost its wide-card and collapsed variants (it lives in a 252px column now), and 143
      CSS rules whose classes no longer appear anywhere were removed (~18 KB).

- [x] DONE (2026-08-25, round two): the run history is recorded, not reconstructed.
      Migration v12 adds `agent_runs` (one row per settled run: kind, label, lens, ok, pages,
      tokens, cost, error, started/finished), written by the runner's `settle()` behind the
      same swallow-errors discipline as the per-kind state, pruned to the newest 1000.
      `GET /maintenance/history?kind=&limit=` serves it. The client merge now prefers the log
      and keeps the older sources for what only they know: the in-memory registry for a run
      still IN FLIGHT, the settle record for a pre-v12 failure, and the synthesis pages in
      the vault for every run that predates the table. Verified against the live service: an
      index rebuild wrote its row and came back out of the endpoint.
- [x] SPEC.md §6 amended (2026-08-26). Both structure changes folded in as one correction:
      the five screens with their routes and what each holds, a mapping from every old
      subsection to where its content lives now, and the two things that belong to no
      subsection (the status chips in the header, the legacy-route normalisation). 6.1-6.5
      are left standing rather than rewritten - code comments cite their numbers, and the
      document's habit is to annotate, not to erase. Two divergences the amendment states
      outright rather than papering over: the queue was never made reorderable, and
      `recentPages` is served but rendered nowhere. §6.5's endpoint excerpt was at the M4
      state and now names the families added since.

### Round two fixes (2026-08-25)

- [x] Home scrolled sideways: the activity table used the default `auto` layout, so one long
      file name or a row of page chips widened it past its box. Fixed column widths plus
      `overflow: hidden` on the cells - the event column takes what is left and clips.
- [x] The graph bar's Shortcuts and Fullscreen buttons sat a few pixels short of the search
      field beside them. Every control in `.graph-controls` is now one `--control-h` box.
- [x] The System control column showed one letter per section: `.domrow` is a three-column
      grid (dot | name | count) and those rows had no dot, so the label landed in the 9px
      column. They carry a state dot now, like every other row in that panel.
- [x] Usage: the ingests series was the shared Sparkline (a 74x26 viewBox) stretched to card
      width, which scaled its stroke up with it. A count per day is discrete, so it is bars
      now, with the date span and the peak labelled. The most expensive runs became a real
      table with columns instead of one packed line per row.
- [x] Vault stats: only the domain list scrolls - the figures, growth and index cards stay on
      screen instead of scrolling away with it.
- [x] The library table reformatted itself per domain filter: `.lib-main > table` carried
      `display: block` so the table could scroll as a flex child, and a block-level table
      shrinks to its content - so picking a domain with shorter page titles pulled the
      domain, links and date columns left. A div scrolls around a real table now, with fixed
      column widths; the page column takes the rest, which is the layout the longest titles
      need, and the title itself ellipsizes on one line (full text in the cell tooltip).
- [x] Decided: "clear history" stays scoped to the job rows. The run log is a separate
      record - it is the cost history, and it should not disappear with a click meant to
      tidy the inbox.

## Phase 10: third pass - the vault as a shape, Research as two ledgers (2026-08-26)

Scope from the approved clickable mockup ("Vault Dashboard Redesign", three rounds of
review). Four complaints, all structural:

1. Home was the activity table and nothing else; the vault it is about never appeared.
2. Home's control column read as cramped: seven blocks stacked in one column with nothing
   but air between them, in an order nobody had chosen.
3. Research listed its runs twice - a short list in the rail, a full ledger in the box.
4. The conversations were rail furniture while the runs were a first-class record, though
   from the user's side they are the same kind of thing.

No server change. Every figure was already collected; nothing new is fetched that another
screen did not already fetch (`/graph` is the Graph tab's own query key).

### Home

- [x] **Two zones instead of one table.** Zone 1 is the stock (hero page count, the
      countable facts as a list of doors, and the wikilink graph as a picture); zone 2 is
      the flow (four operational figures as a strip on the activity table, then the stream).
      The eye is led by the rhythm between them, not by a rule between equals.
- [x] **The lead tiles were sorted by what they describe.** `Pages` is stock and leads zone
      1; in-flight, failures, spend and checks are the run of the machine and sit on the
      table they describe. `Ingests · 7d` joined them - a rate belongs next to failures.
- [x] **`components/VaultConstellation.tsx`**: canvas portrait of the graph, reusing the
      Graph tab's layout worker so both screens show one arrangement. It does NOT reuse
      GraphCanvas - that module carries d3-force, and Home is the first screen rendered; the
      domain grouping the worker needs is five lines and is computed locally.
- [x] **It draws knowledge pages only.** With the scaffolding in, the index hub links to
      every page there is and one 800-edge node pulls every domain into a single star.
      `knowledgeSubgraph()` drops the scaffolding and remaps the surviving edges. Tested.
- [x] **Nothing is measured off a force layout**, so every measurable thing is text beside
      it, and the legend counts the DOTS rather than the page census - otherwise it lists
      kinds the picture does not draw.
- [x] **`lib/vaultShape.ts` is the single derivation** behind Home's facts and System's
      vault statistics: links, median degree, domains, unfiled, orphans, stubs, unresolved,
      gaps. System read its own copy of four of them. Tested (8 cases).
- [x] **"Unfiled" fixed while it was being shared.** A page parked in the vault's catch-all
      domain is exactly as unfiled as one with no `domain:` field, so the catch-all no
      longer counts as a domain of its own: the vault reported 18 domains and zero unfiled
      pages while eleven pages sat in the catch-all. Now 17 and 11, on both screens.
- [x] **The rail is in the order the work happens**: intake, then filter / state / channel /
      time, then the queue as a sticky status foot on its own ground - it is not a filter,
      it is the answer to "why is nothing moving".
- [x] The seven job states are a closed set and sit in two columns, one glance instead of a
      scroll; the height that buys goes to the channel list, the one list that grows with
      the vault. The kind hints became pill titles - same information, no column height.
- [x] Verified on the live service at 1760x1010: panel scrollHeight 938 vs client 932, so
      the column fits its window with the foot visible, and no screen scrolls the page.

### Research

- [x] **One place per object.** The rail's run list is gone; the ledger in the box is the
      list, and the detail view has a Back button. The duplicate existed only because
      opening a run replaced the ledger and left no way back - a navigation bug wearing a
      duplicate's clothes.
- [x] **Two ledgers of one shape**: *Web Research* (runs) and *Vault Research*
      (conversations) split the height and scroll on their own. Same table, different
      columns: one files pages and costs fetches, the other cites pages and commits nothing.
- [x] **The modes carry the ledger names** ("Web Research" / "Vault Research"), so the mode
      you arm and the ledger it lands in are named identically.
- [x] **Conversations kept both their actions** in the move: inline rename (no
      `window.prompt` - blocked in installed PWAs) and the two-step delete, revealed on
      hover AND focus-within so a keyboard can still reach them.
- [x] **The backlog stays a band of offers** under the ledgers - cards with a verb on them,
      not a third table - and keeps its own height instead of taking a third of theirs.
- [x] **The rail holds what shapes a run and what the runs add up to**: lens, a lens filter
      over the web ledger, the running totals, and the same queue foot Home has (a run takes
      a queue slot, the same as a drop). Runs whose cost was never recorded are excluded
      from the spend total rather than counted as free; the tile says across how many runs
      the figure holds.
- [x] Dead styles for the two replaced rail lists removed (`.sess*`, `.runrow`, `.backlog`).

### Open

- [ ] **SPEC.md §6 is one pass behind again.** The correction table describes Home as five
      figures plus the stream, and Research as a console plus a run list; Home now leads
      with the vault's own shape, and Research has two ledgers with new mode names. The spec
      is not edited here (it is edited on request only) - proposed as a follow-up, the same
      shape as the 2026-08-26 correction.
- [ ] The hero page count and the last line of the metric list both read 805. That is what
      the approved mockup asked for; worth revisiting if it reads as a duplicate in daily use.

## Phase 11: fourth pass - the panel, the rows, the entrance (2026-08-27)

Six changes asked for from daily use, plus one measurement. No server change; every figure
comes from a payload the screen already fetches.

### Home - the stock zone

- [x] **Domains is the default second panel**, and Growth is gone as a view. A number per
      window is not a picture: the two figures its foot carried are now two more lines in
      the hero's metric list (`new pages (7d)`, `new pages (30d)`), and the chart they came
      from is still in System → Vault stats, where it always was. `GrowthChart` loses its
      `panel` variant with it (and `.plotbox`, `.chart.fill/.spark`, `.gx*` with that).
- [x] **`lib/homePanels.ts: newPagesIn()`** replaces two index-based reads of the growth
      series ("the eighth-from-last point is a week back"). The server emits a point per day
      the vault MOVED, so on a quiet week that point can be a month old; the baseline is now
      the newest point on or before `today - days`. The hero delta and both new lines read
      the one derivation, so they cannot drift apart. Tested in `web/test/homePanels.test.ts`.
- [x] **The second panel sits in the graph's own dark inset** (`.vz-body.inset`) - all three
      views, so switching them changes the content and nothing else. Border and padding sit
      inside the fixed body height, so nothing below the zone moves.
- [x] **The constellation is drawn finer**: dot radius `0.8 + min(2.1, √degree · 0.3)`, down
      from `1.4 + min(3.2, √degree · 0.42)`, and hairline links. Eight hundred pages in a
      460px box is a dot every fifteen pixels - at the old radii a cluster merged into one
      blob and the picture claimed less than it knows.

### Home - the control column and the rows

- [x] **The queue foot and the stream search are gone.** The lead tiles already answer "what
      is in flight, and why is nothing moving"; the search was never used. The height goes to
      the two pill groups, which now read the way Research files its lens filter: one row per
      option, label left, count right - and the count is what that pill would leave on the
      table, every other axis of the filter still applied.
- [x] **Order follows the narrowing**: kind, from when, in what state, over which channel.
      The channel list is last because it is the one section that grows with the vault: it
      takes the leftover height and scrolls, and nothing under it can be pushed out of sight.
      The four time ranges are two per row (`.pillrow.stacked.two`) - four short labels are
      not worth four rows of a column the channel list is measured out of.
- [x] **A row opens where you click it.** The page-chip band stopped every click that landed
      on it, and on a three-chip ingest that band is most of the row - so "click a row" meant
      "hit the title line". The chips stop their own clicks now (in `PageLink`, where the
      links are), and the air around them belongs to the row.
- [x] **A settled run opens its record in place**, like every other row in the table. It used
      to navigate - research to the run list, everything else to System - which answered a
      question the row had not been asked. Live runs still navigate: a run in flight has no
      record yet, and the tab it came from is where its progress is.

### Graph

- [x] **The entrance runs on every rebuild, not just the first.** Clearing a filter re-lays
      the graph out AND re-fits it, and the fit was applied to the still-cooling layout: the
      half-settled graph was on screen for the second or so of cooling, then cut to the
      build-in - the graph appeared twice. The fit effect now arms the same hold the first
      layout arms, so a rebuild always starts from an empty canvas and builds itself in.
      Live vault updates are deliberately NOT armed: they keep the camera and reheat gently,
      and blanking the whole graph because one page arrived is a worse flicker than the one
      this fixes. Measured on the live service by sampling canvas ink: `12.5% → 0 → 2.1 →
      5.9 → 8.2 → 12.4%` across a filter toggle, with no full-ink frame before the zero.

### Finding: "links to pages that do not exist" counts something else than the gaps view

Home's metric list reads **54**; the gaps view in the Graph tab reads **12 unresolved links ·
10 distinct targets**; the Graph tab's own top bar offers "54 gaps". Two of those three are
the same number under a name that does not fit it.

Both come from `GET /api/v1/graph`: `unresolved` counts every wikilink occurrence that
resolves to no page, while `gaps` only lists targets worth WRITING. Reproduced against the
live vault (833 pages, 8,735 links), the 54 break down as:

| what | count | why it is not a gap |
| --- | --- | --- |
| `.raw/…` provenance links from source pages | 21 | path-qualified staging references, not pages |
| links quoted by artifact pages (lint reports, session logs, folds) | 17 | they report dangling links, they do not want them written |
| plugin-shipped doc pages linking into upstream docs | 4 | upstream's gaps; agent runs may not edit those pages |
| embeds (`![[…]]`) | 0 | a missing image is not a page to write |
| **real content gaps** | **12** | 10 distinct targets - what the gaps view lists |

So the server is right and the two labels are wrong: 54 is "dangling wikilinks", of which 42
are structural and nobody's backlog. Applied on request (2026-08-27) - the server is
unchanged, only what the three places COUNT and call it:

- [x] Home's line reads `10 pages linked but not written`, with the raw 54 and why it differs
      in its title. It is a door to the gaps view; a door may not disagree with the room.
- [x] The Graph top bar's "54 gaps" reads `graph.gaps.length` - it opens the gap list, and it
      said 54 over a list of ten.
- [x] The gaps panel's foot says `10 pages linked but not written`, not "links" - the head of
      the gaps view next door counts the links behind them separately (12 links · 10 pages).
- [x] System's Gaps figure already read `shape.gaps`; all four now agree.

### Also in this pass (2026-08-27)

- [x] **The hero delta is gone.** "▲ 151 in the last 7 days" said exactly what the metric
      list under it now says by name (`151 new pages (7d)`), six pixels away. `.vz-delta`
      removed with it.
- [x] **The detail view's WROTE band holds two rows without scrolling** (69px = 2 × 26px chip
      + 5px row gap + 12px padding, was 57px). Two rows is the common case for an ingest that
      wrote four or five pages, and it always carried a scrollbar for the twelve pixels it was
      short. A third row scrolls, which is where scrolling belongs.
- [x] **A domain bar opens the Library filtered to that domain** (`/library?domain=…`,
      consumed and dropped from the URL like the graph's `?gaps=1`, for the same reasons).
      The other narrowing filters are cleared with it - they are whatever the screen was last
      left at, and a leftover type or search would answer a different question than the bar
      was clicked to ask. The active row is scrolled into view: a filter set from another
      screen has to be visible as a filter, not just as a shorter table.
- [x] Fixed while there: Home's gap cards navigated to `/research?topic=`, which nothing
      reads - the composer opened empty. Research reads `?prefill=`.
