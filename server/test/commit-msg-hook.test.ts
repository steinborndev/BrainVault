/**
 * The commit-msg leak hook (scripts/git-hooks/commit-msg, CLAUDE.md hard rule 7).
 *
 * This repo is public, the vault it operates on is private, and the hook is the backstop
 * that stops a commit message from naming a vault subject. It is a shell script nobody
 * imports, so nothing else would notice it breaking - and a leak guard that has quietly
 * stopped guarding is worse than none, because it still looks like protection.
 *
 * Two properties matter and neither is obvious from reading it: it still BLOCKS a real
 * entity name, and it no longer blocks a git attribution trailer (a co-author's address
 * kept matching an entity page that shares the name).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = path.resolve(fileURLToPath(new URL('../../scripts/git-hooks/commit-msg', import.meta.url)))

let vaultRoot: string
let msgFile: string

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-vault-'))
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'entities'), { recursive: true })
  fs.mkdirSync(path.join(vaultRoot, 'wiki', 'sources'), { recursive: true })
  msgFile = path.join(vaultRoot, 'COMMIT_EDITMSG')
})

afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

/** Writes a page whose TITLE is the denylisted term, the way the vault stores entities. */
function entity(title: string, body = 'a page'): void {
  fs.writeFileSync(path.join(vaultRoot, 'wiki', 'entities', `${title}.md`), body)
}

/** Runs the hook over `message`; returns its exit status and what it told the user. */
function run(message: string, env: Record<string, string> = {}): { ok: boolean; stderr: string } {
  fs.writeFileSync(msgFile, message)
  const r = spawnSync('bash', [HOOK, msgFile], {
    encoding: 'utf8',
    env: { ...process.env, VAULT_ROOT: vaultRoot, ...env },
  })
  return { ok: r.status === 0, stderr: r.stderr ?? '' }
}

describe('commit-msg leak hook', () => {
  it('blocks a message naming an entity page', () => {
    entity('Northwind Logistics')
    const r = run('feat: handle the Northwind Logistics import edge case\n')
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain('Northwind Logistics')
  })

  it('blocks a handle found inside an entity page, not just the title', () => {
    entity('Someone', 'Posts as @quietcartographer on the usual place.\n')
    expect(run('fix: parse posts from @quietcartographer\n').ok).toBe(false)
  })

  it('passes a message that describes the mechanism instead of the subject', () => {
    entity('Northwind Logistics')
    expect(run('feat: the single-post creator class gets its own parser\n').ok).toBe(true)
  })

  it('passes an attribution trailer whose address matches an entity name', () => {
    // The regression this exists for: an entity page named after a company meant every
    // co-authored commit was blocked by its email domain.
    entity('Acme')
    const r = run('feat: something generic\n\nCo-Authored-By: Someone <noreply@acme.com>\n')
    expect(r.ok).toBe(true)
  })

  it('covers the other -by trailers, not just Co-Authored-By', () => {
    entity('Acme')
    for (const trailer of ['Signed-off-by', 'Reviewed-by', 'reported-BY']) {
      expect(run(`fix: generic\n\n${trailer}: A Person <a@acme.com>\n`).ok).toBe(true)
    }
  })

  it('does NOT let prose claim the trailer exemption', () => {
    // The exemption is the `<Word>-by:` line form and nothing looser - a body sentence that
    // happens to mention a vault name must still be caught.
    entity('Northwind Logistics')
    expect(run('fix: generic\n\nThis was caused by Northwind Logistics data.\n').ok).toBe(false)
    // ...including a line that merely starts with a word and a colon.
    expect(run('fix: generic\n\nContext: Northwind Logistics again.\n').ok).toBe(false)
  })

  it('still scans the body when a legitimate trailer is also present', () => {
    entity('Northwind Logistics')
    const r = run('feat: rework the Northwind Logistics view\n\nCo-Authored-By: X <x@example.com>\n')
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain('Northwind Logistics')
  })

  it('honours the documented escape hatch', () => {
    entity('Northwind Logistics')
    expect(run('feat: Northwind Logistics\n', { ALLOW_VAULT_NAMES: '1' }).ok).toBe(true)
  })

  it('passes silently with no vault present - fresh clones and CI block nothing', () => {
    fs.rmSync(path.join(vaultRoot, 'wiki'), { recursive: true, force: true })
    expect(run('feat: anything at all\n').ok).toBe(true)
  })

  it('skips short and ordinary words that happen to be entity titles', () => {
    // "Data" as a page title must not block every commit that says "data".
    entity('Data')
    expect(run('fix: keep the data layer honest\n').ok).toBe(true)
  })
})
