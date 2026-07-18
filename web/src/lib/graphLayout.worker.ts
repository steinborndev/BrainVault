/**
 * Force-layout worker for the vault graph (SPEC.md §12.4). The d3-force simulation runs
 * entirely off the UI thread — the page stays responsive while the layout "warms up", which
 * is exactly the failure mode of Obsidian's graph under WSLg that this view replaces.
 *
 * Protocol:
 *   in : { nodes: Array<{ degree: number }>, edges: Array<[number, number]> }
 *   out: { type: 'tick' | 'done', positions: Float32Array }  // [x0, y0, x1, y1, …]
 *
 * The simulation cools and STOPS (alphaMin) — no perpetual ticking, no idle CPU burn.
 * Positions are posted as transferable buffers every few ticks, so even a large layout
 * animates smoothly without flooding the main thread.
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
  nodes: Array<{ degree: number }>
  edges: Array<[number, number]>
}

interface SimNode extends SimulationNodeDatum {
  index: number
  degree: number
}

self.onmessage = (ev: MessageEvent<LayoutRequest>) => {
  const { nodes, edges } = ev.data

  const simNodes: SimNode[] = nodes.map((n, i) => ({ index: i, degree: n.degree }))
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
    .stop()

  const positions = (): Float32Array => {
    const out = new Float32Array(simNodes.length * 2)
    simNodes.forEach((n, i) => {
      out[i * 2] = n.x ?? 0
      out[i * 2 + 1] = n.y ?? 0
    })
    return out
  }

  // Tick synchronously in batches; post intermediate frames so the warm-up is visible.
  const BATCH = 5
  while (sim.alpha() > sim.alphaMin()) {
    for (let i = 0; i < BATCH && sim.alpha() > sim.alphaMin(); i++) sim.tick()
    const buf = positions()
    self.postMessage({ type: 'tick', positions: buf }, { transfer: [buf.buffer] })
  }
  const finalBuf = positions()
  self.postMessage({ type: 'done', positions: finalBuf }, { transfer: [finalBuf.buffer] })
}
