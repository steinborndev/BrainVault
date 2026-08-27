/**
 * The stale-tab case, pinned.
 *
 * A rebuild renames every hashed bundle, and the Graph screen is the app's only dynamic
 * import - so a tab open across a rebuild asked for a file that no longer existed and, with
 * no boundary anywhere in the tree, React tore the whole dashboard down. These tests cover
 * the two decisions that make that survivable: recognising a chunk error whatever the engine
 * calls it, and reloading for it exactly once.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isChunkLoadError, shouldAutoReload, RELOAD_GUARD_MS } from '../src/components/ErrorBoundary.tsx'

describe('isChunkLoadError', () => {
  it('recognises the message each engine actually produces', () => {
    const real = [
      'Failed to fetch dynamically imported module: http://127.0.0.1:8420/assets/Vault-abc123.js',
      'error loading dynamically imported module: http://127.0.0.1:8420/assets/Vault-abc123.js',
      'Importing a module script failed.',
      'Failed to load module script: Expected a JavaScript module script but the server ' +
        'responded with a MIME type of "text/html".',
    ]
    for (const message of real) expect(isChunkLoadError(new Error(message))).toBe(true)
  })

  it('recognises a bundler-tagged error by name', () => {
    const err = new Error('Loading chunk 3 failed')
    err.name = 'ChunkLoadError'
    expect(isChunkLoadError(err)).toBe(true)
  })

  it('leaves ordinary render errors alone - those are bugs, not stale tabs', () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'domain')"))).toBe(false)
    expect(isChunkLoadError('boom')).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('shouldAutoReload', () => {
  const chunk = new Error('Failed to fetch dynamically imported module: /assets/Vault-abc.js')
  const bug = new TypeError('x is not a function')
  const now = 1_700_000_000_000

  it('reloads on the first chunk error of the session', () => {
    expect(shouldAutoReload(chunk, null, now)).toBe(true)
  })

  it('refuses a second reload inside the guard window, so a broken build cannot loop', () => {
    expect(shouldAutoReload(chunk, now - 1_000, now)).toBe(false)
    expect(shouldAutoReload(chunk, now - RELOAD_GUARD_MS, now)).toBe(false)
  })

  it('treats a chunk error long after the last reload as a fresh rebuild', () => {
    expect(shouldAutoReload(chunk, now - RELOAD_GUARD_MS - 1, now)).toBe(true)
  })

  it('never reloads for an ordinary error - reloading would just hide it', () => {
    expect(shouldAutoReload(bug, null, now)).toBe(false)
    expect(shouldAutoReload(bug, now - 60_000, now)).toBe(false)
  })
})

/**
 * The boundary only helps where it is mounted, and the two things worth pinning are not
 * visible from the component itself: that every screen has one (the screens stay mounted
 * behind `[hidden]`, so one shared boundary would blank all five), and that the Graph
 * screen's sits ABOVE its Suspense - below it, the failed lazy import escapes.
 */
describe('App.tsx wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const app = readFileSync(join(here, '..', 'src', 'App.tsx'), 'utf8')

  it('wraps every screen', () => {
    const labels = [...app.matchAll(/<ErrorBoundary label="([^"]+)"/g)].map((m) => m[1])
    expect(labels.slice().sort()).toEqual(['Graph', 'Home', 'Library', 'Research', 'System'])
    // `screen` exactly, not the `screens` container that holds all five.
    const screens = app.match(/className=(?:"screen[ "]|\{`screen[ $])/g) ?? []
    expect(labels).toHaveLength(screens.length)
  })

  it('keeps the Graph boundary outside the Suspense', () => {
    expect(app.indexOf('<ErrorBoundary label="Graph"')).toBeLessThan(app.indexOf('<Suspense'))
  })
})
