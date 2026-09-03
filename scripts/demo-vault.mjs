/**
 * Build a synthetic vault + operational database, so the dashboard can be screenshotted
 * without a single line of anyone's real notes.
 *
 * The README's screenshots used to come from the author's own vault. That leaked page
 * titles, people and sources into a public repo, and it also aged badly: a screenshot is
 * only re-shootable if the data behind it can be recreated. This script recreates it.
 *
 *   node scripts/demo-vault.mjs [--out DIR] [--db PATH]
 *
 * It is sized like a real vault on purpose - roughly 830 pages across 17 subject domains,
 * one of them far deeper than the rest. A hundred-page vault cannot show what the graph,
 * the domain filters or the library are FOR; the interesting behaviour (clusters, bridges,
 * gaps, orphans, a crowded colour legend) only appears at scale.
 *
 * Subject matter lives in `demo-vault-topics.mjs`. Everything is invented: textbook topics,
 * generic document titles, no real people or organisations. Page bodies are assembled from
 * templates - the titles are what a screenshot shows, and 500 hand-written bodies nobody
 * looks at would be busywork.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { DOMAINS, GAPS, CROSS_LINKS, SOURCE_SUFFIXES } from './demo-vault-topics.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const OUT = argOf('--out', join(homedir(), '.local/share/vault-service/demo-vault'))
const DB = argOf('--db', join(homedir(), '.local/share/vault-service/demo-jobs.db'))

/**
 * "Now", rounded down to the hour. Dates are all relative to it, so a re-shot screenshot
 * shows a vault that was worked on recently rather than one frozen in the past - and no
 * date can land in the future, which is what silently empties the growth chart.
 */
const TODAY = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000)
const day = (offset) => new Date(TODAY.getTime() - offset * 86_400_000)
const iso = (d) => d.toISOString().slice(0, 10)

/** The vault predates the growth chart's 30-day window, the way a real one does. */
const SPAN_DAYS = 74

/* --------------------------------------------------------------------------- page text */

/**
 * A page's filename IS its title in a claude-obsidian vault - that is also the label the
 * graph renders and the target `[[wikilinks]]` resolve against. Only characters the
 * filesystem dislikes get dropped.
 */
const fileName = (title) => title.replace(/[\\/:*?"<>|]/g, '').trim()

/** Rotating openers, so 500 concept pages do not all begin with the same sentence. */
const LEADS = [
  (t, d) => `${t} is one of the load-bearing ideas in ${d}: get it wrong and everything downstream inherits the error.`,
  (t, d) => `Within ${d}, ${t} is the piece that decides what a measurement can actually tell you.`,
  (t, d) => `${t} names a specific effect, not a general one. It matters in ${d} because the correction it demands is not optional.`,
  (t, d) => `The short version: ${t} is what happens when the idealised description of ${d} meets a real instrument.`,
  (t, d) => `${t} is usually introduced as a definition and then used as a constraint. Both readings show up across ${d}.`,
  (t, d) => `Most treatments of ${d} reach for ${t} at the point where the simple model stops predicting the data.`,
]

const DETAILS = [
  'The practical consequence is a trade-off rather than a rule. Push one side and the neighbouring effect starts to dominate; push the other and the measurement stops being sensitive to what you wanted to know.',
  'Two groups reporting different values are frequently both right and simply not measuring the same thing, which is why the method section matters more than the headline figure.',
  'The usual failure is to treat a convention as a fact. The number is only comparable to another taken under the same convention, and that convention is often unstated.',
  'It is cheap to state and expensive to satisfy. Most working practice sits at a compromise point and says so explicitly; the write-ups that do not are the ones later reanalyses disagree with.',
  'Where it breaks down is well characterised, which makes it useful: the failure mode is diagnostic, so an anomaly here usually points at a specific cause rather than at noise.',
]

const PRACTICE = [
  ['State the assumption that makes the simple form valid, and check it holds.',
   'Report the quantity actually measured, not the one it is usually converted into.',
   'Keep the raw observable: conversions are lossy and conventions change.'],
  ['Separate the systematic term from the statistical one before quoting an uncertainty.',
   'Say which correction was applied, and in which order.',
   'When results disagree, compare methods before comparing numbers.'],
  ['Record the configuration alongside the result - it is the part nobody can reconstruct later.',
   'Prefer a stated range over a single number with an implied precision.',
   'Re-derive at least one known value before trusting a new pipeline.'],
]

const pick = (arr, i) => arr[i % arr.length]

/* ------------------------------------------------------------------------ page building */

const pages = []

/**
 * Pages are collected without a date and stamped later - see `assignTimeline()`. Building
 * domain by domain and dating as you go produces a vault whose last month is one subject,
 * which is not how anyone reads: the library's "recently changed" view then shows a single
 * domain and the growth curve is a straight line.
 */
function page({ dir, title, type, domain, tags, body, related = [], sources = [], status = 'evergreen' }) {
  const rel = dir === '.' ? `wiki/${fileName(title)}.md` : `wiki/${dir}/${fileName(title)}.md`
  pages.push({ path: rel, domain, type, title, tags, body, related, sources, status, created: null })
}

/** Renders the frontmatter once the page has a date. */
function render(p) {
  return [
    '---',
    `type: ${p.type}`,
    `title: "${p.title}"`,
    `domain: ${p.domain}`,
    `created: ${iso(p.created)}`,
    `updated: ${iso(p.created)}`,
    'tags:',
    ...p.tags.map((t) => `  - ${t}`),
    `status: ${p.status}`,
    ...(p.related.length ? ['related:', ...p.related.map((r) => `  - "[[${r}]]"`)] : []),
    ...(p.sources.length ? ['sources:', ...p.sources.map((x) => `  - "[[${x}]]"`)] : []),
    '---',
    '',
  ].join('\n') + p.body + '\n'
}

/** Pick n neighbours around an index, wrapping - links without randomness. */
const around = (arr, i, n) =>
  Array.from({ length: n }, (_, k) => arr[(i + k + 1) % arr.length]).filter((x) => x !== undefined && x !== arr[i])

let gapSeq = 0

for (const [domain, spec] of Object.entries(DOMAINS)) {
  const conceptTitles = spec.concepts

  // Roughly one ingested document per 2.7 concepts, which is about the real ratio.
  const sourceCount = Math.ceil(conceptTitles.length / 2.7)
  const sourceTitles = []
  for (let i = 0; i < sourceCount; i++) {
    const anchor = conceptTitles[Math.floor((i * conceptTitles.length) / sourceCount)]
    sourceTitles.push(`${anchor} ${pick(SOURCE_SUFFIXES, i + domain.length)}`)
  }

  conceptTitles.forEach((title, i) => {
    const related = around(conceptTitles, i, i % 4 === 0 ? 4 : 2)
    const cross = CROSS_LINKS.find(([a]) => a === title)
    if (cross) related.push(cross[1])
    // Every fifth concept points at a page nobody has written - the Gaps overlay counts these.
    const gap = i % 5 === 2 ? GAPS[gapSeq++ % GAPS.length] : null
    const linked = around(conceptTitles, i + 3, 2)
    page({
      dir: 'concepts',
      title,
      type: 'concept',
      domain,
      tags: ['concept', ...spec.tags.slice(0, 3)],
      related,
      sources: [sourceTitles[i % sourceTitles.length]],
      status: i % 17 === 5 ? 'stub' : 'evergreen',
      body: [
        `# ${title}`,
        '',
        pick(LEADS, i)(title, spec.blurb),
        '',
        '## Why it matters',
        '',
        `It sits directly under ${linked.map((l) => `[[${l}]]`).join(' and ')}, which is why it turns up`,
        `whenever ${spec.blurb} is discussed at any depth.`,
        '',
        '## Detail',
        '',
        pick(DETAILS, i),
        pick(DETAILS, i + 3),
        '',
        '## In practice',
        '',
        ...pick(PRACTICE, i).map((l) => `- ${l}`),
        '',
        '## See also',
        '',
        ...related.map((r) => `- [[${r}]]`),
        ...(gap ? ['', `Still to write: [[${gap}]].`] : []),
      ].join('\n'),
    })
  })

  spec.entities.forEach((title, i) => {
    page({
      dir: 'entities',
      title,
      type: 'entity',
      domain,
      tags: ['entity', 'organization', ...spec.tags.slice(0, 2)],
      related: around(conceptTitles, i * 5, 3),
      body: [
        `# ${title}`,
        '',
        `Appears throughout the ${domain} material as the thing that produced, holds or standardises`,
        'the data other pages argue about.',
        '',
        '## Role',
        '',
        'Pages cite it when the provenance of a number matters: what was measured, under which',
        'programme, and which release the figure came from.',
        '',
        '## What it constrains',
        '',
        'Its coverage and cadence set what questions can be asked at all. A gap in the record is not',
        'a null result, and treating it as one is the most common way conclusions drift from what the',
        'data can support.',
        '',
        '## Related',
        '',
        ...around(conceptTitles, i * 5, 4).map((c) => `- [[${c}]]`),
      ].join('\n'),
    })
  })

  sourceTitles.forEach((title, i) => {
    const cited = around(conceptTitles, i * 3, 5)
    page({
      dir: 'sources',
      title,
      type: 'source',
      domain,
      tags: ['source', ...spec.tags.slice(0, 2)],
      related: cited,
      status: 'reference',
      body: [
        `# ${title}`,
        '',
        `A synthetic stand-in for an ingested document about ${spec.blurb}. It exists so the`,
        'dashboard has provenance to show: the pages below were written from it.',
        '',
        '## Summary',
        '',
        'Reviews the established method, states where it breaks down, and proposes a correction that',
        'trades a little precision for a good deal of robustness. The useful contribution is the',
        'failure catalogue rather than the correction itself.',
        '',
        '## Extracted claims',
        '',
        ...cited.map((c) => `- Supports [[${c}]].`),
        '',
        '## Caveats',
        '',
        '- The sample is convenient rather than representative.',
        '- Uncertainties are quoted as statistical only; the systematic term is larger.',
      ].join('\n'),
    })
  })

  // A couple of open questions per domain, more for the deep ones.
  const questionCount = Math.min(5, 1 + Math.floor(conceptTitles.length / 30))
  for (let i = 0; i < questionCount; i++) {
    const anchor = conceptTitles[(i * 11) % conceptTitles.length]
    const cited = around(conceptTitles, i * 7, 3)
    page({
      dir: 'questions',
      title: `What actually limits ${anchor.toLowerCase()}?`,
      type: 'question',
      domain,
      tags: ['question', ...spec.tags.slice(0, 2)],
      related: [anchor, ...cited],
      status: 'open',
      body: [
        `# What actually limits ${anchor.toLowerCase()}?`,
        '',
        'Asked while reading, answered from the pages below.',
        '',
        '## Working answer',
        '',
        'Not one mechanism but two that are easy to confuse, because they leave the same signature in',
        'the usual summary plot and separate only when the raw observable is kept. The pages below',
        'cover each in turn; the comparison between them is where the answer is.',
        '',
        '## Sources of the answer',
        '',
        `- [[${anchor}]]`,
        ...cited.map((c) => `- [[${c}]]`),
        '',
        '',
        '## Why it is not settled',
        '',
        'The two candidate explanations predict the same thing everywhere the usual data set has',
        'coverage, and differ only in the regime that is hardest to measure. Ruling one out needs',
        'either a longer baseline or an instrument that does not share the systematic, and neither',
        'is available on the timescale most projects work to.',
        '',
        'Still open: whether the distinction matters at the precision most work reports.',
      ].join('\n'),
    })
  }

  // One comparison per domain that has enough to compare.
  if (conceptTitles.length >= 12) {
    const [a, b, c] = conceptTitles
    page({
      dir: 'comparisons',
      title: `${a} vs ${b}`,
      type: 'comparison',
      domain,
      tags: ['comparison', ...spec.tags.slice(0, 2)],
      related: [a, b, c],
      body: [
        `# ${a} vs ${b}`,
        '',
        'Two approaches to the same problem, with different failure modes.',
        '',
        `| | [[${a}]] | [[${b}]] |`,
        '|---|---|---|',
        '| Measures | the direct observable | the indirect one |',
        '| Needs | a favourable configuration | a quiet baseline |',
        '| Fails on | edge geometry | correlated noise |',
        '',
        `Where they disagree, [[${c}]] is usually the reason.`,
        '',
        '## When to reach for which',
        '',
        `Use [[${a}]] when the configuration cooperates and you want the quantity directly; the`,
        'result is then easy to defend and needs little modelling. Its weakness is that the',
        'favourable case is rare, so a survey built on it alone measures a biased subset.',
        '',
        `[[${b}]] applies far more widely and is correspondingly harder to interpret: what it`,
        'returns is a lower bound rather than the quantity itself, and the correction between the',
        'two carries the assumption most disagreements turn out to be about.',
        '',
        'In practice the two are complementary rather than competing, and the pages that combine',
        'them report the tightest constraints.',
      ].join('\n'),
    })
  }
}

/* Two pages deliberately unfiled, so the `unassigned` bucket is not empty. */
for (const title of ['Signal Averaging Across Instruments', 'Calibration Drift']) {
  page({
    dir: 'concepts',
    title,
    type: 'concept',
    domain: 'unassigned',
    tags: ['concept', 'measurement'],
    related: ['Photometric Precision', 'Proxy Calibration'],
    body: [
      `# ${title}`,
      '',
      'Belongs to measurement in general rather than to one subject, so it is filed nowhere yet.',
      '',
      'Related: [[Photometric Precision]], [[Proxy Calibration]].',
    ].join('\n'),
  })
}

/* References and meta: the wiki's own machinery, which the System toggle hides in the graph. */
page({
  dir: 'references',
  title: 'Unit Conventions',
  type: 'reference',
  domain: 'meta',
  tags: ['reference', 'meta'],
  status: 'reference',
  body: ['# Unit Conventions', '',
    'Which units pages use when a field could reasonably take several.', '',
    '- Radii in Earth radii for rocky planets, Jupiter radii above.',
    '- Temperatures in kelvin in [[Equilibrium Temperature]] contexts, Celsius in [[Maillard Reaction]] ones.',
    '- Byte sizes are powers of ten unless a page says otherwise.'].join('\n'),
})
page({
  dir: 'references',
  title: 'Citation Style',
  type: 'reference',
  domain: 'meta',
  tags: ['reference', 'meta'],
  status: 'reference',
  body: ['# Citation Style', '',
    'Sources are pages. A claim cites the source page, which links back to the raw document.', '',
    'See [[Unit Conventions]] for the other house rule.'].join('\n'),
})
page({
  dir: '.',
  title: 'index',
  type: 'meta',
  domain: 'meta',
  tags: ['meta', 'index'],
  body: ['# Index', '', 'Entry point to the wiki.', '',
    ...Object.entries(DOMAINS).map(([d, s]) => `- **${d}** - ${s.blurb}`)].join('\n'),
})
page({
  dir: '.',
  title: 'hot',
  type: 'meta',
  domain: 'meta',
  tags: ['meta', 'hot-cache'],
  body: ['# Hot Cache', '', 'A digest of the vault, refreshed after ingests.', '',
    `Currently ${pages.length + 2} pages across ${Object.keys(DOMAINS).length} domains.`, '',
    'One subject is far deeper than the others; the long tail is one-afternoon detours.'].join('\n'),
})

/** The domain registry, in the shape install-domain-registry.sh seeds. */
const registry = [
  '---', 'type: meta', 'title: "Domain Registry"', 'domain: meta',
  `created: ${iso(day(SPAN_DAYS))}`, `updated: ${iso(day(4))}`,
  'tags:', '  - meta', '  - domains', 'status: evergreen', '---', '',
  '# Domain Registry', '',
  'The list of meta-categories this wiki uses. Every page carries exactly one of these keys in',
  'its `domain:` frontmatter field. This page is the single source of truth for that list.', '',
  '## Domains', '',
  ...Object.entries(DOMAINS).flatMap(([key, spec]) => [
    `## ${key}`, '',
    spec.blurb.charAt(0).toUpperCase() + spec.blurb.slice(1) + '.', '',
    `**Tags:** ${spec.tags.map((t) => `\`${t}\``).join(', ')}`, '',
  ]),
  '## meta', '',
  "The wiki's own machinery rather than a subject: index and overview pages, the hot cache, and",
  'this page.', '', '**Tags:** `meta`, `index`, `hot-cache`', '',
].join('\n')
pages.push({
  path: 'wiki/meta/domains.md', domain: 'meta', type: 'meta', title: 'Domain Registry',
  tags: ['meta', 'domains'], related: [], sources: [], status: 'evergreen',
  body: registry, created: day(SPAN_DAYS), prerendered: true,
})

/* --------------------------------------------------------------------------- timeline */

/**
 * Stamp every page with a creation date, in reading order rather than build order.
 *
 * Pages are built domain by domain, but nobody reads that way: a real vault interleaves
 * subjects, a few pages at a sitting. So the pages are cut into sittings (a source page plus
 * the concepts around it stay together, which is also what one ingest writes), the sittings
 * are shuffled deterministically, and the sittings are then laid down across the span with an
 * uneven cadence - busy weeks and quiet ones - so the growth curve has a shape.
 */
function assignTimeline() {
  const undated = pages.filter((p) => p.created === null)
  const sittings = []
  for (let i = 0; i < undated.length; i += 6) sittings.push(undated.slice(i, i + 6))

  // Deterministic shuffle (LCG): same input, same vault, same screenshot.
  let state = 20260827
  const rand = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let i = sittings.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[sittings[i], sittings[j]] = [sittings[j], sittings[i]]
  }

  // Uneven cadence: weight each sitting so some days take several and others none.
  const weights = sittings.map((_, i) => 0.35 + Math.abs(Math.sin(i * 0.7)) + (i % 11 === 0 ? 1.6 : 0))
  const total = weights.reduce((a, b) => a + b, 0)
  let acc = 0
  sittings.forEach((sitting, i) => {
    acc += weights[i]
    const daysAgo = Math.max(2, Math.round(SPAN_DAYS - (acc / total) * (SPAN_DAYS - 2)))
    for (const pg of sitting) pg.created = day(daysAgo)
  })
}
assignTimeline()

/* ------------------------------------------------------------------------- write it out */

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
for (const dir of ['wiki/concepts', 'wiki/entities', 'wiki/sources', 'wiki/questions',
                   'wiki/comparisons', 'wiki/references', 'wiki/meta', 'skills/ingest', '.raw']) {
  mkdirSync(join(OUT, dir), { recursive: true })
}
writeFileSync(join(OUT, 'skills/ingest/SKILL.md'),
  '---\nname: ingest\ndescription: Demo placeholder so the vault shape validates.\n---\n\n# ingest\n\nPlaceholder.\n')
writeFileSync(join(OUT, 'README.md'),
  '# Demo vault\n\nGenerated by `scripts/demo-vault.mjs`. Every page here is synthetic.\n')

for (const p of pages) {
  p.content = p.prerendered === true ? p.body : render(p)
  mkdirSync(dirname(join(OUT, p.path)), { recursive: true })
  writeFileSync(join(OUT, p.path), p.content)
  // Without this every page reads "1 min ago" in the library's Changed column.
  utimesSync(join(OUT, p.path), p.created, p.created)
}

/* --------------------------------------------------------------------------- provenance */

/**
 * `.raw/<job>/` holds the document an ingest read, and `.raw/.manifest.json` maps each raw
 * file to the pages it created. That tracker - not SQLite - is what the Library's Source
 * column reads, because provenance has to survive losing the operational database.
 */
const STUB_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj',
  '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  '5 0 obj<</Length 58>>stream',
  'BT /F1 10 Tf 16 64 Td (Synthetic demo document.) Tj ET',
  'endstream endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n')

const slugFile = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
const rawSources = {}
const sourcePageList = pages.filter((p) => p.path.startsWith('wiki/sources/'))
const jobRecords = []

sourcePageList.forEach((sp, i) => {
  const jobId = `demo-${String(i + 1).padStart(3, '0')}`
  const title = /^title: "(.+)"$/m.exec(sp.content)?.[1] ?? 'document'
  const isWeb = i % 9 === 4
  const isText = i % 17 === 7
  const name = `${slugFile(title)}.${isWeb ? 'html' : isText ? 'md' : 'pdf'}`
  mkdirSync(join(OUT, '.raw', jobId), { recursive: true })
  writeFileSync(join(OUT, '.raw', jobId, name),
    isWeb ? '<!doctype html><title>Synthetic demo document</title><p>Generated for screenshots.</p>\n'
      : isText ? '# Synthetic demo document\n\nGenerated for screenshots.\n' : STUB_PDF)
  const url = isWeb ? `https://example.invalid/${slugFile(title)}` : null
  writeFileSync(join(OUT, '.raw', jobId, 'manifest.json'),
    JSON.stringify({ original: name, type: isWeb ? 'web' : isText ? 'text' : 'pdf', url }, null, 2) + '\n')
  // The source page itself, plus the concepts that cite it.
  const created = [
    sp.path,
    ...pages
      .filter((q) => q.path.startsWith('wiki/concepts/') && q.content.includes(`[[${title}]]`))
      .slice(0, 5)
      .map((q) => q.path),
  ]
  rawSources[`.raw/${jobId}/${name}`] = { ingested_at: sp.created.toISOString(), pages_created: created }
  jobRecords.push({ jobId, name, url, type: isWeb ? 'web' : isText ? 'text' : 'pdf', created, at: sp.created })
})
writeFileSync(join(OUT, '.raw', '.manifest.json'), JSON.stringify({ sources: rawSources }, null, 2) + '\n')

/* --------------------------------------------------------------- backdated git history */

const git = (a, env = {}) => execFileSync('git', a, { cwd: OUT, env: { ...process.env, ...env }, stdio: 'pipe' })

git(['init', '-q', '-b', 'vault-main'])
git(['config', 'user.name', 'LibrisVault Demo'])
git(['config', 'user.email', 'demo@example.invalid'])

/**
 * Chronological, because `git log --since` walks the parent chain and stops at the first
 * commit older than the window. A single out-of-order date (the registry page is built last
 * but dated first) truncates the history the growth chart can see to one day.
 */
const ordered = [...pages].sort((a, b) => a.created - b.created)
const commitPlan = []
let bucket = []
for (const p of ordered) {
  bucket.push(p)
  // An ingest typically writes a source page plus a handful of concepts.
  if (bucket.length >= 6) {
    commitPlan.push(bucket)
    bucket = []
  }
}
if (bucket.length) commitPlan.push(bucket)

git(['add', 'README.md', 'skills', '.raw'])
git(['commit', '-q', '-m', 'chore: vault scaffold'], {
  GIT_AUTHOR_DATE: day(SPAN_DAYS + 1).toISOString(),
  GIT_COMMITTER_DATE: day(SPAN_DAYS + 1).toISOString(),
})

const commitNames = jobRecords.map((j) => j.name)
commitPlan.forEach((group, i) => {
  const when = group[group.length - 1].created
  const stamp = new Date(when.getTime() + (i % 9) * 3_600_000).toISOString()
  for (const p of group) git(['add', '--', p.path])
  const name = commitNames[i % commitNames.length]
  git(['commit', '-q', '-m', `ingest: ${name}`], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp })
})

console.log(`vault:  ${OUT}`)
console.log(`        ${pages.length} pages, ${Object.keys(DOMAINS).length} domains, ${commitPlan.length + 1} commits`)

/* ------------------------------------------------------------- the operational database */

const { default: Database } = await import('better-sqlite3')
mkdirSync(dirname(DB), { recursive: true })
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })

const { migrate } = await import(join(process.cwd(), 'server/dist/db/index.js'))
const db = new Database(DB)
migrate(db)

const ulid = (n) => `01DEMO${String(n).padStart(20, '0')}`
const at = (d) => d.toISOString()

const jobStmt = db.prepare(
  `INSERT INTO jobs (id, user_id, source, type, original_name, url, sha256, status, created_pages,
                     attempts, tokens_in, tokens_out, cost_usd, created_at, started_at, finished_at, error)
   VALUES (@id, 'local', @source, @type, @original_name, @url, @sha256, @status, @created_pages,
           @attempts, @tokens_in, @tokens_out, @cost_usd, @created_at, @started_at, @finished_at, @error)`,
)

/**
 * Only recent ingests get a job row. The dashboard's history is operational state with a
 * 30-day view; an older vault has pages whose job record was long since cleared, which is
 * exactly the state a real install is in.
 */
const recentJobs = jobRecords.filter((j) => j.at >= day(30))
recentJobs.forEach((j, i) => {
  jobStmt.run({
    id: ulid(i + 1),
    source: i % 6 === 0 ? 'watch' : j.type === 'web' ? 'url' : 'drop',
    type: j.type,
    original_name: j.name,
    url: j.url,
    sha256: `demo${String(i).padStart(60, '0')}`,
    status: 'done',
    created_pages: JSON.stringify(j.created),
    attempts: 1,
    tokens_in: 34_000 + ((i * 2_411) % 60_000),
    tokens_out: 4_800 + ((i * 317) % 9_000),
    cost_usd: Number((0.18 + ((i * 37) % 210) / 400).toFixed(3)),
    created_at: at(j.at),
    started_at: at(new Date(j.at.getTime() + 20_000)),
    finished_at: at(new Date(j.at.getTime() + 190_000 + (i % 11) * 9_000)),
    error: null,
  })
})

/* One failure and one duplicate, so the filters and the status vocabulary are visible. */
jobStmt.run({
  id: ulid(900), source: 'drop', type: 'pdf', original_name: 'scanned-handout.pdf', url: null,
  sha256: `demo${String(900).padStart(60, '0')}`, status: 'failed', created_pages: '[]', attempts: 2,
  tokens_in: 4_100, tokens_out: 200, cost_usd: 0.02,
  created_at: at(day(3)), started_at: at(day(3)), finished_at: at(new Date(day(3).getTime() + 64_000)),
  error: 'preprocessing: no extractable text layer (OCR produced 12 characters)',
})
jobStmt.run({
  id: ulid(901), source: 'watch', type: 'pdf',
  original_name: recentJobs[2]?.name ?? 'duplicate.pdf', url: null,
  sha256: `dup${String(901).padStart(61, '0')}`, status: 'duplicate', created_pages: '[]', attempts: 1,
  tokens_in: null, tokens_out: null, cost_usd: null,
  created_at: at(day(2)), started_at: at(day(2)), finished_at: at(new Date(day(2).getTime() + 1_400)),
  error: null,
})

/** Agent runs: what System's usage section and Home's stream read. */
const runStmt = db.prepare(
  `INSERT INTO agent_runs (id, user_id, kind, label, profile_key, ok, pages, tokens_in, tokens_out,
                           cost_usd, error, started_at, finished_at)
   VALUES (@id, 'local', @kind, @label, @profile_key, @ok, @pages, @tokens_in, @tokens_out,
           @cost_usd, NULL, @started_at, @finished_at)`,
)
const conceptPaths = pages.filter((p) => p.path.startsWith('wiki/concepts/')).map((p) => p.path)
const RUNS = [
  ['research', 'Atmospheric retrieval at low resolution', 'sota', 7, 268_000, 21_400, 2.34, 4],
  ['research', 'Ocean carbon sink capacity', 'broad', 5, 191_000, 15_100, 1.62, 9],
  ['research', 'Storage engine trade-offs under write amplification', 'broad', 4, 158_000, 12_800, 1.31, 14],
  ['research', 'Recent patents on adaptive optics', 'patents', 3, 121_000, 9_900, 1.04, 19],
  ['research', 'Who is funding fermentation biotech', 'startups', 4, 143_000, 11_200, 1.19, 26],
  ['lint', null, null, 0, 118_000, 3_900, 0.52, 1],
  ['hot-cache', null, null, 1, 47_000, 2_300, 0.21, 1],
  ['domain-backfill', null, null, 23, 104_000, 7_800, 0.63, 6],
  ['lint-fix', null, null, 8, 88_000, 6_400, 0.51, 2],
  ['domain-review', null, null, 0, 39_000, 2_100, 0.18, 8],
]
RUNS.forEach(([kind, label, profile, pageCount, tin, tout, cost, daysAgo], i) => {
  const started = day(daysAgo)
  runStmt.run({
    id: ulid(200 + i), kind, label, profile_key: profile, ok: 1,
    pages: JSON.stringify(conceptPaths.slice(i * 17, i * 17 + pageCount)),
    tokens_in: tin, tokens_out: tout, cost_usd: cost,
    started_at: at(started), finished_at: at(new Date(started.getTime() + 300_000 + i * 40_000)),
  })
})

/** Saved conversations, so Research opens with a ledger rather than an empty state. */
const sess = db.prepare(`INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (?, 'local', ?, ?, ?)`)
const msg = db.prepare(`INSERT INTO messages (session_id, role, content, citations, ts) VALUES (?, ?, ?, ?, ?)`)
const CONVOS = [
  ['What sets the noise floor of a transit survey?', 3],
  ['How do proxy records constrain climate sensitivity?', 7],
  ['Why prefix chunks before indexing them?', 11],
  ['When is a log-structured store the wrong choice?', 16],
  ['What makes a fermentation stall?', 22],
]
CONVOS.forEach(([title, daysAgo], i) => {
  const id = ulid(300 + i)
  const when = day(daysAgo)
  sess.run(id, title, at(when), at(new Date(when.getTime() + 120_000)))
  msg.run(id, 'user', title, '[]', at(when))
  msg.run(id, 'assistant',
    'Short answer first, then the pages it came from.\n\nThe limit is set by a combination of the instrument and the source itself; see the linked pages for the split between the two.',
    JSON.stringify(
      pages
        .filter((p) => p.path.startsWith('wiki/concepts/'))
        .slice(i * 23, i * 23 + 3)
        .map((p) => ({ path: p.path, title: /^title: "(.+)"$/m.exec(p.content)?.[1] ?? p.path })),
    ),
    at(new Date(when.getTime() + 60_000)))
})

db.close()
console.log(`db:     ${DB}`)
console.log(`        ${recentJobs.length + 2} jobs, ${RUNS.length} runs, ${CONVOS.length} conversations`)
