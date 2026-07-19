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
 *
 * Live updates (SPEC.md §12.4): positions are keyed by page PATH, not by array index — the
 * server sorts nodes by path, so one new page shifts every index after it. When the node set
 * changes (vault SSE event mid-ingest, filter toggle, local mode), known pages keep their
 * place and the simulation re-heats gently instead of being thrown away; brand-new pages
 * appear at their neighbors' centroid and flash briefly. The camera NEVER moves on a live
 * update — auto-fit happens only on the very first layout.
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
  /** Node coloring axis: wiki bucket (`type`, default) or frontmatter meta-category (`domain`). */
  colorBy?: 'type' | 'domain'
  /**
   * Changes whenever the CALLER changes the visible subgraph (domain/type filters, local
   * depth) — each change re-fits the view so the filtered graph fills the canvas again.
   * Live SSE updates leave this key alone, so mid-ingest arrivals still never move the camera.
   */
  fitKey?: string
  onSelect: (node: GraphNode) => void
  /** Extra UI rendered inside the canvas wrap (e.g. the search box, top-right). */
  overlay?: React.ReactNode
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

/**
 * Deterministic color for a domain: string hash → hue, fixed saturation/lightness that read
 * on both themes. Domains are open-ended (the user coins new ones), so a fixed palette can't
 * work — and hashing keeps a domain's color stable across sessions with zero bookkeeping.
 * Exported so the filter chips can wear the same color as their nodes (the legend).
 */
export function domainColor(domain: string): string {
  let h = 0
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 62% 52%)`
}

/** A layout with at least this share of never-placed nodes restarts cold instead of reheating. */
const COLD_RESTART_SHARE = 0.2
/** How long a newly appeared node flashes, ms. */
const FLASH_MS = 1600

interface Transform {
  x: number
  y: number
  k: number
}

interface WorkerFrame {
  gen: number
  type: 'tick' | 'done'
  positions: Float32Array
}

interface LayoutMsg {
  paths: string[]
  degrees: Array<{ degree: number }>
  edges: Array<[number, number]>
  seed: Float32Array
  alpha: number
}

/**
 * Camera + layout memory that OUTLIVES the component: the canvas unmounts on every
 * graph ↔ page-view switch, and refs die with it — which used to reset the user's zoom
 * and re-run the whole force layout each time. Module scope is safe because the app has
 * exactly one graph view.
 */
const persist = {
  /** Positions aligned with the CURRENT `nodes` prop, [x0, y0, x1, y1, …]; NaN = unplaced. */
  positions: { current: new Float32Array(0) as Float32Array },
  /** The persistent position memory, keyed by page path — index-stable across updates. */
  posByPath: { current: new Map<string, { x: number; y: number }>() },
  transform: { current: { x: 0, y: 0, k: 1 } as Transform },
  /** Set once the user pans/zooms, so an automatic re-fit never yanks the view away. */
  userMoved: { current: false },
  fitted: { current: false },
  /** The last posted layout, re-postable (remounts and StrictMode re-create the worker). */
  lastMsg: { current: null as LayoutMsg | null },
  /** True once the posted layout finished cooling — a remount then skips the replay. */
  settled: { current: true },
}

export function GraphCanvas({ nodes, edges, focusIndex, matches, colorBy = 'type', fitKey, onSelect, overlay }: GraphCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const positionsRef = persist.positions
  const posByPathRef = persist.posByPath
  /** Paths recently added to the view → timestamp, for the arrival flash. */
  const flashRef = useRef<Map<string, number>>(new Map())
  const transformRef = persist.transform
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
    const colorFor = (n: GraphNode): string =>
      colorBy === 'domain'
        ? n.domain !== null
          ? domainColor(n.domain)
          : cssVar('--muted', '#888')
        : cssVar(TYPE_VARS[n.type] ?? '--muted', '#888')
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

    // Edges first, faint; highlighted edges stronger. NaN endpoints (a node the worker
    // hasn't placed yet, mid live-update) simply don't draw this frame.
    ctx.lineWidth = 1 / t.k
    for (const [a, b] of edges) {
      const x1 = pos[a * 2]!
      const y1 = pos[a * 2 + 1]!
      const x2 = pos[b * 2]!
      const y2 = pos[b * 2 + 1]!
      if (Number.isNaN(x1) || Number.isNaN(x2)) continue
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
    const now = performance.now()
    let flashActive = false
    for (let i = 0; i < nodes.length; i++) {
      const x = pos[i * 2]!
      const y = pos[i * 2 + 1]!
      if (Number.isNaN(x)) continue
      if (!visible(x, y)) continue
      const r = radius(i)
      const dimmed = highlight !== null && !highlight.has(i)
      ctx.globalAlpha = dimmed ? 0.18 : 1
      ctx.fillStyle = colorFor(nodes[i]!)
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
      // Arrival flash: an expanding, fading ring on nodes that just appeared (live ingest).
      const born = flashRef.current.get(nodes[i]!.path)
      if (born !== undefined) {
        const age = now - born
        if (age < FLASH_MS) {
          flashActive = true
          const p = age / FLASH_MS
          ctx.globalAlpha = (1 - p) * 0.9
          ctx.strokeStyle = colorFor(nodes[i]!)
          ctx.lineWidth = 2 / t.k
          ctx.beginPath()
          ctx.arc(x, y, r + (3 + p * 14) / t.k, 0, Math.PI * 2)
          ctx.stroke()
        } else {
          flashRef.current.delete(nodes[i]!.path)
        }
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
      if (Number.isNaN(x)) continue
      if (!visible(x, y)) continue
      const dimmed = highlight !== null && !highlight.has(i)
      ctx.globalAlpha = dimmed ? 0.15 : 0.95
      ctx.fillStyle = textColor
      ctx.fillText(n.title, x, y + radius(i) + 3 / t.k)
    }
    ctx.globalAlpha = 1

    // Keep animating while any arrival flash is fading (rAF-coalesced, self-terminating).
    if (flashActive) scheduleDrawRef.current?.()
  }, [nodes, edges, focusIndex, matches, colorBy, neighbors, radius])

  const scheduleDraw = useRafDraw(draw)
  const scheduleDrawRef = useRef<(() => void) | null>(null)
  scheduleDrawRef.current = scheduleDraw
  const fittedRef = persist.fitted
  const userMovedRef = persist.userMoved

  /** Centers and scales the transform so the whole layout fits with a small margin. */
  const fitToView = useCallback((): void => {
    const canvas = canvasRef.current
    const pos = positionsRef.current
    if (!canvas || pos.length < 2) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr
    // Fit the FULL extent by default — cropping to an inner percentile leaves real nodes
    // outside the initial frame ("the graph doesn't fit"). Only when a few stragglers blow
    // the extent far beyond the body of the graph (full span > 3× the 5–95 core) does the
    // fit fall back to the core; those outliers stay reachable by panning.
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < pos.length; i += 2) {
      if (Number.isNaN(pos[i]!)) continue // unplaced mid-update nodes have no extent yet
      xs.push(pos[i]!)
      ys.push(pos[i + 1]!)
    }
    if (xs.length === 0) return
    xs.sort((a, b) => a - b)
    ys.sort((a, b) => a - b)
    const bounds = (arr: number[]): [number, number] => {
      const full: [number, number] = [arr[0]!, arr[arr.length - 1]!]
      const core: [number, number] = [
        arr[Math.floor(arr.length * 0.05)]!,
        arr[Math.min(arr.length - 1, Math.ceil(arr.length * 0.95))]!,
      ]
      return full[1] - full[0] > Math.max(1, core[1] - core[0]) * 3 ? core : full
    }
    const [minX, maxX] = bounds(xs)
    const [minY, maxY] = bounds(ys)
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

  // ---------------------------------------------------------------- layout worker session
  //
  // ONE worker for the whole mount; each node/edge change posts a new layout generation.
  // The worker interrupts whatever it was cooling and frames tagged with an old generation
  // are dropped here — so a burst of live updates can never interleave stale positions.

  const workerRef = useRef<Worker | null>(null)
  /** The generation counter and the path list the in-flight layout was posted with. */
  const layoutRef = useRef<{ gen: number; paths: string[] }>({
    gen: 0,
    // A remount picks up the persisted layout's paths so replayed worker frames land
    // in the right posByPath slots.
    paths: persist.lastMsg.current?.paths ?? [],
  })
  const lastMsgRef = persist.lastMsg
  const fitPendingRef = useRef(false)

  const postLayout = useCallback((): void => {
    const msg = lastMsgRef.current
    const worker = workerRef.current
    if (!msg || !worker) return
    // The seed buffer is transferred, so every post ships a fresh copy.
    const seed = msg.seed.slice()
    worker.postMessage(
      { gen: layoutRef.current.gen, nodes: msg.degrees, edges: msg.edges, seed, alpha: msg.alpha },
      { transfer: [seed.buffer] },
    )
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL('../lib/graphLayout.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (ev: MessageEvent<WorkerFrame>) => {
      const { gen, type, positions } = ev.data
      if (gen !== layoutRef.current.gen) return // superseded layout — drop the frame
      positionsRef.current = positions
      const byPath = posByPathRef.current
      const paths = layoutRef.current.paths
      for (let i = 0; i < paths.length; i++) {
        byPath.set(paths[i]!, { x: positions[i * 2]!, y: positions[i * 2 + 1]! })
      }
      if (type === 'done') {
        persist.settled.current = true
        setLayouting(false)
        // Frame the FIRST finished layout once, so a graph of any size lands filling the
        // viewport instead of as a speck. Later layouts (live updates, filter toggles)
        // leave the camera alone — nothing yanks the user away mid-look.
        if (fitPendingRef.current) {
          fitPendingRef.current = false
          fittedRef.current = true
          fitToView()
        }
      }
      scheduleDrawRef.current?.()
    }
    // A recreated worker (remount, dev StrictMode double-mount) starts empty. Replay only
    // when the last layout was still cooling — a settled layout's positions are already
    // persisted, and re-posting would make the graph jiggle on every return to this view.
    if (!persist.settled.current) postLayout()
    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [fitToView, postLayout])

  useEffect(() => {
    if (nodes.length === 0) {
      layoutRef.current = { gen: layoutRef.current.gen + 1, paths: [] } // orphan in-flight frames
      lastMsgRef.current = null
      positionsRef.current = new Float32Array(0)
      setLayouting(false)
      scheduleDraw()
      return
    }

    // Structurally identical to the last posted layout (a refetch where only mtimes moved,
    // or StrictMode's second effect pass)? Then there is nothing to re-settle — skip.
    const prev = lastMsgRef.current
    if (
      prev !== null &&
      prev.paths.length === nodes.length &&
      prev.edges.length === edges.length &&
      nodes.every((n, i) => n.path === prev.paths[i]) &&
      edges.every((e, i) => e[0] === prev.edges[i]![0] && e[1] === prev.edges[i]![1])
    ) {
      return
    }

    const byPath = posByPathRef.current
    const firstLayout = byPath.size === 0
    const newPaths: number[] = []
    const seed = new Float32Array(nodes.length * 2)
    for (let i = 0; i < nodes.length; i++) {
      const known = byPath.get(nodes[i]!.path)
      if (known) {
        seed[i * 2] = known.x
        seed[i * 2 + 1] = known.y
      } else {
        seed[i * 2] = NaN
        seed[i * 2 + 1] = NaN
        newPaths.push(i)
      }
    }

    // New nodes start at their placed neighbors' centroid (plus a small golden-angle offset
    // so siblings don't stack) — a page appearing mid-ingest surfaces where it belongs
    // instead of flying across the view from d3's default spiral.
    if (!firstLayout && newPaths.length > 0) {
      const adj = new Map<number, number[]>()
      for (const [a, b] of edges) {
        if (!adj.has(a)) adj.set(a, [])
        if (!adj.has(b)) adj.set(b, [])
        adj.get(a)!.push(b)
        adj.get(b)!.push(a)
      }
      for (const i of newPaths) {
        let sx = 0
        let sy = 0
        let count = 0
        for (const nb of adj.get(i) ?? []) {
          const x = seed[nb * 2]!
          if (Number.isNaN(x)) continue
          sx += x
          sy += seed[nb * 2 + 1]!
          count++
        }
        if (count > 0) {
          const angle = i * 2.399963 // golden angle: deterministic spread for co-arriving pages
          seed[i * 2] = sx / count + Math.cos(angle) * 12
          seed[i * 2 + 1] = sy / count + Math.sin(angle) * 12
        }
        flashRef.current.set(nodes[i]!.path, performance.now())
      }
    }

    // Cold start when nothing is placed yet or the view changed shape substantially
    // (unhiding a whole bucket); gentle reheat for everything else — that is what keeps a
    // live update a "reorientation" instead of a re-deal.
    const cold = firstLayout || newPaths.length > nodes.length * COLD_RESTART_SHARE
    if (firstLayout) fitPendingRef.current = true
    if (cold) setLayouting(true)

    // Align the drawn positions with the new node order IMMEDIATELY (indices shift when the
    // sorted node list changes) — known nodes render in place this very frame, before the
    // worker's first tick arrives; unplaced ones are NaN and skip drawing.
    positionsRef.current = seed.slice()
    scheduleDraw()

    const paths = nodes.map((n) => n.path)
    layoutRef.current = { gen: layoutRef.current.gen + 1, paths }
    lastMsgRef.current = {
      paths,
      degrees: nodes.map((n) => ({ degree: n.in + n.out })),
      edges,
      seed,
      alpha: cold ? 1 : 0.3,
    }
    persist.settled.current = false
    postLayout()
  }, [nodes, edges, scheduleDraw, postLayout])

  // A changed fitKey = the user changed the visible subgraph (filter/depth toggle) — re-fit
  // so the remaining graph fills the canvas. Runs AFTER the layout effect above, so
  // `persist.settled` already reflects whether that change posted a re-layout: fit now on
  // the seeded positions (survivors keep their place), and when a re-layout is cooling,
  // fit once more when it settles. First mount keeps the first-layout fit path.
  const prevFitKeyRef = useRef(fitKey)
  useEffect(() => {
    if (prevFitKeyRef.current === fitKey) return
    prevFitKeyRef.current = fitKey
    userMovedRef.current = false // an explicit view change wins over an old pan/zoom
    if (!persist.settled.current) fitPendingRef.current = true
    fitToView()
  }, [fitKey, fitToView])

  // Canvas sizing (device-pixel aware) + redraw on resize and theme change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement!
    const resize = (): void => {
      // Hidden (a display:none tab panel) → 0×0; sizing the canvas to that would wipe it.
      // Skip; the observer fires again with the real size when the panel re-shows.
      if (parent.clientWidth === 0 || parent.clientHeight === 0) return
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

  // Repaint when pure-presentation props change (search rings, focus, color axis) — these
  // must not depend on a pointer move or a layout tick happening to come along.
  useEffect(() => {
    scheduleDraw()
  }, [matches, focusIndex, colorBy, scheduleDraw])

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
        const d = dx * dx + dy * dy // NaN for unplaced nodes → both comparisons false
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

  /** Zoom to `next`, keeping the world point under screen coords (sx, sy) fixed. */
  const zoomAt = useCallback((sx: number, sy: number, next: number): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const t = transformRef.current
    const rect = canvas.getBoundingClientRect()
    const cx = sx - rect.left - rect.width / 2
    const cy = sy - rect.top - rect.height / 2
    t.x = cx - ((cx - t.x) / t.k) * next
    t.y = cy - ((cy - t.y) / t.k) * next
    t.k = next
    userMovedRef.current = true
  }, [transformRef, userMovedRef])

  const clampK = (k: number): number => Math.min(8, Math.max(0.15, k))

  /** Button zoom: around the canvas center. */
  const zoomBy = (factor: number): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, clampK(transformRef.current.k * factor))
    scheduleDraw()
  }

  // Pointer events cover mouse AND touch: drag to pan, wheel or two-finger pinch to zoom,
  // click/tap to select. All active pointers are tracked so a second touch turns the pan
  // into a pinch.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pinch = useRef<{ dist: number; k: number } | null>(null)
  /** True from pinch start until the last finger lifts — suppresses the tap-select. */
  const pinchedRef = useRef(false)

  const onPointerDown = (e: React.PointerEvent): void => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: transformRef.current.k }
      pinchedRef.current = true
      drag.current = null
    } else {
      drag.current = { x: e.clientX, y: e.clientY, moved: false }
    }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (dist > 0 && pinch.current.dist > 0) {
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, clampK((pinch.current.k * dist) / pinch.current.dist))
        scheduleDraw()
      }
      return
    }
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
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    const wasDrag = drag.current?.moved ?? false
    drag.current = null
    if (pointers.current.size === 0) {
      const wasPinch = pinchedRef.current
      pinchedRef.current = false
      if (!wasDrag && !wasPinch) {
        const hit = hitTest(e.clientX, e.clientY)
        if (hit !== null) onSelect(nodes[hit]!)
      }
    }
  }
  const onPointerCancel = (e: React.PointerEvent): void => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) pinchedRef.current = false
    drag.current = null
  }

  // Wheel zoom is a NATIVE non-passive listener: React's synthetic wheel event can't
  // preventDefault (browsers register it passive), so the page would scroll along with
  // every zoom. And because zooming moves the world under a stationary pointer, the hover
  // must be re-hit-tested — otherwise a node grazed on the way out stays "hovered" and its
  // neighborhood highlight keeps the rest of the graph dimmed.
  const onWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  onWheelRef.current = (e: WheelEvent): void => {
    e.preventDefault()
    zoomAt(e.clientX, e.clientY, clampK(transformRef.current.k * Math.exp(-e.deltaY * 0.0015)))
    const hit = hitTest(e.clientX, e.clientY)
    if (hit !== hoverRef.current) setHover(hit)
    scheduleDraw()
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent): void => onWheelRef.current(e)
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [])

  return (
    <div className="graph-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => {
          if (hoverRef.current !== null) {
            setHover(null)
            scheduleDraw()
          }
        }}
        role="img"
        aria-label={`Wikilink graph with ${nodes.length} pages`}
        style={{ cursor: hover !== null ? 'pointer' : drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
      />
      <div className="graph-controls">
        <button
          className="btn ghost"
          onClick={() => {
            userMovedRef.current = false
            fitToView()
          }}
          title="Fit the view to the graph"
        >
          Fit
        </button>
        <button className="btn ghost" onClick={() => zoomBy(1 / 1.4)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button className="btn ghost" onClick={() => zoomBy(1.4)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
      </div>
      {overlay}
      {layouting && <div className="graph-status">Laying out…</div>}
      {hover !== null && nodes[hover] && (
        <div className="graph-tooltip">
          <strong>{nodes[hover]!.title}</strong>
          <span>
            {nodes[hover]!.path}
            {nodes[hover]!.domain ? ` · ${nodes[hover]!.domain}` : ''} · {nodes[hover]!.in} in /{' '}
            {nodes[hover]!.out} out
          </span>
        </div>
      )}
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
