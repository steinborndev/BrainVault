/**
 * Types mirroring the server's JSON responses (server/src/db/jobs.ts, routes/stats.ts).
 * Kept hand-written and small rather than generated: the API surface is tiny and stable,
 * and a shared build step between server/ and web/ isn't worth it for M3.
 */

export type JobStatus =
  | 'queued'
  | 'preprocessing'
  | 'ingesting'
  | 'done'
  | 'failed'
  | 'deferred'
  | 'duplicate'
  | 'cancelled'

export type JobSource = 'drop' | 'watch' | 'url'
export type JobType = 'pdf' | 'office' | 'web' | 'image' | 'text' | 'av' | 'other'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** A row from the `jobs` table (snake_case, as the server sends it). */
export interface Job {
  id: string
  user_id: string
  batch_id: string | null
  source: JobSource
  type: JobType
  original_name: string | null
  url: string | null
  sha256: string | null
  status: JobStatus
  raw_path: string | null
  /** JSON array (string) of created/updated wiki page paths. */
  created_pages: string | null
  error: string | null
  attempts: number
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface JobLogLine {
  /** `job_logs` rowid — present on seed fetches and job-log SSE lines; exact dedup key. */
  id?: number
  ts: string
  level: LogLevel
  message: string
}

export interface JobDetail {
  job: Job
  logs: JobLogLine[]
}

export interface PageCounts {
  byDir: Record<string, number>
  total: number
}

export interface RecentPage {
  path: string
  dir: string
  modified: string
}

export interface Commit {
  hash: string
  date: string
  subject: string
  pages: string[]
}

export interface GrowthPoint {
  date: string
  total: number
}

/** Anthropic auth mode. In `oauth` (subscription) mode cost is an estimate, not money charged. */
export type AuthMode = 'oauth' | 'api-key'

/** Why the queue is paused — a spent budget reads differently from a usage limit. */
export type PauseReason = 'rate-limit' | 'budget' | null

/** Token/cost totals over a window (server/src/db/jobs.ts `usageSince`). */
export interface UsageTotals {
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** Agent runs in the window (done + failed) — the unit the budget uses in oauth mode. */
  ingests: number
}

/** Daily budget state (server/src/pipeline/budget.ts, SPEC.md §7.1/§11.3). */
export interface Budget {
  /** null = no budget configured (default). */
  limit: number | null
  /** `jobs` in subscription mode, `usd` with an API key. */
  unit: 'jobs' | 'usd'
  spent: number
  exceeded: boolean
  resetsAt: string
}

export interface Stats {
  vaultName: string
  authMode: AuthMode
  pages: PageCounts
  recentPages: RecentPage[]
  commits: Commit[]
  growth: GrowthPoint[]
  hotCache: string | null
  /** mtime of wiki/hot.md — the Wartung tab's "letzter Refresh". null if never written. */
  hotCacheUpdatedAt: string | null
  kpis7d: { ingests: number; failures: number; deferred: number; duplicates: number }
  usage: { today: UsageTotals; last7d: UsageTotals }
  budget: Budget
  jobs: Record<string, number>
  queue: {
    queued: number
    active: number
    inFlight: number
    paused: boolean
    pauseReason: PauseReason
    concurrency: number
  }
  watcher: { active: boolean; folder: string }
  generatedAt: string
}

export interface Health {
  status: string
  vaultRoot: string
  queue: { inFlight: number; paused: boolean; pauseReason: PauseReason; concurrency: number }
  jobs: Record<string, number>
  /** Server-side caps the client pre-checks against (dropzone size warning). */
  limits?: { maxUploadBytes: number }
}

/** One node of the vault's wikilink graph (GET /api/v1/graph, SPEC.md §12.4). */
export interface GraphNode {
  path: string
  title: string
  /** Top-level wiki bucket: concepts | entities | sources | meta | … | root. */
  type: string
  /** Frontmatter `tags:` — the thematic axis; searchable and (via domain) filterable. */
  tags: string[]
  /** Frontmatter `domain:` meta-category, or null when the page carries none. */
  domain: string | null
  out: number
  in: number
}

export interface VaultGraph {
  nodes: GraphNode[]
  /** Directed edges as [fromIndex, toIndex] into `nodes`. */
  edges: Array<[number, number]>
  unresolved: number
  builtAt: string
}

/** Full page content for the vault viewer (GET /api/v1/pages?full=1). */
export interface PageFull {
  path: string
  markdown: string
  truncated: false
  title: string
  type: string
  mtime?: string
}

/** Result of a user page edit (PUT /pages) — every edit is one git commit. */
export interface PageWriteResult {
  ok: boolean
  path: string
  mtime: string
  commit: string | null
  committed: boolean
}

/** Result of a user page delete; staleLinks = backlinks that just went dangling. */
export interface PageDeleteResult {
  ok: boolean
  path: string
  staleLinks: number
  commit: string | null
  committed: boolean
}

/** A resolved page citation for a chat answer (server/src/pipeline/citations.ts). */
export interface Citation {
  label: string
  /** Vault-relative page path, or null if the cited page couldn't be resolved. */
  path: string | null
}

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: number
  session_id: string
  role: MessageRole
  content: string
  /** JSON string of Citation[] as stored, or null. Parse with parseCitations(). */
  citations: string | null
  ts: string
}

export interface Session {
  id: string
  user_id: string
  title: string | null
  sdk_session_id: string | null
  created_at: string
  updated_at: string | null
  /** Present on list responses. */
  message_count?: number
  last_ts?: string | null
}

export interface QueryResponse {
  sessionId: string
  message: ChatMessage
  citations: Citation[]
  usage: { tokensIn: number; tokensOut: number; costUsd: number }
  authMode: 'oauth' | 'api-key'
}

// ---- Maintenance (server/src/pipeline/lint-report.ts, maintenance.ts) ----

export interface LintFinding {
  text: string
  page: Citation | null
}

export interface LintSection {
  title: string
  findings: LintFinding[]
}

export interface LintReport {
  date: string | null
  summary: Record<string, number>
  sections: LintSection[]
  totalFindings: number
}

/** `save` is the chat's "Session in Vault sichern" — same async run machinery. */
export type MaintenanceKind =
  | 'lint'
  | 'research'
  | 'hot-cache'
  | 'save'
  | 'domain-backfill'
  | 'domain-review'

/** One meta-category from the vault's domain registry (GET /api/v1/domains, SPEC §12.4). */
export interface DomainEntry {
  key: string
  description: string
  tags: string[]
}

export interface DomainsResponse {
  /** False when the vault has no `wiki/meta/domains.md` — the backfill is then unavailable. */
  installed: boolean
  path: string
  domains: DomainEntry[]
}

/** A theme among `unassigned` pages big enough to justify a new domain (SPEC §12.4 Stufe 3). */
export interface DomainCandidate {
  key: string
  tags: string[]
  pages: Array<{ path: string; title: string }>
  pageCount: number
  /** 0–1: share of the candidate's pages linked to another page in the same candidate. */
  cohesion: number
}

export interface CandidatesResponse {
  candidates: DomainCandidate[]
  unassignedCount: number
  /** Pages with no `domain:` field at all — non-zero means a backfill is due. */
  undomainedCount: number
  threshold: number
  dismissed: Array<{ key: string; dismissedAt: string }>
}

export type DomainVerdict = 'new-domain' | 'existing' | 'not-a-domain'

/** The optional agent judgement on one candidate. */
export interface DomainReviewEntry {
  candidate: string
  verdict: DomainVerdict
  key?: string
  description?: string
  tags?: string[]
  existing?: string
  reason?: string
}

export interface DomainReview {
  entries: DomainReviewEntry[]
}

export interface MaintenanceResult {
  ok: boolean
  kind: MaintenanceKind
  pages: string[]
  usage: { tokensIn: number; tokensOut: number; costUsd: number }
  error?: string
  /** The agent's final text (summary / fallback when no structured report). */
  answer?: string
  lint?: LintReport
  /** Present for a domain-review run: the agent's verdict per candidate. */
  domainReview?: DomainReview
  reportPath?: string
}

export type MaintenanceRunStatus = 'running' | 'done' | 'error'

/**
 * An async maintenance run. POST returns this at `running`; the client polls
 * `GET /maintenance/runs/:id` until it settles and `result` appears (server-side
 * `MaintenanceRunner`, TASKS-M5 §0).
 */
export interface MaintenanceRun {
  id: string
  kind: MaintenanceKind
  /** SSE channel carrying the live log, e.g. `maintenance:lint`. */
  channel: string
  status: MaintenanceRunStatus
  startedAt: string
  finishedAt?: string
  result?: MaintenanceResult
  error?: string
}

// ---- Settings (server/src/db/settings.ts, SPEC.md §6.4/§6.5) ----

/** The runtime-settable configuration. Bind + credentials are deliberately NOT in here. */
export interface EffectiveSettings {
  watchFolder: string
  concurrency: number
  maxUploadBytes: number
  gitAutoCommit: boolean
  /** null = no budget. Unit depends on authMode: ingests/day (oauth) or USD/day (api-key). */
  dailyBudget: number | null
}

/**
 * Precedence (defined server-side): env/env-file is the start-time `baseline`, the settings
 * table holds `overrides`, and `effective` = override ?? baseline.
 */
export interface SettingsResponse {
  effective: EffectiveSettings
  baseline: EffectiveSettings
  overrides: Partial<EffectiveSettings>
  /** Read-only status incl. the API-key SOURCE — never the credential itself (hard rule 3). */
  readOnly: Record<string, string>
  /** Keys that only take effect after a service restart. */
  restartRequiredKeys: string[]
  /** Set on a PUT response: restart-required keys this write actually changed. */
  pendingRestart?: string[]
}

/** A settings write. `null` clears an override, falling back to the baseline. */
export type SettingsPatch = Partial<{
  [K in keyof EffectiveSettings]: EffectiveSettings[K] | null
}>

/** One wiki page's markdown for the citation preview (server/src/api/routes/pages.ts). */
export interface PagePreview {
  path: string
  markdown: string
  /** True when the page was cut to the preview limit. */
  truncated: boolean
}

/** SSE event payloads (server/src/api/routes/events.ts). */
export type BusEvent =
  | { kind: 'job'; job: Job }
  | { kind: 'log'; log: { jobId: string; ts: string; level: LogLevel; message: string } }
  | { kind: 'stats' }
  | { kind: 'vault' }
