/**
 * The SPA fallback, and the one request it must NOT answer with the shell.
 *
 * Vite emits hashed bundles under `/assets/` and renames them on every rebuild. The Graph
 * screen is a dynamic import, so a tab left open across a rebuild asks for a file name that
 * is gone. While the fallback answered that with `index.html` (200, text/html), the browser
 * refused the reply as a module and the dashboard went blank until a manual reload.
 *
 * The deep-link cases are here for the opposite reason: the fix must not become a "looks
 * like a file" rule, because vault pages route as `/page/Some Note.md`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerFrontend, notFoundKind } from '../src/api/server.js'

let dist: string
let app: FastifyInstance

beforeEach(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-dist-'))
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>LibrisVault</title>')
  fs.writeFileSync(path.join(dist, 'assets', 'Vault-CURRENT.js'), 'export const x = 1\n')
  app = Fastify({ logger: false })
  await registerFrontend(app, dist)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(dist, { recursive: true, force: true })
})

describe('static assets', () => {
  it('serves a bundle that exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/Vault-CURRENT.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('javascript')
  })

  it('404s a bundle that is gone instead of serving the shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/Vault-STALEHASH.js' })
    expect(res.statusCode).toBe(404)
    // The status alone is the fix; this pins WHY it matters - a module request must never
    // come back as HTML, or the browser reports a MIME error instead of a missing file.
    expect(res.headers['content-type']).not.toContain('text/html')
    expect(res.body).not.toContain('<!doctype html>')
  })
})

describe('SPA deep links', () => {
  it('serves the shell for a client route', async () => {
    const res = await app.inject({ method: 'GET', url: '/graph' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('LibrisVault')
  })

  it('serves the shell for a page route that ends in a file extension', async () => {
    const res = await app.inject({ method: 'GET', url: '/page/Some%20Note.md' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('LibrisVault')
  })

  it('keeps unknown API routes a JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not found' })
  })
})

describe('notFoundKind', () => {
  it('classifies by prefix, query string included', () => {
    expect(notFoundKind('/api/v1/jobs?limit=5')).toBe('api')
    expect(notFoundKind('/assets/index-abc123.js?t=1')).toBe('asset')
    expect(notFoundKind('/graph?focus=Some%20Page.md')).toBe('shell')
    expect(notFoundKind('/')).toBe('shell')
  })
})
