import { describe, it, expect } from 'vitest'
import { isValidElement, type ReactNode } from 'react'
import { linkifyText, espacenetUrl } from '../src/lib/linkify.tsx'

/** Collects the hrefs of every <a> the linkifier emitted, in order. */
function hrefs(nodes: ReactNode[]): string[] {
  return nodes
    .filter((n): n is React.ReactElement<{ href: string }> => isValidElement(n) && n.type === 'a')
    .map((n) => n.props.href)
}

/** The visible text of every <a>, in order. */
function anchorText(nodes: ReactNode[]): string[] {
  return nodes
    .filter((n): n is React.ReactElement<{ children: string }> => isValidElement(n) && n.type === 'a')
    .map((n) => n.props.children)
}

describe('linkifyText — URLs', () => {
  it('links a bare http(s) URL', () => {
    expect(hrefs(linkifyText('see https://example.com/x for more', 'k'))).toEqual([
      'https://example.com/x',
    ])
  })

  it('does not swallow trailing sentence punctuation', () => {
    expect(hrefs(linkifyText('at https://example.com/page.', 'k'))).toEqual([
      'https://example.com/page',
    ])
  })

  it('leaves text without a URL untouched (returns the original string)', () => {
    expect(linkifyText('plain text', 'k')).toEqual(['plain text'])
  })
})

describe('linkifyText — patent numbers', () => {
  it('links the compact form the vault uses', () => {
    const nodes = linkifyText('cf. US8691748B2 and DE102016100455A1', 'k')
    expect(hrefs(nodes)).toEqual([
      espacenetUrl('US8691748B2'),
      espacenetUrl('DE102016100455A1'),
    ])
    expect(anchorText(nodes)).toEqual(['US8691748B2', 'DE102016100455A1'])
  })

  it('strips grouping commas when building the Espacenet number', () => {
    expect(hrefs(linkifyText('US9,526,637B2', 'k'))).toEqual([espacenetUrl('US9526637B2')])
  })

  it('handles application publications and WO numbers', () => {
    expect(hrefs(linkifyText('US20230077899A1 / WO2015057941A1', 'k'))).toEqual([
      espacenetUrl('US20230077899A1'),
      espacenetUrl('WO2015057941A1'),
    ])
  })

  it('accepts an optional space before the number and kind code', () => {
    expect(hrefs(linkifyText('EP 1234567 B1', 'k'))).toEqual([espacenetUrl('EP1234567B1')])
  })

  it('does NOT link a country code followed by a short number (year, quantity)', () => {
    expect(hrefs(linkifyText('filed in US2020 and only US 10 were granted', 'k'))).toEqual([])
  })

  it('does NOT match a word that merely starts with a country code', () => {
    expect(hrefs(linkifyText('a USB cable and a DEbug flag', 'k'))).toEqual([])
  })
})

describe('linkifyText — mixed', () => {
  it('links a URL and a patent in the same text', () => {
    const nodes = linkifyText('src https://patents.example/US1 covers US8691748B2', 'k')
    expect(hrefs(nodes)).toEqual([
      'https://patents.example/US1',
      espacenetUrl('US8691748B2'),
    ])
  })
})
