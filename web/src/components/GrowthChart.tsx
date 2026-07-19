/**
 * Area+line chart of cumulative wiki-page growth (SPEC.md §6.1). SVG shapes stretch with the
 * card (preserveAspectRatio none); everything textual — y labels, tooltip, crosshair — is an
 * HTML overlay so it never distorts. Hover shows the per-day value.
 */

import { useState } from 'react'
import type { GrowthPoint } from '../api/types.ts'

const W = 600
const H = 150
const PAD = 8

export function GrowthChart({ points }: { points: GrowthPoint[] }): React.ReactElement {
  const [hover, setHover] = useState<number | null>(null)

  if (points.length < 2) {
    return (
      <div className="empty">
        Not enough history for a trend yet — once ingests span several days, the curve appears here.
      </div>
    )
  }

  const totals = points.map((p) => p.total)
  const min = Math.min(...totals)
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

  return (
    <div>
      <div className="gchart-wrap" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg
          className="chart tall"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Wiki page growth, ${min} to ${max} pages over ${points.length} days`}
        >
          {/* three recessive gridlines between min and max */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} className="gridline" x1={PAD} x2={W - PAD} y1={y(min + span * f)} y2={y(min + span * f)} />
          ))}
          <path className="area" d={area} />
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
      <div className="job-meta" style={{ justifyContent: 'space-between' }}>
        <span>{first.date}</span>
        <span>{last.date}</span>
      </div>
    </div>
  )
}
