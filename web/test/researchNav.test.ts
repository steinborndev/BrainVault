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
  return [...source.matchAll(/onClick=\{(\w+)\}/g)]
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

  it('keeps the conversation bar out of the scrolling thread', () => {
    // A bar inside `.thread` scrolls away with the conversation, which is the same as not
    // having one from the first answer onward.
    const bar = chat.indexOf('className="thread-bar"')
    const body = chat.indexOf('className={`box-body')
    expect(bar).toBeGreaterThan(-1)
    expect(bar).toBeLessThan(body)
  })
})
