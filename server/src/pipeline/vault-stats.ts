/**
 * Read-only vault statistics for the Overview tab (SPEC.md §6.1, TASKS-M3 §1).
 *
 * Everything here is derived from the vault filesystem + git history — the vault is the
 * single source of truth (hard rule 1), so these numbers are rebuildable and never mirrored
 * into SQLite. The service only ever READS the vault here; it never writes.
 *
 * Results are cheap for a personal vault (hundreds of pages) but not free (a `git log`
 * scan), so the caller caches them with a short TTL and invalidates on the bus `stats`
 * event (a commit landed).
 */

import fs from 'node:fs'
import path from 'node:path'
import { runTool } from './preprocess/tools.js'

/** Wiki subfolders whose `*.md` files are counted as pages (SPEC.md §6.1). */
export const WIKI_PAGE_DIRS = [
  'concepts',
  'entities',
  'sources',
  'references',
  'comparisons',
  'questions',
  'folds',
  'meta',
] as const

export type WikiPageDir = (typeof WIKI_PAGE_DIRS)[number]

export interface PageCounts {
  readonly byDir: Record<string, number>
  readonly total: number
}

export interface RecentPage {
  /** Vault-relative POSIX path, e.g. `wiki/concepts/foo.md`. */
  readonly path: string
  readonly dir: string
  /** ISO mtime. */
  readonly modified: string
}

export interface Commit {
  readonly hash: string
  readonly date: string
  readonly subject: string
  /** Wiki markdown pages touched by this commit (vault-relative POSIX). */
  readonly pages: string[]
}

export interface GrowthPoint {
  /** `YYYY-MM-DD`. */
  readonly date: string
  /** Cumulative wiki page count at end of that day. */
  readonly total: number
}

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep)

async function git(vaultRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runTool('git', ['-C', vaultRoot, ...args], { timeoutMs: 30_000 })
  return stdout
}

/** Counts `*.md` files under each known wiki subfolder. */
export function pageCounts(vaultRoot: string): PageCounts {
  const byDir: Record<string, number> = {}
  let total = 0
  for (const dir of WIKI_PAGE_DIRS) {
    const abs = path.join(vaultRoot, 'wiki', dir)
    const n = countMarkdown(abs)
    byDir[dir] = n
    total += n
  }
  return { byDir, total }
}

/** Recursively counts `*.md` files under `dir` (0 if it doesn't exist). */
function countMarkdown(dir: string): number {
  let n = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (e.isDirectory()) n += countMarkdown(path.join(dir, e.name))
    else if (e.isFile() && e.name.endsWith('.md')) n += 1
  }
  return n
}

/** Most-recently-modified wiki pages by mtime — "recently created/changed" (SPEC.md §6.1). */
export function recentPages(vaultRoot: string, limit = 12): RecentPage[] {
  const found: RecentPage[] = []
  for (const dir of WIKI_PAGE_DIRS) {
    const base = path.join(vaultRoot, 'wiki', dir)
    walkMarkdown(base, (abs, stat) => {
      found.push({
        path: toPosix(path.relative(vaultRoot, abs)),
        dir,
        modified: stat.mtime.toISOString(),
      })
    })
  }
  return found.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit)
}

function walkMarkdown(dir: string, visit: (abs: string, stat: fs.Stats) => void): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walkMarkdown(abs, visit)
    // Skip `_index.md` / other `_`-prefixed files: they are auto-generated folder indexes,
    // not content pages, so they'd otherwise dominate "recently changed" (SPEC.md §6.1).
    else if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')) {
      try {
        visit(abs, fs.statSync(abs))
      } catch {
        /* raced deletion — skip */
      }
    }
  }
}

/** The last `limit` commits with the wiki pages each touched (SPEC.md §6.1). */
export async function recentCommits(vaultRoot: string, limit = 5): Promise<Commit[]> {
  // Records separated by \x1e, fields by \x1f, so subjects with any punctuation stay intact.
  const raw = await git(vaultRoot, [
    'log',
    `-n`,
    String(limit),
    '--name-only',
    `--pretty=format:%x1e%H%x1f%cI%x1f%s`,
  ])
  const commits: Commit[] = []
  for (const record of raw.split('\x1e')) {
    if (record.trim() === '') continue
    const [header, ...fileLines] = record.split('\n')
    const [hash, date, subject] = (header ?? '').split('\x1f')
    if (!hash) continue
    const pages = fileLines
      .map((l) => l.trim())
      .filter((l) => l.startsWith('wiki/') && l.endsWith('.md'))
    commits.push({ hash: hash.slice(0, 8), date: date ?? '', subject: subject ?? '', pages })
  }
  return commits
}

/**
 * Cumulative wiki-page growth over the last `days`, anchored to the current on-disk total.
 *
 * Rather than replay the whole history, we walk recent commits newest→oldest, subtracting
 * each commit's net wiki add/delete from a running total that starts at `currentTotal`.
 * The result is a per-day series that ends today at the real page count — approximate for
 * the far past (renames count as add+delete), exact at the present.
 */
export async function growth(vaultRoot: string, days = 30, currentTotal?: number): Promise<GrowthPoint[]> {
  const total = currentTotal ?? pageCounts(vaultRoot).total
  const raw = await git(vaultRoot, [
    'log',
    `--since=${days} days ago`,
    '--diff-filter=AD',
    '--name-status',
    `--pretty=format:%x1e%cI`,
  ])

  // Net wiki-page delta per calendar day (A = +1, D = −1 for a wiki *.md path).
  const deltaByDay = new Map<string, number>()
  for (const record of raw.split('\x1e')) {
    if (record.trim() === '') continue
    const [iso, ...fileLines] = record.split('\n')
    const day = (iso ?? '').slice(0, 10)
    if (day === '') continue
    let delta = 0
    for (const line of fileLines) {
      const [status, file] = line.split('\t')
      if (!file || !file.startsWith('wiki/') || !file.endsWith('.md')) continue
      if (status === 'A') delta += 1
      else if (status === 'D') delta -= 1
    }
    deltaByDay.set(day, (deltaByDay.get(day) ?? 0) + delta)
  }

  // Walk days newest→oldest: today's cumulative is `total`; each earlier day is the day
  // after minus that day's additions.
  const days_sorted = [...deltaByDay.keys()].sort() // ascending
  const points: GrowthPoint[] = []
  let running = total
  for (let i = days_sorted.length - 1; i >= 0; i--) {
    const day = days_sorted[i]!
    points.push({ date: day, total: running })
    running -= deltaByDay.get(day) ?? 0
  }
  points.reverse() // ascending by date for the chart
  return points
}

/** Raw `wiki/hot.md` contents for the Overview hot-cache panel, or null if absent. */
export function readHotCache(vaultRoot: string): string | null {
  try {
    return fs.readFileSync(path.join(vaultRoot, 'wiki', 'hot.md'), 'utf8')
  } catch {
    return null
  }
}

/**
 * When `wiki/hot.md` was last written, as an ISO string — the "Anzeige des letzten
 * Refresh-Zeitpunkts" the Wartung tab shows next to its refresh button (SPEC.md §6.4).
 * The file's mtime is the honest source: the hot cache is refreshed by agent runs writing it,
 * so nothing else would know when that last happened.
 */
export function hotCacheUpdatedAt(vaultRoot: string): string | null {
  try {
    return fs.statSync(path.join(vaultRoot, 'wiki', 'hot.md')).mtime.toISOString()
  } catch {
    return null
  }
}
