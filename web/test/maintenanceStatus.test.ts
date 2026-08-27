import { describe, it, expect } from 'vitest'
import {
  deriveMaintenanceStatus,
  buildRunPlan,
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
  lastLintRun: null,
  hotCacheUpdatedAt: '2026-07-23T12:00:00.000Z',
  index: { scriptsPresent: true, provisioned: true },
  unversioned: { untracked: 0, modified: 0 },
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
    expect(s.healthy).toBe(7)
    expect(s.items.map((i) => i.id).sort()).toEqual(
      ['backfill', 'domains', 'hot-cache', 'index', 'lint', 'tags', 'unversioned'].sort(),
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

  it('pages outside git are DUE and name both kinds', () => {
    // The failure this encodes: pages an agent wrote with Bash never entered a commit, and
    // nothing in the dashboard ever said so - the sweep that would catch them is skipped
    // whenever more than one run is writing, which with batch drops is the normal case.
    const s = deriveMaintenanceStatus(healthy({ unversioned: { untracked: 24, modified: 1 } }))
    const item = byId(s, 'unversioned')
    expect(item?.severity).toBe('due')
    expect(item?.title).toContain('25 pages')
    expect(item?.why).toContain('24 pages never committed')
    expect(item?.why).toContain('1 page changed')
  })

  it('pages outside git: none is an explicit healthy state, not a missing item', () => {
    expect(byId(deriveMaintenanceStatus(healthy()), 'unversioned')?.severity).toBe('healthy')
  })

  it('pages outside git: the item is omitted while the count is still loading', () => {
    const s = deriveMaintenanceStatus(healthy({ unversioned: null }))
    expect(byId(s, 'unversioned')).toBeUndefined()
  })

  it('lint: a run that wrote no report is DUE, not a stale-report recommendation', () => {
    // The failure this encodes: the run record says a lint finished hours ago, the newest
    // report in the vault is a month old. Reporting "last report is 31 days old" contradicts
    // what the user just did; the real problem is that the run produced nothing.
    const s = deriveMaintenanceStatus(
      healthy({
        lintReport: { date: '2026-06-23' },
        lastLintRun: { finishedAt: '2026-07-23T20:43:41.000Z', ok: true },
      }),
    )
    const item = byId(s, 'lint')
    expect(item?.severity).toBe('due')
    expect(item?.title).toBe('Lint ran, but wrote no report')
    expect(item?.why).toContain('31 days old')
    expect(s.due).toBe(1)
  })

  it('lint: a recent run WITH its report is healthy, whatever the report file name says', () => {
    const s = deriveMaintenanceStatus(
      healthy({
        lintReport: { date: '2026-07-23' },
        lastLintRun: { finishedAt: '2026-07-23T20:43:41.000Z', ok: true },
      }),
    )
    expect(byId(s, 'lint')?.severity).toBe('healthy')
    expect(byId(s, 'lint')?.why).toContain('in the last 24 hours')
  })

  it('lint: a covering report is healthy even when the run that should have written it failed', () => {
    // The artifact is what the area is about. Once a report covering the run exists - from a
    // later render, a retry, a manual run - safe fixes have something current to be bounded
    // by, and saying "wrote no report" next to a report dated today is the original bug
    // pointing the other way. The failed run stays visible in the run history on its own.
    const s = deriveMaintenanceStatus(
      healthy({
        lintReport: { date: '2026-07-23' },
        lastLintRun: { finishedAt: '2026-07-23T20:43:41.000Z', ok: false },
      }),
    )
    expect(byId(s, 'lint')?.severity).toBe('healthy')
  })

  it('lint: a failed run with only a STALE report is still due', () => {
    const s = deriveMaintenanceStatus(
      healthy({
        lintReport: { date: '2026-06-23' },
        lastLintRun: { finishedAt: '2026-07-23T20:43:41.000Z', ok: false },
      }),
    )
    expect(byId(s, 'lint')?.severity).toBe('due')
  })

  it('lint: an OLD run does not mask a stale report - the report age still decides', () => {
    const s = deriveMaintenanceStatus(
      healthy({
        lintReport: { date: '2026-06-01' },
        lastLintRun: { finishedAt: '2026-06-01T10:00:00.000Z', ok: true },
      }),
    )
    expect(byId(s, 'lint')?.severity).toBe('recommended')
    expect(byId(s, 'lint')?.title).toBe('Lint the wiki, then apply safe fixes')
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

describe('buildRunPlan', () => {
  it('plans only what is due/recommended, in dependency order', () => {
    const s = deriveMaintenanceStatus(
      healthy({ undomained: 5, candidateCount: 2, tagRepairCount: 3, lintReport: null, hotCacheUpdatedAt: null }),
    )
    const plan = buildRunPlan(s)
    expect(plan.map((p) => p.id)).toEqual(['backfill', 'domains', 'backfill2', 'tags', 'lint', 'hot-cache'])
    expect(plan.map((p) => p.kind)).toEqual(['auto', 'decision', 'auto', 'decision', 'auto', 'auto'])
  })

  it('a healthy vault yields an empty plan', () => {
    expect(buildRunPlan(deriveMaintenanceStatus(healthy()))).toEqual([])
  })

  it('the follow-up backfill is planned exactly when domain decisions are', () => {
    const withDomains = buildRunPlan(deriveMaintenanceStatus(healthy({ candidateCount: 1 })))
    expect(withDomains.map((p) => p.id)).toEqual(['domains', 'backfill2'])
    const withoutDomains = buildRunPlan(deriveMaintenanceStatus(healthy({ tagRepairCount: 1 })))
    expect(withoutDomains.map((p) => p.id)).toEqual(['tags'])
  })

  it('never plans the index (self-refreshing) or a registry install (not runnable)', () => {
    const s = deriveMaintenanceStatus(
      healthy({ registryInstalled: false, index: { scriptsPresent: true, provisioned: false } }),
    )
    expect(buildRunPlan(s)).toEqual([])
  })
})
