/**
 * The vault as a shape: every page a dot, every wikilink a line, domains as clusters
 * (Home's zone 1, redesign pass 2026-08-26).
 *
 * It is the Graph tab's picture without the Graph tab's instrument. There is no zoom, no
 * pan, no hover read-out and no lens - a portrait, not a tool. What can be counted is
 * stated as text beside it, because nothing here is measurable off the picture: a force
 * layout says "these belong together", never "this one is 12% bigger".
 *
 * It reuses the Graph tab's own layout worker (lib/graphLayout.worker.ts), so the clusters
 * that emerge here are the same clusters the Graph tab shows - one arrangement of the
 * vault, not two that disagree. What it does NOT reuse is GraphCanvas: that module carries
 * d3-force into whatever imports it, and Home is the first screen the app renders. The
 * domain grouping the worker needs is five lines, so it is computed here instead.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GraphNode } from '../api/types.ts'
import { TYPE_VARS } from '../lib/domains.ts'

interface WorkerFrame {
  gen: number
  type: 'tick' | 'done'
  positions: Float32Array
}

/** Padding inside the canvas, in device-independent pixels, so no dot touches the edge. */
const FIT_PAD = 14

/** Domain → group id, the shape the worker's group forces expect (-1 = no domain). */
function groupsOf(nodes: readonly GraphNode[]): Int32Array {
  const ids = new Map<string, number>()
  const out = new Int32Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const d = nodes[i]?.domain ?? null
    if (d === null) {
      out[i] = -1
      continue
    }
    let id = ids.get(d)
    if (id === undefined) {
      id = ids.size
      ids.set(d, id)
    }
    out[i] = id
  }
  return out
}

export function VaultConstellation({
  nodes,
  edges,
  onOpen,
}: {
  nodes: readonly GraphNode[]
  edges: ReadonlyArray<readonly [number, number]>
  /** Click anywhere on the picture - it is a door to the Graph tab, and says so. */
  onOpen: () => void
}): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const posRef = useRef<Float32Array>(new Float32Array(0))
  const workerRef = useRef<Worker | null>(null)
  const genRef = useRef(0)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [settled, setSettled] = useState(false)

  // ---------------------------------------------------------------- draw
  const draw = (): void => {
    const canvas = canvasRef.current
    const pos = posRef.current
    if (canvas === null || pos.length === 0 || size.w === 0 || size.h === 0) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const styles = getComputedStyle(document.documentElement)
    const cssVar = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback

    // Fit the whole layout into the tile every frame: the simulation expands while it cools,
    // and a fixed scale would let it grow straight out of the box.
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < nodes.length; i++) {
      const x = pos[i * 2]
      const y = pos[i * 2 + 1]
      if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (!Number.isFinite(minX)) return
    const fitX = (size.w - FIT_PAD * 2) / Math.max(1, maxX - minX)
    const fitY = (size.h - FIT_PAD * 2) / Math.max(1, maxY - minY)
    const scale = Math.min(fitX, fitY)
    // The layout settles roughly round while the tile is wide, so a uniform fit leaves a
    // third of the box empty. x is allowed to take some of that back, capped at 1.25 so
    // clusters stay recognisably round - this is a portrait, and nothing is measured off it.
    const scaleX = Math.min(fitX, scale * 1.25)
    const offX = (size.w - (maxX - minX) * scaleX) / 2 - minX * scaleX
    const offY = (size.h - (maxY - minY) * scale) / 2 - minY * scale
    const sx = (i: number): number => (pos[i * 2] ?? 0) * scaleX + offX
    const sy = (i: number): number => (pos[i * 2 + 1] ?? 0) * scale + offY

    ctx.clearRect(0, 0, size.w, size.h)

    // Links first and faint. All 8k of them: a sampled picture would be a different vault,
    // and at this alpha the density itself is the information.
    ctx.strokeStyle = cssVar('--border-strong', '#30405f')
    ctx.globalAlpha = 0.3
    ctx.lineWidth = 0.4
    ctx.beginPath()
    for (const [a, b] of edges) {
      const ax = pos[a * 2]
      const bx = pos[b * 2]
      if (ax === undefined || bx === undefined || Number.isNaN(ax) || Number.isNaN(bx)) continue
      ctx.moveTo(sx(a), sy(a))
      ctx.lineTo(sx(b), sy(b))
    }
    ctx.stroke()
    ctx.globalAlpha = 1

    // Dots wear the page-kind tokens - the same blue for a concept as the Graph tab and the
    // Library use, so the colour means one thing across the app.
    const colorCache = new Map<string, string>()
    const colorFor = (type: string): string => {
      const hit = colorCache.get(type)
      if (hit !== undefined) return hit
      const c = cssVar(TYPE_VARS[type] ?? '--muted', '#888')
      colorCache.set(type, c)
      return c
    }
    // Dot radii are deliberately small. Eight hundred pages in a 460px box is about a dot
    // every fifteen pixels, so a hub at 4.6px and its neighbours at 3px merged into blobs
    // and a cluster read as one shape rather than as the many pages it is. Halved, the same
    // layout reads as a constellation - which is the only thing this picture claims to be.
    // The degree term still separates a hub from a leaf, just at a finer grain.
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (n === undefined) continue
      const x = sx(i)
      const y = sy(i)
      if (Number.isNaN(x) || Number.isNaN(y)) continue
      ctx.fillStyle = colorFor(n.type)
      ctx.beginPath()
      ctx.arc(x, y, 0.8 + Math.min(2.1, Math.sqrt(n.in + n.out) * 0.3), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ---------------------------------------------------------------- size
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null) return
    // Both dimensions come from the box: how tall the picture is a layout decision (the
    // zone sizes itself against the window), not something a caller passes in pixels.
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect()
      setSize({ w: Math.max(1, Math.round(rect.width)), h: Math.max(1, Math.round(rect.height)) })
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || size.w === 0 || size.h === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    canvas.style.width = `${size.w}px`
    canvas.style.height = `${size.h}px`
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw()
  })

  // ---------------------------------------------------------------- layout
  useEffect(() => {
    const worker = new Worker(new URL('../lib/graphLayout.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (ev: MessageEvent<WorkerFrame>) => {
      if (ev.data.gen !== genRef.current) return // a superseded layout must not scribble
      posRef.current = ev.data.positions
      if (ev.data.type === 'done') setSettled(true)
      draw()
    }
    return () => {
      worker.terminate()
      workerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One layout per node set. Re-runs when a live vault update changes the graph, seeded from
  // the positions already on screen so known pages keep their place instead of jumping.
  useEffect(() => {
    const worker = workerRef.current
    if (worker === null || nodes.length === 0) return
    const seed = new Float32Array(nodes.length * 2).fill(NaN)
    const prev = posRef.current
    if (prev.length === nodes.length * 2) seed.set(prev)
    genRef.current += 1
    setSettled(false)
    worker.postMessage({
      gen: genRef.current,
      nodes: nodes.map((n) => ({ degree: n.in + n.out })),
      edges: edges.map(([a, b]) => [a, b]),
      groups: groupsOf(nodes),
      seed,
      alpha: prev.length === nodes.length * 2 ? 0.35 : 1,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  // Theme switch repaints: the colours are read from CSS variables at draw time.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => draw()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  })

  return (
    <div className="constell" ref={wrapRef}>
      <button
        className="constell-hit"
        onClick={onOpen}
        title="Open the Graph tab"
        aria-label={`The vault as a graph: ${nodes.length} pages, ${edges.length} links. Opens the Graph tab.`}
      >
        <canvas ref={canvasRef} aria-hidden />
      </button>
      {!settled && nodes.length > 0 && <span className="constell-cap">settling…</span>}
    </div>
  )
}
