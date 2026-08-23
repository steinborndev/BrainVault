/**
 * Domain color + page-health constants, shared between the graph canvas and the library.
 * Lives outside GraphCanvas so the library (main bundle) never pulls in d3-force - the
 * graph stays the only lazy chunk that pays for it.
 */

/**
 * Deterministic color for a domain: string hash → hue, fixed saturation/lightness that read
 * on both themes. Domains are open-ended (the user coins new ones), so a fixed palette can't
 * work - and hashing keeps a domain's color stable across sessions with zero bookkeeping.
 */
export function domainHue(domain: string): number {
  let h = 0
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0
  return h % 360
}

export function domainColor(domain: string): string {
  return `hsl(${domainHue(domain)} 62% 52%)`
}

/** A page under ~this many bytes is treated as a stub (frontmatter + a line). */
export const STUB_BYTES = 1024
