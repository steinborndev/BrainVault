/** Inline SVG icon set — no icon-font dependency, theme-inheriting via `currentColor`. */

export type IconName =
  | 'logo'
  | 'grid'
  | 'inbox'
  | 'chat'
  | 'wrench'
  | 'file'
  | 'link'
  | 'copy'
  | 'retry'
  | 'x'
  | 'check'
  | 'search'
  | 'graph'
  | 'back'
  | 'upload'
  | 'edit'
  | 'palette'

const PATHS: Record<Exclude<IconName, 'logo'>, React.ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l.9-4.6A8 8 0 1 1 21 12z" />,
  wrench: (
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7 7.3 20l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.5 2.5-2.3-.6-.6-2.3z" />
  ),
  file: (
    <>
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
      <path d="M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  retry: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M4 12.5l5 5L20 6.5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5L21 21" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
      <path d="M8.2 7l7.4 0.7M7 8.2l1.4 7.4M16.4 10l-5.8 6.3" />
    </>
  ),
  back: <path d="M15 4l-8 8 8 8" />,
  upload: (
    <>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 20h16" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20l4-1L20 7l-3-3L5 16z" />
      <path d="M14 6l3 3" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18h1.2a2.1 2.1 0 0 0 1.5-3.6 2.1 2.1 0 0 1 1.5-3.6H19a3 3 0 0 0 3-3.2C21.7 6.3 17.3 3 12 3z" />
      <circle cx="7.5" cy="11.5" r="1" />
      <circle cx="10.5" cy="7.5" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </>
  ),
}

export function Icon({ name }: { name: IconName }): React.ReactElement {
  if (name === 'logo') {
    return (
      // The mark: two facing brackets (the [[wikilink]] hemispheres) enclosing the knowledge
      // graph the service builds. Strokes are tuned for ~28px in the topbar; the small-size
      // cut with heavier strokes lives in public/favicon.svg.
      <svg viewBox="0 0 64 64" width="1em" height="1em" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="var(--accent)" />
        <g fill="none" stroke="#fff" strokeWidth="3.8" strokeLinecap="round">
          <path d="M28 18A14 14 0 0 0 28 46" />
          <path d="M36 18A14 14 0 0 1 36 46" />
        </g>
        <g fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round">
          <path d="M32 32.5 27.5 27M32 32.5 37 26.8M32 32.5 27 38M32 32.5 37 37.6" />
        </g>
        <g fill="#fff">
          <circle cx="32" cy="32.5" r="3.9" />
          <circle cx="27.5" cy="27" r="2.8" />
          <circle cx="37" cy="26.8" r="2.8" />
          <circle cx="27" cy="38" r="2.8" />
          <circle cx="37" cy="37.6" r="2.8" />
        </g>
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.file}
    </svg>
  )
}
