/**
 * Tooltips for explanatory text. Replaces native `title=` where the text carries meaning:
 * styled, keyboard-reachable (focus shows it, Escape closes) and touch-friendly (tap
 * toggles) - a `title` attribute is none of those.
 *
 * The body is rendered through a PORTAL and positioned `fixed` (2026-08-26). It used to be
 * absolutely positioned inside its anchor, which meant any ancestor with a clipped overflow
 * cut it off - and nearly every container in this app has one: `.subcard` and `.box` hide
 * overflow, `.gpanel`, `.box-body` and the System panes scroll. In Vault stats every single
 * tooltip was sliced by the card it sat in. A portal has no such ancestors, and placing it
 * by hand is also what lets it flip and clamp so it always lands on screen.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Gap between anchor and body, and the margin the body keeps from the viewport edge. */
const GAP = 8
const EDGE = 8

interface Placement {
  readonly left: number
  readonly top: number
}

/** Above the anchor when it fits, below when it does not; always inside the viewport. */
function place(anchor: DOMRect, body: DOMRect): Placement {
  const fitsAbove = anchor.top - GAP - body.height >= EDGE
  const top = fitsAbove ? anchor.top - GAP - body.height : anchor.bottom + GAP
  const centred = anchor.left + anchor.width / 2 - body.width / 2
  const left = Math.min(Math.max(EDGE, centred), Math.max(EDGE, window.innerWidth - body.width - EDGE))
  return { left, top: Math.min(Math.max(EDGE, top), Math.max(EDGE, window.innerHeight - body.height - EDGE)) }
}

/**
 * The floating body. Renders once off-screen so it can be measured, then positions itself -
 * one frame the reader never sees, and the price of not hard-coding the height.
 */
function TipBody({
  anchorRef,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}): React.ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Placement | null>(null)

  useLayoutEffect(() => {
    const measure = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      const body = bodyRef.current?.getBoundingClientRect()
      if (anchor !== undefined && body !== undefined) setPos(place(anchor, body))
    }
    measure()
    // The anchor moves whenever anything between it and the viewport scrolls, and in this
    // app that is every pane - hence the capture phase rather than a window scroll listener.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [anchorRef])

  return createPortal(
    <div
      ref={bodyRef}
      className="tip-body"
      role="tooltip"
      style={pos === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: pos.left, top: pos.top }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** Open on hover and on focus, toggle on tap, close on Escape - one behaviour, two anchors. */
function useTipState(): {
  open: boolean
  ref: React.RefObject<HTMLButtonElement | null>
  anchorProps: React.HTMLAttributes<HTMLElement> & { 'aria-expanded': boolean }
} {
  const [hovering, setHovering] = useState(false)
  const [pinned, setPinned] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const open = hovering || pinned

  // Tap-to-open (touch, and the keyboard's Enter) needs tap-outside-to-close.
  useEffect(() => {
    if (!pinned) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPinned(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [pinned])

  return {
    open,
    ref,
    anchorProps: {
      'aria-expanded': open,
      onPointerEnter: () => setHovering(true),
      onPointerLeave: () => setHovering(false),
      onFocus: () => setHovering(true),
      onBlur: () => setHovering(false),
      onClick: () => setPinned((v) => !v),
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          setPinned(false)
          setHovering(false)
        }
      },
    },
  }
}

/** The ⓘ marker and its tooltip, for a heading that needs a footnote. */
export function Tip({ text }: { text: React.ReactNode }): React.ReactElement {
  const { open, ref, anchorProps } = useTipState()
  return (
    <span className="tip">
      <button type="button" className="tip-i" aria-label="Info" ref={ref} {...anchorProps}>
        i
      </button>
      {open && <TipBody anchorRef={ref}>{text}</TipBody>}
    </span>
  )
}

/**
 * A tooltip on the content itself, with no marker beside it - for something that is already
 * a legible label and only needs its detail on demand, like the topbar's status chips.
 * Renders a button, because it opens something and has to be reachable by keyboard.
 */
export function HoverTip({
  text,
  className,
  label,
  children,
}: {
  text: React.ReactNode
  className?: string
  /** Accessible name, when the visible content alone is not one. */
  label?: string
  children: React.ReactNode
}): React.ReactElement {
  const { open, ref, anchorProps } = useTipState()
  return (
    <>
      <button
        type="button"
        className={className}
        ref={ref}
        {...(label !== undefined ? { 'aria-label': label } : {})}
        {...anchorProps}
      >
        {children}
      </button>
      {open && <TipBody anchorRef={ref}>{text}</TipBody>}
    </>
  )
}
