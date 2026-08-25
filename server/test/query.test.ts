import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseWikilinks, parseWikilinkRefs, extractCitations, indexWikiPages } from '../src/pipeline/citations.js'
import {
  decidePermission,
  profileAllowsWeb,
  profileAllowsVaultWrite,
} from '../src/pipeline/permissions.js'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import { ChatStore } from '../src/db/chat.js'
import { parseLintReport } from '../src/pipeline/lint-report.js'

describe('citations', () => {
  it('parses wikilink targets, stripping aliases/headings and de-duping', () => {
    const text = 'See [[Compound Interest]], [[Compound Interest|it]], [[Risk#Types]], and [[Compound Interest]] again.'
    expect(parseWikilinks(text)).toEqual(['Compound Interest', 'Risk'])
  })

  it('ignores wikilinks inside fenced blocks and inline code', () => {
    // `tf.constant([[1.]] * n)` is a Python literal, and a lint report QUOTES the dangling
    // links it reports. Both used to come back as page names.
    const text = [
      'Real link to [[Alpha]].',
      '',
      '```python',
      'y = tf.constant([[0.]] * n + [[1.]] * n)  # [[Beta]] in a comment',
      '```',
      '',
      'Inline `tf.constant([[1.,2.],[3.,4.]])` next to a quoted `[[Gamma]]` finding.',
      '',
      '~~~',
      'tilde fence holding [[Delta]]',
      '~~~',
      '',
      'Closing with [[Epsilon]].',
    ].join('\n')
    expect(parseWikilinks(text)).toEqual(['Alpha', 'Epsilon'])
  })

  it('pairs fences by length and lets an unterminated one run to the end', () => {
    // A four-backtick fence quoting a three-backtick one must not close early.
    expect(parseWikilinks('````\n```\n[[Inside]]\n```\n````\n\n[[After]]')).toEqual(['After'])
    // CommonMark and Obsidian both run an unterminated fence to end of document.
    expect(parseWikilinks('[[Before]]\n\n```\n[[Never Closed]]')).toEqual(['Before'])
  })

  it('unescapes the table-escaped alias pipe', () => {
    // Inside a markdown table the alias separator must be written `\|` or the cell breaks.
    // Splitting on the bare pipe left the escape in the page name and it resolved to nothing.
    const row = '| [[Compound Interest\\|CI]] | [[Alpha\\|A]] |'
    expect(parseWikilinks(row)).toEqual(['Compound Interest', 'Alpha'])
  })

  it('flags embeds, and one plain link anywhere clears the flag', () => {
    const refs = parseWikilinkRefs('![[shot.png]], then ![[Alpha]], but also [[Alpha]] plainly.')
    expect(refs.find((r) => r.target === 'shot.png')?.embed).toBe(true)
    expect(refs.find((r) => r.target === 'Alpha')?.embed).toBe(false)
    // The string view keeps embeds: callers that only ask WHICH pages a text names want them.
    expect(parseWikilinks('![[shot.png]]')).toEqual(['shot.png'])
  })

  it('resolves links to vault page paths, unresolved → null', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cite-'))
    fs.mkdirSync(path.join(vault, 'wiki', 'concepts'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'Compound Interest.md'), '#')
    try {
      const index = indexWikiPages(vault)
      const cites = extractCitations('[[Compound Interest]] and [[Ghost]]', vault, index)
      expect(cites.find((c) => c.label === 'Compound Interest')?.path).toBe('wiki/concepts/Compound Interest.md')
      expect(cites.find((c) => c.label === 'Ghost')?.path).toBeNull()
    } finally {
      fs.rmSync(vault, { recursive: true, force: true })
    }
  })
})

describe('run profiles', () => {
  const ctx = (profile: 'ingest' | 'query' | 'research') => ({ vaultRoot: '/vault', profile })

  it('query is read-only and web-free; research allows both; ingest writes but no web', () => {
    expect(profileAllowsWeb('query')).toBe(false)
    expect(profileAllowsVaultWrite('query')).toBe(false)
    expect(profileAllowsWeb('research')).toBe(true)
    expect(profileAllowsVaultWrite('research')).toBe(true)
    expect(profileAllowsWeb('ingest')).toBe(false)
    expect(profileAllowsVaultWrite('ingest')).toBe(true)

    // A query run denies Write and WebFetch; ingest allows Write; research allows WebFetch.
    expect(decidePermission(ctx('query'), 'Write', { file_path: '/vault/wiki/x.md' }).behavior).toBe('deny')
    expect(decidePermission(ctx('query'), 'WebFetch', { url: 'https://x' }).behavior).toBe('deny')
    expect(decidePermission(ctx('ingest'), 'Write', { file_path: '/vault/wiki/x.md' }).behavior).toBe('allow')
    expect(decidePermission(ctx('research'), 'WebFetch', { url: 'https://x' }).behavior).toBe('allow')
    // Path confinement still applies in every profile.
    expect(decidePermission(ctx('research'), 'Read', { file_path: '/etc/passwd' }).behavior).toBe('deny')
  })
})

describe('parseLintReport', () => {
  it('extracts summary counts, sections, and resolves each finding’s first page', () => {
    const md = [
      '# Lint Report: 2026-07-17',
      '## Summary',
      '- Pages scanned: 94',
      '- Issues found: 3',
      '## Orphan Pages',
      '- [[Lonely]]: no inbound links.',
      '- [[Also Lonely]]: no inbound links.',
      '## Dead Links',
      '- [[Ghost]]: referenced in [[Real Page]] but does not exist.',
    ].join('\n')
    const known = new Set(['real page'])
    const report = parseLintReport(md, (label) => ({
      label,
      path: known.has(label.toLowerCase()) ? `wiki/concepts/${label}.md` : null,
    }))

    expect(report.date).toBe('2026-07-17')
    expect(report.summary).toEqual({ 'Pages scanned': 94, 'Issues found': 3 })
    expect(report.sections.map((s) => s.title)).toEqual(['Orphan Pages', 'Dead Links'])
    expect(report.totalFindings).toBe(3)
    // The dead-link finding's first wikilink is [[Ghost]] (unresolved → null).
    expect(report.sections[1]!.findings[0]!.page?.path).toBeNull()
    expect(report.sections[1]!.findings[0]!.page?.label).toBe('Ghost')
  })
})

describe('ChatStore', () => {
  let db: Db
  let chat: ChatStore
  beforeEach(() => {
    db = openDb(MEMORY_DB)
    chat = new ChatStore(db)
  })
  afterEach(() => db.close())

  it('stores messages with citations and lists sessions by recent activity', () => {
    const s1 = chat.createSession({ title: 'first' })
    const s2 = chat.createSession({ title: 'second' })
    chat.addMessage({ sessionId: s1.id, role: 'user', content: 'q' })
    chat.addMessage({
      sessionId: s1.id,
      role: 'assistant',
      content: 'a',
      citations: [{ label: 'P', path: 'wiki/concepts/P.md' }],
    })
    chat.setSdkSessionId(s1.id, 'sdk-1')

    const msgs = chat.messages(s1.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(JSON.parse(msgs[1]!.citations!)).toEqual([{ label: 'P', path: 'wiki/concepts/P.md' }])
    expect(chat.getSessionOrThrow(s1.id).sdk_session_id).toBe('sdk-1')

    // s1 has the most recent activity → sorts before s2.
    const list = chat.listSessions()
    expect(list[0]!.id).toBe(s1.id)
    expect(list.find((s) => s.id === s1.id)!.message_count).toBe(2)

    expect(chat.deleteSession(s2.id)).toBe(true)
    expect(chat.getSession(s2.id)).toBeUndefined()
  })

  it('persists per-message usage on assistant messages (v6), null elsewhere', () => {
    const s = chat.createSession({ title: 'usage' })
    chat.addMessage({ sessionId: s.id, role: 'user', content: 'q' })
    chat.addMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'a',
      usage: { tokensIn: 1200, tokensOut: 340, costUsd: 0.021 },
    })
    const [user, assistant] = chat.messages(s.id)
    expect(user!.tokens_in).toBeNull()
    expect(assistant!.tokens_in).toBe(1200)
    expect(assistant!.tokens_out).toBe(340)
    expect(assistant!.cost_usd).toBeCloseTo(0.021)
  })
})
