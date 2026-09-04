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
import { ensureVaultExcludes, RETRIEVE_EXCLUDE_ENTRIES } from './vault-excludes.js'

export { RETRIEVE_EXCLUDE_ENTRIES }

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
  // Belt and braces: startup already does this, but a build must never be the thing that
  // bleeds hundreds of megabytes into an ingest commit.
  ensureVaultExcludes(vaultRoot, RETRIEVE_EXCLUDE_ENTRIES)
  fs.mkdirSync(path.join(vaultRoot, '.vault-meta', 'chunks'), { recursive: true })
  fs.mkdirSync(path.join(vaultRoot, '.vault-meta', 'bm25'), { recursive: true })
  log('info', 'retrieve-index: chunking changed pages (synthetic prefix tier — no egress)')
  await run('python3', ['scripts/contextual-prefix.py', '--all'], { cwd: vaultRoot, timeoutMs: 15 * 60_000 })
  const pruned = pruneStaleChunks(path.join(vaultRoot, '.vault-meta', 'chunks'), vaultRoot)
  if (pruned.removedFiles > 0 || pruned.removedDirs > 0) {
    log('info', `retrieve-index: pruned ${pruned.removedFiles} stale chunk file(s) and ${pruned.removedDirs} directory(ies) of deleted pages`)
  }
  log('info', 'retrieve-index: rebuilding BM25 index')
  await run('python3', ['scripts/bm25-index.py', 'build'], { cwd: vaultRoot, timeoutMs: 5 * 60_000 })
  return {
    chunkCount: countChunks(path.join(vaultRoot, '.vault-meta', 'chunks')),
    durationMs: Date.now() - started,
  }
}

/**
 * Removes the chunk records the chunker leaves behind. `contextual-prefix.py --all` rewrites the
 * chunks a page still has and never deletes: when a page shrinks, its surplus chunk files stay on
 * disk and in every later index, and when a page is deleted its whole directory does. Measured on
 * 2026-09-04 (TASKS-RETRIEVE F-R14): a hot cache trimmed from 53,000 to 400 words kept 111 stale
 * chunk records holding 51,000 words of text that no longer existed, and retrieval kept serving
 * them. The index is built from whatever files exist, so pruning has to happen here.
 *
 * chunk-000 of a page carries the hash of the body the chunker last saw, so it is the reference:
 * siblings with another `page_body_hash` are stale. Anything unreadable is left alone, and only
 * files under the chunks directory are ever removed.
 */
export function pruneStaleChunks(
  chunksDir: string,
  vaultRoot: string,
): { removedFiles: number; removedDirs: number } {
  let removedFiles = 0
  let removedDirs = 0
  let dirs: fs.Dirent[]
  try {
    dirs = fs.readdirSync(chunksDir, { withFileTypes: true })
  } catch {
    return { removedFiles, removedDirs }
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(chunksDir, d.name)
    const first = readChunkRecord(path.join(dir, 'chunk-000.json'))
    if (first === null) continue
    if (!fs.existsSync(path.join(vaultRoot, first.pagePath))) {
      fs.rmSync(dir, { recursive: true, force: true })
      removedDirs++
      continue
    }
    for (const name of fs.readdirSync(dir)) {
      if (!/^chunk-\d+\.json$/.test(name) || name === 'chunk-000.json') continue
      const rec = readChunkRecord(path.join(dir, name))
      if (rec !== null && rec.pageBodyHash !== first.pageBodyHash) {
        fs.unlinkSync(path.join(dir, name))
        removedFiles++
      }
    }
  }
  return { removedFiles, removedDirs }
}

/** The two fields of a chunk record the pruning needs; null for anything malformed or off-vault. */
function readChunkRecord(file: string): { pagePath: string; pageBodyHash: string } | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as { page_path?: unknown; page_body_hash?: unknown }
    if (typeof r.page_path !== 'string' || typeof r.page_body_hash !== 'string') return null
    if (!r.page_path.startsWith('wiki/') || r.page_path.includes('..')) return null
    return { pagePath: r.page_path, pageBodyHash: r.page_body_hash }
  } catch {
    return null
  }
}

/**
 * Chunks requested from `retrieve.py` per page the caller asked for. Five chunks collapsed to
 * 4.00 distinct pages on average over the labeled set (F-R14), so "top-5" handed the agent four
 * pages; fetching more and cutting AFTER the collapse restores the contract. Monotone: a page in
 * today's top five stays there, since its chunks still rank above the ones that fill the gap.
 */
const CHUNKS_PER_PAGE = 4
const MIN_CHUNK_FETCH = 20

/**
 * Generated root pages (index, log, hot, overview) aggregate everything and therefore match
 * everything; left uncapped they took 8 of 175 top-5 slots on the labeled set, log.md alone 4
 * after the hot cache was trimmed. One slot keeps them available for a question about the vault
 * itself without letting a journal crowd out the content pages.
 */
const ROOT_PAGE_SLOTS = 1
const isRootPage = (pagePath: string): boolean => /^wiki\/[^/]+\.md$/.test(pagePath)

/** One retrieved page, best first. Chunk hits are collapsed to their page. */
export interface RetrievedCandidate {
  /** Vault-relative wiki path (`wiki/concepts/Foo.md`) — what the agent is told to read. */
  readonly pagePath: string
  readonly rank: number
}

export interface RetrievalResult {
  readonly candidates: RetrievedCandidate[]
  /** `retrieve.py`'s own label, e.g. `bm25-only` or `bm25+rerank:cosine:nomic-embed-text`. */
  readonly strategy: string | null
}

export interface RetrieveQueryOptions {
  readonly vaultRoot: string
  readonly question: string
  readonly topK?: number
  readonly timeoutMs?: number
  readonly run?: ProcessRunner
  /**
   * Semantic rerank (ollama cosine) on top of BM25. **Defaults to OFF**, and that default is a
   * measurement, not a guess: over a 35-case labeled set BM25 alone returned the right page in
   * the top 5 in 97% of cases vs 94% with rerank, and top-1 fell 69% → 54% (TASKS-RETRIEVE
   * F-R13). Reordering *inside* a top-5 the agent reads in full is invisible anyway, so the
   * rerank was pure dependency and latency. Flipping this back on is a one-liner — do it after
   * re-running `npm run retrieval-eval`, e.g. once the vault has roughly doubled or with a
   * stronger embedding model, since BM25's lexical matching is simply very strong at this size.
   */
  readonly rerank?: boolean
}

export type CandidateRetriever = (opts: RetrieveQueryOptions) => Promise<RetrievalResult>

const EMPTY_RETRIEVAL: RetrievalResult = { candidates: [], strategy: null }

/** A question longer than this is truncated before it reaches argv — retrieval over an essay
 * is pointless, and it keeps the child's argument list bounded. */
const MAX_QUESTION_CHARS = 1000

/**
 * Runs chunk-level retrieval for ONE question — **in the service process, never inside an agent
 * sandbox** (SPEC.md §12.6). This is what keeps the read-only `query` profile untouched: the
 * rerank stage needs to reach the local ollama and to write the embed cache, and doing that here
 * means the sandbox needs neither a network hole nor a write exception. The agent only ever reads
 * the pages this returns.
 *
 * Degrades to `EMPTY_RETRIEVAL` on ANY failure (not provisioned, script error, unparseable
 * output, timeout): a query must never fail because retrieval did — the caller then falls back
 * to the legacy hot-cache → index read path.
 */
export const retrieveCandidates: CandidateRetriever = async ({
  vaultRoot,
  question,
  topK = 5,
  timeoutMs = 30_000,
  run = runProcess,
  rerank = false,
}) => {
  if (!isRetrieveProvisioned(vaultRoot)) return EMPTY_RETRIEVAL
  const q = question.trim().slice(0, MAX_QUESTION_CHARS)
  if (q === '') return EMPTY_RETRIEVAL
  try {
    // Chunks are over-fetched and the cut to `topK` happens after the collapse to pages, so the
    // agent gets topK DISTINCT pages rather than topK chunks that collapse to fewer. `--bm25-top`
    // travels with `--top`: retrieve.py caps its output at the BM25 candidate count.
    const fetch = Math.max(topK * CHUNKS_PER_PAGE, MIN_CHUNK_FETCH)
    // `shell: false` in the runner, so the question is one argv element — never a second command.
    const args = [
      'scripts/retrieve.py', q, '--top', String(fetch), '--bm25-top', String(fetch),
      ...(rerank ? [] : ['--no-rerank']),
    ]
    const { stdout } = await run('python3', args, { cwd: vaultRoot, timeoutMs })
    // STDOUT ONLY: retrieve.py prints progress ("bm25: N hits") to stderr, and merging the two
    // corrupts the JSON parse (finding F-R5).
    const parsed = JSON.parse(stdout) as {
      strategy?: unknown
      candidates?: ReadonlyArray<{ page_path?: unknown }>
    }
    const seen = new Set<string>()
    const candidates: RetrievedCandidate[] = []
    let rootSlots = 0
    for (const c of parsed.candidates ?? []) {
      // Several chunks of one page can rank — the agent reads whole pages, so collapse them,
      // keeping each page at its best rank.
      const pagePath = typeof c.page_path === 'string' ? c.page_path : ''
      if (pagePath === '' || seen.has(pagePath)) continue
      if (isRootPage(pagePath)) {
        if (rootSlots >= ROOT_PAGE_SLOTS) continue
        rootSlots++
      }
      seen.add(pagePath)
      candidates.push({ pagePath, rank: candidates.length + 1 })
      if (candidates.length >= topK) break
    }
    return { candidates, strategy: typeof parsed.strategy === 'string' ? parsed.strategy : null }
  } catch {
    return EMPTY_RETRIEVAL
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
