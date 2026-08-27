/**
 * In-memory live log store, keyed by job id. The SSE hook merges `log` events here as they
 * arrive; the JobLog component seeds it with the job's historical lines (one fetch) and then
 * renders live via `useSyncExternalStore`. Merge is idempotent - by `job_logs` rowid when the
 * line carries one, by ts|level|message otherwise - so a seed and the live stream can overlap
 * without duplicating lines (the DoD's live agent log).
 *
 * Memory is bounded: the SSE stream feeds EVERY job's lines through here, viewed or not, so an
 * unbounded map would grow for the lifetime of the tab. Per job the buffer keeps the newest
 * MAX_LINES; across jobs an LRU keeps the newest MAX_JOBS entries that nobody is watching.
 */

import type { JobLogLine } from '../api/types.ts'

type Listener = () => void

/** Newest lines kept per job - an ingest run logs hundreds, not tens of thousands. */
const MAX_LINES = 2000
/** Unwatched jobs retained before the least-recently-updated is dropped. */
const MAX_JOBS = 50

function keyOf(line: JobLogLine): string {
  return line.id !== undefined ? `#${line.id}` : `${line.ts}|${line.level}|${line.message}`
}

class LogStore {
  /** Insertion order doubles as LRU order - re-inserting on merge moves a job to the tail. */
  private readonly lines = new Map<string, JobLogLine[]>()
  private readonly seen = new Map<string, Set<string>>()
  private readonly listeners = new Map<string, Set<Listener>>()

  /** Adds any not-yet-seen lines for a job, preserving ts order; notifies on change. */
  merge(jobId: string, incoming: JobLogLine[]): void {
    if (incoming.length === 0) return
    const seen = this.seen.get(jobId) ?? new Set<string>()
    const current = this.lines.get(jobId) ?? []
    let added = false
    let next = current.slice()
    for (const line of incoming) {
      const k = keyOf(line)
      if (seen.has(k)) continue
      seen.add(k)
      next.push(line)
      added = true
    }
    if (!added) return
    // Keep chronological order; the seed fetch may arrive after some live lines.
    next.sort((a, b) => a.ts.localeCompare(b.ts))
    if (next.length > MAX_LINES) {
      const dropped = next.slice(0, next.length - MAX_LINES)
      next = next.slice(next.length - MAX_LINES)
      for (const line of dropped) seen.delete(keyOf(line))
    }
    // Delete-then-set keeps Map insertion order as an LRU: the freshest job sits at the tail.
    this.lines.delete(jobId)
    this.seen.delete(jobId)
    this.lines.set(jobId, next)
    this.seen.set(jobId, seen)
    this.evict()
    this.notify(jobId)
  }

  snapshot(jobId: string): JobLogLine[] {
    return this.lines.get(jobId) ?? EMPTY
  }

  subscribe(jobId: string, listener: Listener): () => void {
    const set = this.listeners.get(jobId) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(jobId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(jobId)
    }
  }

  /** Drops the least-recently-updated jobs nobody is watching once the cap is exceeded. */
  private evict(): void {
    if (this.lines.size <= MAX_JOBS) return
    for (const jobId of this.lines.keys()) {
      if (this.lines.size <= MAX_JOBS) return
      if (this.listeners.has(jobId)) continue // never evict under a live viewer
      this.lines.delete(jobId)
      this.seen.delete(jobId)
    }
  }

  private notify(jobId: string): void {
    for (const l of this.listeners.get(jobId) ?? []) l()
  }
}

const EMPTY: JobLogLine[] = []

export const logStore = new LogStore()
