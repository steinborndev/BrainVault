/**
 * A tiny dependency-free area+line chart of cumulative wiki-page growth (SPEC.md §6.1).
 * SVG, theme-aware via CSS vars; degrades to a note when there aren't enough points.
 */

import type { GrowthPoint } from '../api/types.ts'

const W = 600
const H = 120
const PAD = 6

export function GrowthChart({ points }: { points: GrowthPoint[] }): React.ReactElement {
  if (points.length < 2) {
    return <div className="empty">Not enough history for a trend yet — once ingests span several days, the curve appears here.</div>
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

  const last = points[points.length - 1]!
  const first = points[0]!

  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Wiki page growth">
        <path className="area" d={area} />
        <path className="line" d={line} />
        <circle className="dot" cx={x(points.length - 1)} cy={y(last.total)} r={3} />
      </svg>
      <div className="job-meta" style={{ justifyContent: 'space-between' }}>
        <span>{first.date}</span>
        <span>
          {min} → {max} pages
        </span>
        <span>{last.date}</span>
      </div>
    </div>
  )
}
