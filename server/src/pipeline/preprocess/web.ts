/**
 * URL / web-page preprocessing (SPEC.md §5). Unlike the file plugins, this runs BEFORE
 * the agent and is the ONE place the pipeline itself reaches the network — the agent
 * run has no web egress (SPEC.md §9). Because we fetch here, the repo's egress-hygiene
 * rules apply and are enforced below: http/https only (no `file://`), no RFC1918 /
 * loopback / link-local targets (SSRF guard), and a hard size cap on the response.
 *
 * Extraction uses `defuddle-cli` when present; otherwise a minimal HTML-to-text
 * fallback keeps the job moving rather than failing on a missing optional tool.
 */

import fs from 'node:fs'
import path from 'node:path'
import dns from 'node:dns/promises'
import net from 'node:net'
import type { JobType } from '../../db/jobs.js'
import { nowIso } from '../../db/index.js'
import type { Manifest, PreprocessResult, ToolAvailability } from './types.js'
import { PreprocessError } from './types.js'
import { runTool } from './tools.js'
import { detectTools } from './tools.js'

/** Default response cap. Web pages are larger than the 50 KB autoresearch fetch cap. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5

/** True for addresses an outbound fetch must never reach (SSRF guard). */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip)
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // link-local
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  if (kind === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80')) return true // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1]!)
    return false
  }
  return false
}

export interface ValidatedUrl {
  readonly url: URL
  readonly address: string
}

/** Validates scheme + resolves the host, refusing private/loopback targets. */
export async function validateUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<ValidatedUrl> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PreprocessError(`not a valid URL: ${raw}`, true)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PreprocessError(`refused URL scheme ${url.protocol} — only http/https are fetched`, true)
  }
  const addresses = await resolve(url.hostname)
  if (addresses.length === 0) {
    throw new PreprocessError(`could not resolve host: ${url.hostname}`, true)
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new PreprocessError(
        `refused: ${url.hostname} resolves to a private/loopback address (${addr}) — SSRF guard`,
        true,
      )
    }
  }
  return { url, address: addresses[0]! }
}

async function defaultResolve(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host]
  const records = await dns.lookup(host, { all: true })
  return records.map((r) => r.address)
}

/** Fetches with a byte cap, manual redirect handling (each hop re-validated), and a timeout. */
async function fetchCapped(start: URL, maxBytes: number, timeoutMs: number): Promise<string> {
  let current = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(current, { redirect: 'manual', signal: controller.signal })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new PreprocessError(`redirect with no Location from ${current.href}`)
        const next = new URL(location, current)
        await validateUrl(next.href) // re-validate every hop against the SSRF guard
        current = next
        continue
      }
      if (!res.ok) throw new PreprocessError(`fetch failed: HTTP ${res.status} for ${current.href}`)

      const declared = Number(res.headers.get('content-length') ?? '0')
      if (declared > maxBytes) {
        throw new PreprocessError(`response too large: ${declared} bytes > cap ${maxBytes}`)
      }
      return await readCapped(res, maxBytes)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new PreprocessError(`too many redirects (> ${MAX_REDIRECTS}) starting at ${start.href}`)
}

/** Reads the body, aborting if it exceeds the cap even when content-length lied. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return await res.text()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new PreprocessError(`response exceeded cap ${maxBytes} bytes mid-stream`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Bare-minimum HTML→text when defuddle is unavailable — strips tags, collapses space. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface PreprocessUrlInput {
  readonly jobId: string
  readonly url: string
  readonly vaultRoot: string
  readonly jobDir: string
  readonly maxBytes?: number
  readonly timeoutMs?: number
  readonly tools?: ToolAvailability
}

export async function preprocessUrl(input: PreprocessUrlInput): Promise<PreprocessResult> {
  fs.mkdirSync(input.jobDir, { recursive: true })
  const { url } = await validateUrl(input.url)
  const html = await fetchCapped(url, input.maxBytes ?? DEFAULT_MAX_BYTES, input.timeoutMs ?? 30_000)

  const rawPath = path.join(input.jobDir, 'raw.html')
  fs.writeFileSync(rawPath, html, 'utf8')

  const tools = input.tools ?? (await detectTools())
  const notes: string[] = []
  let markdown: string

  if (tools.defuddle) {
    try {
      const { stdout } = await runTool('defuddle', ['parse', rawPath, '--md'], { timeoutMs: 30_000 })
      markdown = stdout.trim()
      notes.push('extracted via defuddle')
    } catch {
      markdown = htmlToText(html)
      notes.push('defuddle failed — used built-in HTML-to-text fallback')
    }
  } else {
    markdown = htmlToText(html)
    notes.push('defuddle not installed — used built-in HTML-to-text fallback')
  }

  const normalizedPath = path.join(input.jobDir, 'normalized.md')
  const body = `# ${url.href}\n\n${markdown}\n`
  fs.writeFileSync(normalizedPath, body, 'utf8')

  const manifest: Manifest = {
    jobId: input.jobId,
    source: 'url',
    type: 'web' as JobType,
    originalName: url.href,
    url: url.href,
    createdAt: nowIso(),
    original: 'raw.html',
    normalized: 'normalized.md',
    normalizedChars: markdown.length,
    ocrApplied: false,
    passImageToAgent: false,
    deferred: false,
    notes,
  }
  const manifestPath = path.join(input.jobDir, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  return {
    type: 'web',
    deferred: false,
    manifestPath,
    primaryArtifact: path
      .relative(input.vaultRoot, normalizedPath)
      .split(path.sep)
      .join(path.posix.sep),
    manifest,
  }
}
