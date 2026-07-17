import { describe, it, expect } from 'vitest'
import { resolveInputPath } from '../src/cli/ingest.js'

describe('resolveInputPath', () => {
  it('resolves a relative path against INIT_CWD, not the workspace cwd', () => {
    // Regression: `npm run ingest -- ./x.pdf` runs with cwd = server/ under npm
    // workspaces, so resolving against process.cwd() looked for the file in
    // server/ and reported "not a file" for a path that plainly existed.
    expect(resolveInputPath('./paper.pdf', { INIT_CWD: '/home/user/project' })).toBe(
      '/home/user/project/paper.pdf',
    )
  })

  it('leaves absolute paths untouched', () => {
    expect(resolveInputPath('/tmp/paper.pdf', { INIT_CWD: '/home/user/project' })).toBe(
      '/tmp/paper.pdf',
    )
  })

  it('handles parent-relative paths', () => {
    expect(resolveInputPath('../docs/paper.pdf', { INIT_CWD: '/home/user/project' })).toBe(
      '/home/user/docs/paper.pdf',
    )
  })

  it('falls back to process.cwd() when INIT_CWD is absent (direct tsx invocation)', () => {
    expect(resolveInputPath('paper.pdf', {})).toBe(`${process.cwd()}/paper.pdf`)
  })
})
