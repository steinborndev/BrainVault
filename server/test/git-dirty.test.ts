import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { dirtyPaths, newWikiPaths, commitPaths, commitVault, unversionedWikiPages } from '../src/pipeline/git.js'

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

describe('unversionedWikiPages', () => {
  // This is the reporting half of the F4 trade-off. The sweep in `newWikiPaths` is skipped
  // whenever a run cannot prove it was the sole writer, on the stated grounds that "losing a
  // page from a commit is visible and fixable" - nothing ever made it visible, so pages sat
  // outside git for a month. These tests pin what "visible" means.

  it('reports a page that was never committed', async () => {
    write('wiki/concepts/Bash Written.md')
    const u = await unversionedWikiPages(repo)
    expect(u.untracked).toEqual(['wiki/concepts/Bash Written.md'])
    expect(u.modified).toEqual([])
  })

  it('reports a committed page whose working copy has drifted', async () => {
    write('wiki/concepts/Existing.md', 'changed')
    const u = await unversionedWikiPages(repo)
    expect(u.modified).toEqual(['wiki/concepts/Existing.md'])
    expect(u.untracked).toEqual([])
  })

  it('is silent on a clean vault - the healthy state has to be reachable', async () => {
    expect(await unversionedWikiPages(repo)).toEqual({ untracked: [], modified: [] })
  })

  it('ignores everything that is not a wiki page', async () => {
    // .raw payloads, index scratch and plugin files are dirty constantly by design; counting
    // them would bury the one number that means content is at risk.
    write('.raw/01ABC/manifest.json')
    write('.vault-meta/lint-scan.json')
    write('wiki/concepts/Note.txt')
    const u = await unversionedWikiPages(repo)
    expect(u.untracked).toEqual([])
    expect(u.modified).toEqual([])
  })

  it('handles page names with spaces and punctuation without unquoting artifacts', async () => {
    // Vault titles routinely carry spaces, commas and parentheses; porcelain quotes those
    // unless -z is used, and a quoted path would silently never match the wiki/ prefix.
    write('wiki/concepts/Log P and Log D (HPLC, Shake-Flask).md')
    const u = await unversionedWikiPages(repo)
    expect(u.untracked).toEqual(['wiki/concepts/Log P and Log D (HPLC, Shake-Flask).md'])
  })

  it('counts a page deleted-but-not-committed as neither - it is not content at risk', async () => {
    fs.rmSync(path.join(repo, 'wiki/concepts/Existing.md'))
    const u = await unversionedWikiPages(repo)
    expect(u.untracked).toEqual([])
    expect(u.modified).toEqual([])
  })

  it('degrades to empty outside a git repo rather than throwing', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'))
    try {
      expect(await unversionedWikiPages(bare)).toEqual({ untracked: [], modified: [] })
    } finally {
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('index.lock discipline', () => {
  // 2026-08-24: an ingest's `git add` failed with "Unable to create .git/index.lock: File
  // exists" and its commit was dropped - the run's `.raw/` payload and address counter stayed
  // unversioned, and only the wiki pages were recovered (by the reconcile pass, which covers
  // nothing else). The lock holder was our own status polling: `/api/v1/stats` runs one on
  // every SSE tick, and a job's `done` transition publishes that tick milliseconds before the
  // run's own commit. Both halves of the fix are pinned here.

  /** Stat info git has cached is now stale, so the next read WANTS to refresh the index. */
  const staleTheIndex = (): void => {
    const now = Date.now() / 1000 + 5
    fs.utimesSync(path.join(repo, 'wiki/concepts/Existing.md'), now, now)
  }
  const indexMtime = (): number => fs.statSync(path.join(repo, '.git/index')).mtimeMs

  it('a read does not take the lock - it never rewrites the index', async () => {
    staleTheIndex()
    const before = indexMtime()
    await dirtyPaths(repo)
    await unversionedWikiPages(repo)
    // A plain `git status` writes the refreshed index back, and holds `.git/index.lock`
    // while it does. `--no-optional-locks` is what skips that write; without it these two
    // reads race every commit the service makes.
    expect(indexMtime()).toBe(before)
  })

  it('the control: a plain status DOES rewrite it, which is the race being avoided', () => {
    staleTheIndex()
    const before = indexMtime()
    execFileSync('git', ['-C', repo, 'status', '--porcelain', '-z', '--untracked-files=all'], { stdio: 'pipe' })
    expect(indexMtime()).not.toBe(before)
  })

  it('a write retries through a lock held by someone else', async () => {
    // Anything may hold it for a few milliseconds - Obsidian's git plugin, a terminal, our
    // own reads before this fix. A command that loses the race did no work at all, so the
    // retry is safe: this must end in a commit, not in pages left on disk.
    write('wiki/concepts/Written While Locked.md', '# page')
    const lock = path.join(repo, '.git/index.lock')
    fs.writeFileSync(lock, '')
    const release = setTimeout(() => fs.rmSync(lock, { force: true }), 150)
    try {
      const res = await commitPaths(repo, 'ingest: contested', ['wiki/concepts/Written While Locked.md'])
      expect(res.committed).toBe(true)
      expect(res.committedPages).toEqual(['wiki/concepts/Written While Locked.md'])
    } finally {
      clearTimeout(release)
      fs.rmSync(lock, { force: true })
    }
  })

  it('gives up on a lock that never clears, rather than hanging', async () => {
    write('wiki/concepts/Never Committed.md', '# page')
    const lock = path.join(repo, '.git/index.lock')
    fs.writeFileSync(lock, '')
    try {
      await expect(commitPaths(repo, 'ingest: stuck', ['wiki/concepts/Never Committed.md'])).rejects.toThrow(
        /index\.lock/,
      )
    } finally {
      fs.rmSync(lock, { force: true })
    }
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

describe('commitVault — no add -A sweep on an explicit pathspec', () => {
  const head = (): string => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim()

  it('commits ONLY the pathspec, never a foreign dirty page an unrelated run left behind', async () => {
    // A dead run's orphaned page is sitting dirty in the tree (the Q8/Q14 incident shape).
    write('wiki/concepts/Orphan From Dead Run.md', '# orphan')
    // This run legitimately wrote its own page and commits it by exact pathspec.
    write('wiki/concepts/Mine.md', '# mine')
    const res = await commitVault(repo, 'ingest: mine', { pathspec: ['wiki/concepts/Mine.md'] })

    expect(res.committed).toBe(true)
    const committed = execFileSync('git', ['-C', repo, 'show', '--name-only', '--pretty=format:', 'HEAD'])
      .toString()
      .trim()
      .split('\n')
    expect(committed).toContain('wiki/concepts/Mine.md')
    // The orphan is NOT in the commit and stays dirty — draining it is reconciliation's job.
    expect(committed).not.toContain('wiki/concepts/Orphan From Dead Run.md')
    expect((await dirtyPaths(repo)).has('wiki/concepts/Orphan From Dead Run.md')).toBe(true)
  })

  it('reports committed:false (no add -A) when the pathspec matches nothing on disk', async () => {
    const before = head()
    // A foreign dirty page exists, but this run's own pathspec matches nothing — the old
    // fallback would have `git add -A`-swept the foreign page. It must not.
    write('wiki/concepts/Someone Elses Edit.md', '# not mine')
    const res = await commitVault(repo, 'ingest: nothing of mine', {
      pathspec: ['wiki/concepts/Does Not Exist.md'],
    })

    expect(res.committed).toBe(false)
    expect(head()).toBe(before) // no new commit
    expect((await dirtyPaths(repo)).has('wiki/concepts/Someone Elses Edit.md')).toBe(true)
  })

  it('still stages everything for a legacy no-pathspec call', async () => {
    write('wiki/concepts/A.md', '# a')
    write('wiki/concepts/B.md', '# b')
    const res = await commitVault(repo, 'maintenance: coarse')

    expect(res.committed).toBe(true)
    const committed = execFileSync('git', ['-C', repo, 'show', '--name-only', '--pretty=format:', 'HEAD'])
      .toString()
      .trim()
      .split('\n')
    expect(committed).toEqual(expect.arrayContaining(['wiki/concepts/A.md', 'wiki/concepts/B.md']))
  })
})

/**
 * Git QUOTES any path holding a byte outside plain ASCII, escaping it octally:
 * `wiki/x — y.md` comes back as `"wiki/x \342\200\224 y.md"`. A reader that filters on
 * `startsWith('wiki/')` drops it, so the page silently vanished from what a run reported
 * having written - and in this vault every research synthesis page has an em dash in its
 * name (2026-08-26). Every reader passes `-z` now, which never quotes.
 */
describe('paths git would quote', () => {
  const NON_ASCII = 'wiki/questions/Research: Topic — State of the Art.md'

  it('reports a page whose name holds an em dash', async () => {
    write(NON_ASCII, '# synthesis')
    write('wiki/concepts/Plain.md', '# plain')
    const res = await commitVault(repo, 'maintenance: research', {
      pathspec: [NON_ASCII, 'wiki/concepts/Plain.md'],
    })

    expect(res.committed).toBe(true)
    expect(res.committedPages).toEqual(expect.arrayContaining([NON_ASCII, 'wiki/concepts/Plain.md']))
  })

  it('reports one whose name holds an umlaut, through the pathspec-limited commit too', async () => {
    const UMLAUT = 'wiki/concepts/Größe und Maß.md'
    write(UMLAUT, '# size')
    const res = await commitPaths(repo, 'edit: size', [UMLAUT])

    expect(res.committed).toBe(true)
    expect(res.committedPages).toEqual([UMLAUT])
  })

  it('still reports nothing but wiki markdown', async () => {
    write(NON_ASCII, '# synthesis')
    write('.vault-meta/address-counter.txt', '42')
    const res = await commitVault(repo, 'maintenance: research', {
      pathspec: [NON_ASCII, '.vault-meta/address-counter.txt'],
    })

    expect(res.committedPages).toEqual([NON_ASCII])
  })
})
