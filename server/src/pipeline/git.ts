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

import path from 'node:path'
import { runTool } from './preprocess/tools.js'

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

/**
 * Stages everything and commits. Returns `committed: false` (not an error) when there is
 * nothing to stage — at concurrency 2 a sibling job may have already swept the shared
 * changes into its own commit. Callers serialize this behind a mutex.
 *
 * `committedPages` is read back from the commit itself (`git show`), NOT from a pre-commit
 * status snapshot: `git add -A` can sweep in a file written after any snapshot, so only
 * the commit is authoritative about what actually landed. Every page is committed exactly
 * once, so the union of `committedPages` across jobs attributes every page exactly once.
 */
export async function commitVault(vaultRoot: string, message: string): Promise<CommitResult> {
  await git(vaultRoot, ['add', '-A'])
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
