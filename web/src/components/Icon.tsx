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
}

export function Icon({ name }: { name: IconName }): React.ReactElement {
  if (name === 'logo') {
    return (
      <svg viewBox="0 0 64 64" width="1em" height="1em" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="var(--accent)" />
        <path
          d="M20 16h13c6 0 10 3.4 10 8.6 0 3.4-1.9 5.9-4.8 7 3.6 1 6 3.8 6 7.8 0 5.6-4.3 8.6-11 8.6H20V16zm12.3 12.4c2.6 0 4.1-1.2 4.1-3.3 0-2-1.5-3.2-4.1-3.2h-5.1v6.5h5.1zm.6 12.6c2.8 0 4.4-1.3 4.4-3.5s-1.6-3.5-4.4-3.5h-5.7V41h5.7z"
          fill="#fff"
        />
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
      {PATHS[name]}
    </svg>
  )
}
