/**
 * The one thing standing between a thrown render error and a white page.
 *
 * The app had no boundary at all, so ANY error during render tore down the whole tree -
 * header, tabs and all five screens - and only a reload brought it back.
 *
 * The case that actually bit (2026-08-25): `Vault`, the Graph screen, is the only lazily
 * loaded chunk, and every rebuild renames it. A tab left open across a rebuild still asks
 * for the old hashed file, the SPA fallback answered that with `index.html` (200,
 * text/html), the browser refused it as a module, and `React.lazy` rethrew that at render
 * time. The server half of that pair is fixed too - missing `/assets/*` now 404s instead of
 * serving the shell (api/server.ts) - but the version skew itself is normal after any
 * rebuild. So a chunk error is not treated as a bug here: it means this tab is stale, and
 * the cure is one reload.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { errorMessage } from './QueryState.tsx'

/**
 * How a failed dynamic import reads, by engine: Chrome "Failed to fetch dynamically imported
 * module", Firefox "error loading dynamically imported module", Safari "Importing a module
 * script failed". A chunk that resolves to HTML instead of JS fails one step earlier, with a
 * MIME complaint. Every one of them means the same thing: this tab wants a file the server
 * does not have under that name any more.
 */
const CHUNK_ERROR_PATTERNS = [
  'dynamically imported module',
  'importing a module script failed',
  'failed to load module script',
  'expected a javascript module script',
]

/** Exported for its unit tests. */
export function isChunkLoadError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'ChunkLoadError') return true
  if (error === null || error === undefined) return false
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return CHUNK_ERROR_PATTERNS.some((p) => text.includes(p))
}

/**
 * A reload cures a stale tab exactly once. If the reloaded page throws the same way again
 * right afterwards, the new build is broken for some other reason and reloading forever
 * would be the worst possible answer - so inside this window the user gets the button
 * instead. A chunk error later than that is a fresh rebuild, not a loop.
 */
export const RELOAD_GUARD_MS = 10_000

/** Exported for its unit tests. */
export function shouldAutoReload(error: unknown, lastReloadAt: number | null, now: number): boolean {
  if (!isChunkLoadError(error)) return false
  if (lastReloadAt === null) return true
  return now - lastReloadAt > RELOAD_GUARD_MS
}

/** Survives the reload it guards, and only the reload: sessionStorage, not localStorage. */
const RELOAD_KEY = 'bv.chunkReloadAt'

function lastReloadAt(): number | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY)
    if (raw === null) return null
    const at = Number(raw)
    return Number.isFinite(at) ? at : null
  } catch {
    return null // storage unavailable (private mode): every chunk error looks like the first
  }
}

function markReload(now: number): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch {
    /* without storage the guard cannot arm; the loop protection degrades, the app does not */
  }
}

interface Props {
  /** Names the screen in the message, so a failure says WHERE it broke - as the tab spells it. */
  label: string
  children: ReactNode
}

interface State {
  error: unknown
  /** The error is a stale-chunk error, i.e. the fix is a reload rather than a retry. */
  stale: boolean
}

/**
 * One boundary per screen, not one around all of them: the screens stay mounted behind
 * `[hidden]`, so a single shared boundary would replace all five when any one of them throws
 * - and the header would be the only thing left to navigate with.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stale: false }

  static getDerivedStateFromError(error: unknown): State {
    return { error, stale: isChunkLoadError(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // A production build has no dev overlay, so this is the only record of what threw.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack)
    const now = Date.now()
    if (shouldAutoReload(error, lastReloadAt(), now)) {
      markReload(now)
      window.location.reload()
    }
  }

  render(): ReactNode {
    const { error, stale } = this.state
    if (error === null) return this.props.children
    if (stale) {
      return (
        <div className="empty">
          <p className="qs-line">The dashboard was rebuilt while this tab was open.</p>
          <p className="qs-detail">
            This screen loads its code on demand, and that file is gone from the server under
            the name this tab knows. Reloading picks up the new version.
          </p>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )
    }
    return (
      <div className="empty">
        <p className="qs-line">Something went wrong in {this.props.label}.</p>
        <p className="qs-detail">{errorMessage(error)}</p>
        <button className="btn" onClick={() => this.setState({ error: null, stale: false })}>
          Try again
        </button>
      </div>
    )
  }
}
