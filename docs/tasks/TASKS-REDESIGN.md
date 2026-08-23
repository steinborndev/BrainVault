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
