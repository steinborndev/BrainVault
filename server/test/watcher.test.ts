import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { frontmatterUrl } from '../src/pipeline/watcher.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, content: string): string => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

describe('frontmatterUrl', () => {
  it('extracts a Web Clipper frontmatter URL', () => {
    const p = write('clip.md', '---\ntitle: Thing\nsource: https://example.com/article\n---\n\nBody')
    expect(frontmatterUrl(p)).toBe('https://example.com/article')
  })

  it('supports a url: key', () => {
    const p = write('clip.md', '---\nurl: "https://example.org/x"\n---\nbody')
    expect(frontmatterUrl(p)).toBe('https://example.org/x')
  })

  it('returns undefined for a plain markdown file', () => {
    const p = write('note.md', '# Just a note\n\nno frontmatter here')
    expect(frontmatterUrl(p)).toBeUndefined()
  })

  it('returns undefined when frontmatter has no url', () => {
    const p = write('note.md', '---\ntitle: x\ntags: [a, b]\n---\nbody')
    expect(frontmatterUrl(p)).toBeUndefined()
  })
})
