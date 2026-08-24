# Tasks: Dashboard redesign (sidebar shell, 8 areas)

Source of truth for scope: the approved clickable mockup (artifact "BrainVault Redesign",
2026-08-23) and the frontend deep-review findings (artifact "BrainVault Frontend Review").
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

Source of truth: the clickable mockup "BrainVault Redesign" (artifact, revised 2026-08-24)
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

Source of truth: the approved clickable mockup ("BrainVault UI Rework", 2026-08-24), six
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
