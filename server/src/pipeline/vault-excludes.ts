/**
 * Keeps derived artifacts and agent scratch out of the vault's git history.
 *
 * The vault is a git repo whose history is the user's record of what their knowledge base
 * actually is. Two kinds of file must never enter it:
 *
 *  - REBUILDABLE INDEX DATA (`.vault-meta/chunks`, `bm25`, `embed-cache.json`) - hundreds of
 *    megabytes that regenerate from the wiki, and that `dirtyPaths` bracketing would
 *    otherwise sweep into whatever ingest happened to be running.
 *
 *  - AGENT SCRATCH. An agent asked to health-check 750 pages will reasonably write itself a
 *    scanner and dump its findings somewhere. That happened: a lint run committed a 254-line
 *    Python script and a 472 KB JSON dump into the vault permanently. The scratch was
 *    legitimate; keeping it forever was not.
 *
 * Why an exclude and not "tell the agent to clean up": `BOOKKEEPING_PATHS` stages
 * `.vault-meta` wholesale on every commit, so anything left there at commit time lands in
 * history whatever the prompt said. `git add` skips ignored untracked files, which makes
 * this the one mechanism that holds regardless of what the agent does.
 *
 * `.git/info/exclude` rather than `.gitignore`: repo-local, never a tracked file, so the
 * service never modifies vault CONTENT to do this (hard rule 1). Note the limit - excludes
 * only affect untracked files. Anything already committed stays committed until someone
 * removes it deliberately, which is a decision about the user's history, not ours.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Rebuildable retrieval-index artifacts (SPEC.md §12.6). */
export const RETRIEVE_EXCLUDE_ENTRIES = [
  '.vault-meta/chunks/',
  '.vault-meta/bm25/',
  '.vault-meta/embed-cache.json',
] as const

/**
 * Agent scratch under `.vault-meta/`.
 *
 * `.vault-meta` is the vault's STATE directory - the plugin's own code lives in `scripts/`,
 * so a `.py` file appearing here is by definition something an agent wrote for itself. The
 * `lint-scan` entries cover the pinned intermediate path the lint prompt names, plus the
 * underscore spelling a run picked on its own before that path existed.
 */
export const SCRATCH_EXCLUDE_ENTRIES = [
  '.vault-meta/*.py',
  '.vault-meta/lint-scan.json',
  '.vault-meta/lint_scan*',
] as const

const ALL_ENTRIES = [...RETRIEVE_EXCLUDE_ENTRIES, ...SCRATCH_EXCLUDE_ENTRIES] as const

/**
 * Idempotently appends the entries to the vault's `.git/info/exclude`. No-op when the vault
 * is not a git repo (fresh clone, test fixture) - this is hygiene, never a gate.
 *
 * Only appends what is missing, so a user's own additions to that file are left alone.
 */
export function ensureVaultExcludes(vaultRoot: string, entries: readonly string[] = ALL_ENTRIES): void {
  if (!fs.existsSync(path.join(vaultRoot, '.git'))) return
  const infoDir = path.join(vaultRoot, '.git', 'info')
  fs.mkdirSync(infoDir, { recursive: true })
  const file = path.join(infoDir, 'exclude')
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const present = new Set(existing.split('\n').map((line) => line.trim()))
  const missing = entries.filter((entry) => !present.has(entry))
  if (missing.length === 0) return
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  fs.appendFileSync(file, `${sep}${missing.join('\n')}\n`)
}
