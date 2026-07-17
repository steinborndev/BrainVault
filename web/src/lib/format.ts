/** Small display formatters shared across tabs. */

/** JSON-array-string `created_pages` → string[] (server stores it as a JSON string). */
export function parsePages(createdPages: string | null): string[] {
  if (!createdPages) return []
  try {
    const parsed = JSON.parse(createdPages)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

/** Relative time in German, e.g. "vor 3 min". Falls back to a date for older stamps. */
export function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const secs = Math.round((Date.now() - then) / 1000)
  if (secs < 5) return 'gerade eben'
  if (secs < 60) return `vor ${secs} s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `vor ${mins} min`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `vor ${hours} h`
  const days = Math.round(hours / 24)
  if (days < 30) return `vor ${days} d`
  return new Date(iso).toLocaleDateString('de-DE')
}

/** Duration between two ISO stamps, e.g. "1m 12s". */
export function duration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return '—'
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime()
  if (Number.isNaN(ms) || ms < 0) return '—'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${secs % 60}s`
}

/** Compact token count, e.g. 12_400 → "12.4k". */
export function tokens(n: number | null): string {
  if (n === null || n === undefined) return '—'
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

export function usd(n: number | null): string {
  if (n === null || n === undefined) return '—'
  return `$${n.toFixed(n < 1 ? 3 : 2)}`
}
