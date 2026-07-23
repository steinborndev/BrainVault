/**
 * Hybrid-retrieval index maintenance (SPEC.md §12.6, TASKS-RETRIEVE §1): provisions and
 * rebuilds the vault's `wiki-retrieve` chunk/BM25 index by running the vault's OWN scripts
 * as child processes — deterministic, no LLM, no agent run. This is the one sanctioned
 * place where pipeline code writes into the vault tree (hard rule 1 exception): only the
 * derived, rebuildable artifacts under `.vault-meta/{chunks,bm25}` and
 * `.vault-meta/embed-cache.json`, all of which are kept OUT of vault git history via
 * `.git/info/exclude`. That exclusion is load-bearing twice over: `BOOKKEEPING_PATHS`
 * stages `.vault-meta` on every commit, and `dirtyPaths` bracketing lists untracked files —
 * without the exclude entries every rebuild would bleed into the next ingest commit.
 *
 * No `--allow-egress` is ever passed and credentials are stripped from the child env, so
 * `contextual-prefix.py` is pinned to its tier-3 synthetic prefix: nothing leaves the
 * machine during an index build (stage 3 relaxes this behind an explicit setting).
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from './events.js'

/** Entries appended to the vault's `.git/info/exclude` — repo-local, never a tracked file. */
export const RETRIEVE_EXCLUDE_ENTRIES = [
  '.vault-meta/chunks/',
  '.vault-meta/bm25/',
  '.vault-meta/embed-cache.json',
] as const

/** Thrown when the vault clone ships no wiki-retrieve scripts → HTTP 409 at the route. */
export class RetrieveScriptsMissingError extends Error {
  override readonly name = 'RetrieveScriptsMissingError'
}

const REQUIRED_SCRIPTS = ['retrieve.py', 'contextual-prefix.py', 'bm25-index.py'] as const

/** True when the vault ships the wiki-retrieve scripts (claude-obsidian v1.7+). */
export function hasRetrieveScripts(vaultRoot: string): boolean {
  return REQUIRED_SCRIPTS.every((s) => fs.existsSync(path.join(vaultRoot, 'scripts', s)))
}

/**
 * The skill's canonical feature-detection (skills/wiki-retrieve/SKILL.md §Feature gating):
 * scripts present + chunks dir + built BM25 index. Once this is true, the vault's own
 * wiki-query/autoresearch skills start using the index of their own accord.
 */
export function isRetrieveProvisioned(vaultRoot: string): boolean {
  return (
    hasRetrieveScripts(vaultRoot) &&
    fs.existsSync(path.join(vaultRoot, '.vault-meta', 'chunks')) &&
    fs.existsSync(path.join(vaultRoot, '.vault-meta', 'bm25', 'index.json'))
  )
}

/**
 * Idempotently appends the index-artifact entries to the vault's `.git/info/exclude`.
 * `git add .vault-meta` (BOOKKEEPING_PATHS) skips ignored untracked files, so this is what
 * keeps every rebuild out of ingest commits. No-op when the vault is not a git repo.
 */
export function ensureIndexExcluded(vaultRoot: string): void {
  if (!fs.existsSync(path.join(vaultRoot, '.git'))) return
  const infoDir = path.join(vaultRoot, '.git', 'info')
  fs.mkdirSync(infoDir, { recursive: true })
  const file = path.join(infoDir, 'exclude')
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const present = new Set(existing.split('\n').map((line) => line.trim()))
  const missing = RETRIEVE_EXCLUDE_ENTRIES.filter((entry) => !present.has(entry))
  if (missing.length === 0) return
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  fs.appendFileSync(file, `${sep}${missing.join('\n')}\n`)
}

export interface RetrieveIndexStats {
  /** The vault ships the wiki-retrieve scripts at all (v1.7+ clone). */
  readonly scriptsPresent: boolean
  /** Full feature-detection: the vault's skills will use the index. */
  readonly provisioned: boolean
  readonly chunkCount: number
  /** mtime of the BM25 index file (ISO), or null when never built. */
  readonly indexBuiltAt: string | null
}

/** Cheap status for the Maintenance-tab card (`GET /maintenance/retrieve-index`). */
export function retrieveIndexStats(vaultRoot: string): RetrieveIndexStats {
  const indexFile = path.join(vaultRoot, '.vault-meta', 'bm25', 'index.json')
  let indexBuiltAt: string | null = null
  try {
    indexBuiltAt = fs.statSync(indexFile).mtime.toISOString()
  } catch {
    /* never built */
  }
  return {
    scriptsPresent: hasRetrieveScripts(vaultRoot),
    provisioned: isRetrieveProvisioned(vaultRoot),
    chunkCount: countChunks(path.join(vaultRoot, '.vault-meta', 'chunks')),
    indexBuiltAt,
  }
}

function countChunks(dir: string): number {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let n = 0
  for (const entry of entries) {
    if (entry.isDirectory()) n += countChunks(path.join(dir, entry.name))
    else if (/^chunk-\d+\.json$/.test(entry.name)) n++
  }
  return n
}

/** Injectable child-process seam — tests supply a fake, the real python never runs in units. */
export type ProcessRunner = (
  bin: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>

const runProcess: ProcessRunner = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    // Belt and braces on top of the missing --allow-egress flag: without a credential in the
    // child env, contextual-prefix.py cannot pick a network tier even if a future vault
    // version changed its gating default.
    const env = { ...process.env }
    delete env['ANTHROPIC_API_KEY']
    delete env['CLAUDE_CODE_OAUTH_TOKEN']
    execFile(
      bin,
      args as string[],
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, shell: false, env },
      (err, stdout, stderr) => {
        if (err) {
          const tail = stderr ? `\n${stderr.toString().slice(-2000)}` : ''
          reject(new Error(`${bin} ${args.join(' ')} failed: ${err.message}${tail}`))
          return
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
      },
    )
  })

export interface RetrieveBuildResult {
  readonly chunkCount: number
  readonly durationMs: number
}

export interface RetrieveBuildOptions {
  readonly vaultRoot: string
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
  readonly run?: ProcessRunner
}

export type RetrieveIndexBuilder = (opts: RetrieveBuildOptions) => Promise<RetrieveBuildResult>

/**
 * Provision-if-needed + incremental rebuild, in one call: ensure dirs and exclude entries,
 * re-chunk changed pages (`contextual-prefix.py --all` skips unchanged body hashes), then
 * rebuild the BM25 index (always full — cheap, pure python). First run IS the provisioning.
 */
export const buildRetrieveIndex: RetrieveIndexBuilder = async ({
  vaultRoot,
  log = () => {},
  run = runProcess,
}) => {
  if (!hasRetrieveScripts(vaultRoot)) {
    throw new RetrieveScriptsMissingError(
      'vault has no wiki-retrieve scripts (scripts/retrieve.py, contextual-prefix.py, bm25-index.py) — the claude-obsidian clone needs v1.7+',
    )
  }
  const started = Date.now()
  ensureIndexExcluded(vaultRoot)
  fs.mkdirSync(path.join(vaultRoot, '.vault-meta', 'chunks'), { recursive: true })
  fs.mkdirSync(path.join(vaultRoot, '.vault-meta', 'bm25'), { recursive: true })
  log('info', 'retrieve-index: chunking changed pages (synthetic prefix tier — no egress)')
  await run('python3', ['scripts/contextual-prefix.py', '--all'], { cwd: vaultRoot, timeoutMs: 15 * 60_000 })
  log('info', 'retrieve-index: rebuilding BM25 index')
  await run('python3', ['scripts/bm25-index.py', 'build'], { cwd: vaultRoot, timeoutMs: 5 * 60_000 })
  return {
    chunkCount: countChunks(path.join(vaultRoot, '.vault-meta', 'chunks')),
    durationMs: Date.now() - started,
  }
}

export interface RetrieveIndexScheduler {
  close(): void
}

export interface RetrieveIndexSchedulerOptions {
  readonly events: EventBus
  /** Kicks off a rebuild — `maintenance.startRetrieveIndex()` in production. */
  readonly start: () => void
  /** Checked at FIRE time (not scheduling time), so provisioning mid-window needs no restart. */
  readonly isProvisioned: () => boolean
  /** Quiet window after the last finished ingest before one rebuild runs. Default 5 min. */
  readonly debounceMs?: number
}

/**
 * Keeps the index fresh (SPEC.md §12.6 "Frische"): every job that reaches `done` resets a
 * debounce timer; when the window elapses, ONE rebuild is started — a burst of watch-folder
 * jobs must not cause N rebuilds. Inert while the index is unprovisioned.
 */
export function startRetrieveIndexScheduler(opts: RetrieveIndexSchedulerOptions): RetrieveIndexScheduler {
  const debounceMs = opts.debounceMs ?? 5 * 60_000
  let timer: NodeJS.Timeout | null = null
  const unsubscribe = opts.events.subscribe((event) => {
    if (event.kind !== 'job' || event.job.status !== 'done') return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!opts.isProvisioned()) return
      // A throw here would be an uncaught exception inside a timer — never let it escape.
      try {
        opts.start()
      } catch {
        /* the run records its own failure; scripts vanishing mid-flight lands here */
      }
    }, debounceMs)
    timer.unref?.()
  })
  return {
    close: () => {
      unsubscribe()
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
