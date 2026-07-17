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

export interface Stats {
  vaultName: string
  pages: PageCounts
  recentPages: RecentPage[]
  commits: Commit[]
  growth: GrowthPoint[]
  hotCache: string | null
  kpis7d: { ingests: number; failures: number; deferred: number; duplicates: number }
  jobs: Record<string, number>
  queue: { queued: number; active: number; inFlight: number; paused: boolean; concurrency: number }
  watcher: { active: boolean; folder: string }
  generatedAt: string
}

export interface Health {
  status: string
  vaultRoot: string
  queue: { inFlight: number; paused: boolean; concurrency: number }
  jobs: Record<string, number>
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

export type MaintenanceKind = 'lint' | 'research' | 'hot-cache'

export interface MaintenanceResult {
  ok: boolean
  kind: MaintenanceKind
  /** The SSE channel its live log streamed on, e.g. `maintenance:lint`. */
  channel: string
  pages: string[]
  usage: { tokensIn: number; tokensOut: number; costUsd: number }
  error?: string
  /** The agent's final text (summary / fallback when no structured report). */
  answer?: string
  lint?: LintReport
  reportPath?: string
}

/** SSE event payloads (server/src/api/routes/events.ts). */
export type BusEvent =
  | { kind: 'job'; job: Job }
  | { kind: 'log'; log: { jobId: string; ts: string; level: LogLevel; message: string } }
  | { kind: 'stats' }
