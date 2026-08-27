/**
 * The contract that broke the whole dashboard once (2026-08-25, UI sweep package 2).
 *
 * `queryState` was first written as a component. `<QueryState … />` is a React ELEMENT, so it
 * is truthy even when the component renders nothing - which made every call site's
 * `state ?? content` and `if (state !== null)` swallow the content on all five screens.
 * TypeScript could not see it: `ReactElement | null` is the return type of the function,
 * while the JSX expression has type `ReactElement`.
 *
 * The first tests pin the contract; the last one pins the shape of the call sites, because
 * the contract alone cannot stop someone from wrapping it in JSX again.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { merge, queryState } from '../src/components/QueryState.tsx'

const ready = { isLoading: false, isError: false, error: null, refetch: () => {} }
const loading = { ...ready, isLoading: true }
const failed = { ...ready, isError: true, error: new Error('boom') }

describe('queryState', () => {
  it('returns null when the data is there, so the caller renders its own content', () => {
    expect(queryState(ready, 'the page index')).toBeNull()
  })

  it('returns an element while loading and after a failure', () => {
    expect(queryState(loading, 'the page index')).not.toBeNull()
    expect(queryState(failed, 'the page index')).not.toBeNull()
  })
})

describe('merge', () => {
  it('is ready only when every query is ready', () => {
    expect(queryState(merge(ready, ready), 'x')).toBeNull()
    expect(queryState(merge(ready, loading), 'x')).not.toBeNull()
    expect(queryState(merge(ready, failed), 'x')).not.toBeNull()
  })

  it('carries the first failure, so the retry has something to report', () => {
    const m = merge(ready, failed, loading)
    expect(m.isError).toBe(true)
    expect((m.error as Error).message).toBe('boom')
  })

  it('retries every query it was built from', () => {
    const calls: string[] = []
    const one = { ...ready, refetch: () => calls.push('one') }
    const two = { ...ready, refetch: () => calls.push('two') }
    merge(one, two).refetch()
    expect(calls).toEqual(['one', 'two'])
  })
})

describe('call sites', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.tsx') ? [path] : []
    })

  it('never render it as a component - the element would always be truthy', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
    const offenders = walk(src)
      // Its own file describes the mistake in prose; everywhere else the string is the bug.
      .filter((path) => !path.endsWith('QueryState.tsx'))
      .filter((path) => /<\s*QueryState[\s/>]/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(src.length + 1))
    expect(offenders).toEqual([])
  })
})
