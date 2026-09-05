import { describe, it, expect } from 'vitest'
import { DROP_TARGET_SELECTOR, ownsDrop } from '../src/lib/dropTarget.ts'

/** A stand-in for an element: `closest` answers whether it sits inside a drop target. */
const inside = { closest: (sel: string) => (sel === DROP_TARGET_SELECTOR ? {} : null) }
const outside = { closest: () => null }

describe('ownsDrop', () => {
  it('claims a drop inside a marked drop target and nothing else', () => {
    expect(ownsDrop(inside)).toBe(true)
    expect(ownsDrop(outside)).toBe(false)
  })

  it('treats a missing or non-element target as unowned', () => {
    expect(ownsDrop(null)).toBe(false)
    expect(ownsDrop(undefined)).toBe(false)
    // A text node has no `closest`; the window handler keeps the drop.
    expect(ownsDrop({ nodeType: 3 })).toBe(false)
  })
})
