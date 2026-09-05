/**
 * Dedupe memory that lives in the VAULT, not only in SQLite (2026-09-05).
 *
 * The `jobs.sha256` UNIQUE column was the whole dedupe until now, and it forgets: "Clear
 * history" deletes the rows, and with them every hash the service ever saw. The vault keeps
 * the same fact in a place that survives: every ingest leaves `.raw/<job-id>/manifest.json`
 * behind, and that manifest names the original's SHA-256. Reading it back makes dedupe as
 * durable as the vault itself (CLAUDE.md hard rule 1: losing the DB must cost nothing).
 *
 * A byte hash cannot recognise a publication that was downloaded a second time: publishers
 * stamp a per-download watermark (date, licensee) into the PDF, so the bytes differ while
 * the paper is the same. The DOI does not change. The second index maps the DOIs named in
 * the frontmatter of `wiki/sources/*.md` (`url:` / `doi:`) back to their page, and the queue
 * asks it once the normalized text exists - BEFORE an agent run is paid for.
 *
 * READ-ONLY over the vault. Both indexes re-read only what changed on disk since the last
 * call, so asking on every enqueue is cheap.
 */

import fs from 'node:fs'
import path from 'node:path'

/** An original the vault already holds, by content hash. */
export interface KnownSource {
  /** The job whose `.raw/<job-id>/` holds the original: the directory name. */
  readonly jobId: string
  readonly originalName: string | null
}

/** A source page that carries the same DOI as a freshly normalized document. */
export interface DoiMatch {
  readonly doi: string
  /** Vault-relative POSIX path of the source page (`wiki/sources/....md`). */
  readonly page: string
  /** The job that created the page, when `.raw/.manifest.json` names one; null otherwise. */
  readonly jobId: string | null
  /** When the page file was last written - the tie-breaker when no job is known. */
  readonly pageMtimeMs: number
}

/**
 * A DOI as it appears in running text or a URL. The prefix is fixed by the standard
 * (`10.` + a 4-9 digit registrant); the suffix is anything up to whitespace or a delimiter
 * that cannot be part of one in practice.
 */
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>()[\]{}]+/g

/** Lowercases (DOIs are case-insensitive) and drops the punctuation a sentence appends. */
export function normalizeDoi(raw: string): string {
  return raw.replace(/[.,;:]+$/, '').toLowerCase()
}

/** Every DOI in `text`, normalized, in order of appearance. */
function doisIn(text: string): string[] {
  return (text.match(DOI_RE) ?? []).map(normalizeDoi)
}

/**
 * How much of a document the "own DOI" heuristic looks at, in whitespace-collapsed
 * characters. Measured over the vault's PDF ingests (2026-09-05): every paper that states
 * its own DOI does so within the first ~5,500 collapsed characters (the title block, or the
 * publisher's first-page watermark after the abstract), while the first CITED DOI of a
 * paper without one of its own sits past 12,000. 8,000 clears the one and stays under the
 * other. Collapsing matters: `pdftotext -layout` pads a title page with kilobytes of spaces.
 */
const HEAD_CHARS = 8000
/** Counting occurrences is linear in the text; a scan beyond this is not worth its time. */
const COUNT_CHARS = 2_000_000

/**
 * The DOI a document identifies ITSELF by, or undefined when it names none up front.
 *
 * Candidates are the DOIs on the first page (the head of the normalized text): a paper
 * states its own DOI there, and the reference list - where other papers' DOIs live - comes
 * last. Among several candidates the most frequent one across the whole document wins,
 * because a publisher watermark repeats the paper's own DOI on every page while a cited DOI
 * appears once; ties go to the earliest mention.
 */
export function extractDoi(text: string): string | undefined {
  const collapsed = text.slice(0, COUNT_CHARS).replace(/\s+/g, ' ')
  const candidates = [...new Set(doisIn(collapsed.slice(0, HEAD_CHARS)))]
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  const counts = new Map<string, number>()
  for (const d of doisIn(collapsed)) counts.set(d, (counts.get(d) ?? 0) + 1)
  let best = candidates[0]!
  for (const c of candidates) if ((counts.get(c) ?? 0) > (counts.get(best) ?? 0)) best = c
  return best
}

/** The frontmatter block of a markdown page, or null when the page has none. */
function frontmatterOf(markdown: string): string | null {
  if (!markdown.startsWith('---')) return null
  const end = markdown.indexOf('\n---', 3)
  return end === -1 ? null : markdown.slice(3, end)
}

/**
 * DOIs a source page declares about ITSELF: the values of its `url:` and `doi:` frontmatter
 * keys. The body is deliberately not scanned - a review's body cites dozens of other DOIs,
 * and matching one of those would call a new paper a duplicate of the review that cited it.
 */
export function pageDois(markdown: string): string[] {
  const fm = frontmatterOf(markdown)
  if (fm === null) return []
  const out: string[] = []
  for (const line of fm.split('\n')) {
    const m = /^(url|doi|source_url)\s*:\s*(.*)$/i.exec(line)
    if (m === null) continue
    out.push(...doisIn(m[2]!))
  }
  return [...new Set(out)]
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

interface RawEntry {
  readonly stamp: string
  readonly sha256: string | null
  readonly originalName: string | null
}

interface PageEntry {
  readonly stamp: string
  readonly dois: readonly string[]
  readonly mtimeMs: number
}

/** The ingest skill's delta tracker at `.raw/.manifest.json` - only the part read here. */
interface RawManifest {
  sources?: Record<string, { pages_created?: unknown }>
}

export class DedupeIndex {
  private readonly raw = new Map<string, RawEntry>()
  private readonly pages = new Map<string, PageEntry>()

  constructor(private readonly vaultRoot: string) {}

  /**
   * The ingest whose original has this content hash, from the per-job manifests under
   * `.raw/`. Manifests are service-written, but the directory is agent-writable, so a
   * manifest without a usable hash is simply skipped.
   */
  byHash(sha256: string): KnownSource | undefined {
    this.refreshRaw()
    for (const [jobId, entry] of this.raw) {
      if (entry.sha256 === sha256) return { jobId, originalName: entry.originalName }
    }
    return undefined
  }

  /** The source page (and the job behind it) that declares this DOI, if any. */
  byDoi(doi: string): DoiMatch | undefined {
    const wanted = normalizeDoi(doi)
    this.refreshPages()
    for (const [page, entry] of this.pages) {
      if (!entry.dois.includes(wanted)) continue
      return { doi: wanted, page, jobId: this.jobForPage(page), pageMtimeMs: entry.mtimeMs }
    }
    return undefined
  }

  /**
   * Which job created a page, read from `.raw/.manifest.json` (the skill records every
   * page a raw file produced under `sources[<raw path>].pages_created`). The job id is the
   * `.raw/<job-id>/` directory the raw path sits in; pre-service ingests (`.raw/m0-test/`)
   * and hand-written pages resolve to null.
   */
  private jobForPage(page: string): string | null {
    const manifest = readJson<RawManifest>(path.join(this.vaultRoot, '.raw', '.manifest.json'))
    if (manifest?.sources === undefined) return null
    for (const [rawPath, entry] of Object.entries(manifest.sources)) {
      const created = entry.pages_created
      if (!Array.isArray(created) || !created.includes(page)) continue
      const parts = rawPath.split('/')
      // `.raw/<job-id>/<file>` and nothing else: anything shallower or deeper is not a job dir.
      return parts.length === 3 && parts[0] === '.raw' ? parts[1]! : null
    }
    return null
  }

  private refreshRaw(): void {
    const rawRoot = path.join(this.vaultRoot, '.raw')
    let dirs: string[]
    try {
      dirs = fs.readdirSync(rawRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      this.raw.clear()
      return
    }
    const seen = new Set(dirs)
    for (const known of this.raw.keys()) if (!seen.has(known)) this.raw.delete(known)
    for (const dir of dirs) {
      const file = path.join(rawRoot, dir, 'manifest.json')
      const st = statOrNull(file)
      if (st === null) {
        this.raw.delete(dir)
        continue
      }
      const stamp = `${st.mtimeMs}:${st.size}`
      if (this.raw.get(dir)?.stamp === stamp) continue
      const m = readJson<{ sha256?: unknown; originalName?: unknown }>(file)
      this.raw.set(dir, {
        stamp,
        sha256: typeof m?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256) ? m.sha256 : null,
        originalName: typeof m?.originalName === 'string' ? m.originalName : null,
      })
    }
  }

  private refreshPages(): void {
    const root = path.join(this.vaultRoot, 'wiki', 'sources')
    const files = new Set<string>()
    const walk = (dir: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else if (e.isFile() && e.name.endsWith('.md')) files.add(abs)
      }
    }
    walk(root)
    const rels = new Map<string, string>()
    for (const abs of files) rels.set(path.relative(this.vaultRoot, abs).split(path.sep).join('/'), abs)
    for (const known of this.pages.keys()) if (!rels.has(known)) this.pages.delete(known)
    for (const [rel, abs] of rels) {
      const st = statOrNull(abs)
      if (st === null) {
        this.pages.delete(rel)
        continue
      }
      const stamp = `${st.mtimeMs}:${st.size}`
      if (this.pages.get(rel)?.stamp === stamp) continue
      let dois: string[]
      try {
        // Frontmatter sits at the top; 8 KB covers any page's header without reading a
        // long article for a field that is never past its first lines.
        const fd = fs.openSync(abs, 'r')
        try {
          const buf = Buffer.alloc(8192)
          const n = fs.readSync(fd, buf, 0, buf.length, 0)
          dois = pageDois(buf.subarray(0, n).toString('utf8'))
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        dois = []
      }
      this.pages.set(rel, { stamp, dois, mtimeMs: st.mtimeMs })
    }
  }
}
