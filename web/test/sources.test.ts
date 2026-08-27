/**
 * The Library's source link. The load-bearing case is the web one: a web ingest must link
 * to its LIVE URL, never to the scraped `raw.html` it stored - rendering that from the
 * dashboard's origin would run the scraped page's script with the dashboard's API behind
 * it. The server refuses to serve HTML inline as the backstop; this is the near side.
 */
import { describe, it, expect } from 'vitest'
import { sourceLink } from '../src/lib/sources.ts'
import type { SourceRef } from '../src/api/types.ts'

const ref = (over: Partial<SourceRef>): SourceRef => ({
  dir: '.raw/job-1',
  file: 'paper.pdf',
  type: 'pdf',
  url: null,
  ...over,
})

describe('sourceLink', () => {
  it('links a file source to the raw endpoint, with the path encoded', () => {
    const link = sourceLink(ref({ file: 'Nudelsalat & Co.pdf' }))
    expect(link).not.toBeNull()
    expect(link!.href).toBe('/api/v1/sources/raw?path=.raw%2Fjob-1%2FNudelsalat%20%26%20Co.pdf')
    expect(link!.external).toBe(false)
    expect(link!.label).toBe('PDF')
    expect(link!.icon).toBe('file')
  })

  it('sends a web source to its live URL, never to the stored raw.html', () => {
    const link = sourceLink(ref({ type: 'web', file: 'raw.html', url: 'https://www.example.com/a/post' }))
    expect(link!.href).toBe('https://www.example.com/a/post')
    expect(link!.external).toBe(true)
    expect(link!.title).toContain('example.com')
    expect(link!.title).not.toContain('www.')
  })

  it('falls back to the stored payload for a web ingest that kept no URL', () => {
    const link = sourceLink(ref({ type: 'web', file: 'raw.html', url: null }))
    expect(link!.href).toContain('/api/v1/sources/raw')
    expect(link!.external).toBe(false)
  })

  it('gives every known type a label and an icon', () => {
    const of = (type: string): { label: string; icon: string } => {
      const l = sourceLink(ref({ type }))!
      return { label: l.label, icon: l.icon }
    }
    expect(of('image')).toEqual({ label: 'Image', icon: 'image' })
    expect(of('text')).toEqual({ label: 'Text', icon: 'file' })
    expect(of('office')).toEqual({ label: 'Office', icon: 'file' })
    expect(of('av')).toEqual({ label: 'Media', icon: 'play' })
    // An unknown type is still a document, and still openable.
    expect(of('quantum-fax')).toEqual({ label: 'File', icon: 'file' })
  })

  it('has nothing to open without a ref, or without a file and a URL', () => {
    expect(sourceLink(undefined)).toBeNull()
    expect(sourceLink(ref({ file: null }))).toBeNull()
    expect(sourceLink(ref({ type: 'web', file: null, url: null }))).toBeNull()
  })

  it('keeps a malformed URL as its own tooltip rather than throwing', () => {
    const link = sourceLink(ref({ type: 'web', file: null, url: 'not a url' }))
    expect(link!.href).toBe('not a url')
    expect(link!.external).toBe(true)
  })
})
