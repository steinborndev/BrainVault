/**
 * Cost rendering with the subscription caveat (SPEC.md §7.1).
 *
 * In `oauth` (subscription) mode the SDK still reports a `cost_usd`, but it is an API-price
 * EQUIVALENT — no money is charged for that run; it competes against the subscription's shared
 * limits instead. The spec requires it be marked as a subscription estimate wherever shown, so the
 * marking lives here rather than at each call site, where it would eventually be forgotten.
 */

import { usd } from '../lib/format.ts'
import type { AuthMode } from '../api/types.ts'

export const ESTIMATE_LABEL = 'estimate (subscription)'

const ESTIMATE_TITLE =
  'Estimate (subscription): the API-price equivalent — in subscription mode this amount is not actually charged.'

/** True when a cost figure is an estimate rather than money actually charged. */
export function isEstimate(authMode: AuthMode): boolean {
  return authMode === 'oauth'
}

/** A cost figure, suffixed with `*` and an explanatory tooltip when it is only an estimate. */
export function Cost({
  value,
  authMode,
}: {
  value: number | null
  authMode: AuthMode
}): React.ReactElement {
  if (!isEstimate(authMode)) return <>{usd(value)}</>
  return (
    <span title={ESTIMATE_TITLE}>
      {usd(value)}
      <span className="cost-est">*</span>
    </span>
  )
}

/** The footnote that explains the `*`. Render once per view that shows estimated costs. */
export function CostFootnote({ authMode }: { authMode: AuthMode }): React.ReactElement | null {
  if (!isEstimate(authMode)) return null
  return (
    <span className="cost-est-note" title={ESTIMATE_TITLE}>
      * {ESTIMATE_LABEL}
    </span>
  )
}
