/**
 * Feeds the deterministic status model (lib/maintenanceStatus.ts, SPEC §12.7 Stufe b) from
 * the queries the dashboard already runs — every key here is shared with the Maintenance
 * tab's cards, so mounting this hook in a second place (the Overview badge) costs no extra
 * fetches thanks to TanStack's dedup. SSE keeps `stats`/`graph` fresh; the candidate and
 * state queries refetch with the tab's own invalidations.
 *
 * Returns null until every input is loaded — a half-derived status would flicker between
 * severities on first paint.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { MaintenanceAreaState } from '../api/types.ts'
import { computeTagReport, recommendedKeys, MAX_TAG_ACTIONS } from '../lib/tagReport.ts'
import { deriveMaintenanceStatus, type MaintStatus } from '../lib/maintenanceStatus.ts'

export interface MaintenanceStatusData {
  readonly status: MaintStatus
  /** Restart-proof last-settle facts, keyed by run kind (tag-fix, domain-backfill, …). */
  readonly lastRuns: ReadonlyMap<string, MaintenanceAreaState>
}

export interface MaintenanceStatusResult {
  /** Null while loading — or while failed (check `failed` to tell the two apart). */
  readonly data: MaintenanceStatusData | null
  /** True when any input query errored: the head must offer a retry, not spin forever. */
  readonly failed: boolean
  readonly retry: () => void
}

export function useMaintenanceStatus(): MaintenanceStatusResult {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const candidates = useQuery({ queryKey: ['domain-candidates'], queryFn: api.domainCandidates })
  const index = useQuery({ queryKey: ['retrieve-index-status'], queryFn: api.retrieveIndexStatus })
  const state = useQuery({ queryKey: ['maintenance-state'], queryFn: api.maintenanceState })

  const report = useMemo(
    () => (graph.data !== undefined ? computeTagReport(graph.data.nodes) : null),
    [graph.data],
  )

  const failed = stats.isError || graph.isError || domains.isError || candidates.isError
  const retry = (): void => {
    for (const q of [stats, graph, domains, candidates, index, state]) {
      if (q.isError) void q.refetch()
    }
  }

  const data = useMemo(() => {
    if (
      stats.data === undefined ||
      domains.data === undefined ||
      candidates.data === undefined ||
      report === null
    ) {
      return null
    }
    const status = deriveMaintenanceStatus({
      undomained: candidates.data.undomainedCount,
      registryInstalled: domains.data.installed,
      candidateCount: candidates.data.candidates.length,
      missingDomainEchoes: report.domainEchoes.filter((e) => e.domain === 'unassigned').length,
      tagRepairCount: recommendedKeys(report, MAX_TAG_ACTIONS).size,
      lintReport: stats.data.lintReport,
      hotCacheUpdatedAt: stats.data.hotCacheUpdatedAt,
      index: index.data ?? null,
      now: new Date(),
    })
    const lastRuns = new Map((state.data?.areas ?? []).map((a) => [a.kind, a]))
    return { status, lastRuns }
  }, [stats.data, domains.data, candidates.data, report, index.data, state.data])

  return { data, failed, retry }
}
