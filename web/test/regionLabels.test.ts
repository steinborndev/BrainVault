import { describe, it, expect } from 'vitest'
import {
  pointInPolygon,
  boxIntersectsPolygon,
  placeRegionLabels,
  hullBody,
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

describe('hullBody', () => {
  it('drops a far spatial outlier from a compact cluster (the cross-domain-entity case)', () => {
    // Four members bunched near the origin + one flung far right (a shared entity the layout
    // pulled toward another cluster). The tongue toward it must not be part of the hull.
    const body: Pt[] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]
    const withOutlier: Pt[] = [...body, [400, 5]]
    const trimmed = hullBody(withOutlier)
    expect(trimmed).toHaveLength(4)
    expect(trimmed).not.toContainEqual([400, 5])
  })

  it('keeps a genuinely elongated cluster intact (no false outlier)', () => {
    const line: Pt[] = [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
      [40, 0],
    ]
    expect(hullBody(line)).toHaveLength(5) // spread is uniform — nothing is an outlier
  })

  it('leaves small clusters (< 5) untouched — too few to tell a body from a corner', () => {
    const pts: Pt[] = [
      [0, 0],
      [1, 1],
      [200, 200],
      [2, 0],
    ]
    expect(hullBody(pts)).toHaveLength(4)
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

  it('anchors the label near the hull edge, not the bounding-box corner', () => {
    // A diamond (rotated square): its bounding box is much larger than the hull along the
    // diagonals. The label goes straight up, so its bottom should sit just past the TOP
    // VERTEX (y=-10), not out at some bounding-box-inflated distance.
    const diamond: Pt[] = [
      [0, -10],
      [10, 0],
      [0, 10],
      [-10, 0],
    ]
    const [placed] = placeRegionLabels([{ key: 1, width: 6, weight: 3 }], new Map([[1, diamond]]), LABEL_H, MARGIN)
    expect(placed!.fallback).toBe(false)
    // Bottom of the label box is just above the top vertex + margin, not far above it.
    expect(placed!.box[3]).toBeLessThanOrEqual(-10)
    expect(placed!.box[3]).toBeGreaterThan(-10 - LABEL_H - MARGIN - 0.001)
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
