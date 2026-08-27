/**
 * The graph's keyboard reference, as a popover anchored under the canvas bar.
 *
 * It used to be a `<Tip>`, which opens UPWARD by default. That was fine while the bar sat
 * in the page header; once the density pass moved it into the canvas - `position: absolute;
 * top: 10px` inside a box with `overflow: hidden` - upward meant into the clipped region,
 * so the panel rendered off-screen and unreadable. The flip-down rule that had covered this
 * keyed off a wrapper class that same pass deleted, so it silently stopped applying.
 *
 * Hence a component rather than another CSS override: opening downward and staying inside
 * the canvas is structural here, not a per-instance tweak. A dozen shortcut rows also want
 * click-to-pin and Escape, which a hover tooltip does not give you.
 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'

export interface ShortcutRow {
  /** The keys, in press order. Rendered as separate <kbd> chips. */
  readonly keys: string[]
  readonly what: string
}

export function Shortcuts({ rows }: { rows: readonly ShortcutRow[] }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // The graph binds Escape to backing out of focus/cluster/search. While this panel is
      // open it is the innermost thing on screen, so it consumes the key.
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <span
      className="shortcut-wrap"
      ref={wrapRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        // Hover opens it, but a click pins it - don't yank it away from someone reading.
        if (document.activeElement !== wrapRef.current?.querySelector('button')) setOpen(false)
      }}
    >
      <button
        className="btn ghost"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title="Keyboard and pointer shortcuts"
      >
        <Icon name="keyboard" /> Shortcuts
      </button>
      {open && (
        <span className="shortcut-pop" role="dialog" aria-label="Keyboard and pointer shortcuts">
          <span className="sp-head">Keyboard and pointer</span>
          <span className="shortcuts">
            {rows.map((r) => (
              <span key={r.keys.join('+') + r.what} className="sc-row">
                <span className="k">
                  {r.keys.map((k, i) => (
                    <kbd key={`${k}-${i}`}>{k}</kbd>
                  ))}
                </span>
                <span className="w">{r.what}</span>
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  )
}
