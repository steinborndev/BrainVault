/**
 * Info tooltip (ⓘ) for explanatory text. Replaces native `title=` where the text carries
 * meaning: styled, keyboard-reachable (focus shows it, Escape closes) and touch-friendly
 * (tap toggles) — a `title` attribute is none of those.
 */

import { useEffect, useRef, useState } from 'react'

export function Tip({ text }: { text: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  // Tap-to-open (touch) needs tap-outside-to-close.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  return (
    <span className={`tip${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        className="tip-i"
        aria-label="Info"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
      >
        i
      </button>
      <span className="tip-body" role="tooltip">
        {text}
      </span>
    </span>
  )
}
