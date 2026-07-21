/**
 * Tracks wikilinks orphaned by manual page deletions, to guide the user toward a lint run
 * (the vault's own mechanism for cleaning dangling references). Session-scoped and
 * accumulating: two deletions with 2 + 3 backlinks show one banner with 5.
 *
 * sessionStorage-backed so the banner survives in-app navigation and a reload, but does not
 * outlive the browser session — after a lint (or a dismiss) it is gone, and stale state can
 * never linger for weeks. Same useSyncExternalStore pattern as the log store.
 */

import { useSyncExternalStore } from 'react'

const KEY = 'brainvault.staleLinks'

export interface StaleLinksState {
  /** Total dangling links produced by deletions this session. */
  readonly count: number
  /** Titles of the deleted pages (newest last), for the banner text. */
  readonly pages: readonly string[]
}

const EMPTY: StaleLinksState = { count: 0, pages: [] }

let cached: StaleLinksState = read()
const listeners = new Set<() => void>()

function read(): StaleLinksState {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as { count?: number; pages?: string[] }
    if (typeof parsed.count !== 'number' || parsed.count <= 0) return EMPTY
    return { count: parsed.count, pages: Array.isArray(parsed.pages) ? parsed.pages : [] }
  } catch {
    return EMPTY
  }
}

function write(state: StaleLinksState): void {
  cached = state
  try {
    if (state.count === 0) sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* storage full/blocked — the in-memory copy still drives the banner */
  }
  for (const l of listeners) l()
}

export const staleLinks = {
  /** Records a deletion. `count` may be 0 (nothing linked here) — then nothing changes. */
  add(count: number, pageTitle: string): void {
    if (count <= 0) return
    // Deduped: the titles double as the payload for the reference-cleanup run.
    write({ count: cached.count + count, pages: [...new Set([...cached.pages, pageTitle])].slice(-8) })
  },
  /** Clears the banner (dismissed, or the user headed off to run lint). */
  clear(): void {
    write(EMPTY)
  },
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useStaleLinks(): StaleLinksState {
  return useSyncExternalStore(subscribe, () => cached)
}
