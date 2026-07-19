/**
 * Force-layout worker for the vault graph (SPEC.md §12.4). The d3-force simulation runs
 * entirely off the UI thread — the page stays responsive while the layout "warms up", which
 * is exactly the failure mode of Obsidian's graph under WSLg that this view replaces.
 *
 * Protocol (one long-lived worker per canvas mount, layouts are replaceable in flight):
 *   in : { gen, nodes: Array<{ degree: number }>, edges: Array<[number, number]>,
 *          seed: Float32Array,   // [x0, y0, …]; NaN pairs = unplaced, d3 places them
 *          alpha: number }       // 1 = cold start, ~0.3 = gentle reheat of a live layout
 *   out: { gen, type: 'tick' | 'done', positions: Float32Array }
 *
 * `gen` (generation) ties every outgoing frame to the request that produced it — the main
 * thread bumps it per layout and drops stale frames, so a superseded layout can never
 * scribble over a newer one.
 *
 * Ticking is timer-sliced, NOT a blocking while-loop: between batches the worker yields to
 * its message queue, so a new layout request (live vault update mid-ingest, filter toggle)
 * interrupts the current one immediately. The simulation still cools and STOPS (alphaMin)
 * — no perpetual ticking, no idle CPU burn.
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force'

interface LayoutRequest {
  gen: number
  nodes: Array<{ degree: number }>
  edges: Array<[number, number]>
  seed: Float32Array
  alpha: number
}

interface SimNode extends SimulationNodeDatum {
  index: number
  degree: number
}

let timer: ReturnType<typeof setTimeout> | undefined

self.onmessage = (ev: MessageEvent<LayoutRequest>) => {
  const { gen, nodes, edges, seed, alpha } = ev.data

  // A new request supersedes whatever is still cooling.
  if (timer !== undefined) clearTimeout(timer)

  const simNodes: SimNode[] = nodes.map((n, i) => {
    const node: SimNode = { index: i, degree: n.degree }
    const x = seed[i * 2]
    const y = seed[i * 2 + 1]
    // Seeded nodes keep their place (live update / filter toggle); unseeded ones are left
    // undefined so d3's phyllotaxis initialization spreads them — except that the main
    // thread pre-seeds new nodes at their neighbors' centroid, so mid-ingest arrivals
    // surface where they belong instead of flying in from the origin.
    if (x !== undefined && y !== undefined && !Number.isNaN(x) && !Number.isNaN(y)) {
      node.x = x
      node.y = y
    }
    return node
  })
  const simLinks = edges.map(([source, target]) => ({ source, target }))

  const sim = forceSimulation(simNodes)
    .force('link', forceLink(simLinks).distance(60).strength(0.4))
    // Barnes-Hut approximation (theta default 0.9) keeps this O(n log n) at scale.
    .force('charge', forceManyBody().strength(-120).distanceMax(600))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide<SimNode>().radius((d) => 6 + Math.sqrt(d.degree) * 2))
    // Centering pull, stronger the fewer links a node has. Without this, orphan and
    // near-orphan pages have nothing but repulsion acting on them and drift far outside
    // the cluster — which then blows up the bounding box and makes fit-to-view useless.
    .force('x', forceX<SimNode>(0).strength((d) => (d.degree === 0 ? 0.5 : d.degree < 3 ? 0.15 : 0.05)))
    .force('y', forceY<SimNode>(0).strength((d) => (d.degree === 0 ? 0.5 : d.degree < 3 ? 0.15 : 0.05)))
    .alpha(alpha)
    .stop()

  const positions = (): Float32Array => {
    const out = new Float32Array(simNodes.length * 2)
    simNodes.forEach((n, i) => {
      out[i * 2] = n.x ?? 0
      out[i * 2 + 1] = n.y ?? 0
    })
    return out
  }

  // Tick in batches; post intermediate frames so the warm-up (or the live re-settle) is
  // visible, then yield so an interrupting request gets through.
  const BATCH = 5
  const step = (): void => {
    for (let i = 0; i < BATCH && sim.alpha() > sim.alphaMin(); i++) sim.tick()
    const buf = positions()
    if (sim.alpha() > sim.alphaMin()) {
      self.postMessage({ gen, type: 'tick', positions: buf }, { transfer: [buf.buffer] })
      timer = setTimeout(step, 0)
    } else {
      timer = undefined
      self.postMessage({ gen, type: 'done', positions: buf }, { transfer: [buf.buffer] })
    }
  }
  step()
}
