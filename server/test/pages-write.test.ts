/**
 * PUT/DELETE /api/v1/pages (SPEC.md §12.4 editing): confinement, optimistic locking,
 * commit-per-mutation against a REAL git vault, the gitAutoCommit=false path, and the
 * staleLinks backlink count that drives the dashboard's lint-guidance banner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { openDb, MEMORY_DB } from '../src/db/index.js'
import { JobStore } from '../src/db/jobs.js'
import { ChatStore } from '../src/db/chat.js'
import { IngestQueue } from '../src/pipeline/queue.js'
import { EventBus } from '../src/pipeline/events.js'
import { MaintenanceRunner } from '../src/pipeline/maintenance.js'
import { Mutex } from '../src/util/mutex.js'
import { buildServer } from '../src/api/server.js'
import type { Config } from '../src/config.js'

let vaultRoot: string
let app: FastifyInstance
let autoCommitEnabled: boolean

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', vaultRoot, ...args], { encoding: 'utf8' })

function page(rel: string, content: string): void {
  const abs = path.join(vaultRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

beforeEach(async () => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-write-'))
  page('wiki/concepts/Alpha.md', '# Alpha\n\nlinks to [[Beta]]\n')
  page('wiki/concepts/Beta.md', '# Beta\n\noriginal content\n')
  page('wiki/index.md', '[[Alpha]] [[Beta]]\n')
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed')

  autoCommitEnabled = true
  const db = openDb(MEMORY_DB)
  const events = new EventBus()
  const store = new JobStore(db, events)
  const config: Config = {
    vaultRoot,
    obsidianVaultName: 'vault',
    auth: { mode: 'oauth', credential: 'x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
    server: {
      host: '127.0.0.1',
      port: 0,
      watchFolder: path.join(vaultRoot, 'inbox'),
      maxUploadBytes: 1024 * 1024,
      authMode: 'local-single-user',
    },
  }
  const queue = new IngestQueue({
    store,
    vaultRoot,
    auth: config.auth,
    runIngest: async () => {
      throw new Error('no agent in this test')
    },
  })
  app = await buildServer({
    config,
    store,
    chat: new ChatStore(db),
    queue,
    events,
    maintenance: new MaintenanceRunner({ vaultRoot, auth: config.auth, events, commitMutex: new Mutex() }),
    logger: false,
    commitMutex: new Mutex(),
    autoCommit: () => autoCommitEnabled,
  })
})
afterEach(async () => {
  await app.close()
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('PUT /api/v1/pages', () => {
  it('writes the page and commits it as "edit: <title>"', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/v1/pages?path=wiki/concepts/Beta.md&full=1' })).json<{
      mtime: string
    }>()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/pages',
      payload: { path: 'wiki/concepts/Beta.md', markdown: '# Beta\n\nedited!\n', baseMtime: before.mtime },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ ok: boolean; committed: boolean; commit: string | null }>()
    expect(body.committed).toBe(true)
    expect(fs.readFileSync(path.join(vaultRoot, 'wiki/concepts/Beta.md'), 'utf8')).toContain('edited!')
    expect(git('log', '-1', '--pretty=%s')).toContain('edit: Beta')
    expect(git('status', '--porcelain').trim()).toBe('') // fully committed, tree clean
  })

  it('409s when the page changed since it was loaded (optimistic lock)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/pages',
      payload: { path: 'wiki/concepts/Beta.md', markdown: 'x', baseMtime: '2000-01-01T00:00:00.000Z' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ currentMtime: string }>().currentMtime).toBeTruthy()
    // The stale write must not have landed.
    expect(fs.readFileSync(path.join(vaultRoot, 'wiki/concepts/Beta.md'), 'utf8')).toContain('original content')
  })

  it('refuses traversal and non-wiki targets', async () => {
    for (const bad of ['../.git/config', '/etc/passwd', 'wiki/../SPEC.md', 'wiki/concepts/Beta.txt']) {
      const res = await app.inject({ method: 'PUT', url: '/api/v1/pages', payload: { path: bad, markdown: 'x' } })
      expect([400, 404]).toContain(res.statusCode)
    }
  })

  it('writes without committing when gitAutoCommit is off', async () => {
    autoCommitEnabled = false
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/pages',
      payload: { path: 'wiki/concepts/Beta.md', markdown: 'no commit\n' },
    })
    expect(res.json<{ committed: boolean }>().committed).toBe(false)
    expect(git('status', '--porcelain')).toContain('Beta.md')
  })

  it('does not sweep an unrelated dirty file into the edit commit', async () => {
    // Simulates an agent mid-write: another page is dirty while the user edits Beta.
    page('wiki/concepts/AgentDraft.md', 'half-written by a concurrent run\n')
    await app.inject({
      method: 'PUT',
      url: '/api/v1/pages',
      payload: { path: 'wiki/concepts/Beta.md', markdown: 'user edit\n' },
    })
    const committed = git('show', '--name-only', '--pretty=format:', 'HEAD')
    expect(committed).toContain('Beta.md')
    expect(committed).not.toContain('AgentDraft.md')
    expect(git('status', '--porcelain')).toContain('AgentDraft.md') // still dirty, untouched
  })
})

describe('DELETE /api/v1/pages', () => {
  it('deletes, commits as "delete: <title>", and reports the backlink count', async () => {
    // Beta is linked from Alpha and index → 2 stale links after deletion.
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/pages?path=wiki/concepts/Beta.md' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ staleLinks: number; committed: boolean }>()
    expect(body.staleLinks).toBe(2)
    expect(body.committed).toBe(true)
    expect(fs.existsSync(path.join(vaultRoot, 'wiki/concepts/Beta.md'))).toBe(false)
    expect(git('log', '-1', '--pretty=%s')).toContain('delete: Beta')
    expect(git('status', '--porcelain').trim()).toBe('')
  })

  it('404s on a missing page and refuses traversal', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/pages?path=wiki/concepts/Nope.md' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/pages?path=../.git/config' })).statusCode).toBe(400)
  })
})
