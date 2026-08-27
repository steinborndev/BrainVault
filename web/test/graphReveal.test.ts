/**
 * The graph's entrance. The interesting properties are all about ORDER and BOUNDS - that the
 * queue is deterministic, that nothing is ever drawn at a negative or over-full alpha, and
 * that every node has finished by the time the clock has.
 */
import { describe, expect, it } from 'vitest'
import {
  LABEL_ENTER_AT,
  REVEAL_STAGGER,
  revealAlpha,
  revealLabelAlpha,
  revealOrder,
  revealPop,
} from '../src/lib/graphReveal.ts'

describe('revealOrder', () => {
  it('puts the most connected node first and the least connected last', () => {
    const rank = revealOrder([1, 9, 4])
    expect(rank[1]).toBe(0)
    expect(rank[2]).toBeCloseTo(0.5, 10)
    expect(rank[0]).toBe(1)
  })

  it('breaks ties on index, so the same graph reveals the same way twice', () => {
    expect([...revealOrder([3, 3, 3])]).toEqual([...revealOrder([3, 3, 3])])
    expect([...revealOrder([3, 3, 3])]).toEqual([0, 0.5, 1])
  })

  it('handles the degenerate sizes without dividing by zero', () => {
    expect([...revealOrder([])]).toEqual([])
    expect([...revealOrder([7])]).toEqual([0])
  })

  it('spans the full queue regardless of how lopsided the degrees are', () => {
    const rank = revealOrder([0, 0, 0, 0, 500])
    expect(Math.min(...rank)).toBe(0)
    expect(Math.max(...rank)).toBe(1)
  })
})

describe('revealAlpha', () => {
  it('starts every node at nothing and finishes every node at full', () => {
    for (const rank of [0, 0.25, 0.5, 0.75, 1]) {
      expect(revealAlpha(0, rank)).toBe(0)
      expect(revealAlpha(1, rank)).toBeCloseTo(1, 10)
    }
  })

  it('never leaves the 0..1 range, including past both ends of the clock', () => {
    for (const t of [-1, -0.01, 0, 0.37, 1, 1.5, 99]) {
      for (const rank of [-1, 0, 0.5, 1, 2]) {
        const a = revealAlpha(t, rank)
        expect(a).toBeGreaterThanOrEqual(0)
        expect(a).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is monotonic in time for one node', () => {
    let last = -1
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const a = revealAlpha(t, 0.4)
      expect(a).toBeGreaterThanOrEqual(last)
      last = a
    }
  })

  it('keeps a hub ahead of the tail for the whole stagger', () => {
    // The point of the order: at any moment before the end, the more connected page is at
    // least as present as the less connected one.
    for (let t = 0; t < 1; t += 0.05) {
      expect(revealAlpha(t, 0)).toBeGreaterThanOrEqual(revealAlpha(t, 0.5))
      expect(revealAlpha(t, 0.5)).toBeGreaterThanOrEqual(revealAlpha(t, 1))
    }
  })

  it('has not started the last node before the stagger is over', () => {
    expect(revealAlpha(REVEAL_STAGGER - 0.001, 1)).toBe(0)
    expect(revealAlpha(REVEAL_STAGGER + 0.05, 1)).toBeGreaterThan(0)
  })
})

describe('revealPop', () => {
  it('lands at exactly the node\'s own radius when the fade is done', () => {
    expect(revealPop(1)).toBeCloseTo(1, 10)
  })

  it('grows into it, never out of nothing and never past it', () => {
    expect(revealPop(0)).toBeGreaterThan(0)
    let last = 0
    for (let a = 0; a <= 1.0001; a += 0.05) {
      const p = revealPop(a)
      expect(p).toBeGreaterThanOrEqual(last)
      expect(p).toBeLessThanOrEqual(1)
      last = p
    }
  })

  it('clamps rather than inverting the circle on an out-of-range alpha', () => {
    expect(revealPop(-5)).toBeGreaterThan(0)
    expect(revealPop(5)).toBeCloseTo(1, 10)
  })
})

describe('revealLabelAlpha', () => {
  it('holds the labels back until the nodes are mostly in', () => {
    expect(revealLabelAlpha(0)).toBe(0)
    expect(revealLabelAlpha(LABEL_ENTER_AT)).toBe(0)
    expect(revealLabelAlpha(1)).toBeCloseTo(1, 10)
  })

  it('never leaves the 0..1 range', () => {
    for (const t of [-5, 0, 0.5, 1, 5]) {
      expect(revealLabelAlpha(t)).toBeGreaterThanOrEqual(0)
      expect(revealLabelAlpha(t)).toBeLessThanOrEqual(1)
    }
  })
})
