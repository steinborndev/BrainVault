# BrainVault dashboard - design conventions

The goal: moving between areas must feel like moving inside ONE application. These
conventions are what every screen follows; new UI goes through this list before it ships.

Rewritten for the 2026-08 redesign (sidebar shell, 7 screens). The findings that motivated
it are in the frontend deep review; the task list is `docs/tasks/TASKS-REDESIGN.md`.

## Shell and navigation

- **Sidebar, three groups:** *Knowledge* is what you browse (Library, Graph), *Work* is what
  you do (Research, Inbox), *System* is what you tend and configure (Health, Settings). Home
  sits above the groups. A new screen has to belong to one of the three, or the grouping is
  wrong.
- **The topbar carries context, not navigation:** the current screen name (the app's single
  `h1`) plus a short state line, the global-search trigger, the live pill. Screens never
  re-invent their own service-status corner - the live pill's popover is the one home for
  watcher / queue / budget / vault / last commit.
- **Sidebar badges own attention:** Inbox shows outstanding jobs (pulsing while running),
  Health shows due/soon. Both stay silent when there is nothing to say.
- **Ctrl+K reaches everything:** pages (from the shared graph query), navigation, and a
  research handoff for the typed topic. Anything that spends money keeps its own consent
  surface and stays out of the palette.
- **Routes:** `/`, `/library`, `/graph`, `/page/<path>`, `/research`, `/inbox`, `/health`,
  `/settings`. Every view is deep-linkable; renamed routes keep a prefix alias that
  normalizes via `replaceState` (`/vault` → `/graph`, `/ingestion` → `/inbox`,
  `/maintenance` → `/health`, `/chat` → `/research`).
- **Desktop-only for now.** Below ~1000px the shell scrolls horizontally rather than
  degrading into a mobile layout.

## Layout

- **Content lane:** screens live in a centered 1180px lane; the graph widens to 1620px
  (`.lane.wide`). The Research thread keeps an 860px reading lane inside its screen.
- **Each screen owns its scroll** (`.screen` is the scroll container), so switching areas
  never resets where you were.
- **Vertical rhythm:** sections stack with 20px gaps (`.section`); cards use
  `.card.card-pad` (16/18px padding). No ad-hoc margins between siblings.
- **Canvas-like areas** (the graph) carry their controls ON the canvas: zoom top-left,
  search top-right, legend bottom-right, trail bottom-left. Panels beside a canvas **dock**
  (the canvas shrinks) - they never overlay a corner that holds a control.

## Type and color

- **Faces:** Bricolage Grotesque for display landmarks (brand, screen title, stat values),
  Instrument Sans for the UI, IBM Plex Mono for data (logs, hashes, paths). All self-hosted
  via `@fontsource` - no CDN, the PWA stays offline-capable.
- **Body text is 14px.** Section labels are the 11px uppercase micro-label; anything below
  11px is a bug, not a density choice.
- **Colors come exclusively from the CSS variables** in `styles.css`, never raw hex in a
  component. Token names are stable so components keep working when the palette moves.
- **Three separate color roles, never mixed:**
  - *Status* (`--ok/--warn/--err/--busy` + their `-bg` pairs): health, outcome, urgency.
  - *Categorical* (`--type-*` for page buckets, `domainColor()` for domains): identity, no
    judgement. A source is not a warning.
  - *Brand* (`--gold`): the mark, the Home "now" edge. Never a status.
- **`--research` (violet) is a risk signal:** the mode that reaches the web and writes vault
  pages wears it across composer border, plan line and send button. It must never look like
  a harmless filter.
- **`--accent-ink`** is the text color on accent fills - the dark theme's accent is light, so
  white-on-accent would wash out.

## Interaction language

- **Chips** are the filter/selection vocabulary. `active` (accent) = visible/selected. Facet
  chips are **solo-selects**: clicking one shows *only* it; clicks accumulate; empty
  selection = everything. Rarely-needed filter sets fold into a `.dropdown` with checkboxes.
- **Segmented controls** (`.seg`) hold mutually exclusive values (sort order, focus depth).
  Rectangular = view control, round = filter: the shape difference is the distinction.
- **Buttons:** exactly one `.btn.primary` per view - the main action. Secondary actions are
  `.btn`, tertiary/icon actions `.btn.ghost`.
- **Destructive actions** are a two-step confirm on the button itself (arm → 3-4s window →
  confirm). Never `window.confirm`. The armed state is unmistakable: `.btn.armed` (red fill)
  with a visible countdown, and it names **exactly what it will delete** - not what happens
  to be on screen.
- **Unsaved work is never dropped silently.** The page editor shows a dirty badge, arms its
  Cancel, guards `beforeunload`, and every in-app exit asks first.
- **Composer pattern:** input areas are one bordered card (`:focus-within` accent) that
  contains its mode switches and its submit button. Consent detail that must stay visible
  while typing collapses to ONE line (the research plan: lens, target title, fetch cap, one
  commit); the picker behind it opens as a popover.
- **Tables are for scanning, drawers for depth.** A list row carries what you compare on;
  everything else (hashes, exact times, full log, destructive actions) lives in the drawer
  the row opens.
- **Every reference is a link.** A cross-reference described in prose ("see the Domains
  card") is a bug: wire it.

## Explanations and tooltips

- Explanatory text goes through the `<Tip>` component (ⓘ icon; hover, focus AND tap) at the
  section/tool title - never a native `title=` attribute for meaning (invisible on touch,
  unreachable by keyboard). `title=` remains fine for pure redundancy (an icon button that
  also has a visible label elsewhere, absolute timestamps behind relative ones).
- Tool cards (Health) share one anatomy: `.section-head` with title + `<Tip>`, action button
  top-right, then a meta line carrying durable facts (last run, last report, registry link)
  that survive screen switches and restarts.
- **Evidence before consent:** a button that mutates on the basis of a stored artifact shows
  that artifact where the click happens (the lint report under "Fix safe findings").

## Feedback and state

- Empty/loading/error states use `.empty` (centered, faint) and always offer the next step
  (retry button, "ingest your first file"). **A failed query offers a retry** - never an
  indefinite "Checking…".
- Outcomes render as `.toast.ok/.warn/.err` directly below the triggering control. Success
  toasts that are pure FYI dismiss themselves; errors stay.
- Long-running agent runs stream into `.log` (JobLog) next to the button that started them.
- Times are relative (`timeAgo`), with the absolute timestamp in `title` or in the drawer.
  Costs always go through `<Cost>` so the subscription-estimate marking can't be forgotten,
  and **every run that costs money shows what it cost**.
- Numbers must be honest about their source: a windowed count says so next to the all-time
  count rather than quietly capping.

## State survival

- Screens stay mounted (`[hidden]`), so in-screen state (graph camera, active session,
  filters, scroll) survives switching. Anything that must survive a full unmount (the graph
  camera across graph ↔ page view) persists at module level.
- Expensive reactions are debounced, not run per keystroke (graph search: 220ms before the
  subgraph, community detection and camera refit react).
- Client-driven sequences (the guided run) refresh the data their next step derives from
  when a step settles - dependency order has to hold at the data layer, not just in the UI.

## Language

- **UI language is English only** - strings, aria-labels, tooltips, locales (`en-US`).
- **Regular hyphens, never em or en dashes**, in UI strings, comments and docs alike.
