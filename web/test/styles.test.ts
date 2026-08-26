/**
 * Structural checks on `styles.css`.
 *
 * These exist because a scripted sweep over the stylesheet (2026-08-25) damaged it in two
 * ways that no type check, no unit test and no eyeball caught:
 *
 *   1. It removed the LAST line of a multi-line selector group together with its block, and
 *      left the earlier lines dangling. `.gp-search:focus-within,` then swallowed whatever
 *      came next - in one case an `@media` block - and the focus ring on every search field
 *      was silently gone.
 *   2. It removed rules whose class it had classified as unused from a list built by hand,
 *      and one of them (`.badge.queued-badge`) was still being rendered.
 *
 * The build DID warn about the first one. Nobody read it. A test does not scroll past.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, '..', 'src', 'styles.css')
const css = readFileSync(cssPath, 'utf8')
/** Comments replaced by blanks of the same length, so offsets and line numbers survive. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

describe('styles.css structure', () => {
  it('has balanced braces', () => {
    let depth = 0
    for (const ch of bare) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
      expect(depth).toBeGreaterThanOrEqual(0)
    }
    expect(depth).toBe(0)
  })

  it('has no dangling selector line - one ending in a comma with no rule after it', () => {
    const lines = bare.split('\n')
    const dangling: string[] = []
    lines.forEach((line, i) => {
      if (!line.trimEnd().endsWith(',')) return
      let j = i + 1
      while (j < lines.length && lines[j]!.trim() === '') j++
      const next = lines[j]?.trim() ?? ''
      // A comma continues a selector list. Anything that starts a new construct instead
      // means the block this selector belonged to was removed out from under it.
      if (next === '' || next.startsWith('@') || next.startsWith('}')) {
        dangling.push(`line ${i + 1}: ${css.split('\n')[i]!.trim()}`)
      }
    })
    expect(dangling).toEqual([])
  })

  it('has no at-rule nested inside a plain rule', () => {
    let depth = 0
    const nested: string[] = []
    bare.split('\n').forEach((line, i) => {
      if (depth > 0 && line.trim().startsWith('@media')) nested.push(`line ${i + 1}`)
      for (const ch of line) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
    })
    expect(nested).toEqual([])
  })
})

describe('styles.css geometry invariants', () => {
  /** The declaration block of the first rule whose selector list is exactly `selector`. */
  const block = (selector: string): string => {
    const i = bare.indexOf(`\n${selector} {`)
    expect(i, `no rule for ${selector}`).toBeGreaterThan(-1)
    return bare.slice(i, bare.indexOf('}', i))
  }

  /**
   * The research console's plan line must be the same height in both modes. Only research
   * files a page, so only research renders the bordered `.pl-page` chip - and while the
   * plain values had no border and no vertical padding, that made the row 5.25px taller in
   * research than in ask, which shifted the console and every list under it on every mode
   * switch. `.pl-val` therefore reserves the chip's box and `.pl-page` only paints it.
   */
  it('reserves the same box for a plan-line value with and without the page chip', () => {
    const plain = block('.pl-val')
    expect(plain).toMatch(/border:\s*1px solid transparent/)
    expect(plain).toMatch(/padding:\s*2px 0/)

    const chip = block('.pl-val.pl-page')
    expect(chip).toMatch(/padding:\s*2px 7px/)
    // Only the COLOUR may be restated - a `border:` shorthand here would reset the width
    // and bring the height difference back.
    expect(chip).not.toMatch(/border:\s/)
    expect(chip).toMatch(/border-color:/)
  })
})

describe('styles.css coverage', () => {
  /** Every class token any component can put on an element. */
  const rendered = (): Set<string> => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? walk(path) : path.endsWith('.tsx') ? [path] : []
      })
    const out = new Set<string>()
    for (const file of walk(join(here, '..', 'src'))) {
      const text = readFileSync(file, 'utf8')
      // Only forms that carry class names literally: a string, or the literal parts of a
      // template. `className={someVariable}` is skipped on purpose - its value is built
      // elsewhere, and reading the identifier would report `cls` and `tone` as class names.
      for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const literal = [m[1], m[2]].join(' ').replace(/\$\{[^}]*\}/g, ' ')
        for (const token of literal.match(/[A-Za-z][\w-]*/g) ?? []) out.add(token)
      }
      // …and the templates those variables are assigned from, which is the same literal
      // form one step removed: `const cls = ` + backtick + `fact${…}` + backtick.
      for (const m of text.matchAll(/^\s*(?:const|let)\s+\w+\s*=\s*`([^`]*)`/gm)) {
        const literal = m[1]!.replace(/\$\{[^}]*\}/g, ' ')
        // Only if it looks like a class list: no spaces-with-punctuation, no sentences.
        if (/^[\w\s-]*$/.test(literal)) {
          for (const token of literal.match(/[A-Za-z][\w-]*/g) ?? []) out.add(token)
        }
      }
    }
    return out
  }

  /**
   * Classes a component renders but the stylesheet never mentions. Not every one is a bug -
   * a class can be a hook for a test or for nothing at all - so this is a named list rather
   * than a blanket ban, and adding to it should be a deliberate act.
   */
  const UNSTYLED_ON_PURPOSE = new Set<string>([])

  it('styles every class the components render', () => {
    const declared = new Set(css.match(/\.([a-zA-Z][\w-]*)/g)?.map((s) => s.slice(1)) ?? [])
    const missing = [...rendered()]
      .filter((c) => !declared.has(c) && !UNSTYLED_ON_PURPOSE.has(c))
      // A token ending in `-` is the fixed half of a class assembled at runtime
      // (`verdict-${verdict}`); the whole name never appears in the source, so the scan
      // cannot check it and the stylesheet declares the variants instead.
      .filter((c) => !c.endsWith('-'))
      // Single letters are variable names that leaked in, never class names here.
      .filter((c) => c.length > 1)
      .sort()
    expect(missing).toEqual([])
  })
})
