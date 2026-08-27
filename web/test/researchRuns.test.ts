import { describe, it, expect } from 'vitest'
import {
  buildResearchRuns,
  listedRuns,
  splitResearchTitle,
  synthesisPage,
  targetTitle,
  type ResearchRunEntry,
} from '../src/lib/researchRuns.ts'
import type {
  AgentRunRecord,
  GraphNode,
  MaintenanceAreaState,
  MaintenanceRun,
  ResearchProfile,
} from '../src/api/types.ts'

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

const history = (over: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  id: 'hist-1',
  kind: 'research',
  label: 'Topic',
  profileKey: 'broad',
  ok: true,
  pages: ['wiki/questions/Research: Topic.md'],
  tokensIn: 1000,
  tokensOut: 200,
  costUsd: 2.4,
  error: null,
  startedAt: '2026-08-20T09:40:00.000Z',
  finishedAt: '2026-08-20T10:00:00.000Z',
  ...over,
})

describe('buildResearchRuns with the persistent run log', () => {
  it('lists a recorded run with the facts only the log keeps', () => {
    const entries = buildResearchRuns({
      history: [history()],
      runs: [],
      lastRuns: [],
      nodes: [],
      profiles: PROFILES,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      topic: 'Topic',
      profileKey: 'broad',
      costUsd: 2.4,
      startedAt: '2026-08-20T09:40:00.000Z',
      source: 'history',
    })
  })

  it('keeps a failed run that never wrote a page', () => {
    const entries = buildResearchRuns({
      history: [history({ id: 'bad', ok: false, pages: [], error: 'usage limit reached' })],
      runs: [],
      lastRuns: [],
      nodes: [],
      profiles: PROFILES,
    })
    expect(entries[0]).toMatchObject({ status: 'failed', error: 'usage limit reached' })
  })

  it('does not list the same run twice when the registry still holds it', () => {
    const entries = buildResearchRuns({
      history: [history({ id: 'shared' })],
      runs: [run({ id: 'shared' })],
      lastRuns: [],
      nodes: [],
      profiles: PROFILES,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.source).toBe('history')
  })

  it('still shows a run that is in flight - the log only has settled ones', () => {
    const entries = buildResearchRuns({
      history: [history({ id: 'old' })],
      runs: [run({ id: 'live', status: 'running', finishedAt: undefined, result: undefined, label: 'Live' })],
      lastRuns: [],
      nodes: [],
      profiles: PROFILES,
    })
    expect(entries.map((e) => e.id)).toEqual(['live', 'old'])
    expect(entries[0]!.status).toBe('running')
  })

  it('drops the vault page of a run the log already covers', () => {
    const entries = buildResearchRuns({
      history: [history()],
      runs: [],
      lastRuns: [],
      nodes: [node()],
      profiles: PROFILES,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.source).toBe('history')
  })

  it('keeps pages of runs that predate the log', () => {
    const entries = buildResearchRuns({
      history: [history()],
      runs: [],
      lastRuns: [],
      nodes: [node({ path: 'wiki/questions/Research: Older.md', title: 'Research: Older' })],
      profiles: PROFILES,
    })
    expect(entries.map((e) => e.source).sort()).toEqual(['history', 'page'])
  })

  it('drops a settle row the log already explains', () => {
    const entries = buildResearchRuns({
      history: [history({ id: 'run-old', ok: false, pages: [], error: 'boom' })],
      runs: [],
      lastRuns: [settle({ runId: 'run-old' })],
      nodes: [],
      profiles: PROFILES,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.source).toBe('history')
  })
})

describe('what a run is recorded as having written', () => {
  /**
   * The run log records what the run's COMMIT carried, which always includes the index hubs
   * a run touches in passing. Counting those told the reader a run of two pages wrote six,
   * and listed `index`, `hot`, `log` and the `_index` MOCs among its results.
   */
  it('leaves the index hubs out of a run\'s pages', () => {
    const entries = buildResearchRuns({
      history: [
        history({
          pages: [
            'wiki/questions/Research: Topic.md',
            'wiki/concepts/A Real Page.md',
            'wiki/concepts/_index.md',
            'wiki/sources/_index.md',
            'wiki/index.md',
            'wiki/hot.md',
            'wiki/log.md',
            'wiki/overview.md',
          ],
        }),
      ],
      runs: [],
      lastRuns: [],
      nodes: [],
      profiles: PROFILES,
    })
    expect(entries[0]!.pages).toEqual(['wiki/questions/Research: Topic.md', 'wiki/concepts/A Real Page.md'])
  })

  /**
   * A file name drops the characters the filesystem dislikes; the page's own title keeps
   * them, and the run log records the topic as typed. Comparing by file name alone, a run
   * about "implantable/wearable" did not recognise its own page and was reconstructed a
   * second time - so the ledger showed the run twice, the copy claiming a single page.
   */
  it('does not reconstruct a run whose page name lost a character to the filesystem', () => {
    const topic = 'Nanoparticle-based implantable/wearable drug delivery'
    const entries = buildResearchRuns({
      history: [history({ id: 'h1', label: topic, profileKey: 'sota', pages: ['wiki/concepts/Some Page.md'] })],
      runs: [],
      lastRuns: [],
      nodes: [
        node({
          path: 'wiki/questions/Research: Nanoparticle-based implantable_wearable drug delivery - State of the Art.md',
          title: 'Research: Nanoparticle-based implantable_wearable drug delivery - State of the Art',
          names: [`Research: ${topic} - State of the Art`],
          mtimeMs: Date.parse('2026-08-20T10:00:00.000Z'),
        }),
      ],
      profiles: PROFILES,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.source).toBe('history')
  })

  it('still reconstructs a page no run in the log accounts for', () => {
    const entries = buildResearchRuns({
      history: [],
      runs: [],
      lastRuns: [],
      nodes: [
        node({
          path: 'wiki/questions/Research: Older Topic - State of the Art.md',
          title: 'Research: Older Topic - State of the Art',
        }),
      ],
      profiles: PROFILES,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ topic: 'Older Topic', source: 'page', profileKey: 'sota' })
  })

  it('names a reconstructed run by the page\'s own title, not by its file name', () => {
    const entries = buildResearchRuns({
      history: [],
      runs: [],
      lastRuns: [],
      nodes: [
        node({
          path: 'wiki/questions/Research: a_b - State of the Art.md',
          title: 'Research: a_b - State of the Art',
          names: ['Research: a/b - State of the Art'],
        }),
      ],
      profiles: PROFILES,
    })
    expect(entries[0]!.topic).toBe('a/b')
  })
})

/**
 * What the ledger LISTS, as opposed to what the merge can reconstruct (2026-08-27).
 *
 * A run rebuilt from its synthesis page is a real run, but the only timestamp it carries is
 * the page's mtime - and that is not when the run happened. One vault had eleven such pages
 * sharing a single bulk-touch mtime to the microsecond, and the ledger reported all eleven
 * as having run at the same instant. The pages stay reachable from the Library and the
 * Graph; what is dropped is the claim that these rows are dated records.
 */
describe('listedRuns', () => {
  const entry = (over: Partial<ResearchRunEntry> = {}): ResearchRunEntry => ({
    id: 'e',
    topic: 'Topic',
    profileKey: 'broad',
    status: 'done',
    startedAt: null,
    finishedAt: null,
    pages: [],
    costUsd: null,
    error: null,
    source: 'history',
    pagePath: null,
    ...over,
  })

  it('drops the runs reconstructed from a vault page', () => {
    const out = listedRuns([
      entry({ id: 'a', source: 'history' }),
      entry({ id: 'b', source: 'page', pagePath: 'wiki/questions/Research: Topic.md' }),
    ])
    expect(out.map((e) => e.id)).toEqual(['a'])
  })

  it('keeps everything the service itself recorded', () => {
    const out = listedRuns([
      entry({ id: 'a', source: 'history' }),
      entry({ id: 'b', source: 'run', status: 'running' }),
      entry({ id: 'c', source: 'state', status: 'failed' }),
    ])
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('leaves two runs of the same topic and lens as two rows', () => {
    // "Run again" is a button on the detail. Collapsing a re-run into the older run because
    // it happens to have filed fewer pages would hide the run the reader just started.
    const out = listedRuns([
      entry({ id: 'new', pages: ['wiki/concepts/A.md'] }),
      entry({ id: 'old', pages: ['wiki/concepts/A.md', 'wiki/concepts/B.md'] }),
    ])
    expect(out.map((e) => e.id)).toEqual(['new', 'old'])
  })
})

/**
 * Resolving the page a run was FOR. The client used to guess it from the deterministic
 * title alone; the agent names the page itself and does not always land there, and when the
 * guess missed, the detail view rendered no article at all (2026-08-27).
 */
describe('synthesisPage', () => {
  const entry = (over: Partial<ResearchRunEntry> = {}): ResearchRunEntry => ({
    id: 'e',
    topic: 'quantum computing',
    profileKey: 'sota',
    status: 'done',
    startedAt: null,
    finishedAt: null,
    pages: [],
    costUsd: null,
    error: null,
    source: 'history',
    pagePath: null,
    ...over,
  })

  it('takes the questions page the run actually committed', () => {
    const e = entry({
      topic: 'expected impact of climate change on property prices in europe',
      profileKey: 'broad',
      pages: [
        'wiki/concepts/Climate Gentrification.md',
        'wiki/questions/Research: climate change impact on European property prices.md',
        'wiki/sources/Some Source.md',
      ],
    })
    // The deterministic title would have been "Research: expected impact of climate change
    // …", which matches no page here - and used to leave the detail with no article.
    expect(synthesisPage(e, PROFILES, [])).toBe(
      'wiki/questions/Research: climate change impact on European property prices.md',
    )
  })

  it('falls back to the page that answers to the deterministic name', () => {
    // Observed: the synthesis page is missing from the commit's page list while the page
    // itself sits in the vault.
    const e = entry({ pages: ['wiki/concepts/Surface Code.md'] })
    const nodes = [
      node({
        path: 'wiki/questions/Research: quantum computing - State of the Art.md',
        title: 'Research: quantum computing - State of the Art',
      }),
    ]
    expect(synthesisPage(e, PROFILES, nodes)).toBe(
      'wiki/questions/Research: quantum computing - State of the Art.md',
    )
  })

  it('prefers the page a reconstructed entry already knows about', () => {
    const e = entry({ source: 'page', pagePath: 'wiki/questions/Research: X.md', pages: [] })
    expect(synthesisPage(e, PROFILES, [])).toBe('wiki/questions/Research: X.md')
  })

  it('ignores a questions page that is not a synthesis page', () => {
    const e = entry({ pages: ['wiki/questions/Why does this happen.md'] })
    expect(synthesisPage(e, PROFILES, [])).toBeNull()
  })

  it('is null when the run wrote no page and none answers to the name', () => {
    expect(synthesisPage(entry(), PROFILES, [])).toBeNull()
  })
})
