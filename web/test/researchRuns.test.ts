import { describe, it, expect } from 'vitest'
import { buildResearchRuns, splitResearchTitle, targetTitle } from '../src/lib/researchRuns.ts'
import type { GraphNode, MaintenanceAreaState, MaintenanceRun, ResearchProfile } from '../src/api/types.ts'

const PROFILES: ResearchProfile[] = [
  { key: 'broad', label: 'Broad sweep', blurb: '', sources: [], fetchEstimate: '30-45', titleSuffix: '' },
  {
    key: 'sota',
    label: 'State of the art',
    blurb: '',
    sources: [],
    fetchEstimate: '30-40',
    titleSuffix: ' - State of the Art',
  },
  {
    key: 'patents',
    label: 'Recent patents',
    blurb: '',
    sources: [],
    fetchEstimate: '25-35',
    titleSuffix: ' - Patent Landscape',
  },
]

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  path: 'wiki/questions/Research: Topic.md',
  title: 'Research: Topic',
  type: 'questions',
  tags: [],
  domain: null,
  out: 3,
  in: 1,
  mtimeMs: Date.parse('2026-08-20T10:00:00.000Z'),
  ...over,
})

const run = (over: Partial<MaintenanceRun> = {}): MaintenanceRun => ({
  id: 'run-1',
  kind: 'research',
  channel: 'maintenance:research',
  status: 'done',
  label: 'Topic',
  profileKey: 'broad',
  startedAt: '2026-08-20T09:40:00.000Z',
  finishedAt: '2026-08-20T10:00:00.000Z',
  result: {
    ok: true,
    kind: 'research',
    pages: ['wiki/questions/Research: Topic.md'],
    usage: { tokensIn: 100, tokensOut: 50, costUsd: 1.5 },
  },
  ...over,
})

const settle = (over: Partial<MaintenanceAreaState> = {}): MaintenanceAreaState => ({
  kind: 'research',
  runId: 'run-old',
  ok: false,
  pages: 0,
  error: 'usage limit reached',
  finishedAt: '2026-08-10T08:00:00.000Z',
  ...over,
})

describe('splitResearchTitle', () => {
  it('returns null for a page that is not a synthesis page', () => {
    expect(splitResearchTitle('Sulfide Electrolyte', PROFILES)).toBeNull()
  })

  it('strips the longest matching lens suffix, not the empty default', () => {
    expect(splitResearchTitle('Research: Batteries - State of the Art', PROFILES)).toEqual({
      topic: 'Batteries',
      profileKey: 'sota',
    })
  })

  it('reads a plain title as the broad lens (no suffix)', () => {
    expect(splitResearchTitle('Research: Batteries', PROFILES)).toEqual({
      topic: 'Batteries',
      profileKey: null,
    })
  })

  it('tolerates an em-dash suffix written by an older version', () => {
    expect(splitResearchTitle('Research: Batteries — Patent Landscape', PROFILES)).toEqual({
      topic: 'Batteries',
      profileKey: 'patents',
    })
  })
})

describe('buildResearchRuns', () => {
  it('lists a tracked run with its cost and pages', () => {
    const entries = buildResearchRuns({ runs: [run()], lastRuns: [], nodes: [], profiles: PROFILES })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ topic: 'Topic', status: 'done', costUsd: 1.5, source: 'run' })
  })

  it('reconstructs a run from its synthesis page when the record is gone', () => {
    const entries = buildResearchRuns({
      runs: [],
      lastRuns: [],
      nodes: [node({ title: 'Research: Batteries - State of the Art' })],
      profiles: PROFILES,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ topic: 'Batteries', profileKey: 'sota', source: 'page', costUsd: null })
  })

  it('does not list a run twice when its page is still in the graph', () => {
    const entries = buildResearchRuns({ runs: [run()], lastRuns: [], nodes: [node()], profiles: PROFILES })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.source).toBe('run')
  })

  it('ignores non-research pages and non-research runs', () => {
    const entries = buildResearchRuns({
      runs: [run({ id: 'lint-1', kind: 'lint', label: undefined })],
      lastRuns: [],
      nodes: [node({ title: 'Sulfide Electrolyte', path: 'wiki/concepts/Sulfide Electrolyte.md' })],
      profiles: PROFILES,
    })
    expect(entries).toHaveLength(0)
  })

  it('keeps a failed run from the settle record - it wrote no page and left no record', () => {
    const entries = buildResearchRuns({ runs: [], lastRuns: [settle()], nodes: [], profiles: PROFILES })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ status: 'failed', source: 'state', error: 'usage limit reached' })
  })

  it('does not add a settle row for a run that is already listed', () => {
    const entries = buildResearchRuns({
      runs: [run({ id: 'run-old', status: 'error', result: undefined, error: 'boom' })],
      lastRuns: [settle({ runId: 'run-old' })],
      nodes: [],
      profiles: PROFILES,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.status).toBe('failed')
  })

  it('sorts running first, then newest settled', () => {
    const entries = buildResearchRuns({
      runs: [
        run({ id: 'old', finishedAt: '2026-08-01T10:00:00.000Z', result: undefined, status: 'done' }),
        run({ id: 'live', status: 'running', finishedAt: undefined, result: undefined, label: 'Live topic' }),
      ],
      lastRuns: [],
      nodes: [node({ title: 'Research: Older - Patent Landscape', mtimeMs: Date.parse('2026-08-15T10:00:00.000Z') })],
      profiles: PROFILES,
    })
    expect(entries.map((e) => e.id)).toEqual(['live', 'page:wiki/questions/Research: Topic.md', 'old'])
  })
})

describe('targetTitle', () => {
  it('builds the deterministic page title the run will file as', () => {
    expect(targetTitle('Batteries', PROFILES[1])).toBe('Research: Batteries - State of the Art')
    expect(targetTitle('Batteries', PROFILES[0])).toBe('Research: Batteries')
    expect(targetTitle('Batteries', undefined)).toBe('Research: Batteries')
  })
})
