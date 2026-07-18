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

async function git(vaultRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runTool('git', ['-C', vaultRoot, ...args], { timeoutMs: 60_000 })
  return stdout
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
    raw = await git(vaultRoot, ['status', '--porcelain', '-z', '--untracked-files=all'])
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
  if (opts.pathspec !== undefined && targeted.length > 0) {
    await git(vaultRoot, ['add', '--', ...targeted])
    const staged = await git(vaultRoot, ['diff', '--cached', '--name-only'])
    // Nothing matched (e.g. pages were written by a route we didn't observe) → stage all,
    // so the working tree never silently accumulates changes.
    if (staged.trim() === '') await git(vaultRoot, ['add', '-A'])
  } else {
    await git(vaultRoot, ['add', '-A'])
  }

  const staged = await git(vaultRoot, ['status', '--porcelain'])
  if (staged.trim() === '') {
    return {
      committed: false,
      committedPages: [],
      note: 'nothing to commit (a concurrent job likely committed the changes)',
    }
  }
  await git(vaultRoot, [...AUTHOR_ARGS, 'commit', '--no-verify', '-m', message])
  const hash = (await git(vaultRoot, ['rev-parse', 'HEAD'])).trim()
  const files = await git(vaultRoot, ['show', '--name-only', '--pretty=format:', 'HEAD'])
  return { committed: true, hash, committedPages: wikiPagesFrom(files) }
}
