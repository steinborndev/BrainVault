/**
 * Maintenance runs (SPEC.md §6.4, TASKS-M4 §2): lint, autoresearch, hot-cache refresh. Each
 * is a vault-mutating agent run, so — unlike chat — it goes through the SAME commit
 * discipline as ingest: a shared commit mutex (one writer) and a per-run commit. Progress is
 * streamed live to the dashboard over the event bus under a stable per-kind channel id
 * (`maintenance:lint` etc.), which the Wartung tab renders as a live log.
 *
 * Runs are ASYNC/job-style (TASKS-M5 §0): `start*()` registers a run, kicks it off in the
 * background and returns a `runId` immediately — the HTTP request is NOT held for the (up to
 * 15-min) agent run, so a slow or stuck lint can no longer wedge the request or a worker. The
 * caller polls `getRun(id)` for the result while watching the live log on the bus channel.
 * A stuck run is now bounded by the agent runner's hard, group-level kill (Finding F1).
 *
 * Profiles (permissions.ts): lint + hot-cache use `ingest` (write, no web); autoresearch
 * uses `research` (write AND web egress — the one flow allowed the web, CLAUDE.md hard rule 4).
 */

import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { runAgent, type AgentAuth, type AgentRunResult, DEFAULT_TIMEOUT_MS } from './agent-runner.js'
import { ENTITY_NOTABILITY_RULES, PAGE_HYGIENE_CHECKLIST } from './system-prompt.js'
import { formatMessage } from './format-message.js'
import { commitVault, dirtyPaths, newWikiPaths, BOOKKEEPING_PATHS, type CommitResult, type CommitOptions } from './git.js'
import { RunRegistry } from './run-registry.js'
import { extractWrittenPaths } from './written-paths.js'
import { parseLintReport, type LintReport } from './lint-report.js'
import { readDomainRegistry, domainSystemPrompt, DOMAIN_REGISTRY_PATH, UNASSIGNED } from './domains.js'
import { parseDomainReview, DOMAIN_REVIEW_FORMAT, type DomainReview } from './domain-review.js'
import type { DomainCandidate } from './domain-candidates.js'
import { indexWikiPages } from './citations.js'
import { findRelatedPages, renderOverlapBlock } from './related-pages.js'
import type { Validator } from './validator.js'
import type { EventBus } from './events.js'
import { Mutex } from '../util/mutex.js'

/**
 * `save` is the chat's "Session in Vault sichern" (SPEC.md §6.3), not a Wartung-tab action — but
 * it is the same shape: a vault-mutating agent run that must hold the same commit discipline.
 * Sharing this runner also shares its run mutex, which is what stops a save interleaving with a
 * lint; two concurrent vault writers is exactly what that mutex exists to prevent.
 */
export type MaintenanceKind =
  | 'lint'
  | 'lint-fix'
  | 'research'
  | 'hot-cache'
  | 'save'
  | 'domain-backfill'
  | 'domain-review'
  | 'cleanup'
  | 'repair'

/**
 * One user-selected graph-repair task (SPEC.md §12.4 graph view). `connect` = an isolated
 * page that should be woven into the graph; `edge` = an existing link flagged as possibly
 * incidental (e.g. the single edge between two otherwise unconnected domains). The route
 * validates every path against the live graph before this reaches a prompt.
 */
export type RepairTask =
  | { readonly kind: 'connect'; readonly path: string; readonly reason?: string }
  | { readonly kind: 'edge'; readonly from: string; readonly to: string; readonly reason?: string }

/** Thrown by `startDomainBackfill` when the vault has no registry installed → HTTP 409. */
export class DomainRegistryMissingError extends Error {
  override readonly name = 'DomainRegistryMissingError'
}

/** Thrown by `startLintFix` when the vault has no lint report to fix against → HTTP 409. */
export class LintReportMissingError extends Error {
  override readonly name = 'LintReportMissingError'
}

/** Stable SSE channel id per kind, so the UI can subscribe to a run's live log. */
export const maintenanceChannel = (kind: MaintenanceKind): string => `maintenance:${kind}`

/** Injectable agent runner (tests supply a fake — no real SDK). Matches runAgent's shape. */
export type MaintenanceAgentRunner = typeof runAgent

export interface MaintenanceRunnerOptions {
  readonly vaultRoot: string
  /** `null` in setup mode (no credential yet): runs are refused at the route with a 503. */
  readonly auth: AgentAuth | null
  readonly events: EventBus
  /** Shared with the ingest queue so commits never interleave (TASKS-M4 §2). */
  readonly commitMutex: Mutex
  readonly runAgent?: MaintenanceAgentRunner
  readonly commit?: (vaultRoot: string, message: string, opts?: CommitOptions) => Promise<CommitResult>
  readonly timeoutMs?: number
  /**
   * Shared with the ingest queue so each side can tell whether it is the sole vault writer
   * (finding F4). Defaults to a private registry when this runner is the only writer.
   */
  readonly runRegistry?: RunRegistry
  /**
   * Post-run validator (validator.ts), same instance the queue uses: deterministic checks
   * over the pages a run touched, streamed as warnings on the run's channel. Advisory only.
   */
  readonly validate?: Validator
}

export interface MaintenanceResult {
  readonly ok: boolean
  readonly kind: MaintenanceKind
  /** Committed wiki pages touched by the run (from the commit). */
  readonly pages: string[]
  readonly usage: AgentRunResult['usage']
  readonly error?: string
  /** The agent's final text — a summary/fallback the UI can render as markdown. */
  readonly answer?: string
  /** Present for a lint run: the parsed report (from the written file, or the answer text). */
  readonly lint?: LintReport
  /** Where the lint report was written (vault-relative), if a file was found. */
  readonly reportPath?: string
  /** Present for a domain-review run: the agent's verdict per candidate. */
  readonly domainReview?: DomainReview
}

export type MaintenanceRunStatus = 'running' | 'done' | 'error'

/**
 * A tracked async run. `start*()` returns this immediately (status `running`); the client
 * polls `getRun(id)` until it settles to `done`/`error`, at which point `result` is present.
 */
export interface MaintenanceRun {
  readonly id: string
  readonly kind: MaintenanceKind
  /** SSE channel carrying this run's live log — the UI subscribes to it. */
  readonly channel: string
  readonly status: MaintenanceRunStatus
  readonly startedAt: string
  readonly finishedAt?: string
  readonly result?: MaintenanceResult
  /** Failure reason when `status === 'error'` (agent failure or an unexpected throw). */
  readonly error?: string
}

/** How many finished runs to retain for polling before the oldest is evicted. */
const RUN_HISTORY_CAP = 25

/** Per-run knobs that differ between the kinds. */
interface RunOptions {
  /** SDK session to resume, so the run inherits a conversation (used by `save`). */
  readonly resumeSessionId?: string
  /** Overrides the default `maintenance: <kind>` commit subject. */
  readonly commitMessage?: string
  /** Vault-derived system-prompt extension; defaults to the domain registry for write runs. */
  readonly systemPromptExtra?: string
}

export class MaintenanceRunner {
  private readonly vaultRoot: string
  private readonly auth: AgentAuth | null
  private readonly events: EventBus
  private readonly commitMutex: Mutex
  private readonly runAgentFn: MaintenanceAgentRunner
  private readonly commit: (vaultRoot: string, message: string, opts?: CommitOptions) => Promise<CommitResult>
  private readonly timeoutMs: number
  private readonly runRegistry: RunRegistry
  private readonly validate: Validator | undefined
  /** One maintenance run at a time — they all write the vault. */
  private readonly runMutex = new Mutex()
  /** In-memory registry of async runs, keyed by run id (insertion-ordered for eviction). */
  private readonly runs = new Map<string, MaintenanceRun>()
  /**
   * One-shot per-run completion callbacks for out-of-band notifiers (the telegram bot, so a
   * research run it started reports back to the chat). The dashboard polls `getRun` instead and
   * needs none of this. Keyed by run id; fired once in `settle()`, then dropped.
   */
  private readonly settledCallbacks = new Map<string, (run: MaintenanceRun) => void>()

  constructor(opts: MaintenanceRunnerOptions) {
    this.vaultRoot = opts.vaultRoot
    this.auth = opts.auth
    this.events = opts.events
    this.commitMutex = opts.commitMutex
    this.runAgentFn = opts.runAgent ?? runAgent
    this.commit = opts.commit ?? commitVault
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.runRegistry = opts.runRegistry ?? new RunRegistry()
    this.validate = opts.validate
  }

  /** The credential for a run. The route 503s in setup mode, so this throwing is a wiring bug. */
  private assertAuth(): AgentAuth {
    if (this.auth === null) throw new Error('maintenance run attempted with no credential configured (setup mode)')
    return this.auth
  }

  /** Starts a lint run in the background; returns its tracked run immediately. */
  startLint(): MaintenanceRun {
    // Be explicit: run the skill, WRITE the report file (the dashboard reads it back), and
    // report-only — never auto-fix, so a lint can't silently rewrite content pages.
    return this.start(
      'lint',
      'Use the wiki-lint skill to health-check the entire wiki and WRITE the full report to ' +
        'wiki/meta/lint-report-<today>.md (date as YYYY-MM-DD). Report only — do NOT auto-fix or ' +
        'modify any existing wiki page. Keep the standard report sections (Orphan Pages, Dead Links, ' +
        'Missing Pages, Frontmatter Gaps, Stale Claims, Cross-Reference Gaps). ' +
        // Belt-and-braces with the hard kill (F1): the DragonScale Mechanism 3 "semantic tiling"
        // path runs embeddings via a long bash call. The runner will now group-kill a stuck run,
        // but the report only needs the read-based checks, so still skip the heavy embedding pass.
        'Do NOT run DragonScale Mechanism 3 semantic tiling or any embedding/similarity pass — ' +
        'use only the read-based checks (Read/Grep/Glob).',
      'ingest',
    )
  }

  /**
   * Fixes the SAFE findings of the newest lint report — the wiki-lint skill's own
   * safe/needs-review split (skills/wiki-lint/SKILL.md "Before Auto-Fixing"): mechanical
   * bookkeeping is automated, everything judgment-shaped stays a human decision. The lint run
   * itself remains report-only; this is the separate, explicit fix step, one revertable commit.
   *
   * Throws when no report exists: the report is what BOUNDS the run. An unbounded "clean up
   * the wiki" prompt is exactly the silent-rewrite risk report-only lint exists to prevent.
   */
  startLintFix(): MaintenanceRun {
    const report = this.readLatestLintReport()
    if (!report) {
      throw new LintReportMissingError('no lint report in the vault — run a lint first, then fix its findings')
    }
    return this.start(
      'lint-fix',
      `Read the lint report at ${report.path} and fix ONLY the safe, mechanical findings it lists.\n\n` +
        'You may do exactly these things:\n' +
        '- Frontmatter gaps: add missing required frontmatter fields (type, status, created, ' +
        'updated, tags) with sensible values — type from the page directory, dates from today, ' +
        'status: developing. Never overwrite a field that already has a value.\n' +
        '- Missing pages: create stub pages for concepts/entities the report says are mentioned ' +
        'in multiple pages but have no page — proper frontmatter, a one-paragraph description ' +
        'from how the existing pages use the term, and wikilinks back to those pages.\n' +
        '- Missing cross-references: where the report lists unlinked mentions, wrap the EXISTING ' +
        'mention text in a [[wikilink]]. Do not add new sentences.\n' +
        '- Stale index entries: update wiki/index.md entries that point at renamed or deleted pages.\n\n' +
        'Explicitly OUT of scope — do NOT do any of these, they need human judgment:\n' +
        '- Do not delete, rename, or merge any page (orphans stay; duplicates stay).\n' +
        '- Do not resolve stale claims or contradictions; do not rewrite prose.\n' +
        '- Do not remove dead links; only fix a dead link when the target is one of the stub ' +
        'pages you created for a "missing page" finding.\n' +
        '- Do not touch findings outside the report.\n\n' +
        `When done, append a short "## Auto-fix run" section to ${report.path} listing what was ` +
        'fixed and what was left for review, and report the same summary as your final answer.',
      'ingest',
      { commitMessage: 'maintenance: lint-fix (safe findings)' },
    )
  }

  /**
   * Starts an autoresearch run in the background; returns its tracked run immediately.
   *
   * The prompt spells the flow out rather than sending `/autoresearch <topic>`. That slash form
   * was what M4 shipped, and the first REAL run proved it never worked: the vault is loaded as a
   * plugin, so its commands are namespaced and the bare `/autoresearch` came back as
   * "Unknown command" — a zero-token no-op the SDK still reported as success (the zero-token
   * guard in agent-runner is what turned it into a visible failure). Mocked tests could never
   * have caught it.
   *
   * The steps below mirror the vault's own `commands/autoresearch.md`, so behaviour is preserved
   * without depending on a namespaced command name or editing the vault (hard rule 5): load the
   * skill's research program, run the loop, then update the wiki's index/log/hot pages.
   *
   * Overlap steering: a deterministic title match (`findRelatedPages`) surfaces the pages the
   * vault ALREADY has on this topic and injects them into the prompt, so a research run on an
   * established theme (e.g. "ionizable lipids", where a whole LNP cluster already exists) extends
   * those pages instead of filing a parallel synthesis. The skill's own "check the index first"
   * rule is otherwise only a soft instruction and the service prompt never named the existing
   * pages; this makes the preferred "extend, don't duplicate" path the explicit default.
   */
  startResearch(topic: string): MaintenanceRun {
    const overlap = renderOverlapBlock(findRelatedPages(this.vaultRoot, topic))
    return this.start(
      'research',
      'Use the autoresearch skill to research this topic and file the findings into the wiki: ' +
        `${topic}\n\n` +
        'Before starting, read skills/autoresearch/references/program.md to load the research ' +
        'constraints and objectives. Then run the research loop: search the web, fetch sources, ' +
        'synthesize, and file structured pages into the wiki. ' +
        'Afterwards update wiki/index.md, wiki/log.md and wiki/hot.md. ' +
        'Finally report how many pages you created and the key findings. ' +
        'Stay focused on the stated topic rather than broadening the scope.' +
        overlap,
      'research',
    )
  }

  /** Starts a hot-cache refresh in the background; returns its tracked run immediately. */
  startHotCache(): MaintenanceRun {
    return this.start('hot-cache', 'update hot cache', 'ingest')
  }

  /**
   * Cleans up the references a user deletion left dangling (the delete flow's follow-up
   * offer). Deleting the Espresso pages produced FOUR lint finding classes at once — dead
   * links in 4 files, orphaned drink mentions, stale address_map entries — because deletion
   * is not a reference-aware operation; this run is the one-click repair, bounded to exactly
   * the named pages. Titles come from the dashboard's own delete flow, not free text.
   */
  startReferenceCleanup(deletedTitles: readonly string[]): MaintenanceRun {
    const titles = deletedTitles.map((t) => `"${t}"`).join(', ')
    return this.start(
      'cleanup',
      `The user deliberately deleted these wiki pages: ${titles}. The pages are gone (each ` +
        'deletion was its own git commit); what remains are dangling references. Find every ' +
        'remaining reference to these page titles across wiki/ (search for the exact titles, ' +
        'as [[wikilinks]] and as plain-text mentions) and clean them up:\n\n' +
        '- Remove list entries/bullets that point at the deleted pages in wiki/index.md, ' +
        'wiki/overview.md, and any _index pages. Adjust page/source counters on the lines ' +
        'you touch if they are now off.\n' +
        '- In content pages, convert a dangling [[wikilink]] into plain text; only rewrite ' +
        'or drop a sentence when it stops making sense without the deleted page.\n' +
        '- Leave wiki/log.md and wiki/hot.md history entries untouched — they are ' +
        'append-only records and MAY keep referring to deleted pages.\n' +
        "- If .raw/.manifest.json has an address_map entry for a deleted page's path, remove " +
        'exactly that entry. Do not touch other entries and never edit the address counter.\n' +
        '- Do not delete, rename, or create any page, and do not touch pages that carry no ' +
        'reference to the deleted ones.\n\n' +
        'Finish by reporting which files you changed and which references you left in place.',
      'ingest',
      { commitMessage: `maintenance: cleanup references (${deletedTitles.join(', ').slice(0, 120)})` },
    )
  }

  /**
   * Repairs user-selected graph-connectivity problems (the explorer panel's "Repair"
   * action): weave isolated pages into the graph, review links flagged as incidental
   * noise. Judgment-shaped by nature — which is exactly why it is bounded to the tasks the
   * USER picked (never a vault-wide sweep) and why lint-fix refuses this category. The
   * upstream guard additionally makes plugin pages unwritable, so a "connect" on a
   * reference doc can only ever add links TO it from knowledge pages, never edit it.
   */
  startGraphRepair(tasks: readonly RepairTask[]): MaintenanceRun {
    if (tasks.length === 0) throw new Error('graph repair started with no tasks (route validates — wiring bug)')
    const lines = tasks.map((t, i) => {
      const reason = t.reason ? ` — context: ${t.reason}` : ''
      return t.kind === 'connect'
        ? `${i + 1}. CONNECT ${t.path}${reason}`
        : `${i + 1}. REVIEW LINK ${t.from} -> ${t.to}${reason}`
    })
    return this.start(
      'repair',
      'The user reviewed the wiki\'s link graph and selected these repair tasks. Work ONLY on ' +
        `them:\n\n${lines.join('\n')}\n\n` +
        'For a CONNECT task (an isolated page no knowledge page links to or from):\n' +
        '- Read the page, then find the existing wiki pages most closely related to its topic ' +
        '(search titles, tags and content).\n' +
        '- Where a related page genuinely mentions — or naturally should mention — the topic, ' +
        'wrap the existing mention in a [[wikilink]] or add ONE short, natural sentence linking ' +
        'to the page. Also add the page to the relevant _index page. 2-4 inbound links are enough.\n' +
        '- If nothing in the vault genuinely relates, add NO links and say so in your report — ' +
        'forced links are worse than an isolated page.\n\n' +
        'For a REVIEW LINK task (an existing link flagged as possibly incidental):\n' +
        '- Read the source page and judge whether its [[wikilink]] to the target genuinely ' +
        'supports the page content.\n' +
        '- If it is an incidental aside (name-dropping, trivia, a passing cross-domain remark), ' +
        'remove the [[ ]] brackets so the text remains but the link goes, or minimally rephrase ' +
        'the sentence.\n' +
        '- If the link IS meaningful, change nothing and justify keeping it in your report.\n\n' +
        'Boundaries:\n' +
        '- Edit only: the pages named in the tasks, pages where you add a wikilink for a ' +
        'CONNECT task, and the relevant index/_index pages.\n' +
        '- Do not create, delete, rename or merge any page. Do not rewrite prose beyond the ' +
        'specific link or mention a task is about.\n\n' +
        'Finish by reporting, per task, exactly what you changed — or why you changed nothing.',
      'ingest',
      { commitMessage: `maintenance: graph repair (${tasks.length} task${tasks.length === 1 ? '' : 's'})` },
    )
  }

  /**
   * Files every existing wiki page under a registry domain (SPEC.md §12.4 Stufe 2). Two jobs
   * in one: the catch-up for pages written before the registry existed, and the adoption step
   * after a human adds a domain — `unassigned` pages are re-classified against the CURRENT
   * registry on every run, so a new key picks up its backlog on the next backfill. (From here
   * on the ingest system-prompt extension keeps new pages classified.)
   *
   * Throws when no registry is installed: a backfill with no closed list to file against is
   * exactly the free-for-all this feature exists to end, so it must fail loudly rather than
   * let the agent improvise 80 domains.
   *
   * Frontmatter-only by construction, which is also why this is cheap and safe: the vault's
   * semantic-tiling cache hashes page BODIES, so a domain backfill does not invalidate it.
   */
  startDomainBackfill(): MaintenanceRun {
    const registry = readDomainRegistry(this.vaultRoot)
    if (!registry) {
      throw new DomainRegistryMissingError(
        `no domain registry at ${DOMAIN_REGISTRY_PATH} — install it (scripts/install-domain-registry.sh) before running a backfill`,
      )
    }
    const keys = registry.domains.map((d) => d.key).join(', ')
    return this.start(
      'domain-backfill',
      `Read ${DOMAIN_REGISTRY_PATH} — it is the closed list of allowed domains. Then go through ` +
        'EVERY markdown page under wiki/ (all subdirectories, all page types: concepts, entities, ' +
        'sources, references, comparisons, questions, folds, meta, and the pages directly in wiki/) ' +
        'and make sure each one carries a `domain:` field in its YAML frontmatter.\n\n' +
        `Allowed values, and nothing else: ${keys}, ${UNASSIGNED}.\n\n` +
        'Rules:\n' +
        `- A page that already has a REAL domain from the list keeps it. A page whose current ` +
        'value is NOT on the list (the field predates the registry, e.g. `investment-funds` or ' +
        '`mrna-delivery`) must be re-filed to the correct listed domain.\n' +
        `- A page carrying \`${UNASSIGNED}\` is NOT settled: re-classify it against the list above — ` +
        'a domain added after the last backfill may fit it now. It keeps ' +
        `\`${UNASSIGNED}\` only when still no listed domain fits.\n` +
        `- If no listed domain fits, set \`${UNASSIGNED}\`. Do not invent new keys, and do not add ` +
        `any key to ${DOMAIN_REGISTRY_PATH} — the registry is edited by humans only.\n` +
        '- Classify by what the page is ABOUT. Tag hints in the registry are guidance, not a ' +
        'lookup table; ignore entity-shaped tags (person, organization, product, researcher).\n' +
        '- Frontmatter edits are limited to the `domain:` field and the domain tag mirrored into ' +
        `the \`tags:\` list: on every page you re-file, remove a stale \`${UNASSIGNED}\` tag (and ` +
        'any tag that merely mirrors a previous domain key) and make sure the new domain key is ' +
        `present as a tag. Pages left as \`${UNASSIGNED}\` keep the \`${UNASSIGNED}\` tag. Leave ` +
        'every other tag, all other frontmatter fields, page bodies, titles, and wikilinks ' +
        'untouched. Do not create, delete, rename or merge any page.\n' +
        `- ${DOMAIN_REGISTRY_PATH} itself and other vault-machinery pages (index, hot, log, ` +
        'overview, session records, folds, lint reports) belong to the `meta` domain.\n\n' +
        'Work through the pages systematically so none is skipped. When done, report the total ' +
        'number of pages touched and a per-domain count, plus the list of pages you left as ' +
        `\`${UNASSIGNED}\` and why.`,
      'ingest',
      { commitMessage: 'maintenance: domain backfill' },
    )
  }

  /**
   * Saves a chat session into the vault (SPEC.md §6.3 "Session in Vault sichern"): resumes the
   * chat's SDK session so the agent has the conversation, then triggers the vault repo's own
   * `/save` flow. Runs under `ingest` — write access, no web — because the chat itself is
   * read-only by design and cannot write the page it is being asked to produce.
   */
  startSave(sdkSessionId: string, title?: string): MaintenanceRun {
    const label = title?.trim() ? ` (${title.trim()})` : ''
    return this.start('save', '/save', 'ingest', {
      resumeSessionId: sdkSessionId,
      commitMessage: `chat: save session${label}`,
    })
  }

  /**
   * Judges the candidate themes the deterministic finder surfaced (SPEC.md §12.4 Stufe 3).
   *
   * READ-ONLY on purpose despite running under a write-capable profile: the agent returns an
   * opinion, it does not touch the registry. Creating a domain stays a user action (the same
   * rule the ingest guardrail enforces — new keys come from a human), so this run's whole
   * output is its final message, parsed into verdicts. Nothing is committed.
   */
  startDomainReview(candidates: readonly DomainCandidate[]): MaintenanceRun {
    const registry = readDomainRegistry(this.vaultRoot)
    const existing = (registry?.domains ?? []).map((d) => `- ${d.key}: ${d.description}`).join('\n')
    const blocks = candidates
      .map(
        (c) =>
          `## ${c.key}\n` +
          `shared tags: ${c.tags.join(', ')}\n` +
          `${c.pageCount} pages, link cohesion ${(c.cohesion * 100).toFixed(0)}%\n` +
          c.pages.map((p) => `- ${p.title} (${p.path})` ).join('\n'),
      )
      .join('\n\n')

    return this.start(
      'domain-review',
      'You are judging proposed new meta-categories for a wiki. Each candidate below is a group ' +
        'of pages that share a tag and that no existing domain covers.\n\n' +
        `The domains that ALREADY exist:\n${existing || '(none)'}\n\n` +
        `Candidates:\n\n${blocks}\n\n` +
        'For each candidate decide ONE of:\n' +
        '- `new-domain` — these pages form a real subject area worth its own domain. Propose a ' +
        'key at the same altitude as the existing ones (broad — a domain is a shelf, not a book).\n' +
        '- `existing` — they belong in a domain that already exists; name it.\n' +
        '- `not-a-domain` — they merely share a label and are not one coherent subject.\n\n' +
        'Read a few of the pages before deciding; the tag alone is not enough evidence. ' +
        'Judge by what the pages are ABOUT.\n\n' +
        'Do NOT edit any file. Do not modify the registry, do not change page frontmatter, do ' +
        'not create pages. Your answer IS the deliverable.\n\n' +
        DOMAIN_REVIEW_FORMAT,
      'ingest',
    )
  }

  /** A tracked run by id (for the poll endpoint), or undefined once evicted. */
  getRun(id: string): MaintenanceRun | undefined {
    return this.runs.get(id)
  }

  /** All tracked runs, newest first (most-recent history for the UI). */
  listRuns(): MaintenanceRun[] {
    return [...this.runs.values()].reverse()
  }

  /**
   * Registers a run and kicks it off in the background. Returns the `running` record at once —
   * the (up to 15-min) agent work happens off the request path. Concurrent starts still
   * serialize on the run mutex; a queued one simply reports `running` until its turn.
   */
  private start(
    kind: MaintenanceKind,
    prompt: string,
    profile: 'ingest' | 'research',
    opts: RunOptions = {},
  ): MaintenanceRun {
    const id = randomUUID()
    const run: MaintenanceRun = {
      id,
      kind,
      channel: maintenanceChannel(kind),
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    this.runs.set(id, run)
    this.evictOldRuns()
    // Fire-and-forget: execute() never rejects (it records failures on the run record).
    void this.execute(id, kind, prompt, profile, opts)
    return run
  }

  /** Runs the agent work, then settles the run record to `done`/`error`. Never rejects. */
  private async execute(
    id: string,
    kind: MaintenanceKind,
    prompt: string,
    profile: 'ingest' | 'research',
    opts: RunOptions = {},
  ): Promise<void> {
    try {
      const result = await this.run(kind, prompt, profile, opts)
      this.settle(id, result.ok ? 'done' : 'error', {
        result,
        ...(result.ok ? {} : { error: result.error ?? `${kind} failed` }),
      })
    } catch (err) {
      // run() only throws on unexpected (non-agent) errors; record them so the poll surfaces it.
      const message = err instanceof Error ? err.message : String(err)
      this.events.publish({
        kind: 'log',
        log: { jobId: maintenanceChannel(kind), ts: new Date().toISOString(), level: 'error', message: `maintenance: ${kind} crashed: ${message}` },
      })
      this.settle(id, 'error', { error: message })
    }
  }

  /**
   * Registers a callback fired once when the given run settles to done/error, for out-of-band
   * notifiers (the telegram bot). If the run has already settled — or is unknown/evicted — the
   * callback still fires on the next tick with the current record so a caller can't hang waiting.
   */
  onRunSettled(id: string, cb: (run: MaintenanceRun) => void): void {
    const existing = this.runs.get(id)
    if (existing !== undefined && existing.status !== 'running') {
      queueMicrotask(() => cb(existing))
      return
    }
    this.settledCallbacks.set(id, cb)
  }

  /** Transitions a tracked run to its terminal state (records may already be evicted — no-op then). */
  private settle(id: string, status: MaintenanceRunStatus, patch: { result?: MaintenanceResult; error?: string }): void {
    const prev = this.runs.get(id)
    if (!prev) return
    const settled: MaintenanceRun = { ...prev, status, finishedAt: new Date().toISOString(), ...patch }
    this.runs.set(id, settled)
    const cb = this.settledCallbacks.get(id)
    if (cb !== undefined) {
      this.settledCallbacks.delete(id)
      // A notifier throwing must never corrupt the settled run record.
      try {
        cb(settled)
      } catch {
        /* swallowed */
      }
    }
  }

  /** Bounds the registry so long-lived services don't accumulate run records without limit. */
  private evictOldRuns(): void {
    while (this.runs.size > RUN_HISTORY_CAP) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined) break
      this.runs.delete(oldest)
      this.settledCallbacks.delete(oldest)
    }
  }

  private async run(
    kind: MaintenanceKind,
    prompt: string,
    profile: 'ingest' | 'research',
    opts: RunOptions = {},
  ): Promise<MaintenanceResult> {
    return this.runMutex.runExclusive(async () => {
      const channel = maintenanceChannel(kind)
      const log = (level: 'info' | 'warn' | 'error', message: string): void =>
        this.events.publish({ kind: 'log', log: { jobId: channel, ts: new Date().toISOString(), level, message } })

      log('info', `maintenance: ${kind} started`)
      // Read the registry per run (it is a user-editable vault page), unless the caller pinned
      // its own extension text. The hygiene checklist rides along for the same reason it does
      // on ingest runs: any of these runs may write pages.
      const systemPromptExtra =
        opts.systemPromptExtra ??
        [domainSystemPrompt(readDomainRegistry(this.vaultRoot)), PAGE_HYGIENE_CHECKLIST, ENTITY_NOTABILITY_RULES]
          .filter(Boolean)
          .join('\n\n')
      // Bracket the run and register as a writer, so pages the agent creates or renames via Bash
      // can still be committed — but only if we turn out to be the sole writer (F4).
      const dirtyBefore = await dirtyPaths(this.vaultRoot)
      const endRun = this.runRegistry.begin()
      const written = new Set<string>()
      const res = await this.runAgentFn({
        vaultRoot: this.vaultRoot,
        prompt,
        auth: this.assertAuth(),
        profile,
        timeoutMs: this.timeoutMs,
        // A save resumes the chat's SDK session so the agent still has the conversation it is
        // being asked to write up. The profile is applied fresh per run, so resuming a
        // read-only chat under a write-enabled profile is what grants the save its write access.
        ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
        // Any run that may write pages gets the domain rules, not just ingest: a lint fixing a
        // frontmatter gap or an autoresearch filing new pages must obey the same closed list.
        ...(systemPromptExtra ? { systemPromptExtra } : {}),
        onMessage: (m: SDKMessage) => {
          const line = formatMessage(m)
          if (line !== undefined) log('info', line)
          for (const p of extractWrittenPaths(m, this.vaultRoot)) written.add(p)
        },
      })

      if (!res.ok) {
        endRun()
        log('error', `maintenance: ${kind} failed: ${res.error ?? 'unknown error'}`)
        return { ok: false, kind, pages: [], usage: res.usage, error: res.error ?? `${kind} failed` }
      }

      // One commit per run, serialized against ingest commits. The sole-writer check and the
      // sweep both happen INSIDE the commit mutex, so no other run can start writing between
      // asking the question and acting on the answer.
      const commit = await this.commitMutex.runExclusive(async () => {
        const swept = this.runRegistry.isSoleWriter()
          ? newWikiPaths(dirtyBefore, await dirtyPaths(this.vaultRoot))
          : []
        if (swept.length > 0) {
          // These are pages the Write/Edit stream never reported — created or renamed via Bash.
          log('info', `staging ${swept.length} page(s) the tool stream did not report (F4)`)
        } else if (!this.runRegistry.isSoleWriter()) {
          log('info', 'another run is writing — staging only tool-reported paths (F4 sweep skipped)')
        }
        const pathspec = [...new Set([...written, ...swept, ...BOOKKEEPING_PATHS])]
        return this.commit(this.vaultRoot, opts.commitMessage ?? `maintenance: ${kind}`, { pathspec })
      })
      endRun()
      const pages = commit.committed ? commit.committedPages : []
      log('info', commit.committed ? `committed ${commit.hash?.slice(0, 8)} (${pages.length} page(s))` : 'nothing to commit')
      this.events.publish({ kind: 'stats' })

      // Post-run validation, only when the run actually touched pages (a read-only kind like
      // domain-review has nothing to check). Advisory: findings never fail the run.
      const touched = [...new Set([...written, ...pages])]
      if (this.validate !== undefined && touched.length > 0) {
        try {
          const findings = this.validate(touched)
          if (findings.length === 0) log('info', 'post-run validation: no findings')
          for (const f of findings) log('warn', `validation [${f.rule}] ${f.path}: ${f.message}`)
          if (findings.length > 0) {
            log('warn', `post-run validation: ${findings.length} finding(s) — advisory only, nothing was modified`)
          }
        } catch (err) {
          log('warn', `post-run validation crashed (ignored): ${(err as Error).message}`)
        }
      }

      const base: MaintenanceResult = { ok: true, kind, pages, usage: res.usage, answer: res.result }
      if (kind === 'lint') {
        // Prefer the written report file; fall back to parsing the agent's inline answer, so
        // a run that summarised in text instead of writing a file still yields structure.
        const fromFile = this.readLatestLintReport()
        if (fromFile && fromFile.report.totalFindings > 0) {
          return { ...base, lint: fromFile.report, reportPath: fromFile.path }
        }
        const fromText = this.parseReportText(res.result)
        if (fromFile) return { ...base, lint: fromFile.report, reportPath: fromFile.path }
        if (fromText.totalFindings > 0 || fromText.sections.length > 0) return { ...base, lint: fromText }
      }
      if (kind === 'domain-review') {
        // The answer IS the deliverable here (nothing is written), so parse it directly. An
        // unparseable answer falls through to `base`, whose `answer` the UI renders as prose.
        const review = parseDomainReview(res.result ?? '')
        if (review.entries.length > 0) {
          log('info', `maintenance: ${kind} judged ${review.entries.length} candidate(s)`)
          return { ...base, domainReview: review }
        }
      }
      log('info', `maintenance: ${kind} complete`)
      return base
    })
  }

  /** Parses a lint report out of arbitrary answer text (fallback when no file was written). */
  private parseReportText(text: string): LintReport {
    const pageIndex = indexWikiPages(this.vaultRoot)
    return parseLintReport(text, (label) => ({
      label,
      path: pageIndex.get(label.toLowerCase()) ?? null,
    }))
  }

  /** Finds and parses the newest `wiki/meta/lint-report-*.md` the run just wrote. */
  private readLatestLintReport(): { report: LintReport; path: string } | undefined {
    const metaDir = path.join(this.vaultRoot, 'wiki', 'meta')
    let files: string[]
    try {
      files = fs
        .readdirSync(metaDir)
        .filter((f) => /^lint-report-.*\.md$/.test(f))
        .sort()
    } catch {
      return undefined
    }
    const newest = files[files.length - 1]
    if (!newest) return undefined
    const markdown = fs.readFileSync(path.join(metaDir, newest), 'utf8')
    const pageIndex = indexWikiPages(this.vaultRoot)
    const report = parseLintReport(markdown, (label) => ({
      label,
      path: pageIndex.get(label.toLowerCase()) ?? null,
    }))
    return { report, path: path.posix.join('wiki', 'meta', newest) }
  }
}
