/**
 * One figure with its label: a caption, the number, and an optional line of context under
 * it. Home's glance strip and System's fact grids were two implementations of exactly this,
 * with the same `.k` / `.v` / `.s` markup and six values drifted apart between them (value
 * 20 vs 16px, sub 11.5 vs 11px, padding 14 vs 12px, and so on).
 *
 * They keep their two densities, because they are doing different jobs: `lead` is Home's
 * strip of five doors across the top of the screen, `default` is a dense grid of a dozen
 * numbers inside a section. That is a size, not a second component.
 *
 * With `onOpen` the tile is a button and says where it goes; without it, it is a `div` and
 * takes no tab stop, because a figure nobody can act on should not be in the tab order.
 */

export function Fact({
  k,
  v,
  sub,
  tone,
  size = 'default',
  onOpen,
}: {
  k: string
  v: React.ReactNode
  sub?: React.ReactNode
  tone?: 'warn' | 'err' | undefined
  size?: 'default' | 'lead'
  onOpen?: (() => void) | undefined
}): React.ReactElement {
  const body = (
    <>
      <span className="k">{k}</span>
      <span className={`v${tone !== undefined ? ` ${tone}` : ''}`}>{v}</span>
      {sub !== undefined && <span className="s">{sub}</span>}
    </>
  )
  const cls = `fact${size === 'lead' ? ' lead' : ''}`
  if (onOpen === undefined) return <div className={cls}>{body}</div>
  return (
    <button className={`${cls} linky`} onClick={onOpen}>
      {body}
    </button>
  )
}

/**
 * The container. `lead` is the full-width strip that sits directly under a box head, with
 * its own bottom border instead of a card outline; the default is a bordered grid that can
 * sit anywhere inside a pane.
 */
export function Facts({
  size = 'default',
  children,
}: {
  size?: 'default' | 'lead'
  children: React.ReactNode
}): React.ReactElement {
  return <div className={`facts${size === 'lead' ? ' lead' : ''}`}>{children}</div>
}
