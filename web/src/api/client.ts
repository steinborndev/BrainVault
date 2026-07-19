/**
 * Thin typed fetch client for the vault-service API. All endpoints are same-origin under
 * `/api/v1` (the SPA is served by the same Fastify process, and the Vite dev proxy forwards
 * `/api` in dev), so no base URL or CORS handling is needed.
 */

import type {
  Job,
  JobDetail,
  Stats,
  Health,
  JobStatus,
  Session,
  ChatMessage,
  QueryResponse,
  Citation,
  MaintenanceRun,
  DomainsResponse,
  SettingsResponse,
  SettingsPatch,
  PagePreview,
  PageFull,
  VaultGraph,
  PageWriteResult,
  PageDeleteResult,
} from './types.ts'

const BASE = '/api/v1'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string; issues?: string[] }
      detail = body.error ? `: ${body.error}` : ''
      // Validation endpoints (e.g. PUT /settings) return per-field issues — surfacing them
      // turns "400 Bad Request" into something the user can actually act on.
      if (Array.isArray(body.issues) && body.issues.length > 0) detail += ` (${body.issues.join('; ')})`
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${res.status} ${res.statusText}${detail}`)
  }
  return res.json() as Promise<T>
}

export interface EnqueueResult {
  batchId?: string
  jobs: Array<{ id: string; name: string; status: JobStatus; duplicateOf?: string }>
}

export const api = {
  health: (): Promise<Health> => fetch(`${BASE}/health`).then(json<Health>),

  stats: (): Promise<Stats> => fetch(`${BASE}/stats`).then(json<Stats>),

  jobs: (params?: { status?: JobStatus; limit?: number }): Promise<{ jobs: Job[] }> => {
    const q = new URLSearchParams()
    if (params?.status) q.set('status', params.status)
    if (params?.limit) q.set('limit', String(params.limit))
    const qs = q.toString()
    return fetch(`${BASE}/jobs${qs ? `?${qs}` : ''}`).then(json<{ jobs: Job[] }>)
  },

  job: (id: string): Promise<JobDetail> => fetch(`${BASE}/jobs/${id}`).then(json<JobDetail>),

  /** Upload files (multipart). Multiple files → one batch (the server groups them). */
  uploadFiles: (files: File[]): Promise<EnqueueResult> => {
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    return fetch(`${BASE}/jobs`, { method: 'POST', body: form }).then(json<EnqueueResult>)
  },

  /** Submit a pasted URL. */
  submitUrl: (url: string): Promise<EnqueueResult> =>
    fetch(`${BASE}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then(json<EnqueueResult>),

  /** Submit pasted text as a note. */
  submitText: (text: string, title?: string): Promise<EnqueueResult> =>
    fetch(`${BASE}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { text, title } : { text }),
    }).then(json<EnqueueResult>),

  retry: (id: string): Promise<{ job: Job }> =>
    fetch(`${BASE}/jobs/${id}/retry`, { method: 'POST' }).then(json<{ job: Job }>),

  cancel: (id: string): Promise<{ job: Job }> =>
    fetch(`${BASE}/jobs/${id}`, { method: 'DELETE' }).then(json<{ job: Job }>),

  /** Clear finished jobs from history. With `status`, only that status; otherwise all at-rest jobs. */
  clearHistory: (status?: JobStatus): Promise<{ removed: number }> => {
    const qs = status ? `?status=${status}` : ''
    return fetch(`${BASE}/jobs${qs}`, { method: 'DELETE' }).then(json<{ removed: number }>)
  },

  // ---- Query / Chat ----

  query: (question: string, sessionId?: string): Promise<QueryResponse> =>
    fetch(`${BASE}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sessionId ? { question, sessionId } : { question }),
    }).then(json<QueryResponse>),

  sessions: (): Promise<{ sessions: Session[] }> => fetch(`${BASE}/sessions`).then(json<{ sessions: Session[] }>),

  session: (id: string): Promise<{ session: Session; messages: ChatMessage[] }> =>
    fetch(`${BASE}/sessions/${id}`).then(json<{ session: Session; messages: ChatMessage[] }>),

  createSession: (title?: string): Promise<{ session: Session }> =>
    fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { title } : {}),
    }).then(json<{ session: Session }>),

  renameSession: (id: string, title: string): Promise<{ session: Session }> =>
    fetch(`${BASE}/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then(json<{ session: Session }>),

  deleteSession: (id: string): Promise<{ ok: boolean }> =>
    fetch(`${BASE}/sessions/${id}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),

  /** Raw markdown of one wiki page, for the Chat tab's inline citation preview. */
  page: (path: string): Promise<PagePreview> =>
    fetch(`${BASE}/pages?path=${encodeURIComponent(path)}`).then(json<PagePreview>),

  /** Full page content + metadata for the vault viewer (SPEC.md §12.4). */
  pageFull: (path: string): Promise<PageFull> =>
    fetch(`${BASE}/pages?path=${encodeURIComponent(path)}&full=1`).then(json<PageFull>),

  /** The vault's wikilink graph (server-side cached; cheap to refetch). */
  graph: (): Promise<VaultGraph> => fetch(`${BASE}/graph`).then(json<VaultGraph>),

  /**
   * User edit of one page (SPEC.md §12.4). `baseMtime` is the optimistic lock: the server
   * 409s if the page changed since it was loaded, instead of silently overwriting.
   */
  savePage: (path: string, markdown: string, baseMtime?: string): Promise<PageWriteResult> =>
    fetch(`${BASE}/pages`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, markdown, ...(baseMtime ? { baseMtime } : {}) }),
    }).then(json<PageWriteResult>),

  /** User delete of one page; the response's staleLinks feeds the lint-guidance banner. */
  deletePage: (path: string): Promise<PageDeleteResult> =>
    fetch(`${BASE}/pages?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).then(json<PageDeleteResult>),

  /** "Session in Vault sichern" — starts an async write-enabled run; poll it like a maintenance run. */
  saveSession: (id: string): Promise<MaintenanceRun> =>
    fetch(`${BASE}/sessions/${id}/save`, { method: 'POST' }).then(json<MaintenanceRun>),

  // ---- Maintenance (async: POST starts a run, GET polls its result) ----

  lint: (): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/lint`, { method: 'POST' }).then(json<MaintenanceRun>),

  hotCache: (): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/hot-cache`, { method: 'POST' }).then(json<MaintenanceRun>),

  research: (topic: string): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic }),
    }).then(json<MaintenanceRun>),

  domainBackfill: (): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/domain-backfill`, { method: 'POST' }).then(json<MaintenanceRun>),

  maintenanceRun: (id: string): Promise<MaintenanceRun> =>
    fetch(`${BASE}/maintenance/runs/${id}`).then(json<MaintenanceRun>),

  domains: (): Promise<DomainsResponse> => fetch(`${BASE}/domains`).then(json<DomainsResponse>),

  // ---- Settings ----

  settings: (): Promise<SettingsResponse> => fetch(`${BASE}/settings`).then(json<SettingsResponse>),

  saveSettings: (patch: SettingsPatch): Promise<SettingsResponse> =>
    fetch(`${BASE}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<SettingsResponse>),
}

/** Parse the stored `citations` JSON string on a message into a typed array. */
export function parseCitations(citations: string | null): Citation[] {
  if (!citations) return []
  try {
    const parsed = JSON.parse(citations)
    return Array.isArray(parsed) ? (parsed as Citation[]) : []
  } catch {
    return []
  }
}
