/**
 * Vault git commits (SPEC.md §3.1, §9; TASKS-M1 §0). Every successful ingest becomes one
 * commit `ingest: <source>` so a bad run is revertible (the §9 undo mechanism). The
 * vault's own auto-commit hook is disabled (`.vault-meta/auto-commit.disabled`), so this
 * is the ONLY thing committing — "only one of the two commits" (SPEC.md §3.1) is settled
 * in the service's favour.
 *
 * `.raw/` is tracked in the vault, so a commit captures the original + normalized source
 * alongside the wiki pages — matching how the M0 ingests were committed by hand.
 */

import fs from 'node:fs'
import path from 'node:path'
import { runTool } from './preprocess/tools.js'

/**
 * Bookkeeping paths that ride along with EVERY vault commit — script-written, regenerable,
 * shared across runs rather than owned by one job.
 *
 * `.raw/.manifest.json` is load-bearing here: the wiki-ingest skill rewrites it as its delta
 * tracker on every run. Leaving it out of the pathspec meant each ingest re-dirtied it and
 * `git status` in the vault never came back clean (TASKS-M5 §0). Both the ingest queue and the
 * maintenance runner stage these, so they are defined once here to stop the two drifting apart.
 */
export const BOOKKEEPING_PATHS = ['.vault-meta', '.raw/.manifest.json'] as const

/** Commit identity, matching the M0 hand-made ingest commits. */
const AUTHOR_ARGS = [
  '-c',
  'user.name=vault-service',
  '-c',
  'user.email=vault-service@localhost',
] as const

export interface CommitResult {
  readonly committed: boolean
  readonly hash?: string
  /** Wiki markdown pages contained in THIS commit, vault-relative POSIX paths. */
  readonly committedPages: string[]
  /** Why nothing was committed, when `committed` is false. */
  readonly note?: string
}

/**
 * `.git/index.lock` is held by every git command that writes the index, and a plain
 * `git status` is one of them - it refreshes the index and writes it back. Our own commits
 * are serialized by the shared commit mutex, but the vault is a shared DIRECTORY: the
 * dashboard's own status polling, Obsidian's git plugin, a terminal, anything can hold the
 * lock for a few milliseconds at exactly the wrong moment.
 *
 * A command that fails this way did no work at all - git bails before touching anything - so
 * retrying it is safe for reads and writes alike, `commit` included. Measured 2026-08-24: an
 * ingest's `git add` lost this race, the run's commit was dropped, and its `.raw/` payload
 * and address counter stayed unversioned (the wiki pages were recovered by the reconcile
 * pass, which only covers `wiki/**`).
 */
const LOCK_RETRIES = 3
const LOCK_BACKOFF_MS = 120

function isIndexLockContention(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('index.lock') && message.includes('File exists')
}

async function git(vaultRoot: string, args: readonly string[]): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await runTool('git', ['-C', vaultRoot, ...args], { timeoutMs: 60_000 })
      return stdout
    } catch (err) {
      // A lock held by a crashed git never clears, so this stays bounded: after the last
      // attempt the caller sees the original failure, exactly as before.
      if (attempt > LOCK_RETRIES || !isIndexLockContention(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, LOCK_BACKOFF_MS * attempt))
    }
  }
}

/**
 * Read-only git, for the status calls that run OUTSIDE the commit mutex - `/api/v1/stats`
 * polls one on every SSE tick, and a `done` transition publishes that tick milliseconds
 * before the run's own commit runs, so an open dashboard sat right in the window.
 *
 * `--no-optional-locks` is what keeps a read out of `.git/index.lock`: git then skips the
 * index write-back it would otherwise do to refresh cached stat info. The reported status is
 * identical - only the write is skipped (verified against a 400-file repo: the index mtime
 * moves after a plain `git status` and does not move with the flag).
 */
async function gitRead(vaultRoot: string, args: readonly string[]): Promise<string> {
  return git(vaultRoot, ['--no-optional-locks', ...args])
}

/**
 * Vault-relative paths git currently reports as dirty (modified, staged, or untracked).
 *
 * Used to bracket an agent run: what is dirty AFTER minus what was dirty BEFORE is what the run
 * actually touched — including files it created or renamed with **Bash**, which the Write/Edit
 * derived pathspec cannot see (finding F4: an autoresearch run's synthesis page was written with
 * Write and then renamed with Bash, so the staged path no longer existed and the real one was
 * never staged, leaving the page unversioned).
 *
 * `-z` is deliberate: the default porcelain output quotes and escapes paths containing spaces or
 * colons, which vault page names routinely have. NUL-separated output needs no unquoting.
 */
export async function dirtyPaths(vaultRoot: string): Promise<Set<string>> {
  let raw: string
  try {
    raw = await gitRead(vaultRoot, ['status', '--porcelain', '-z', '--untracked-files=all'])
  } catch {
    // Not a repo, or git unavailable. Degrade to the Write/Edit-derived pathspec rather than
    // sinking the run: a commit that stages a little less is recoverable, a failed ingest is not.
    return new Set()
  }
  const fields = raw.split('\0')
  const paths = new Set<string>()
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry === undefined || entry.length < 4) continue
    const status = entry.slice(0, 2)
    paths.add(entry.slice(3))
    // A rename/copy entry is followed by its ORIGIN path in the next NUL field; consume it so it
    // is not misread as another status entry, and record it — the old name needs staging too, or
    // the deletion half of the rename never lands.
    if (status.startsWith('R') || status.startsWith('C')) {
      const origin = fields[++i]
      if (origin !== undefined && origin !== '') paths.add(origin)
    }
  }
  return paths
}

export interface UnversionedPages {
  /** Wiki pages git has never seen: on disk, absent from history entirely. */
  readonly untracked: string[]
  /** Wiki pages whose working copy differs from the last commit. */
  readonly modified: string[]
}

/**
 * Wiki pages that exist on disk but not in git as committed content.
 *
 * This is the missing half of finding F4. The commit pathspec is built from a run's
 * `Write`/`Edit` tool calls, so a page the agent creates with **Bash** is invisible to it -
 * and the sweep that would catch those (`newWikiPaths`) is deliberately skipped whenever the
 * run cannot prove it was the sole vault writer, because misattributing a page to the wrong
 * job is worse than missing it. That trade-off is sound, and it rests on one assumption:
 *
 *     "Losing a page from a commit is visible and fixable."
 *
 * Nothing made it visible. With concurrency above 1 - and a batch drop routinely puts eight
 * jobs in flight at once - "not the sole writer" is the normal case, not the exception, so
 * pages accumulate outside git silently. They still render, still resolve links, still get
 * indexed; they simply have no history, cannot be reverted, and disappear without trace if
 * the vault is ever restored from git. This function is what turns that into a fact the
 * dashboard can state.
 *
 * Deliberately NOT included: deletions. A page deleted but not yet committed is a divergence
 * too, but it is not content at risk, and mixing the two would blur what the number means.
 *
 * Costs one `git status` (~8ms on a 750-page vault). Returns empty when git is unavailable,
 * for the same reason `dirtyPaths` does: this is a report, never a gate.
 */
export async function unversionedWikiPages(vaultRoot: string): Promise<UnversionedPages> {
  let raw: string
  try {
    raw = await gitRead(vaultRoot, ['status', '--porcelain', '-z', '--untracked-files=all'])
  } catch {
    return { untracked: [], modified: [] }
  }
  const untracked: string[] = []
  const modified: string[] = []
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry === undefined || entry.length < 4) continue
    const status = entry.slice(0, 2)
    const file = entry.slice(3)
    // A rename/copy entry carries its origin in the next field; consume it so it is not
    // misread as a status entry of its own.
    if (status.startsWith('R') || status.startsWith('C')) i++
    if (!file.startsWith('wiki/') || !file.endsWith('.md')) continue
    if (status === '??') untracked.push(file)
    else if (status.includes('D')) continue
    else modified.push(file)
  }
  return { untracked: untracked.sort(), modified: modified.sort() }
}

/**
 * Wiki paths that became dirty during a run — `after` minus `before`, scoped to `wiki/`.
 *
 * Scoping matters twice over: it keeps the vault's own churn (Obsidian rewriting
 * `.obsidian/workspace.json` mid-run) out of our commits, and it means files the user already had
 * dirty before the run are never swept in (SPEC.md §11.3 risk 5 — the user may be editing the
 * vault while the pipeline runs). Only what this run newly touched under the wiki is returned.
 */
export function newWikiPaths(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...after].filter((p) => !before.has(p) && p.startsWith('wiki/')).sort()
}

/** Wiki markdown paths from a newline list of files, vault-relative POSIX. */
function wikiPagesFrom(files: string): string[] {
  return files
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('wiki/') && p.endsWith('.md'))
    .map((p) => p.split(path.sep).join(path.posix.sep))
}

/**
 * Commits EXACTLY the given paths — used by user-initiated page edits/deletes from the
 * dashboard (SPEC.md §12.4 editing). Unlike commitVault there is deliberately NO
 * `git add -A` fallback and the commit itself is pathspec-limited: these commits can run
 * while an agent is mid-write (the agent's own commit comes later, under the same mutex),
 * and sweeping its half-written pages into a user's edit commit would file them under the
 * wrong change. `git add -- <path>` stages a deletion of a tracked file just fine.
 */
export async function commitPaths(
  vaultRoot: string,
  message: string,
  paths: readonly string[],
): Promise<CommitResult> {
  await git(vaultRoot, ['add', '--', ...paths])
  const staged = await git(vaultRoot, ['diff', '--cached', '--name-only', '--', ...paths])
  if (staged.trim() === '') {
    return { committed: false, committedPages: [], note: 'nothing to commit — content unchanged' }
  }
  // `commit -- <paths>` commits only these paths, leaving anything else staged untouched.
  await git(vaultRoot, [...AUTHOR_ARGS, 'commit', '--no-verify', '-m', message, '--', ...paths])
  const hash = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
  const files = await git(vaultRoot, ['show', '--name-only', '--pretty=format:', 'HEAD'])
  return { committed: true, hash, committedPages: wikiPagesFrom(files) }
}

/** Why a revert could not be performed — each maps to a specific, actionable message. */
export type RevertRefusal = 'unknown-commit' | 'dirty-tree' | 'conflict' | 'already-reverted'

export interface RevertResult {
  readonly reverted: boolean
  /** The NEW commit that undoes the original (present only on success). */
  readonly hash?: string
  readonly refusal?: RevertRefusal
  readonly message?: string
}

/**
 * Undoes exactly one vault commit (SPEC.md §9's undo mechanism, surfaced as the dashboard's
 * "revert this ingest"). Callers MUST hold the shared commit mutex — this writes the vault.
 *
 * The whole value of this function is that it either fully succeeds or leaves the vault exactly
 * as it found it. Three guards, in order:
 *
 *  1. The commit must exist and be an ancestor of HEAD.
 *  2. The working tree must be CLEAN. `git revert` on a dirty tree either refuses or mixes an
 *     in-flight agent's half-written pages into the revert; the commit mutex serializes
 *     COMMITS but agents write files outside it, so this check is what actually protects us.
 *  3. On conflict (a later commit touched the same lines) we `git revert --abort` and report it,
 *     rather than leaving conflict markers in wiki pages for the next ingest to read as content.
 */
export async function revertCommit(vaultRoot: string, hash: string): Promise<RevertResult> {
  try {
    await git(vaultRoot, ['cat-file', '-e', `${hash}^{commit}`])
  } catch {
    return { reverted: false, refusal: 'unknown-commit', message: `no such commit in the vault: ${hash}` }
  }
  try {
    await git(vaultRoot, ['merge-base', '--is-ancestor', hash, 'HEAD'])
  } catch {
    return {
      reverted: false,
      refusal: 'unknown-commit',
      message: `commit ${hash.slice(0, 8)} is not part of the current history`,
    }
  }

  const dirty = await dirtyPaths(vaultRoot)
  if (dirty.size > 0) {
    return {
      reverted: false,
      refusal: 'dirty-tree',
      message:
        'the vault has uncommitted changes — a run may still be writing. Wait for it to finish, then retry.',
    }
  }

  const before = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
  try {
    await git(vaultRoot, [...AUTHOR_ARGS, 'revert', '--no-edit', '--no-commit', hash])
  } catch (err) {
    // Leave nothing half-applied: restore the index and tree we started from.
    try {
      await git(vaultRoot, ['revert', '--abort'])
    } catch {
      try {
        await git(vaultRoot, ['reset', '--hard', before])
      } catch {
        /* nothing further we can safely do; the message below tells the operator */
      }
    }
    return {
      reverted: false,
      refusal: 'conflict',
      message:
        `reverting ${hash.slice(0, 8)} conflicts with later changes — the vault was left untouched. ` +
        `Undo it by hand if you still want it: git -C <vault> revert ${hash.slice(0, 8)}. ` +
        `(${(err as Error).message.split('\n')[0]})`,
    }
  }

  const staged = await git(vaultRoot, ['diff', '--cached', '--name-only'])
  if (staged.trim() === '') {
    // Nothing to undo — the commit's changes are already gone (reverted earlier, or overwritten).
    await git(vaultRoot, ['reset', '--hard', before])
    return {
      reverted: false,
      refusal: 'already-reverted',
      message: `nothing to undo — ${hash.slice(0, 8)} has already been reverted or superseded`,
    }
  }

  await git(vaultRoot, [...AUTHOR_ARGS, 'commit', '--no-verify', '-m', `revert ingest ${hash.slice(0, 8)}`])
  const newHash = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
  return { reverted: true, hash: newHash }
}

export interface CommitOptions {
  /**
   * Vault-relative paths to stage for THIS commit (F4). Staging only a job's own paths
   * keeps a `git revert` of one ingest from disturbing a concurrently-committed sibling.
   * Omit to stage everything (`git add -A`, legacy/coarse behaviour). If a targeted stage
   * matches nothing on disk, we fall back to `git add -A` so the tree never silently keeps
   * uncommitted changes.
   */
  readonly pathspec?: readonly string[]
}

/**
 * Stages and commits. Returns `committed: false` (not an error) when there is nothing to
 * stage. Callers serialize this behind a mutex.
 *
 * `committedPages` is read back from the commit itself (`git show`), NOT a pre-commit
 * status snapshot, so it is authoritative about what actually landed.
 */
export async function commitVault(
  vaultRoot: string,
  message: string,
  opts: CommitOptions = {},
): Promise<CommitResult> {
  const targeted = (opts.pathspec ?? []).filter((p) => fs.existsSync(path.join(vaultRoot, p)))
  if (opts.pathspec !== undefined) {
    // Explicit pathspec: stage ONLY these paths, and NEVER fall back to `git add -A`. A
    // pathspec that matches nothing on disk means this run wrote nothing of its own that
    // survives — falling back to `add -A` here is precisely what swept an interrupted ingest's
    // orphaned pages into an unrelated maintenance commit (the 2026-07-21 Q8/Q14 incident).
    // Draining orphaned dirty pages is startup reconciliation's job (queue.reconcileInterrupted),
    // never any run's own commit. The old fallback existed "so the tree never silently
    // accumulates changes"; that trade — mis-attributing another run's work vs. leaving it for
    // reconciliation — is the wrong one, so it is gone.
    if (targeted.length > 0) await git(vaultRoot, ['add', '--', ...targeted])
  } else {
    // Legacy no-pathspec callers keep the coarse `add -A` behaviour.
    await git(vaultRoot, ['add', '-A'])
  }

  // Gate on what is actually STAGED, not the whole working tree: with the fallback gone, a
  // pathspec that matched nothing leaves the tree dirty (orphans) but the index empty, and a
  // bare `git commit` would then fail. `diff --cached` sees only what this call staged.
  const staged = await git(vaultRoot, ['diff', '--cached', '--name-only'])
  if (staged.trim() === '') {
    return {
      committed: false,
      committedPages: [],
      note: 'nothing to commit (no matching paths staged; a concurrent job may have committed them)',
    }
  }
  await git(vaultRoot, [...AUTHOR_ARGS, 'commit', '--no-verify', '-m', message])
  const hash = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
  const files = await git(vaultRoot, ['show', '--name-only', '--pretty=format:', 'HEAD'])
  return { committed: true, hash, committedPages: wikiPagesFrom(files) }
}
