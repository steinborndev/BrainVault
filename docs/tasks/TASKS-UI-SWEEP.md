# Tasks: cross-tab consistency sweep (2026-08-25)

Follow-up to the shell redesign (`TASKS-REDESIGN.md`). That work unified the *macro*
structure - every screen is now a control column plus one content box. This sweep is about
what sits inside that structure: three redesign rounds left three parallel vocabularies for
cards, status pills, tables and empty states, plus a handful of CSS rules whose context
container was renamed out from under them.

Scope: `web/src` only. No server change, no endpoint change, no data-layer change. The
invariants listed in `TASKS-REDESIGN.md` still hold - in particular the status colour pairs,
the research violet, the armed two-step destructives, the cost-estimate discipline
(SPEC.md 7.1) and the mounted-but-hidden screens.

Findings come from a full read of the five tab files, the shared components and all 5786
lines of `styles.css`.

## Package 1: defects

CSS rules whose ancestor selector no longer exists in the TSX, so the class renders but
never matches. These are visual bugs, not style opinions.

- [x] `.meter` is only defined as `.gx-gaprow .meter`; `System.tsx` renders the daily-budget
      bar outside that context, so the bar has no height, no track and no fill. The orphaned
      `.budget-fill.over` rule is what it used to hang on. Free-standing `.meter` + `.meter i`
      + `.meter i.over`.
- [x] `.btn.sm` is used in six places (Home "Load older", Research "Run again"/"Research",
      Dropzone, two ActivityRows actions) and defined nowhere - every "small" button renders
      full size. Define it.
- [x] `.mono-meta` is only defined as `.fmeta .mono-meta`; `.fmeta` is gone. Used for the
      commit hash in the activity table and "Filed as" in the run detail.
- [x] `.lens-tag` is only defined as `.research-head .lens-tag`; `.research-head` is gone.
      Used in the activity table and the run detail.
- [x] `.bucket` is only defined under `.pagelink` / `.graph-search-results`; the article head
      in `Vault.tsx` renders it bare.
- [x] `Chat.tsx` formats the run cost as a raw `$x.toFixed(2)`, bypassing `<Cost>` and with it
      the subscription-estimate marking SPEC.md 7.1 requires. `Maintenance.tsx` has the same
      precision mismatch against `usd()` (which uses three decimals below $1).

## Package 2: loading and error states

Two screens report a failed query as something other than a failure.

- [x] `Home`: no `isError` handling at all. A failed `/jobs` renders "Nothing yet - drop a
      file on the left and it starts here", i.e. an API error looks like an empty vault. The
      glance tiles stay on their `…` placeholder.
- [x] `System`: no `isError` anywhere in the file. Both sections gate on
      `stats.data === undefined`, so an error renders "Loading usage…" forever.
- [x] `Research`: query errors (sessions, runs, graph) are silent; only mutation errors show.
- [x] `SettingsEditor`: loading uses `tab-hint` where every other screen uses `empty`; the
      error has no retry.
- [x] Extract the pattern Library and Graph already implement (loading → `empty`,
      error → `empty` + retry button) into one shared piece and use it on all five screens.

## Package 3: tables

Four `.dtable` variants with four separately-declared layouts.

- [x] `table-layout: fixed` is set four times (`.box-body > .dtable`, `.runtable`,
      `.sv-scroll > .dtable`, `.lib-table`) and sticky `thead` three times over three
      different ancestors. Both belong on `.dtable` once; per-table rules keep only their
      column widths.
- [x] `.dtable tbody tr { cursor: pointer }` applies globally, including to tables with no
      row action; `.runtable` has to take it back. Make the pointer opt-in.
- [x] Row interaction is inconsistent: Home has `onClick` + `onKeyDown` + `tabIndex` +
      `aria-label`, Research has `tabIndex` without a key handler (focusable, Enter does
      nothing), Library has a click handler and nothing else (unreachable by keyboard).
      Lift Home's pattern into a shared row wrapper.
- [x] The "when" column is left-aligned in three tables and right-aligned in `runtable`
      (it carries `th.num`). Pick left, since it is not a quantity.
- [x] `.box-foot` (9px/14px, 12px) and `.dtable-foot` (10px/14px, 12.5px) are the same
      element in two dialects. Collapse to one.
- [x] Wording: "Changed" vs "When" for the same column; "Load older" vs "Show more" for the
      same gesture.

## Package 4: cards and tiles

- [x] System renders two card languages side by side: `Status & checks` pulls in
      `Maintenance` with `.card.card-pad` + `.section-head` + `.section-title` (uppercase,
      13px), while `Usage & cost` next to it uses `.subcard` + `.sc-head` + `.sc-title`
      (12.5px, sentence case). Different padding (16/18 vs 9/13), different radius, one has
      a shadow. Move Maintenance onto the subcard family.
- [x] `.glance-tile` (Home) and `.fact` (System, Research) are the same k/v/s component with
      six divergent values (value 20 vs 16px, sub 11.5 vs 11px, padding 14 vs 12px, gap 2 vs
      1px, letter-spacing .09 vs .08em, separator border-right vs grid gap). One component,
      one `size` variant.
- [x] `.box` has no shadow, `.lib-main` does - the Library box sits differently on the ground
      than the three screens beside it. Same for the border radius chain.
- [x] `.kv` is defined twice with incompatible layouts (grid for `dt`/`dd` at 4544, flex with
      `.k`/`.v` at 5402); the second wins globally. Key-value exists a third time as
      `.settings-ro-row` and a fourth as `.tool-meta`.

## Package 5: status vocabulary and panel grammar

- [x] Four pill families for one concept, all `border-radius: 999px`: `.badge` (12px/600,
      leading dot), `.sev` (11px/650 uppercase), `.hrow-state` (10.5px/600),
      `.lt-flag` (10.5px/600). "due" is `badge.deferred` on one screen and `sev.due` on the
      next. Collapse onto `.badge` plus modifiers.
- [x] Thirteen status-dot definitions in four sizes (6/7/8/9px). Visible where two of them
      stack: Home's panel has `hrow-dot` (8px) in the state list and `dot` (9px) in the
      channel list directly below, in identical `.domrow` rows; System's panel has the same
      pair the other way round. One token.
- [x] Page-type label exists four times: `.badge.type`, `.lt-bucket`, `.gx-kicker`, `.bucket`.
- [x] Panel grammar: search is at the panel top on Home and Library, in the canvas bar on
      Graph, absent on Research and System. Reset sits in section 3 on Home, section 2 on
      Library, section 1 on Graph, nowhere else. `gp-state` is a value ("all", "Concepts") on
      three screens and a count on Research.
- [x] `--control-h` exists but is applied in three places only. Rows that mix `.btn` (~31px)
      and `.btn.ghost` (~27px) sit unaligned on Home's box head, Library's panel head,
      Research's detail head and the article head.
- [x] The scope line ("what am I showing, how much of it") appears in four places with four
      classes: `box-sub` + `box-foot` (Home), `dtable-foot` (Library), `scopeline` in the
      canvas bar (Graph), `sub-head` with a trailing count (Research). System has none.

## Package 6: CSS consolidation

- [x] 25+ selectors are defined twice or more (`.gpanel`, `.typechips`, `.library`,
      `.graph-workspace` 3x, `.setting` 3x, `.tab-badge`, `.kv`, `.lib-main`, `.sess`, …).
      The cause is that recent rounds were appended as blocks at the end of the file instead
      of edited at their origin. Merge each pair at its origin.
- [x] `.workspace`, `.library`/`.inbox` and `.graph-workspace` are character-identical grid
      definitions (`--gpanel-w` + `minmax(0,1fr)`, gap 12, padding 12/14). One definition.
- [x] Graph is the only screen that still has a `.ws-bar` spanning both columns (the cluster
      and focus rows). It appears conditionally and pushes both columns down, which is what
      the redesign note in styles.css calls abolished. Decide: keep as a documented exception
      or move into the canvas bar.

## Done, with what changed where

**Package 1** - `.meter` + `.meter i` + `.meter i.over` free-standing (the budget bar renders);
`.btn.sm` defined (24px); `.mono-meta`, `.lens-tag`, `.bucket` freed from ancestors that no
longer exist; `.btn.research` freed from `.primary` and the dead `.btn.research-btn` dropped
(the backlog's Research button was grey, not violet); `<Cost>` in the research run table and
`usd()` in the guided run.

**Package 2** - `components/QueryState.tsx`: one loading/failed/ready block plus `merge()` for
screens fed by several queries. Wired into Home (the table's fallback row, and the tiles now
show `-` rather than `…` once stats failed), System (both sections), Research (run list and
backlog), Library, Graph, SettingsEditor. Library and Graph also stopped early-returning over
the whole screen, so a retry no longer makes the workspace jump.

**Package 3** - `table-layout: fixed`, the sticky header and `td { overflow: hidden }` moved
onto `.dtable`; four and three respective duplicates removed. `cursor: pointer` is now
`tbody tr[tabindex]`, i.e. exactly the rows `openableRow()` made focusable, so `.runtable` no
longer has to take it back. `lib/tableRow.ts` gives all three interactive tables the same
click + Enter + tab stop + label. "When" is left-aligned everywhere. One `.box-foot`.

**Package 4** - Library is a plain `.workspace` with a `.box`; `.library`, `.lib-main`,
`.tscroll` and the whole dead `.inbox` layout family are gone, and with them the drop shadow
that made the Library box sit differently from the other three. `components/Fact.tsx` replaces
`.glance-tile` and System's local `Fact`, in two densities. `.kv` split into `.kv` (System's
one-line rows) and `.deflist` (the job drawer's real `<dl>`, which had been rendering every
dt/dd pair side by side on one line). Maintenance's fourteen `.card.card-pad` tools are
`.subcard.sc-pad`, so System's five sections are one card language.

**Package 5** - `--dot` / `--dot-sm` replace thirteen dot declarations in four sizes. The four
pill families share one geometry block and one colour table; their NAMES stay, because
`sev.due` and `hrow-state.failed` say different things and only the visual drift was
accidental. `.lt-bucket` folded into `.badge.type`. `--control-h` is on `.btn` itself, so a
`.btn` and a `.btn.ghost` in one row are finally the same box.

**Package 6** - `.workspace` is the only workspace grid; the graph keeps two documented
departures (it grows inside a flex column, and it is the one screen with a bar spanning both
columns). Four drifted duplicate selectors merged at their origin. 58 rules with no call site
left removed - the old Home feed, the step strip, the lens popover, the progress rail - which
is where most of the drift came from: they were still being read as precedent.

## What went wrong on the way, and what now prevents it

**The shared query state was written as a component, and that blanked every screen.**
`<QueryState … />` is a React *element*, so it is truthy even when the component renders
nothing. Every call site read `state ?? content` or `if (state !== null) return state`, so all
five screens rendered the empty state instead of their content: the graph canvas, the library
table, the research run list and backlog, the settings form. TypeScript cannot catch it -
`ReactElement | null` is the return type of the function, while the JSX expression has type
`ReactElement`. `npm run build` and the unit tests were green throughout.

Fixed by making it a function you call (`queryState(q, what)`), where the null is real.
`test/queryState.test.ts` pins both halves: the contract (null when ready) and the shape of
the call sites (a source scan that fails if anyone writes `<QueryState` again).

**The lesson for this repo:** a green build says nothing about whether a screen renders. The
sweep was verified against `tsc`, `vite build` and 789 unit tests, and shipped five blank
screens. What found it was a browser. The `scripts/probe-screens.mjs` helper added here drives
the headless Chromium already in the Playwright cache over CDP, opens each route and reports
what actually rendered (rows, canvas, cards, visible height). It needs the service running and
`node --experimental-websocket` on Node 20.

**A dead-CSS sweep by pattern nearly cost `styles.css`.** A script that removed rules whose
class had no call site also walked backwards over the preceding comment to remove it, and took
2298 lines with it instead of the intended ~270. Recovered by resetting the file and replaying
every package's CSS with assertions. The second attempt was line-based with no comment
handling. Anything that edits this file in bulk needs a diff check on the line count before
it is believed.

## Checked and deliberately left alone

- **"Changed" vs "When" as a column head.** Not drift: Library lists pages by modification
  time, the other three list events by when they happened. Different facts, different words.
- **"Load older" vs "Show more".** Also not drift: Home fetches a larger window from the
  server, Library reveals more of what it already holds. Same-looking gesture, different
  operation, and the labels say which.
- **The graph's search living in the canvas bar rather than the panel.** Its results land on
  the canvas and drop out of the field; moving it into the panel would separate the control
  from its effect.
- **System has no scope line.** It shows sections, not a filtered list, so there is nothing to
  count.
- **`.sev` / `.hrow-state` / `.lt-flag` keep their names** (see package 5).

## Verification

- `npm run build` (tsc + vite) clean; 629 server + 166 web tests pass.
- All five screens rendered in headless Chromium after the fix: Home 12 rows + 5 figures,
  Research 12 rows, Graph a 312px canvas + 29 panel rows, Library 50 rows + 32 panel rows,
  System all five sections (4/5 subcards, 5 settings rows, the integrations forms).
- CSS 94.8 kB → 88.6 kB (gzip 17.0 → 16.1 kB).
- Duplicate top-level selectors more than 300 lines apart: 5 → 0.
- Service restarted on 8420, dashboard answers 200.

## Left open

- ~30 further dead class names remain in `styles.css` (mostly one- and two-rule fragments).
  They were left because the automated check cannot tell a genuinely unused class from one
  assembled at runtime (`verdict-${…}`), and a scripted sweep over them is what nearly cost
  this file - it has to be done by reading, not by pattern.
- A visual pass over all five screens in both themes is still worth doing by hand; the build
  and the tests cannot see a 2px seam.

## Not in scope

- Touch and mobile (desktop-only for now, per the standing decision).
- Graph canvas internals (forces, layout worker, hit testing).
- SPEC.md section 6 amendment - tracked in `TASKS-REDESIGN.md`.

## Definition of done

- `npm run build` in `web/` passes (tsc + vite).
- Every package's boxes ticked, or explicitly deferred with a reason written here.
- No new `!important`, no new duplicate selector.
- The five screens still switch without shifting the content edge.
