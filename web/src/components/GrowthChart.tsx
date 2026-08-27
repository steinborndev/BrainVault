/**
 * Area+line chart of cumulative wiki-page growth (SPEC.md §6.1). SVG shapes stretch with the
 * card (preserveAspectRatio none); everything textual - y labels, tooltip, crosshair - is an
 * HTML overlay so it never distorts. Hover shows the per-day value.
 */

import { useState } from 'react'
import type { GrowthPoint } from '../api/types.ts'

const W = 600
const H = 150
const PAD = 8

export function GrowthChart({
  points,
  variant = 'card',
}: {
  points: GrowthPoint[]
  /**
   * `card` is the boxed figure System shows in a stack of them. `panel` is Home's second
   * slot beside the graph: a bare sparkline in the same dark inset the graph sits in, filling
   * the height it is given rather than a fixed 170px inside a 300px band, and with the dates
   * as corner labels instead of a row underneath.
   */
  variant?: 'card' | 'panel'
}): React.ReactElement {
  const [hover, setHover] = useState<number | null>(null)

  if (points.length < 2) {
    return (
      <div className="empty">
        Not enough history for a trend yet - once ingests span several days, the curve appears here.
      </div>
    )
  }

  const totals = points.map((p) => p.total)
  // Zero-based scale: a min-max window turned a 6-page week into a dramatic full-height
  // climb. Cumulative page totals are honest from zero.
  const min = 0
  const max = Math.max(...totals)
  const span = max - min || 1
  const stepX = (W - PAD * 2) / (points.length - 1)

  const x = (i: number): number => PAD + i * stepX
  const y = (v: number): number => H - PAD - ((v - min) / span) * (H - PAD * 2)

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`

  const first = points[0]!
  const last = points[points.length - 1]!

  const onMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const rel = (e.clientX - rect.left) / rect.width // 0..1 across the stretched svg
    const i = Math.round(((rel * W - PAD) / (W - PAD * 2)) * (points.length - 1))
    setHover(Math.max(0, Math.min(points.length - 1, i)))
  }
  const hoverPct = hover !== null ? (x(hover) / W) * 100 : 0

  const panel = variant === 'panel'
  return (
    <div className={panel ? 'plotbox' : undefined}>
      <div className="gchart-wrap" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg
          className={panel ? 'chart fill spark' : 'chart tall'}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Wiki page growth, ${min} to ${max} pages over ${points.length} days`}
        >
          {/* three recessive gridlines between min and max */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} className="gridline" x1={PAD} x2={W - PAD} y1={y(min + span * f)} y2={y(min + span * f)} />
          ))}
          {/* A sparkline has no fill: beside a graph that is already a dense picture, a
              filled area is a second block of colour competing with it for the same eye. */}
          {!panel && <path className="area" d={area} />}
          <path className="line" d={line} />
          <circle className="dot" cx={x(points.length - 1)} cy={y(last.total)} r={3} />
        </svg>
        <span className="gy gy-max">{max}</span>
        <span className="gy gy-min">{min}</span>
        {hover !== null && (
          <>
            <div className="gcross" style={{ left: `${hoverPct}%` }} />
            <div className="gtip" style={{ left: `${hoverPct}%` }}>
              <strong>{points[hover]!.total}</strong> pages · {points[hover]!.date}
            </div>
          </>
        )}
      </div>
      {panel ? (
        <>
          <span className="gx gx-a">{first.date}</span>
          <span className="gx gx-b">{last.date}</span>
        </>
      ) : (
        <div className="job-meta" style={{ justifyContent: 'space-between' }}>
          <span>{first.date}</span>
          <span>{last.date}</span>
        </div>
      )}
    </div>
  )
}
