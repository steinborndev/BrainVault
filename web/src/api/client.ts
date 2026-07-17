/**
 * Thin typed fetch client for the vault-service API. All endpoints are same-origin under
 * `/api/v1` (the SPA is served by the same Fastify process, and the Vite dev proxy forwards
 * `/api` in dev), so no base URL or CORS handling is needed.
 */

import type { Job, JobDetail, Stats, Health, JobStatus } from './types.ts'

const BASE = '/api/v1'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string }
      detail = body.error ? `: ${body.error}` : ''
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
}
