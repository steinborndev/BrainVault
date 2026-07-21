import { describe, it, expect } from 'vitest'
import {
  pointInPolygon,
  boxIntersectsPolygon,
  placeRegionLabels,
  type RegionLabelInput,
} from '../src/components/GraphCanvas.tsx'

type Pt = [number, number]
type Box = [number, number, number, number]

/** Axis-aligned square as a vertex ring. */
const sq = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

const overlap = (a: Box, b: Box): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

describe('pointInPolygon', () => {
  const square = sq(0, 0, 10, 10)
  it('is true for an interior point, false for an exterior one', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true)
    expect(pointInPolygon(-1, 5, square)).toBe(false)
    expect(pointInPolygon(5, 20, square)).toBe(false)
  })
})

describe('boxIntersectsPolygon', () => {
  const square = sq(0, 0, 10, 10)
  it('true when the box is inside the polygon', () => {
    expect(boxIntersectsPolygon([2, 2, 8, 8], square)).toBe(true)
  })
  it('true when a polygon vertex sits inside the box (box larger than hull)', () => {
    expect(boxIntersectsPolygon([-5, -5, 5, 5], square)).toBe(true)
  })
  it('false when the box is clear of the polygon', () => {
    expect(boxIntersectsPolygon([20, 20, 30, 30], square)).toBe(false)
  })
})

describe('placeRegionLabels', () => {
  const LABEL_H = 2
  const MARGIN = 1

  it('places a lone label just above its own hull, outside it', () => {
    const hulls = new Map<number, Pt[]>([[1, sq(0, 0, 10, 10)]])
    const labels: RegionLabelInput[] = [{ key: 1, width: 6, weight: 3 }]
    const [placed] = placeRegionLabels(labels, hulls, LABEL_H, MARGIN)
    expect(placed!.fallback).toBe(false)
    expect(placed!.box[3]).toBeLessThanOrEqual(0) // box bottom is at/above the hull top (y=0)
    expect(placed!.x).toBe(5) // centred on the hull
  })

  it('two separated hulls both place without fallback and without overlap', () => {
    const hulls = new Map<number, Pt[]>([
      [1, sq(0, 0, 10, 10)],
      [2, sq(100, 0, 110, 10)],
    ])
    const out = placeRegionLabels(
      [
        { key: 1, width: 6, weight: 3 },
        { key: 2, width: 6, weight: 3 },
      ],
      hulls,
      LABEL_H,
      MARGIN,
    )
    expect(out.every((p) => !p.fallback)).toBe(true)
    expect(overlap(out[0]!.box, out[1]!.box)).toBe(false)
  })

  it('moves a label to another anchor rather than overlapping an already-placed one', () => {
    // Two near hulls whose top-centre labels would collide; the wide labels force a shift.
    const hulls = new Map<number, Pt[]>([
      [1, sq(0, 0, 10, 10)],
      [2, sq(8, 0, 18, 10)],
    ])
    const out = placeRegionLabels(
      [
        { key: 1, width: 12, weight: 3 },
        { key: 2, width: 12, weight: 3 },
      ],
      hulls,
      LABEL_H,
      MARGIN,
    )
    expect(out).toHaveLength(2)
    expect(out.every((p) => !p.fallback)).toBe(true)
    expect(overlap(out[0]!.box, out[1]!.box)).toBe(false)
  })

  it('keeps a label out of a different cluster hull that covers its default spot', () => {
    // A big hull B blankets the area above small hull A; A must drop below B.
    const hulls = new Map<number, Pt[]>([
      [1, sq(0, 0, 10, 10)],
      [2, sq(-50, -50, 60, 5)],
    ])
    const [placed] = placeRegionLabels([{ key: 1, width: 6, weight: 3 }], hulls, LABEL_H, MARGIN)
    expect(placed!.fallback).toBe(false)
    expect(boxIntersectsPolygon(placed!.box, hulls.get(2)!)).toBe(false)
  })

  it('escapes a hull that encloses it by walking outward to a clear position', () => {
    // Small hull A embedded inside a large hull B: the ring search must step the label past
    // B rather than leaving it buried (the #aav-inside-biomedical case).
    const hulls = new Map<number, Pt[]>([
      [1, sq(-5, -5, 5, 5)],
      [2, sq(-100, -100, 100, 100)],
    ])
    const [placed] = placeRegionLabels([{ key: 1, width: 6, weight: 3 }], hulls, LABEL_H, MARGIN)
    expect(placed!.fallback).toBe(false)
    expect(boxIntersectsPolygon(placed!.box, hulls.get(2)!)).toBe(false)
  })

  it('places heavier clusters first (deterministic order)', () => {
    const hulls = new Map<number, Pt[]>([
      [1, sq(0, 0, 10, 10)],
      [2, sq(100, 0, 110, 10)],
    ])
    const out = placeRegionLabels(
      [
        { key: 1, width: 6, weight: 2 },
        { key: 2, width: 6, weight: 9 },
      ],
      hulls,
      LABEL_H,
      MARGIN,
    )
    expect(out[0]!.key).toBe(2) // the weight-9 cluster is positioned first
  })
})
