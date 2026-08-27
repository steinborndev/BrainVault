/**
 * Every view of the Research screen must offer a way back to the overview.
 *
 * The screen has three: the start view, a run's detail, and a conversation. The run detail
 * shipped with an "All runs" button; the conversation shipped with nothing at all, so
 * opening one was a one-way trip - the only routes back were the stat tiles in the control
 * column, which nobody reads as navigation (2026-08-26).
 *
 * Asserted against the source rather than a rendered tree, the way the App.tsx wiring is
 * checked next door: what matters is that the branch EXISTS, and a component test would
 * pass just as happily with the button deleted from one branch and present in another.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const chat = readFileSync(join(here, '..', 'src', 'tabs', 'Chat.tsx'), 'utf8')

/** The slice of the file that renders one view, from its guard to the next one. */
function branch(kind: string): string {
  const start = chat.indexOf(`{view.kind === '${kind}' && (`)
  expect(start, `no render branch for view '${kind}'`).toBeGreaterThan(-1)
  const rest = chat.slice(start + 1)
  const next = rest.indexOf('{view.kind === ')
  return next === -1 ? rest : rest.slice(0, next)
}

/**
 * A route back to the overview: the call itself, or a handler named in the branch that makes
 * it one level down. Following the name matters - pinning the literal call would fail the
 * moment the same navigation moves into a named function, which says nothing about whether
 * the way back still exists.
 */
function goesBackToStart(source: string): boolean {
  if (source.includes("setView({ kind: 'start' })")) return true
  // `onClick` when the branch wires the control itself, `onBack` when it hands the handler
  // to the shared detail shell - which is where both kinds put their back control now.
  return [...source.matchAll(/on(?:Click|Back)=\{(\w+)\}/g)]
    .map((m) => m[1]!)
    .some((fn) => {
      const decl = chat.indexOf(`const ${fn} = (`)
      return decl > -1 && chat.slice(decl, decl + 500).includes("setView({ kind: 'start' })")
    })
}

describe('the Research screen can always be left', () => {
  it('has exactly the three views this test knows about', () => {
    const kinds = [...chat.matchAll(/\{view\.kind === '(\w+)'/g)].map((m) => m[1])
    expect([...new Set(kinds)].sort()).toEqual(['run', 'start', 'thread'])
  })

  it('gets back to the overview from a conversation', () => {
    // The bar is rendered next to the body rather than inside it, so look at the whole
    // guarded region: what is pinned is that the branch carries a route back.
    expect(goesBackToStart(branch('thread'))).toBe(true)
  })

  it('gets back to the overview from a run detail', () => {
    expect(goesBackToStart(branch('run'))).toBe(true)
  })

  /**
   * Both kinds are rendered through ONE shell (2026-08-27), which is what makes the two
   * assertions below structural rather than a pair of coincidences: neither kind can grow a
   * detail band the other lacks, and neither can lose its way back on its own.
   */
  it('renders both kinds of detail through the one shell', () => {
    for (const fn of ['RunDetailBody', 'ThreadDetail']) {
      const start = chat.indexOf(`function ${fn}(`)
      expect(start, `no ${fn} component`).toBeGreaterThan(-1)
      expect(chat.slice(start)).toContain('<DetailShell')
    }
  })

  it('keeps the back control out of the band that scrolls', () => {
    // A back button inside the scrolling band is gone from the first screenful onward, which
    // is the same as not having one. In the shell the bar is a SIBLING above that band.
    const shell = chat.slice(chat.indexOf('function DetailShell('))
    const bar = shell.indexOf('className={`detail-bar')
    const content = shell.indexOf('className="detail-content"')
    expect(bar, 'no detail bar in the shell').toBeGreaterThan(-1)
    expect(content, 'no scrolling content band in the shell').toBeGreaterThan(-1)
    expect(bar).toBeLessThan(content)
  })
})
