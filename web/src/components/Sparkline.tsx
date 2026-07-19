/**
 * Tiny inline trend line for the KPI tiles — one series, no axes, emphasized endpoint.
 * Purely supplementary (aria-hidden): the tile's value + delta carry the information.
 */

export function Sparkline({ values }: { values: number[] }): React.ReactElement | null {
  if (values.length < 2) return null
  const W = 74
  const H = 26
  const P = 3
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const x = (i: number): number => P + (i * (W - P * 2)) / (values.length - 1)
  const y = (v: number): number => H - P - ((v - min) / span) * (H - P * 2)
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const lastX = x(values.length - 1)
  const lastY = y(values[values.length - 1]!)

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline points={pts} />
      <circle cx={lastX} cy={lastY} r={2.5} />
    </svg>
  )
}
