import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { dirtyPaths, newWikiPaths } from '../src/pipeline/git.js'

// Runs against a REAL git repo: the bug this guards (finding F4) was about how git reports
// paths — quoting, renames — which a mocked git could not reproduce.

let repo: string
const git = (...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
}
const write = (rel: string, body = 'x'): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), body)
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-git-'))
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  write('wiki/concepts/Existing.md')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

describe('dirtyPaths', () => {
  it('reports untracked and modified paths', async () => {
    write('wiki/concepts/New.md')
    write('wiki/concepts/Existing.md', 'changed')
    const dirty = await dirtyPaths(repo)
    expect(dirty.has('wiki/concepts/New.md')).toBe(true)
    expect(dirty.has('wiki/concepts/Existing.md')).toBe(true)
  })

  it('handles paths with spaces and colons unquoted', async () => {
    // The real F4 page was `Research: Recent Insights into ….md`. Default porcelain output
    // QUOTES such paths; `git add` on the quoted form would then fail.
    const tricky = 'wiki/questions/Research: Recent Insights (2026).md'
    write(tricky)
    const dirty = await dirtyPaths(repo)
    expect(dirty.has(tricky)).toBe(true)
    for (const p of dirty) expect(p.startsWith('"')).toBe(false)
  })

  it('reports both sides of a rename', async () => {
    git('mv', 'wiki/concepts/Existing.md', 'wiki/concepts/Renamed.md')
    const dirty = await dirtyPaths(repo)
    // Both halves are needed: staging only the new name leaves the deletion uncommitted.
    expect(dirty.has('wiki/concepts/Renamed.md')).toBe(true)
    expect(dirty.has('wiki/concepts/Existing.md')).toBe(true)
  })

  it('is empty on a clean repo', async () => {
    expect((await dirtyPaths(repo)).size).toBe(0)
  })
})

describe('newWikiPaths', () => {
  it('returns what a run newly touched under wiki/', () => {
    const before = new Set(['wiki/concepts/Existing.md'])
    const after = new Set(['wiki/concepts/Existing.md', 'wiki/concepts/New.md'])
    expect(newWikiPaths(before, after)).toEqual(['wiki/concepts/New.md'])
  })

  it('never sweeps in files the user already had dirty (SPEC risk 5)', () => {
    // The user is editing a page while the pipeline runs; that edit is not ours to commit.
    const before = new Set(['wiki/concepts/UserEdit.md', '.obsidian/workspace.json'])
    const after = new Set(['wiki/concepts/UserEdit.md', '.obsidian/workspace.json', 'wiki/concepts/Agent.md'])
    expect(newWikiPaths(before, after)).toEqual(['wiki/concepts/Agent.md'])
  })

  it('ignores churn outside wiki/, e.g. Obsidian rewriting its UI state mid-run', () => {
    const before = new Set<string>()
    const after = new Set(['.obsidian/workspace.json', '.obsidian/graph.json', 'wiki/concepts/A.md'])
    expect(newWikiPaths(before, after)).toEqual(['wiki/concepts/A.md'])
  })

  it('catches the F4 case end-to-end: a page written then renamed via Bash', async () => {
    const before = await dirtyPaths(repo)
    // What the agent did: Write created one name, then Bash `mv` renamed it.
    write('wiki/questions/Research- Draft.md', '# synthesis')
    fs.renameSync(
      path.join(repo, 'wiki/questions/Research- Draft.md'),
      path.join(repo, 'wiki/questions/Research: Final.md'),
    )
    const touched = newWikiPaths(before, await dirtyPaths(repo))
    // Only the surviving name is dirty, and it IS captured — previously the pathspec held the
    // pre-rename path (from the Write call) and this page went uncommitted.
    expect(touched).toEqual(['wiki/questions/Research: Final.md'])
  })
})
