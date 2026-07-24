/**
 * The maintenance status model (SPEC §12.7 Stufe b): a deterministic, token-free derivation
 * of "what's due" from data the dashboard already loads. Every item carries the three fields
 * the concept demands — WHAT (title), WHY NOW (the concrete number), COST (agent run vs.
 * deterministic) — plus a severity with tab-wide semantics:
 *
 *   due          blocks other maintenance or degrades quality until handled
 *   recommended  worth doing soon, nothing depends on it
 *   healthy      explicitly fine — "all healthy" is a state, not an empty screen
 *
 * Pure function over plain inputs (no fetching, no Date.now inside) so the thresholds stay
 * unit-testable; the `useMaintenanceStatus` hook feeds it from the live queries.
 */

export type MaintSeverity = 'due' | 'recommended' | 'healthy'

/** Stable area ids; `anchor` is the DOM id of the expert card the item jumps to. */
export type MaintAreaId = 'backfill' | 'domains' | 'tags' | 'lint' | 'hot-cache' | 'index'

export interface MaintStatusItem {
  readonly id: MaintAreaId
  readonly severity: MaintSeverity
  readonly title: string
  readonly why: string
  readonly cost: string
  readonly anchor: string
}

export interface MaintStatusInput {
  /** Pages with no `domain:` field at all (backfill due while > 0). */
  readonly undomained: number
  readonly registryInstalled: boolean
  /** Open (non-dismissed) domain candidates waiting for a decision. */
  readonly candidateCount: number
  /** `unassigned` domain echoes in the tag report — likely missing domains. */
  readonly missingDomainEchoes: number
  /** Preselected conflict-free tag repairs (recommendedKeys().size). */
  readonly tagRepairCount: number
  /** Newest lint report: its date (YYYY-MM-DD, possibly null) — or null when none exists. */
  readonly lintReport: { date: string | null } | null
  /** mtime of wiki/hot.md, or null when never refreshed. */
  readonly hotCacheUpdatedAt: string | null
  /** Retrieval-index card facts; null while still loading (item omitted then). */
  readonly index: { scriptsPresent: boolean; provisioned: boolean } | null
  readonly now: Date
}

export interface MaintStatus {
  readonly items: MaintStatusItem[]
  readonly due: number
  readonly recommended: number
  readonly healthy: number
}

/** A lint report older than this counts as stale (recommended, never due — nothing blocks on it). */
export const LINT_STALE_DAYS = 14
/** The hot cache serves every agent run's first read — stale earlier than the lint report. */
export const HOT_CACHE_STALE_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

const daysSince = (iso: string, now: Date): number => Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS)

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function deriveMaintenanceStatus(input: MaintStatusInput): MaintStatus {
  const items: MaintStatusItem[] = []

  // The dependency chain's head: domain work first (backfill → decisions), because the
  // candidate analysis and the tag report both read its result.
  if (!input.registryInstalled) {
    items.push({
      id: 'domains',
      severity: 'recommended',
      title: 'Install the domain registry',
      why: 'No registry in the vault - domains, backfill and candidate analysis stay off until it exists.',
      cost: 'one-time setup script',
      anchor: 'card-domains',
    })
  } else {
    if (input.undomained > 0) {
      items.push({
        id: 'backfill',
        severity: 'due',
        title: `File ${plural(input.undomained, 'page')} into domains`,
        why: `${plural(input.undomained, 'page')} carry no domain field yet - candidate analysis and tag report stay incomplete until they are filed.`,
        cost: 'agent run · one commit',
        anchor: 'card-domains',
      })
    } else {
      items.push({
        id: 'backfill',
        severity: 'healthy',
        title: 'All pages filed into domains',
        why: 'Every page carries a domain field.',
        cost: 'nothing to do',
        anchor: 'card-domains',
      })
    }

    if (input.candidateCount > 0) {
      items.push({
        id: 'domains',
        severity: 'due',
        title: `${plural(input.candidateCount, 'domain decision')}`,
        why:
          `${plural(input.candidateCount, 'candidate')} waiting for your call` +
          (input.missingDomainEchoes > 0
            ? ` - the tag report backs ${input.missingDomainEchoes} of them as likely missing domains.`
            : '.'),
        cost: 'read-only review + your decision',
        anchor: 'card-domains',
      })
    } else {
      items.push({
        id: 'domains',
        severity: 'healthy',
        title: 'No open domain candidates',
        why: 'New candidates appear once enough related unassigned pages accumulate.',
        cost: 'nothing to do',
        anchor: 'card-domains',
      })
    }
  }

  if (input.tagRepairCount > 0) {
    items.push({
      id: 'tags',
      severity: 'due',
      title: `${plural(input.tagRepairCount, 'tag repair')} recommended`,
      why: 'Spelling variants and domain echoes with a clear direction - preselected, you only confirm.',
      cost: 'agent run · one commit',
      anchor: 'card-tags',
    })
  } else {
    items.push({
      id: 'tags',
      severity: 'healthy',
      title: 'Tag set looks healthy',
      why: 'No repairs with an unambiguous direction.',
      cost: 'nothing to do',
      anchor: 'card-tags',
    })
  }

  if (input.lintReport === null) {
    items.push({
      id: 'lint',
      severity: 'recommended',
      title: 'Run a first lint',
      why: 'No lint report in the vault yet - a baseline report is what bounds safe auto-fixes.',
      cost: 'agent run',
      anchor: 'card-lint',
    })
  } else {
    const age = input.lintReport.date !== null ? daysSince(input.lintReport.date, input.now) : null
    if (age !== null && age > LINT_STALE_DAYS) {
      items.push({
        id: 'lint',
        severity: 'recommended',
        title: 'Lint the wiki, then apply safe fixes',
        why: `Last report is ${plural(age, 'day')} old.`,
        cost: 'two agent runs',
        anchor: 'card-lint',
      })
    } else {
      items.push({
        id: 'lint',
        severity: 'healthy',
        title: 'Lint report is recent',
        why: age !== null ? `Last report is ${plural(age, 'day')} old.` : 'A lint report exists.',
        cost: 'nothing to do',
        anchor: 'card-lint',
      })
    }
  }

  if (input.hotCacheUpdatedAt === null) {
    items.push({
      id: 'hot-cache',
      severity: 'recommended',
      title: 'Refresh the hot cache',
      why: 'Never refreshed - every agent run reads this compact context first.',
      cost: 'agent run · ~1 min',
      anchor: 'card-hot-cache',
    })
  } else {
    const age = daysSince(input.hotCacheUpdatedAt, input.now)
    if (age > HOT_CACHE_STALE_DAYS) {
      items.push({
        id: 'hot-cache',
        severity: 'recommended',
        title: 'Refresh the hot cache',
        why: `Last refresh ${plural(age, 'day')} ago - ingests and chat may miss recent pages.`,
        cost: 'agent run · ~1 min',
        anchor: 'card-hot-cache',
      })
    } else {
      items.push({
        id: 'hot-cache',
        severity: 'healthy',
        title: 'Hot cache is fresh',
        why: `Last refresh ${plural(age, 'day')} ago.`,
        cost: 'nothing to do',
        anchor: 'card-hot-cache',
      })
    }
  }

  if (input.index !== null && input.index.scriptsPresent) {
    items.push(
      input.index.provisioned
        ? {
            id: 'index',
            severity: 'healthy',
            title: 'Retrieval index is up to date',
            why: 'Rebuilds itself after ingests settle - no manual step.',
            cost: 'automatic',
            anchor: 'card-index',
          }
        : {
            id: 'index',
            severity: 'recommended',
            title: 'Build the retrieval index once',
            why: 'Not provisioned yet - chat falls back to the classic page-title read path.',
            cost: 'deterministic · no credential needed',
            anchor: 'card-index',
          },
    )
  }

  const rank: Record<MaintSeverity, number> = { due: 0, recommended: 1, healthy: 2 }
  items.sort((a, b) => rank[a.severity] - rank[b.severity])

  return {
    items,
    due: items.filter((i) => i.severity === 'due').length,
    recommended: items.filter((i) => i.severity === 'recommended').length,
    healthy: items.filter((i) => i.severity === 'healthy').length,
  }
}
