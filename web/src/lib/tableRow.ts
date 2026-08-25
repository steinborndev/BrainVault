/**
 * A table row that opens something.
 *
 * The three tables that have a row action each implemented it differently: the activity
 * table had click + Enter + `tabIndex` + a label, the research run table was focusable but
 * did nothing on Enter, and the library table had a click handler and nothing else, so its
 * rows were unreachable without a mouse. One helper, so a row cannot be half-interactive.
 *
 * `<tr>` deliberately keeps its row semantics - no `role="button"`, which would take the
 * cell structure away from a screen reader. It is the `aria-label` that says what the row
 * opens. `tabindex` is also what the stylesheet keys the pointer cursor off, so a row that
 * looks clickable is exactly one that is.
 *
 * Enter only, not Space: these rows live in scroll containers, where Space is the reader's
 * page-down and taking it would cost more than the shortcut is worth.
 */

import type { KeyboardEvent } from 'react'

export interface RowHandlers {
  onClick?: () => void
  onKeyDown?: (e: KeyboardEvent<HTMLTableRowElement>) => void
  tabIndex?: number
  'aria-label'?: string
}

/**
 * Pass `open: undefined` for a row that has nothing to open - it then gets no handlers, no
 * tab stop and no pointer, which is the honest rendering of a row that does nothing.
 */
export function openableRow(open: (() => void) | undefined, label: string): RowHandlers {
  if (open === undefined) return {}
  return {
    onClick: open,
    onKeyDown: (e) => {
      if (e.key !== 'Enter') return
      // Only when the row itself has focus: Enter inside a nested control (the library's
      // row actions, a cancel button) belongs to that control.
      if (e.target !== e.currentTarget) return
      e.preventDefault()
      open()
    },
    tabIndex: 0,
    'aria-label': label,
  }
}
