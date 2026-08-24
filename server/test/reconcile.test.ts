/**
 * The reconcile pass (pipeline/reconcile.ts): commits wiki pages no run staged, on the edge
 * where the last vault writer finishes.
 *
 * Runs against a REAL git repo. The bug this closes is entirely about what git reports as
 * dirty and when - a mocked git would let every one of these tests pass while the real thing
 * stayed broken, which is exactly how the pages went missing in the first place.
 *
 * Two properties carry the whole design, and they pull against each other:
 *   1. it must catch what the per-run sweep cannot (Bash-written pages, concurrent runs)
 *   2. it must never commit while anything is still writing, and never touch what the user
 *      already had in progress before the pipeline started
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { VaultReconciler } from '../src/pipeline/reconcile.js'
import { RunRegistry } from '../src/pipeline/run-registry.js'
import { dirtyPaths } from '../src/pipeline/git.js'
import { EventBus } from '../src/pipeline/events.js'
import { Mutex } from '../src/util/mutex.js'

let repo: string
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' })

const write = (rel: string, body = 'x'): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), body)
}

const tracked = (): string[] =>
  git('ls-files', 'wiki')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-reconcile-'))
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  write('wiki/concepts/Existing.md')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

function makeReconciler(registry: RunRegistry, autoCommit = true): VaultReconciler {
  return new VaultReconciler({
    vaultRoot: repo,
    commitMutex: new Mutex(),
    runRegistry: registry,
    events: new EventBus(),
    autoCommit: () => autoCommit,
  })
}

describe('VaultReconciler', () => {
  it('commits a page that became dirty during the busy period and nobody staged', async () => {
    const registry = new RunRegistry()
    const reconciler = makeReconciler(registry)
    const baseline = await dirtyPaths(repo)

    // A run writes a page with Bash - invisible to a Write/Edit-derived pathspec - and
    // commits nothing.
    const end = registry.begin(baseline)
    write('wiki/concepts/Bash Written.md')
    end()

    await reconciler.reconcile(baseline)
    expect(tracked()).toContain('wiki/concepts/Bash Written.md')
  })

  it('commits a modified page too, not only new ones', async () => {
    // The page that surfaced this carried edits from two maintenance runs and was tracked
    // already; a new-files-only sweep would have walked straight past it.
    const registry = new RunRegistry()
    const reconciler = makeReconciler(registry)
    const baseline = await dirtyPaths(repo)

    const end = registry.begin(baseline)
    write('wiki/concepts/Existing.md', 'rewritten by a run')
    end()

    await reconciler.reconcile(baseline)
    expect(git('status', '--porcelain')).toBe('')
  })

  it('leaves alone what the user already had in progress before the pipeline started', async () => {
    // SPEC.md §11.3 risk 5. The baseline is captured before the first writer, so a page the
    // user was already editing is not the pipeline's to commit.
    write('wiki/concepts/User Draft.md', 'half a thought')
    const registry = new RunRegistry()
    const reconciler = makeReconciler(registry)
    const baseline = await dirtyPaths(repo)

    const end = registry.begin(baseline)
    write('wiki/concepts/Run Wrote.md')
    end()

    await reconciler.reconcile(baseline)
    expect(tracked()).toContain('wiki/concepts/Run Wrote.md')
    expect(tracked()).not.toContain('wiki/concepts/User Draft.md')
  })

  it('does nothing while a writer is still running', async () => {
    // The count is re-checked inside the commit mutex, not at the edge that scheduled the
    // pass: a run starting in between owns its own pages.
    const registry = new RunRegistry()
    const reconciler = makeReconciler(registry)
    const baseline = await dirtyPaths(repo)

    write('wiki/concepts/Mid Flight.md')
    const stillRunning = registry.begin(baseline)

    await reconciler.reconcile(baseline)
    expect(tracked()).not.toContain('wiki/concepts/Mid Flight.md')
    stillRunning()
  })

  it('ignores everything outside wiki/', async () => {
    // .raw payloads and .vault-meta artifacts are dirty by design and belong to the runs
    // that own them; sweeping those into a commit is the bug this service already fixed once.
    const registry = new RunRegistry()
    const reconciler = makeReconciler(registry)
    const baseline = await dirtyPaths(repo)

    const end = registry.begin(baseline)
    write('.raw/01ABC/manifest.json')
    write('.vault-meta/scratch.json')
    end()

    await reconciler.reconcile(baseline)
    expect(git('status', '--porcelain')).toContain('.raw/')
    expect(git('log', '--oneline').split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('makes no commit when there is nothing left over', async () => {
    const registry = new RunRegistry()
    const reconciler = makeReconciler(registry)
    const baseline = await dirtyPaths(repo)
    const end = registry.begin(baseline)
    end()

    const result = await reconciler.reconcile(baseline)
    expect(result.pages).toEqual([])
    expect(git('log', '--oneline').split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('respects gitAutoCommit being off', async () => {
    const registry = new RunRegistry()
    const reconciler = makeReconciler(registry, false)
    const baseline = await dirtyPaths(repo)
    const end = registry.begin(baseline)
    write('wiki/concepts/Not Mine To Commit.md')
    end()

    await reconciler.reconcile(baseline)
    expect(tracked()).not.toContain('wiki/concepts/Not Mine To Commit.md')
  })

  it('fires automatically when the LAST of several overlapping writers finishes', async () => {
    // The scenario that produced the real loss: eight ingests started inside 500ms, so no
    // run was ever the sole writer and every per-run sweep sat out.
    const registry = new RunRegistry()
    const reconciler = makeReconciler(registry)
    reconciler.attach()
    const baseline = await dirtyPaths(repo)

    const a = registry.begin(baseline)
    const b = registry.begin(await dirtyPaths(repo))
    write('wiki/concepts/From A.md')
    write('wiki/concepts/From B.md')
    a()
    // Still one writer left: nothing may be committed yet.
    expect(tracked()).not.toContain('wiki/concepts/From A.md')
    b()

    await new Promise((r) => setTimeout(r, 250))
    expect(tracked()).toContain('wiki/concepts/From A.md')
    expect(tracked()).toContain('wiki/concepts/From B.md')
  })

  it('a pass that throws never escapes into the run that triggered it', async () => {
    const registry = new RunRegistry()
    const reconciler = new VaultReconciler({
      vaultRoot: repo,
      commitMutex: new Mutex(),
      runRegistry: registry,
      events: new EventBus(),
      commit: async () => {
        throw new Error('git exploded')
      },
    })
    reconciler.attach()
    const baseline = await dirtyPaths(repo)

    const end = registry.begin(baseline)
    write('wiki/concepts/Doomed.md')
    expect(() => end()).not.toThrow()

    await new Promise((r) => setTimeout(r, 200))
    expect(await reconciler.reconcile(baseline)).toEqual({ pages: [] })
  })
})

describe('RunRegistry busy-period bracket', () => {
  it('keeps the FIRST writer baseline, not the last', async () => {
    // A later writer's baseline already contains the earlier runs' work in progress; taking
    // it would make the reconcile pass blind to everything written before it joined.
    const registry = new RunRegistry()
    let seen: ReadonlySet<string> | undefined
    registry.onIdle((b) => {
      seen = b
    })

    const first = new Set(['wiki/a.md'])
    const second = new Set(['wiki/a.md', 'wiki/b.md'])
    const a = registry.begin(first)
    const b = registry.begin(second)
    a()
    b()

    expect(seen).toBe(first)
  })

  it('announces only when the last writer leaves', () => {
    const registry = new RunRegistry()
    let calls = 0
    registry.onIdle(() => {
      calls++
    })
    const a = registry.begin(new Set())
    const b = registry.begin(new Set())
    a()
    expect(calls).toBe(0)
    b()
    expect(calls).toBe(1)
  })

  it('a double release cannot announce twice or corrupt the count', () => {
    const registry = new RunRegistry()
    let calls = 0
    registry.onIdle(() => {
      calls++
    })
    const end = registry.begin(new Set())
    end()
    end()
    expect(calls).toBe(1)
    expect(registry.activeRuns).toBe(0)
  })

  it('still answers isSoleWriter the way the per-run sweep expects', () => {
    const registry = new RunRegistry()
    const a = registry.begin(new Set())
    expect(registry.isSoleWriter()).toBe(true)
    const b = registry.begin(new Set())
    expect(registry.isSoleWriter()).toBe(false)
    b()
    expect(registry.isSoleWriter()).toBe(true)
    a()
  })
})
