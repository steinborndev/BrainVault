import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isShortcut, readShortcutUrl } from '../src/pipeline/shortcut.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, content: string): string => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

describe('isShortcut', () => {
  it('recognises .url and .webloc', () => {
    expect(isShortcut('a.url')).toBe(true)
    expect(isShortcut('a.URL')).toBe(true)
    expect(isShortcut('a.webloc')).toBe(true)
    expect(isShortcut('a.pdf')).toBe(false)
  })
})

describe('readShortcutUrl', () => {
  it('parses a Windows .url INI', () => {
    const p = write('r.url', '[InternetShortcut]\nURL=https://example.com/x.html\nIconIndex=0\n')
    expect(readShortcutUrl(p)).toBe('https://example.com/x.html')
  })
  it('parses a macOS .webloc plist', () => {
    const p = write(
      'r.webloc',
      '<?xml version="1.0"?><plist><dict><key>URL</key><string>https://example.org/y</string></dict></plist>',
    )
    expect(readShortcutUrl(p)).toBe('https://example.org/y')
  })
  it('returns undefined when there is no http(s) URL', () => {
    const p = write('r.url', '[InternetShortcut]\nURL=file:///etc/passwd\n')
    expect(readShortcutUrl(p)).toBeUndefined()
  })
})
