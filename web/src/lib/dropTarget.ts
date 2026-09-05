/**
 * Who takes a dropped file when two listeners hear the same drop.
 *
 * The Inbox dropzone handles drops on itself; `GlobalDrop` handles drops anywhere else in
 * the window. Both hear a drop on the dropzone (the event bubbles to `window`), and until
 * 2026-09-05 both uploaded it: every file dropped on the dropzone arrived twice, and the
 * second copy was recorded as a "duplicate" of the first. A dedicated target marks itself
 * with `data-drop-target`; the window-level handler leaves those drops alone.
 *
 * Kept as a pure function over the event target so the rule is testable without a DOM.
 */

/** The subset of `Element` the rule needs; a test can pass a plain object. */
export interface DropTargetLike {
  closest(selector: string): unknown
}

export const DROP_TARGET_SELECTOR = '[data-drop-target]'

/** True when the drop landed inside an element that handles drops itself. */
export function ownsDrop(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const el = target as Partial<DropTargetLike>
  if (typeof el.closest !== 'function') return false
  return el.closest(DROP_TARGET_SELECTOR) != null
}
