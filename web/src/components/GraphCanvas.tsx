/**
 * Canvas renderer for the vault graph (SPEC.md §12.4). Canvas 2D, not SVG — an SVG DOM node
 * per page is exactly what makes graph views fall over as a vault grows; a single canvas
 * draws tens of thousands of nodes without breaking a sweat. Layout comes from the d3-force
 * web worker (lib/graphLayout.worker.ts), so the UI thread only ever draws.
 *
 * Scale-mindedness, deliberately built in from the start (the vault will keep growing):
 *   - label level-of-detail: at low zoom only hub labels draw, zooming in reveals the rest
 *   - viewport culling: off-screen nodes/labels are skipped
 *   - the simulation cools and stops; re-layout only when the node set actually changes
 *   - hover/click hit-testing is O(n) over a typed array — fine far beyond 10k nodes
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import type { GraphNode } from '../api/types.ts'

export interface GraphCanvasProps {
  nodes: GraphNode[]
  /** Directed [from, to] index pairs into `nodes`. */
  edges: Array<[number, number]>
  /** Index of the focused/selected node, or null. */
  focusIndex: number | null
  /** Indices matching the current search, highlighted. */
  matches: ReadonlySet<number>
  onSelect: (node: GraphNode) => void
}

/** Bucket → CSS variable. Falls back to --muted for unknown buckets. */
const TYPE_VARS: Record<string, string> = {
  concepts: '--accent',
  entities: '--ok',
  sources: '--warn',
  meta: '--muted',
  root: '--busy',
  questions: '--err',
}

interface Transform {
  x: number
  y: number
  k: number
}

export function GraphCanvas({ nodes, edges, focusIndex, matches, onSelect }: GraphCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const positionsRef = useRef<Float32Array>(new Float32Array(0))
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const [hover, setHover] = useState<number | null>(null)
  const hoverRef = useRef<number | null>(null)
  hoverRef.current = hover
  const [layouting, setLayouting] = useState(false)

  // Neighbor sets for hover highlighting (undirected view of the directed edges).
  const neighbors = useMemo(() => {
    const map = new Map<number, Set<number>>()
    for (const [a, b] of edges) {
      if (!map.has(a)) map.set(a, new Set())
      if (!map.has(b)) map.set(b, new Set())
      map.get(a)!.add(b)
      map.get(b)!.add(a)
    }
    return map
  }, [edges])

  const radius = useCallback(
    (i: number): number => {
      const n = nodes[i]
      if (!n) return 3
      return 3 + Math.min(9, Math.sqrt(n.in + n.out) * 1.1)
    },
    [nodes],
  )

  /** One draw pass. Reads CSS variables live, so light/dark theme switches just work. */
  const draw = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const pos = positionsRef.current
    const t = transformRef.current
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr

    const styles = getComputedStyle(document.documentElement)
    const cssVar = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
    const colorFor = (type: string): string => cssVar(TYPE_VARS[type] ?? '--muted', '#888')
    const edgeColor = cssVar('--border', '#444')
    const textColor = cssVar('--text-dim', '#aaa')

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.translate(w / 2 + t.x, h / 2 + t.y)
    ctx.scale(t.k, t.k)

    if (pos.length < nodes.length * 2) return

    const hovered = hoverRef.current
    const highlight =
      hovered !== null ? new Set([hovered, ...(neighbors.get(hovered) ?? [])]) : focusIndex !== null ? new Set([focusIndex, ...(neighbors.get(focusIndex) ?? [])]) : null

    // Visible world-rect for culling (small margin for radii/labels).
    const margin = 40 / t.k
    const minX = (-w / 2 - t.x) / t.k - margin
    const maxX = (w / 2 - t.x) / t.k + margin
    const minY = (-h / 2 - t.y) / t.k - margin
    const maxY = (h / 2 - t.y) / t.k + margin
    const visible = (x: number, y: number): boolean => x >= minX && x <= maxX && y >= minY && y <= maxY

    // Edges first, faint; highlighted edges stronger.
    ctx.lineWidth = 1 / t.k
    for (const [a, b] of edges) {
      const x1 = pos[a * 2]!
      const y1 = pos[a * 2 + 1]!
      const x2 = pos[b * 2]!
      const y2 = pos[b * 2 + 1]!
      if (!visible(x1, y1) && !visible(x2, y2)) continue
      const lit = highlight !== null && highlight.has(a) && highlight.has(b)
      ctx.strokeStyle = edgeColor
      ctx.globalAlpha = highlight === null ? 0.35 : lit ? 0.9 : 0.08
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
    }

    // Nodes.
    for (let i = 0; i < nodes.length; i++) {
      const x = pos[i * 2]!
      const y = pos[i * 2 + 1]!
      if (!visible(x, y)) continue
      const r = radius(i)
      const dimmed = highlight !== null && !highlight.has(i)
      ctx.globalAlpha = dimmed ? 0.18 : 1
      ctx.fillStyle = colorFor(nodes[i]!.type)
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      if (i === focusIndex || matches.has(i)) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = cssVar('--text', '#fff')
        ctx.lineWidth = 1.6 / t.k
        ctx.beginPath()
        ctx.arc(x, y, r + 2.5 / t.k, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // Labels with level-of-detail: hubs always (top by degree), everything from zoom 1.4,
    // hovered/focused/matched always. Font size is screen-constant.
    const labelAll = t.k >= 1.4
    const hubDegree = labelAll ? 0 : hubThreshold(nodes)
    ctx.font = `${11 / t.k}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      const wanted =
        labelAll || n.in + n.out >= hubDegree || i === hoverRef.current || i === focusIndex || matches.has(i)
      if (!wanted) continue
      const x = pos[i * 2]!
      const y = pos[i * 2 + 1]!
      if (!visible(x, y)) continue
      const dimmed = highlight !== null && !highlight.has(i)
      ctx.globalAlpha = dimmed ? 0.15 : 0.95
      ctx.fillStyle = textColor
      ctx.fillText(n.title, x, y + radius(i) + 3 / t.k)
    }
    ctx.globalAlpha = 1
  }, [nodes, edges, focusIndex, matches, neighbors, radius])

  const scheduleDraw = useRafDraw(draw)
  const fittedRef = useRef(false)
  /** Set once the user pans/zooms, so an automatic re-fit never yanks the view away. */
  const userMovedRef = useRef(false)

  /** Centers and scales the transform so the whole layout fits with a small margin. */
  const fitToView = useCallback((): void => {
    const canvas = canvasRef.current
    const pos = positionsRef.current
    if (!canvas || pos.length < 2) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr
    // Robust bounds: a handful of disconnected pages drift far from the core, and fitting
    // to absolute min/max would shrink the cluster everyone actually looks at to a speck.
    // The 5th–95th percentile frames the body of the graph; stragglers stay reachable by panning.
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < pos.length; i += 2) {
      xs.push(pos[i]!)
      ys.push(pos[i + 1]!)
    }
    xs.sort((a, b) => a - b)
    ys.sort((a, b) => a - b)
    const lo = (arr: number[]): number => arr[Math.floor(arr.length * 0.05)]!
    const hi = (arr: number[]): number => arr[Math.min(arr.length - 1, Math.ceil(arr.length * 0.95))]!
    const minX = lo(xs)
    const maxX = hi(xs)
    const minY = lo(ys)
    const maxY = hi(ys)
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const pad = 110 // room for the labels that sit around the rim
    const k = Math.min(8, Math.max(0.15, Math.min((w - pad) / spanX, (h - pad) / spanY)))
    transformRef.current = {
      k,
      x: -((minX + maxX) / 2) * k,
      y: -((minY + maxY) / 2) * k,
    }
    scheduleDraw()
  }, [scheduleDraw])

  // Layout worker: restart when the node/edge set changes. Positions carry over by index
  // where the count matches (smooth filter transitions are not worth index-mapping).
  useEffect(() => {
    if (nodes.length === 0) {
      positionsRef.current = new Float32Array(0)
      scheduleDraw()
      return
    }
    setLayouting(true)
    fittedRef.current = false
    const worker = new Worker(new URL('../lib/graphLayout.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<{ type: 'tick' | 'done'; positions: Float32Array }>) => {
      positionsRef.current = ev.data.positions
      if (ev.data.type === 'done') {
        setLayouting(false)
        // Frame the finished layout once, so a graph of any size lands filling the
        // viewport instead of as a speck (or spilling past the edges).
        if (!fittedRef.current) {
          fittedRef.current = true
          fitToView()
        }
      }
      scheduleDraw()
    }
    worker.postMessage({
      nodes: nodes.map((n) => ({ degree: n.in + n.out })),
      edges,
    })
    return () => {
      worker.terminate()
      setLayouting(false)
    }
  }, [nodes, edges, scheduleDraw, fitToView])

  // Canvas sizing (device-pixel aware) + redraw on resize and theme change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement!
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = parent.clientWidth * dpr
      canvas.height = parent.clientHeight * dpr
      canvas.style.width = `${parent.clientWidth}px`
      canvas.style.height = `${parent.clientHeight}px`
      // Re-frame on resize (including the first layout pass, which lands before the
      // element has its final size) — but never fight a user who has panned or zoomed.
      if (fittedRef.current && !userMovedRef.current) fitToView()
      else scheduleDraw()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = (): void => scheduleDraw()
    mq.addEventListener('change', onTheme)
    return () => {
      ro.disconnect()
      mq.removeEventListener('change', onTheme)
    }
  }, [scheduleDraw, fitToView])

  /** Screen → world coordinates under the current transform. */
  const toWorld = useCallback((sx: number, sy: number): { x: number; y: number } => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    return {
      x: (sx - rect.left - rect.width / 2 - t.x) / t.k,
      y: (sy - rect.top - rect.height / 2 - t.y) / t.k,
    }
  }, [])

  const hitTest = useCallback(
    (sx: number, sy: number): number | null => {
      const pos = positionsRef.current
      if (pos.length < nodes.length * 2) return null
      const { x, y } = toWorld(sx, sy)
      const slop = 6 / transformRef.current.k
      let best: number | null = null
      let bestD = Infinity
      for (let i = 0; i < nodes.length; i++) {
        const dx = pos[i * 2]! - x
        const dy = pos[i * 2 + 1]! - y
        const d = dx * dx + dy * dy
        const r = radius(i) + slop
        if (d < r * r && d < bestD) {
          best = i
          bestD = d
        }
      }
      return best
    },
    [nodes, radius, toWorld],
  )

  // Pointer events cover mouse AND touch: drag to pan, wheel/pinch to zoom, click to select.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  const onPointerDown = (e: React.PointerEvent): void => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (drag.current) {
      const dx = e.clientX - drag.current.x
      const dy = e.clientY - drag.current.y
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true
      transformRef.current.x += dx
      transformRef.current.y += dy
      userMovedRef.current = true
      drag.current.x = e.clientX
      drag.current.y = e.clientY
      scheduleDraw()
      return
    }
    const hit = hitTest(e.clientX, e.clientY)
    if (hit !== hoverRef.current) {
      setHover(hit)
      scheduleDraw()
    }
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const wasDrag = drag.current?.moved ?? false
    drag.current = null
    if (!wasDrag) {
      const hit = hitTest(e.clientX, e.clientY)
      if (hit !== null) onSelect(nodes[hit]!)
    }
  }
  const onWheel = (e: React.WheelEvent): void => {
    const t = transformRef.current
    const factor = Math.exp(-e.deltaY * 0.0015)
    const next = Math.min(8, Math.max(0.15, t.k * factor))
    // Zoom around the cursor: keep the world point under the pointer fixed.
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left - rect.width / 2
    const cy = e.clientY - rect.top - rect.height / 2
    t.x = cx - ((cx - t.x) / t.k) * next
    t.y = cy - ((cy - t.y) / t.k) * next
    t.k = next
    userMovedRef.current = true
    scheduleDraw()
  }

  return (
    <div className="graph-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (hoverRef.current !== null) {
            setHover(null)
            scheduleDraw()
          }
        }}
        onWheel={onWheel}
        role="img"
        aria-label={`Wikilink-Graph mit ${nodes.length} Seiten`}
        style={{ cursor: hover !== null ? 'pointer' : drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
      />
      <div className="graph-controls">
        <button
          className="btn ghost"
          onClick={() => {
            userMovedRef.current = false
            fitToView()
          }}
          title="Ansicht einpassen"
        >
          Einpassen
        </button>
      </div>
      {layouting && <div className="graph-status">Layout läuft…</div>}
      {hover !== null && nodes[hover] && <div className="graph-tooltip">{nodes[hover]!.title}</div>}
    </div>
  )
}

/** Degree above which a node counts as a hub (labelled even when zoomed out): top ~8 %. */
function hubThreshold(nodes: GraphNode[]): number {
  if (nodes.length === 0) return 0
  const degrees = nodes.map((n) => n.in + n.out).sort((a, b) => b - a)
  return Math.max(3, degrees[Math.floor(nodes.length * 0.08)] ?? 3)
}

/** Coalesces draw requests into one per animation frame. */
function useRafDraw(draw: () => void): () => void {
  const pending = useRef(false)
  const drawRef = useRef(draw)
  drawRef.current = draw
  return useCallback((): void => {
    if (pending.current) return
    pending.current = true
    requestAnimationFrame(() => {
      pending.current = false
      drawRef.current()
    })
  }, [])
}
