/**
 * The graph's entrance (2026-08-27).
 *
 * Opening the Graph tab used to draw every frame the layout worker posted, at the identity
 * transform, and fit the camera exactly once - on the first settled frame. On a vault of a
 * few hundred pages that meant roughly a second and a half of a quarter of the graph filling
 * the canvas and visibly moving, followed by a single hard cut to the fitted frame.
 *
 * What replaces it: the canvas draws NOTHING while the first layout is cooling, and once
 * there is a settled frame it fits and then builds the graph out of itself - the most
 * connected pages land first, the rest fill in behind them, links fade up once both their
 * ends exist. Nothing ever moves; the entrance is made of appearance alone, which is what
 * makes it safe to watch and cheap to draw.
 *
 * The order carries information rather than decorating: hubs first is the shape of the vault
 * stated in the order it is drawn.
 *
 * Pure functions, no clock of their own - the caller owns the timestamps, so the reveal is
 * testable without a canvas or a frame loop.
 */

/** How long the whole entrance takes. */
export const REVEAL_MS = 780

/**
 * The share of that spent staggering hubs ahead of the tail; the remainder is how long one
 * node's own fade lasts. At 0 every node fades together, at 1 the last node has no fade left
 * at all - it appears at the final instant.
 */
export const REVEAL_STAGGER = 0.55

/**
 * Labels join at the end. The collision solver has nothing stable to place against while
 * nodes are still arriving, and forty titles popping in mid-reveal is its own flicker.
 */
export const LABEL_ENTER_AT = 0.65

/**
 * A blank canvas needs a way out. If the worker never reports a settled frame, the hold
 * releases anyway and the entrance runs on whatever positions exist.
 */
export const REVEAL_HOLD_MAX_MS = 4000

/**
 * Reveal order, hubs first: `rank[i]` is where node `i` sits in the queue, 0 for the most
 * connected page and 1 for the least. Ties break on index, so the order is deterministic -
 * two builds over the same graph reveal it identically.
 */
export function revealOrder(degrees: readonly number[]): Float32Array {
  const order = degrees.map((_, i) => i)
  order.sort((a, b) => (degrees[b] ?? 0) - (degrees[a] ?? 0) || a - b)
  const rank = new Float32Array(degrees.length)
  const last = Math.max(1, degrees.length - 1)
  for (let place = 0; place < order.length; place++) rank[order[place]!] = place / last
  return rank
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

/** Cubic ease-out: fast in, settled at the end - an arrival, not a linear ramp. */
const easeOut = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3)

/**
 * How present node `rank` is at overall progress `t`. Its own fade starts at
 * `rank * stagger` and runs for the rest of the clock, so every node fades for the same
 * duration and the queue is what separates them.
 */
export function revealAlpha(t: number, rank: number, stagger = REVEAL_STAGGER): number {
  const span = Math.max(0.001, 1 - stagger)
  return easeOut((clamp01(t) - clamp01(rank) * stagger) / span)
}

/**
 * A node grows into its radius as it fades in. Purely visual: it scales the drawn circle,
 * never the hit target or the label anchor.
 *
 * No overshoot. The first version bounced past the radius and back, which on a circle of
 * three to eight pixels came to a fraction of a pixel - invisible, and one more thing to get
 * wrong. The fade is what carries the arrival; the growth only keeps a node from appearing
 * at full size out of nothing.
 */
export function revealPop(alpha: number): number {
  return 0.6 + 0.4 * clamp01(alpha)
}

/** How present the label pass is at overall progress `t`. */
export function revealLabelAlpha(t: number): number {
  return clamp01((clamp01(t) - LABEL_ENTER_AT) / (1 - LABEL_ENTER_AT))
}
