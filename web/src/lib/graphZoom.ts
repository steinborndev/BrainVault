/**
 * The wheel-zoom mechanics of the graph view (2026-09-05, "anchor and leash").
 *
 * The old mechanic kept the world point under the cursor fixed and nothing else: with the
 * cursor 100 px beside a cluster, every notch pushed the cluster another 16 % of that
 * distance away, and after five notches the picture was empty. Nothing bounded the pan
 * either, so the graph could be scrolled out of view entirely. Four rules replace it:
 *
 *   magnet   zooming IN aims at the cluster within reach, not at the cursor, until that
 *            cluster fills the picture - then the cursor takes over for fine work;
 *   leash    after every zoom and pan the graph's box and the viewport keep overlapping;
 *   tame     wheel deltas are normalized and capped, one notch is a smaller step;
 *   return   the view knows when no node is on screen and can offer the way back.
 *
 * Pure geometry over the canvas's own coordinate convention (screen = center + world * k +
 * offset), so the rules are unit-testable without a canvas. The component only adds the
 * animation frames and the DOM.
 */

export interface Transform {
  x: number
  y: number
  k: number
}

export interface Viewport {
  w: number
  h: number
}

export interface Bounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type Pt = [number, number]

/** One community as the magnet sees it: where its mass is, how big it is, where its edge is. */
export interface ClusterGeom {
  id: number
  /** Member positions, world units. */
  members: readonly Pt[]
  /** Hull polygon in world units (padded like the drawn one); empty when too few members. */
  hull: readonly Pt[]
  cx: number
  cy: number
  /** max(width, height) of the members' box, world units. */
  extent: number
}

export const ZOOM_MIN = 0.15
export const ZOOM_MAX = 8
/** Screen distance (px) within which a cluster attracts the zoom anchor. */
export const MAGNET_REACH_PX = 160
/**
 * The pull is full while the cluster's on-screen extent is below this fraction of the
 * shorter viewport side, and gone at twice it - coarse zooming targets clusters, fine
 * zooming inside a cluster obeys the cursor.
 */
export const MAGNET_FADE_AT = 0.35
/** Graph box and viewport must overlap by this fraction of the smaller one, per axis. */
export const LEASH_OVERLAP = 0.6
/** World padding around the graph's box before the leash applies. */
export const LEASH_PAD_WORLD = 40
/** One wheel event moves the zoom by at most this many pixels' worth. */
export const WHEEL_MAX_DELTA_PX = 120
/** exp(0.001 * 100) = 1.105 per 100 px, against 1.16 before. */
export const WHEEL_RATE = 0.001

export const clampK = (k: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k))

export function toScreen(t: Transform, vp: Viewport, wx: number, wy: number): { x: number; y: number } {
  return { x: vp.w / 2 + wx * t.k + t.x, y: vp.h / 2 + wy * t.k + t.y }
}

export function toWorld(t: Transform, vp: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - vp.w / 2 - t.x) / t.k, y: (sy - vp.h / 2 - t.y) / t.k }
}

/** Scales to `next`, keeping the world point under canvas coords (sx, sy) fixed. In place. */
export function zoomAt(t: Transform, vp: Viewport, sx: number, sy: number, next: number): Transform {
  const cx = sx - vp.w / 2
  const cy = sy - vp.h / 2
  t.x = cx - ((cx - t.x) / t.k) * next
  t.y = cy - ((cy - t.y) / t.k) * next
  t.k = next
  return t
}

/**
 * A wheel event's vertical delta in pixels, capped. Line mode (Firefox with a mouse) and
 * page mode are scaled to pixels first; a high-resolution wheel or a flick that reports a
 * huge delta is cut to WHEEL_MAX_DELTA_PX, so one event can never be more than about one
 * and a half notches.
 */
export function normalizeWheel(deltaY: number, deltaMode: number, viewportH: number): number {
  let dy = deltaY
  if (deltaMode === 1) dy *= 16
  else if (deltaMode === 2) dy *= viewportH
  return Math.max(-WHEEL_MAX_DELTA_PX, Math.min(WHEEL_MAX_DELTA_PX, dy))
}

/** The zoom factor for a (normalized) wheel delta; wheel up (negative) zooms in. */
export const wheelFactor = (dyPx: number): number => Math.exp(-dyPx * WHEEL_RATE)

/** Bounding box of the placed nodes, or null when nothing is placed. NaN = unplaced. */
export function worldBounds(positions: ArrayLike<number>): Bounds | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const x = positions[i]!
    if (Number.isNaN(x)) continue
    const y = positions[i + 1]!
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 }
}

/**
 * The leash: corrects `t` in place so the graph's (padded) box and the viewport overlap by
 * LEASH_OVERLAP of the smaller of the two, per axis. Zoomed far in, the picture stays inside
 * the graph; zoomed out, the graph stays inside the picture. An empty picture is impossible
 * either way - the sparse zone BETWEEN two clusters excepted, which the return rule covers.
 */
export function leash(t: Transform, vp: Viewport, bounds: Bounds | null): Transform {
  if (bounds === null) return t
  const pad = LEASH_PAD_WORLD * t.k
  const a = toScreen(t, vp, bounds.x0, bounds.y0)
  const b = toScreen(t, vp, bounds.x1, bounds.y1)
  const fix = (lo: number, hi: number, view: number): number => {
    const need = LEASH_OVERLAP * Math.min(hi - lo, view)
    const overlap = Math.min(hi, view) - Math.max(lo, 0)
    if (overlap >= need) return 0
    const deficit = need - overlap
    // The box is drifting off the side its center is nearer to; pull it back the other way.
    return lo + hi < view ? deficit : -deficit
  }
  t.x += fix(a.x - pad, b.x + pad, vp.w)
  t.y += fix(a.y - pad, b.y + pad, vp.h)
  return t
}

function pointInPolygon(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!
    const [xj, yj] = poly[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export interface Anchor {
  /** Canvas coords of the point the zoom keeps fixed. */
  x: number
  y: number
  /** 0 = the cursor itself, 1 = the cluster's center. */
  weight: number
  clusterId: number | null
}

/** How much a cluster of this on-screen extent still attracts the anchor. */
function fadeFor(extentWorld: number, k: number, vp: Viewport): number {
  const lim = MAGNET_FADE_AT * Math.min(vp.w, vp.h)
  const onScreen = extentWorld * k
  return Math.max(0, Math.min(1, 1 - (onScreen - lim) / lim))
}

/**
 * The magnet: where a zoom-in from canvas point (sx, sy) actually aims.
 *
 * Inside a cluster's hull the pull is full; outside, it falls off linearly to nothing at
 * MAGNET_REACH_PX from the cluster's nearest member. The strongest pull wins. The pull
 * then fades with the cluster's on-screen size (fadeFor) so that a cluster which already
 * fills the picture leaves the anchor at the cursor: at that point the user is choosing a
 * spot INSIDE the cluster, and taking that choice away would be the old bug in reverse.
 */
export function magnetAnchor(t: Transform, vp: Viewport, sx: number, sy: number, clusters: readonly ClusterGeom[]): Anchor {
  const cursor = toWorld(t, vp, sx, sy)
  let best: { c: ClusterGeom; w: number } | null = null
  for (const c of clusters) {
    let w: number
    if (c.hull.length >= 3 && pointInPolygon(cursor.x, cursor.y, c.hull)) w = 1
    else {
      let d = Infinity
      for (const [mx, my] of c.members) {
        const s = toScreen(t, vp, mx, my)
        const dd = Math.hypot(s.x - sx, s.y - sy)
        if (dd < d) d = dd
      }
      if (d >= MAGNET_REACH_PX) continue
      w = 1 - d / MAGNET_REACH_PX
    }
    if (best === null || w > best.w) best = { c, w }
  }
  if (best === null) return { x: sx, y: sy, weight: 0, clusterId: null }
  const weight = best.w * fadeFor(best.c.extent, t.k, vp)
  const g = toScreen(t, vp, best.c.cx, best.c.cy)
  return { x: sx + (g.x - sx) * weight, y: sy + (g.y - sy) * weight, weight, clusterId: weight > 0 ? best.c.id : null }
}

/**
 * The magnet without communities: the proximity-weighted center of the nodes within reach,
 * fading with THEIR on-screen extent. Same feel, no hull to be inside of.
 */
export function localAnchor(t: Transform, vp: Viewport, sx: number, sy: number, positions: ArrayLike<number>): Anchor {
  let sw = 0
  let ax = 0
  let ay = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const wx = positions[i]!
    if (Number.isNaN(wx)) continue
    const wy = positions[i + 1]!
    const s = toScreen(t, vp, wx, wy)
    const d = Math.hypot(s.x - sx, s.y - sy)
    if (d >= MAGNET_REACH_PX) continue
    const w = (1 - d / MAGNET_REACH_PX) ** 2
    sw += w
    ax += s.x * w
    ay += s.y * w
    if (wx < x0) x0 = wx
    if (wx > x1) x1 = wx
    if (wy < y0) y0 = wy
    if (wy > y1) y1 = wy
  }
  if (sw === 0) return { x: sx, y: sy, weight: 0, clusterId: null }
  const weight = fadeFor(Math.max(x1 - x0, y1 - y0), t.k, vp)
  return { x: sx + (ax / sw - sx) * weight, y: sy + (ay / sw - sy) * weight, weight, clusterId: null }
}

/** How many placed nodes fall inside the viewport, and how many are placed at all. */
export function visibleNodes(t: Transform, vp: Viewport, positions: ArrayLike<number>): { placed: number; inView: number } {
  let placed = 0
  let inView = 0
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const wx = positions[i]!
    if (Number.isNaN(wx)) continue
    placed++
    const s = toScreen(t, vp, wx, positions[i + 1]!)
    if (s.x >= 0 && s.x <= vp.w && s.y >= 0 && s.y <= vp.h) inView++
  }
  return { placed, inView }
}

/** True when the whole (placed) graph fits inside the viewport - nothing to navigate to. */
export function fullyInView(t: Transform, vp: Viewport, bounds: Bounds | null): boolean {
  if (bounds === null) return true
  const a = toScreen(t, vp, bounds.x0, bounds.y0)
  const b = toScreen(t, vp, bounds.x1, bounds.y1)
  return a.x >= 0 && a.y >= 0 && b.x <= vp.w && b.y <= vp.h
}

/**
 * The world point the "go to nearest cluster" return heads for: the nearest cluster center
 * to the viewport's center, or - without communities - the nearest placed node.
 */
export function nearestMass(
  t: Transform,
  vp: Viewport,
  clusters: readonly ClusterGeom[],
  positions: ArrayLike<number>,
): { x: number; y: number } | null {
  const c0 = toWorld(t, vp, vp.w / 2, vp.h / 2)
  let best: { x: number; y: number } | null = null
  let bd = Infinity
  if (clusters.length > 0) {
    for (const c of clusters) {
      const d = Math.hypot(c.cx - c0.x, c.cy - c0.y)
      if (d < bd) {
        bd = d
        best = { x: c.cx, y: c.cy }
      }
    }
    return best
  }
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const wx = positions[i]!
    if (Number.isNaN(wx)) continue
    const wy = positions[i + 1]!
    const d = Math.hypot(wx - c0.x, wy - c0.y)
    if (d < bd) {
      bd = d
      best = { x: wx, y: wy }
    }
  }
  return best
}

/** The offset that puts world point (wx, wy) at the viewport's center at the current scale. */
export function centerOn(t: Transform, wx: number, wy: number): { x: number; y: number } {
  return { x: -wx * t.k, y: -wy * t.k }
}
