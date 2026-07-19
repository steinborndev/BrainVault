# BrainVault dashboard — design conventions

The goal: switching tabs must feel like moving inside ONE application. These conventions
are what every tab follows; new UI goes through this list before it ships.

## Layout

- **Content lane:** text tabs live in a centered 1080 px lane (`.content`); the vault
  graph is the only view that widens it (1600 px). The Research thread uses an 860 px
  reading lane *inside* its tab.
- **Vertical rhythm:** sections stack with 20 px gaps (`.section`); cards use
  `.card.card-pad` (16/18 px padding). No ad-hoc margins between siblings.
- **Above the fold:** the Overview must fit a laptop viewport without scrolling —
  lists are capped (10 pages / 6 commits), the hot cache is a collapsed `<details>`.
  Any new overview widget has to justify its vertical budget.

## Structure per tab

- A tab is either **card sections** (Overview, Maintenance), a **header + card list**
  (Ingestion: section head, then `.job.card`s), or a **fixed-height column** (Research:
  session bar / scrolling thread / composer; Vault: toolbar / canvas / footer).
- Section headings are always `.section-title` (11–13 px uppercase, faint). No other
  heading style inside tabs.
- Canvas-like areas (the graph) carry their controls **on** the canvas:
  zoom top-left, search top-right, status bottom-right, tooltip bottom-left.

## Interaction language

- **Chips** are the filter/selection vocabulary. `active` (accent) = visible/selected.
  Facet chips are **solo-selects**: clicking one shows *only* it; clicks accumulate;
  empty selection = everything (vault domains). Rarely-needed filter sets fold into a
  `.dropdown` with checkboxes (= visible) instead of a permanent chip row (page types).
- **Buttons:** exactly one `.btn.primary` per view — the main action. Secondary actions
  are `.btn`, tertiary/icon actions `.btn.ghost`.
- **Destructive actions** are a two-step confirm on the button itself (arm → 3–4 s window
  → confirm). Never `window.confirm`. The armed state is unmistakable: `.btn.armed`
  (red fill) with a visible countdown where the wait is long enough to matter. In a
  crowded header row, destructive/rare actions move into a `⋯` overflow menu (`.omenu`)
  instead of sitting as bare icons next to safe actions.
- **One state, one control:** mutually exclusive values (graph focus depth) render as a
  segmented control (`.seg`), not a row of independent chips.
- **Composer pattern:** input areas are one bordered card (`:focus-within` accent) that
  contains its mode switches and its submit button — no floating control rows. A mode
  with side effects (Research: web access + vault writes) wears its own accent
  (`--research`) plus a hint line while armed — it must not look like a harmless filter.
- **Global status lives in the topbar:** the connection pill opens the service-status
  popover (watcher, queue, budget, vault); the Ingestion tab carries an activity badge.
  Tabs don't re-invent their own service-status corners.

## Explanations & tooltips

- Explanatory text goes through the `<Tip>` component (ⓘ icon; hover, focus AND tap) at
  the section/tool title — never a native `title=` attribute (invisible on touch,
  unreachable by keyboard) and never a permanent `.tab-hint` paragraph when a tooltip
  will do. `title=` remains fine for pure redundancy (an icon button that also has a
  visible label elsewhere, absolute timestamps behind relative ones).
- Tool cards (Maintenance) share one anatomy: `.section-head` with title + `<Tip>`,
  action button top-right, then a `.tool-meta` line carrying durable facts (last run,
  last report, registry link) that survive tab switches and restarts.

## Feedback & state

- Empty/loading/error states use `.empty` (centered, faint) and always offer the next
  step (retry button, "ingest your first file →").
- Outcomes render as `.toast.ok/.warn/.err` directly below the triggering control.
- Long-running agent runs stream into `.log` (JobLog) next to the button that started them.
- Times are relative (`timeAgo`), with the absolute timestamp in `title`. Costs always go
  through `<Cost>` so the subscription-estimate marking can't be forgotten.

## Language & theme

- **UI language is English only** — strings, aria-labels, tooltips, locales (`en-US`).
- Colors come exclusively from the CSS variables in `styles.css` (theme-aware, light +
  dark). Domain colors are the hash-derived `domainColor()`; never hardcode hues.

## State survival

- Tab panels stay mounted (`[hidden]`), so in-tab state (graph camera, active session,
  filters, scroll) survives switching. Anything that must survive a full unmount
  (the graph camera across graph ↔ page view) persists at module level.
- Routes: every view is deep-linkable; renamed routes keep a legacy alias that
  normalizes via `replaceState` (`/wartung` → `/maintenance`, `/chat` → `/research`).
