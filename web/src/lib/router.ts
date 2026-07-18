/**
 * A hand-rolled history router (SPEC.md §12.4 needs deep-linkable vault pages, and the
 * project deliberately avoids a router dependency — it hand-rolls markdown, charts, SSE
 * and icons for the same reason). pushState + popstate, exposed as one hook.
 *
 * The server's SPA fallback (`registerFrontend` in api/server.ts) serves index.html for
 * any non-API path, so every route here survives a hard reload.
 */

import { useSyncExternalStore } from 'react'

/** Fired on our own navigate() so all subscribers re-read the location. */
const NAV_EVENT = 'brainvault:navigate'

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (path === currentPath()) return
  if (opts.replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAV_EVENT))
}

export function currentPath(): string {
  // Query string included — the graph view keeps its focus target in `?focus=`.
  return `${window.location.pathname}${window.location.search}`
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb)
  window.addEventListener(NAV_EVENT, cb)
  return () => {
    window.removeEventListener('popstate', cb)
    window.removeEventListener(NAV_EVENT, cb)
  }
}

/** The current pathname, live across pushState and back/forward. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath)
}

/** Builds the route for one wiki page in the vault viewer. */
export function pageRoute(pagePath: string): string {
  // Encode each segment, keep the slashes readable.
  return `/vault/page/${pagePath.split('/').map(encodeURIComponent).join('/')}`
}

/** Inverse of pageRoute: the vault-relative page path, or null if not a page route. */
export function pageFromPath(path: string): string | null {
  if (!path.startsWith('/vault/page/')) return null
  return path
    .slice('/vault/page/'.length)
    .split('/')
    .map(decodeURIComponent)
    .join('/')
}
