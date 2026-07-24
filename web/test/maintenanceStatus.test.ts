import { describe, it, expect } from 'vitest'
import {
  deriveMaintenanceStatus,
  LINT_STALE_DAYS,
  HOT_CACHE_STALE_DAYS,
  type MaintStatusInput,
} from '../src/lib/maintenanceStatus.ts'

const NOW = new Date('2026-07-24T12:00:00.000Z')

/** A fully healthy vault; tests override the one signal they exercise. */
const healthy = (over: Partial<MaintStatusInput> = {}): MaintStatusInput => ({
  undomained: 0,
  registryInstalled: true,
  candidateCount: 0,
  missingDomainEchoes: 0,
  tagRepairCount: 0,
  lintReport: { date: '2026-07-20' },
  hotCacheUpdatedAt: '2026-07-23T12:00:00.000Z',
  index: { scriptsPresent: true, provisioned: true },
  now: NOW,
  ...over,
})

const byId = (s: ReturnType<typeof deriveMaintenanceStatus>, id: string) =>
  s.items.find((i) => i.id === id)

describe('deriveMaintenanceStatus', () => {
  it('reports all healthy for a healthy vault — an explicit state, not an empty list', () => {
    const s = deriveMaintenanceStatus(healthy())
    expect(s.due).toBe(0)
    expect(s.recommended).toBe(0)
    expect(s.healthy).toBe(6)
    expect(s.items.map((i) => i.id).sort()).toEqual(
      ['backfill', 'domains', 'hot-cache', 'index', 'lint', 'tags'].sort(),
    )
  })

  it('unfiled pages make the backfill due, with the count in the why', () => {
    const s = deriveMaintenanceStatus(healthy({ undomained: 23 }))
    const item = byId(s, 'backfill')
    expect(item?.severity).toBe('due')
    expect(item?.why).toContain('23 pages')
    expect(s.due).toBe(1)
  })

  it('open candidates are due decisions; missing-domain echoes enrich the why', () => {
    const s = deriveMaintenanceStatus(healthy({ candidateCount: 3, missingDomainEchoes: 1 }))
    const item = byId(s, 'domains')
    expect(item?.severity).toBe('due')
    expect(item?.title).toContain('3 domain decisions')
    expect(item?.why).toContain('1 of them')
  })

  it('a missing registry is one recommended setup item, not a due backfill', () => {
    const s = deriveMaintenanceStatus(healthy({ registryInstalled: false, undomained: 99 }))
    expect(byId(s, 'backfill')).toBeUndefined()
    expect(byId(s, 'domains')?.severity).toBe('recommended')
    expect(s.due).toBe(0)
  })

  it('preselected tag repairs are due', () => {
    const s = deriveMaintenanceStatus(healthy({ tagRepairCount: 6 }))
    expect(byId(s, 'tags')?.severity).toBe('due')
    expect(byId(s, 'tags')?.title).toContain('6 tag repairs')
  })

  it('lint: missing report and stale report recommend, fresh report is healthy', () => {
    expect(byId(deriveMaintenanceStatus(healthy({ lintReport: null })), 'lint')?.severity).toBe('recommended')
    const staleDate = new Date(NOW.getTime() - (LINT_STALE_DAYS + 2) * 24 * 60 * 60 * 1000)
    expect(
      byId(
        deriveMaintenanceStatus(healthy({ lintReport: { date: staleDate.toISOString().slice(0, 10) } })),
        'lint',
      )?.severity,
    ).toBe('recommended')
    expect(byId(deriveMaintenanceStatus(healthy()), 'lint')?.severity).toBe('healthy')
    // Unknown age (no date parsed from the filename) never nags.
    expect(byId(deriveMaintenanceStatus(healthy({ lintReport: { date: null } })), 'lint')?.severity).toBe('healthy')
  })

  it('hot cache: never refreshed and stale recommend, fresh is healthy', () => {
    expect(byId(deriveMaintenanceStatus(healthy({ hotCacheUpdatedAt: null })), 'hot-cache')?.severity).toBe(
      'recommended',
    )
    const stale = new Date(NOW.getTime() - (HOT_CACHE_STALE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString()
    expect(byId(deriveMaintenanceStatus(healthy({ hotCacheUpdatedAt: stale })), 'hot-cache')?.severity).toBe(
      'recommended',
    )
    expect(byId(deriveMaintenanceStatus(healthy()), 'hot-cache')?.severity).toBe('healthy')
  })

  it('index: unprovisioned recommends a one-time build; missing scripts omit the item', () => {
    expect(
      byId(
        deriveMaintenanceStatus(healthy({ index: { scriptsPresent: true, provisioned: false } })),
        'index',
      )?.severity,
    ).toBe('recommended')
    expect(
      byId(deriveMaintenanceStatus(healthy({ index: { scriptsPresent: false, provisioned: false } })), 'index'),
    ).toBeUndefined()
    expect(byId(deriveMaintenanceStatus(healthy({ index: null })), 'index')).toBeUndefined()
  })

  it('sorts due before recommended before healthy, keeping the dependency chain within a rank', () => {
    const s = deriveMaintenanceStatus(
      healthy({ undomained: 5, candidateCount: 1, lintReport: null, hotCacheUpdatedAt: null }),
    )
    const sev = s.items.map((i) => i.severity)
    expect(sev).toEqual([...sev].sort((a, b) => ({ due: 0, recommended: 1, healthy: 2 })[a] - ({ due: 0, recommended: 1, healthy: 2 })[b]))
    // Within "due", backfill (the chain's head) comes before the domain decisions.
    const dueIds = s.items.filter((i) => i.severity === 'due').map((i) => i.id)
    expect(dueIds).toEqual(['backfill', 'domains'])
  })
})
