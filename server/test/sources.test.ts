/**
 * The page-to-source index and the raw-document route (2026-08-26).
 *
 * The index half checks that provenance is read from the VAULT (`.raw/` + its manifests)
 * and that only `pages_created` counts. The route half is a guard test: `.raw/` is the
 * first place the dashboard serves arbitrary files from, so confinement, symlink escapes
 * and - above all - the refusal to render stored HTML inline are pinned here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { openDb, MEMORY_DB } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import { buildSourceIndex, SourceIndexBuilder } from '../src/pipeline/sources.js'
import type { Config } from '../src/config.js'

let vaultRoot: string
let app: FastifyInstance

function write(rel: string, content: string): void {
  const abs = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/** A vault with one PDF ingest, one web ingest, and one pre-manifest drop. */
function seedVault(): void {
  write('wiki/sources/Paper.md', '# Paper\n')
  write('wiki/concepts/Alpha.md', '# Alpha\n')
  write('wiki/sources/Post.md', '# Post\n')
  write('wiki/sources/Old.md', '# Old\n')
  write('wiki/index.md', 'hub\n')

  write('.raw/job-pdf/paper.pdf', '%PDF-1.4 fake\n')
  write('.raw/job-pdf/normalized.txt', 'text of the paper\n')
  write(
    '.raw/job-pdf/manifest.json',
    JSON.stringify({ jobId: 'job-pdf', type: 'pdf', originalName: 'paper.pdf', original: 'paper.pdf' }),
  )

  write('.raw/job-web/raw.html', '<script>alert(document.cookie)</script>\n')
  write('.raw/job-web/normalized.md', '# post\n')
  write(
    '.raw/job-web/manifest.json',
    JSON.stringify({
      jobId: 'job-web',
      type: 'web',
      original: 'raw.html',
      url: 'https://example.com/post',
    }),
  )

  // The pre-manifest shape: a bare file, no per-job manifest beside it.
  write('.raw/legacy/scan.pdf', '%PDF-1.4 older\n')

  write(
    '.raw/.manifest.json',
    JSON.stringify({
      version: 1,
      sources: {
        '.raw/job-pdf/normalized.txt': {
          ingested_at: '2026-08-02',
          pages_created: ['wiki/sources/Paper.md', 'wiki/concepts/Alpha.md'],
          pages_updated: ['wiki/index.md'],
        },
        '.raw/job-web/normalized.md': {
          ingested_at: '2026-08-03',
          pages_created: ['wiki/sources/Post.md'],
        },
        '.raw/legacy/scan.pdf': {
          ingested_at: '2026-08-01',
          pages_created: ['wiki/sources/Old.md'],
        },
      },
    }),
  )
}

beforeEach(async () => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-'))
  seedVault()

  const db = openDb(MEMORY_DB)
  const events = new EventBus()
  const store = new JobStore(db, events)
  const config: Config = {
    vaultRoot,
    obsidianVaultName: 'vault',
    demoMode: false,
    auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
    telegram: null,
    server: {
      host: '127.0.0.1',
      port: 0,
      watchFolder: path.join(vaultRoot, 'inbox'),
      maxUploadBytes: 1024 * 1024,
      authMode: 'local-single-user',
    },
  }
  app = await buildServer({
    config,
    store,
    chat: new ChatStore(db),
    queue: new IngestQueue({
      store,
      vaultRoot,
      auth: config.auth,
      runIngest: async () => {
        throw new Error('no agent in this test')
      },
    }),
    events,
    maintenance: new MaintenanceRunner({ vaultRoot, auth: config.auth, events, commitMutex: new Mutex() }),
    logger: false,
  })
})
afterEach(async () => {
  await app.close()
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('buildSourceIndex', () => {
  it('maps every created page to the original document, not the normalized text', () => {
    const { pages } = buildSourceIndex(vaultRoot)
    expect(pages['wiki/sources/Paper.md']).toEqual({
      dir: '.raw/job-pdf',
      file: 'paper.pdf',
      type: 'pdf',
      url: null,
    })
    // A concept page created as a by-product of the same ingest inherits its source.
    expect(pages['wiki/concepts/Alpha.md']?.file).toBe('paper.pdf')
  })

  it('carries the origin URL of a web ingest', () => {
    const { pages } = buildSourceIndex(vaultRoot)
    expect(pages['wiki/sources/Post.md']).toEqual({
      dir: '.raw/job-web',
      file: 'raw.html',
      type: 'web',
      url: 'https://example.com/post',
    })
  })

  it('falls back to the tracked file when a job has no manifest', () => {
    const { pages } = buildSourceIndex(vaultRoot)
    expect(pages['wiki/sources/Old.md']).toEqual({
      dir: '.raw/legacy',
      file: 'scan.pdf',
      type: 'pdf',
      url: null,
    })
  })

  it('ignores pages_updated - a hub touched in passing has no source', () => {
    const { pages } = buildSourceIndex(vaultRoot)
    expect(pages['wiki/index.md']).toBeUndefined()
  })

  it('drops entries whose page no longer exists', () => {
    fs.rmSync(path.join(vaultRoot, 'wiki/sources/Paper.md'))
    const { pages } = buildSourceIndex(vaultRoot)
    expect(pages['wiki/sources/Paper.md']).toBeUndefined()
    expect(pages['wiki/concepts/Alpha.md']).toBeDefined()
  })

  it('refuses a manifest entry pointing outside .raw', () => {
    write(
      '.raw/.manifest.json',
      JSON.stringify({
        sources: {
          '../../etc/passwd': { ingested_at: '2026-08-05', pages_created: ['wiki/sources/Paper.md'] },
        },
      }),
    )
    expect(buildSourceIndex(vaultRoot).pages).toEqual({})
  })

  it('keeps the oldest creator when two ingests claim the same page', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.raw/.manifest.json'), 'utf8')) as {
      sources: Record<string, { ingested_at: string; pages_created: string[] }>
    }
    manifest.sources['.raw/job-web/normalized.md']!.pages_created.push('wiki/sources/Paper.md')
    write('.raw/.manifest.json', JSON.stringify(manifest))
    // job-pdf (2026-08-02) precedes job-web (2026-08-03), so the PDF stays the origin.
    expect(buildSourceIndex(vaultRoot).pages['wiki/sources/Paper.md']?.type).toBe('pdf')
  })

  it('answers an empty index when the vault has no delta tracker', () => {
    fs.rmSync(path.join(vaultRoot, '.raw/.manifest.json'))
    expect(buildSourceIndex(vaultRoot).pages).toEqual({})
  })
})

describe('SourceIndexBuilder', () => {
  it('rebuilds once the tracker changes and caches until then', () => {
    const builder = new SourceIndexBuilder(vaultRoot)
    const first = builder.build()
    expect(builder.build()).toBe(first) // same object - not rebuilt

    write('wiki/sources/Second.md', '# Second\n')
    const manifest = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.raw/.manifest.json'), 'utf8')) as {
      sources: Record<string, { ingested_at: string; pages_created: string[] }>
    }
    manifest.sources['.raw/job-pdf/normalized.txt']!.pages_created.push('wiki/sources/Second.md')
    write('.raw/.manifest.json', JSON.stringify(manifest))

    const second = builder.build()
    expect(second).not.toBe(first)
    expect(second.pages['wiki/sources/Second.md']?.file).toBe('paper.pdf')
  })
})

describe('GET /api/v1/sources', () => {
  it('serves the index', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sources' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ pages: Record<string, { type: string }> }>()
    expect(body.pages['wiki/sources/Paper.md']?.type).toBe('pdf')
  })
})

describe('GET /api/v1/sources/raw', () => {
  const get = (p: string): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'GET', url: `/api/v1/sources/raw?path=${encodeURIComponent(p)}` })

  it('streams a PDF inline', async () => {
    const res = await get('.raw/job-pdf/paper.pdf')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toContain('inline')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.body).toContain('%PDF-1.4')
  })

  it('NEVER renders stored HTML inline - it is a download, and never text/html', async () => {
    const res = await get('.raw/job-web/raw.html')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('sends SVG as a download too - it is scriptable markup', async () => {
    write('.raw/job-pdf/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const res = await get('.raw/job-pdf/diagram.svg')
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toContain('attachment')
  })

  it('serves markdown as plain text, never as markup', async () => {
    const res = await get('.raw/job-web/normalized.md')
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(res.headers['content-disposition']).toContain('inline')
  })

  it('refuses a path outside .raw', async () => {
    expect((await get('wiki/index.md')).statusCode).toBe(400)
    expect((await get('../../etc/passwd')).statusCode).toBe(400)
    expect((await get('.raw/../wiki/index.md')).statusCode).toBe(400)
  })

  it('refuses a symlink escaping .raw', async () => {
    fs.symlinkSync(path.join(vaultRoot, 'wiki/index.md'), path.join(vaultRoot, '.raw/job-pdf/escape.md'))
    expect((await get('.raw/job-pdf/escape.md')).statusCode).toBe(400)
  })

  it('404s a missing document and 400s a directory', async () => {
    expect((await get('.raw/job-pdf/gone.pdf')).statusCode).toBe(404)
    expect((await get('.raw/job-pdf')).statusCode).toBe(400)
  })

  it('400s without a path', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sources/raw' })
    expect(res.statusCode).toBe(400)
  })

  it('keeps a non-ASCII file name readable in the disposition header', async () => {
    write('.raw/job-pdf/Nudelsalat Größe.pdf', '%PDF-1.4 x\n')
    const res = await get('.raw/job-pdf/Nudelsalat Größe.pdf')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''")
    expect(String(res.headers['content-disposition'])).toContain(encodeURIComponent('Größe'))
  })
})
