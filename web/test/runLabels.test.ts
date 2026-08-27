import { describe, expect, it } from 'vitest'
import { RUN_RUNNING_TITLES, RUN_TITLES, isMaintenanceRun } from '../src/lib/runLabels.ts'

describe('tab responsibility for a run in flight', () => {
  it('gives every known run kind exactly one announcing tab', () => {
    // The split must be exhaustive: a kind that belongs to neither goes unannounced, which
    // is the bug this was written for.
    const kinds = Object.keys(RUN_TITLES)
    const research = kinds.filter((k) => !isMaintenanceRun(k))
    const system = kinds.filter((k) => isMaintenanceRun(k))
    expect([...research, ...system].sort()).toEqual([...kinds].sort())
    expect(research).toEqual(['research', 'save'])
  })

  it('claims the maintenance kinds for System', () => {
    for (const kind of ['domain-backfill', 'lint', 'lint-fix', 'hot-cache', 'tag-fix',
                        'retrieve-index', 'domain-review', 'repair', 'cleanup']) {
      expect(isMaintenanceRun(kind)).toBe(true)
    }
  })

  it('has a present-tense name for every kind, so a badge can say what is running', () => {
    for (const kind of Object.keys(RUN_TITLES)) {
      expect(RUN_RUNNING_TITLES[kind], kind).toBeTypeOf('string')
    }
  })
})
