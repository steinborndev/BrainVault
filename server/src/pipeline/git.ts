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

/** Wiki markdown paths from a newline list of files, vault-relative POSIX. */
function wikiPagesFrom(files: string): string[] {
  return files
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('wiki/') && p.endsWith('.md'))
    .map((p) => p.split(path.sep).join(path.posix.sep))
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
