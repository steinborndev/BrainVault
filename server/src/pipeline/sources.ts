/**
 * The page to ingested-source index (2026-08-26, for the Library's Source column).
 *
 * Every ingest keeps its material inside the vault at `.raw/<job-id>/`: the untouched
 * original next to the normalized text the agent actually read, plus a per-job
 * `manifest.json` naming both. `.raw/` is git-tracked, so a commit captures the source
 * alongside the wiki it produced - which is why this index is built from the VAULT and not
 * from SQLite. Operational state may be lost without damaging anything (CLAUDE.md hard
 * rule 1, SPEC.md §8); provenance may not, and the vault is the copy that survives.
 *
 * The reverse direction comes from `.raw/.manifest.json`, the ingest skill's own delta
 * tracker: its `sources` map lists `pages_created` per raw file. Only `pages_created`
 * counts here - "created" means the page exists because of that document, while
 * `pages_updated` would attach a source to every hub page an ingest touched in passing.
 *
 * READ-ONLY. Nothing here writes to the vault.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Where one wiki page came from. */
export interface SourceRef {
  /** The ingest's folder, vault-relative and POSIX-separated (`.raw/<job-id>`). */
  dir: string
  /**
   * The original document's file name inside `dir` - the PDF, the scraped `raw.html`, the
   * photo. Null when the manifest names one that is no longer on disk.
   */
  file: string | null
  /** Job type: `pdf` | `web` | `image` | `text` | `office` | `av` | `other`. */
  type: string
  /** Where a web ingest came from. Null for everything dropped in as a file. */
  url: string | null
}

export interface SourceIndex {
  /** Vault-relative page path (`wiki/concepts/Foo.md`) to the document that created it. */
  pages: Record<string, SourceRef>
  builtAt: string
}

/** Per-job manifest, as `preprocess/index.ts` writes it. Every field is optional here. */
interface JobManifest {
  type?: string
  url?: string
  original?: string
}

/** The ingest skill's delta tracker at `.raw/.manifest.json`. */
interface RawManifest {
  sources?: Record<string, { ingested_at?: string; pages_created?: string[] }>
}

/** Type guess for pre-manifest ingests, from the extension alone. */
const TYPE_BY_EXT: Record<string, string> = {
  '.pdf': 'pdf',
  '.html': 'web',
  '.htm': 'web',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.txt': 'text',
  '.md': 'text',
  '.docx': 'office',
  '.doc': 'office',
  '.pptx': 'office',
  '.ppt': 'office',
  '.xlsx': 'office',
  '.xls': 'office',
  '.mp3': 'av',
  '.mp4': 'av',
  '.m4a': 'av',
  '.wav': 'av',
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Vault-relative POSIX path, or null when `abs` escaped `root`. */
function relWithin(root: string, abs: string): string | null {
  const rel = path.relative(root, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join(path.posix.sep)
}

/**
 * Builds the index. Manifest entries are agent-written, so every path out of them is
 * re-resolved and confined to `VAULT_ROOT/.raw` before it is published - a garbled or
 * hostile entry drops out instead of becoming a link the dashboard offers.
 */
export function buildSourceIndex(vaultRoot: string): SourceIndex {
  const rawRoot = path.resolve(vaultRoot, '.raw')
  const manifest = readJson<RawManifest>(path.join(rawRoot, '.manifest.json'))
  const pages: Record<string, SourceRef> = {}
  const builtAt = new Date().toISOString()
  if (manifest?.sources === undefined) return { pages, builtAt }

  // Oldest first, so the document that BROUGHT a page into existence wins over a later
  // ingest that also claims to have created it.
  const entries = Object.entries(manifest.sources).sort((a, b) =>
    (a[1].ingested_at ?? '').localeCompare(b[1].ingested_at ?? ''),
  )

  // One job folder serves many pages; read each manifest once.
  const cache = new Map<string, SourceRef | null>()

  for (const [rawPath, entry] of entries) {
    const created = entry.pages_created
    if (!Array.isArray(created) || created.length === 0) continue

    const ref = resolveRef(vaultRoot, rawRoot, rawPath, cache)
    if (ref === null) continue

    for (const page of created) {
      if (typeof page !== 'string' || page in pages) continue
      const abs = path.resolve(vaultRoot, page)
      const rel = relWithin(vaultRoot, abs)
      // A page that has since been deleted or renamed keeps no source: the Library never
      // renders a row for it anyway, and a stale entry is exactly what the address-map
      // lint reports elsewhere.
      if (rel === null || !fs.existsSync(abs)) continue
      pages[rel] = ref
    }
  }
  return { pages, builtAt }
}

/**
 * The source descriptor for one entry of the delta tracker. Prefers the job's own manifest
 * (which names the untouched original); falls back to the tracked file itself, which is
 * what the pre-manifest ingests under `.raw/m0-test/` left behind.
 */
function resolveRef(
  vaultRoot: string,
  rawRoot: string,
  rawPath: string,
  cache: Map<string, SourceRef | null>,
): SourceRef | null {
  const absRaw = path.resolve(vaultRoot, rawPath)
  if (relWithin(rawRoot, absRaw) === null) return null // not under .raw/ - not ours to serve

  const absDir = path.dirname(absRaw)
  const dir = relWithin(vaultRoot, absDir)
  if (dir === null) return null

  // NUL as the separator, written as an escape: no path component can contain one, so
  // the two halves can never run together into a colliding key.
  const cacheKey = `${dir}\u0000${path.basename(absRaw)}`
  const hit = cache.get(cacheKey)
  if (hit !== undefined) return hit

  const job = readJson<JobManifest>(path.join(absDir, 'manifest.json'))
  let file: string | null = null
  let type: string | null = null
  let url: string | null = null

  if (job !== null) {
    type = typeof job.type === 'string' && job.type !== '' ? job.type : null
    url = typeof job.url === 'string' && job.url !== '' ? job.url : null
    if (typeof job.original === 'string' && job.original !== '') {
      // `original` is a bare file name; anything that resolves elsewhere is a manifest we
      // do not trust.
      const candidate = path.resolve(absDir, job.original)
      if (path.dirname(candidate) === absDir && fs.existsSync(candidate)) {
        file = path.basename(candidate)
      }
    }
  }

  // No usable original: the tracked file is the best document we have.
  if (file === null && fs.existsSync(absRaw) && fs.statSync(absRaw).isFile()) {
    file = path.basename(absRaw)
  }
  if (type === null) {
    type = file === null ? 'other' : (TYPE_BY_EXT[path.extname(file).toLowerCase()] ?? 'other')
  }

  // Nothing to open in either direction is not a source, it is an empty row.
  const ref = file === null && url === null ? null : { dir, file, type, url }
  cache.set(cacheKey, ref)
  return ref
}

/**
 * Rebuilds only when `.raw/.manifest.json` has changed. The tracker is rewritten by every
 * ingest as its delta, so its mtime and size are exactly the right signal - and 144 small
 * JSON reads are not something to repeat on every dashboard render.
 */
export class SourceIndexBuilder {
  private cached: SourceIndex | null = null
  private stamp = ''

  constructor(private readonly vaultRoot: string) {}

  build(): SourceIndex {
    let stamp = ''
    try {
      const st = fs.statSync(path.join(this.vaultRoot, '.raw', '.manifest.json'))
      stamp = `${st.mtimeMs}:${st.size}`
    } catch {
      /* no tracker yet - keep rebuilding (cheaply, it is empty) until one appears */
    }
    if (this.cached !== null && stamp !== '' && stamp === this.stamp) return this.cached
    this.cached = buildSourceIndex(this.vaultRoot)
    this.stamp = stamp
    return this.cached
  }
}
