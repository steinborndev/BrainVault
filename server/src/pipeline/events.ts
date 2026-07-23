/**
 * The live-update event bus (SPEC.md §6.5, TASKS-M3 §1) — the spine of the dashboard's
 * SSE stream. The `JobStore` publishes a `job` event on every state transition and a
 * `log` event on every `job_logs` append; the queue publishes `stats` when vault-visible
 * numbers change (a commit landed). The SSE route is the only subscriber in-process.
 *
 * This is a notification channel, NOT a source of truth: the `jobs`/`job_logs` tables
 * remain authoritative (hard rule 1). A dropped or missed event only costs a client a
 * slightly stale view until its next poll/reconnect — it can never corrupt state. Keeping
 * it in-memory (no persistence, no backpressure) is therefore deliberate.
 */

import type { JobRow, LogLevel } from '../db/jobs.js'

/** One line appended to a job's log — mirrors a `job_logs` row. */
export interface LogEventPayload {
  readonly jobId: string
  /** The `job_logs` rowid — lets the client dedupe a live line against the seed fetch exactly. */
  readonly id?: number
  readonly ts: string
  readonly level: LogLevel
  readonly message: string
}

/**
 * Events the bus carries:
 *  - `job`   — a job row changed status (full row, so the UI can update without a refetch)
 *  - `log`   — a log line was appended (the DoD's live agent stream)
 *  - `stats` — vault-visible numbers changed (page counts / git history); a refresh hint
 *  - `vault` — wiki pages changed on disk (debounced); the graph view's live-update hint.
 *              Fires DURING an agent run as pages are written, not just at commit time —
 *              that mid-run stream is what lets the graph grow live while an ingest runs.
 */
/**
 * A chunk of a chat answer as it is being written (SPEC.md §6.3). Coalesced by the query route
 * — raw token deltas would be hundreds of SSE frames per answer.
 */
export interface ChatDeltaPayload {
  readonly sessionId: string
  readonly delta: string
}

export type BusEvent =
  | { readonly kind: 'job'; readonly job: JobRow }
  | { readonly kind: 'log'; readonly log: LogEventPayload }
  | { readonly kind: 'stats' }
  | { readonly kind: 'vault' }
  /**
   * Streaming chat text. Advisory like every other bus event: the authoritative answer is the
   * one the `/query` response persists (with citations and usage), and the UI replaces the
   * streamed text with it on completion. A dropped delta therefore costs a flicker, never
   * a wrong answer — which is why no delivery guarantee is needed here.
   */
  | { readonly kind: 'chat'; readonly chat: ChatDeltaPayload }

export type BusListener = (event: BusEvent) => void

/**
 * A minimal synchronous fan-out. A throwing listener never disturbs the publisher or the
 * other listeners — a broken SSE connection must not wedge the pipeline.
 */
export class EventBus {
  private readonly listeners = new Set<BusListener>()

  /** Subscribe; returns an unsubscribe function (called on SSE disconnect). */
  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(event: BusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A listener (a dead SSE socket) must never break the publisher.
      }
    }
  }

  /** Live subscriber count — used only for diagnostics/tests. */
  get size(): number {
    return this.listeners.size
  }
}
