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
 * Everything it writes is invented: the topics are textbook subject matter, the "sources"
 * are generic document titles with no authors, and no page describes a real person or
 * organisation's private material. The git history is backdated so the growth chart and
 * the commit list have something to show.
 *
 * It is deliberately deterministic - same input, same vault, same numbers in every tile -
 * so a re-shot screenshot differs only where the UI changed.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

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

/* ------------------------------------------------------------------ the subject matter */

/**
 * Five domains plus `meta`, chosen to look like a real personal wiki: a science one with
 * deep structure, a second science one that overlaps it at the edges, a technical one, a
 * practical one, and the wiki's own theory. Overlap matters - it is what gives the graph
 * cross-domain links instead of five disconnected balls.
 */
const DOMAINS = {
  astronomy: {
    color: 'exoplanets and the instruments that find them',
    tags: ['astronomy', 'exoplanet', 'spectroscopy', 'photometry', 'telescope'],
    concepts: [
      ['Transit Photometry', 'A planet crossing its star dims it by a few parts in ten thousand. Repeat the dip and you have a period; measure its depth and you have a radius ratio.'],
      ['Radial Velocity Method', 'The star wobbles around the common centre of mass. The wobble shifts its spectral lines, and the shift gives a minimum mass.'],
      ['Transit Depth', 'The fractional drop in flux during a transit, equal to the square of the planet-to-star radius ratio for an opaque disc.'],
      ['Limb Darkening', 'A stellar disc is dimmer at its edge, which rounds the shoulders of a transit light curve and biases a naive radius fit.'],
      ['Transit Timing Variations', 'Deviations from a strict period betray a second body tugging on the transiting one, sometimes one too small to transit itself.'],
      ['Habitable Zone', 'The orbital band where a rocky planet could hold liquid surface water, given an atmosphere. A crude filter, not a verdict.'],
      ['Atmospheric Transmission Spectroscopy', 'During transit a sliver of starlight passes through the planet atmosphere, imprinting molecular absorption on the spectrum.'],
      ['Secondary Eclipse', 'When the planet passes behind its star, the missing planetary emission gives its day-side brightness temperature.'],
      ['Stellar Activity Noise', 'Spots and faculae mimic and mask planetary signals, and they are the dominant systematic in both detection methods.'],
      ['Radius Valley', 'A deficit of planets near 1.8 Earth radii, read as the boundary between rocky cores and those that kept a hydrogen envelope.'],
      ['Photometric Precision', 'The noise floor of a light curve, set by photon statistics, detector systematics and the star itself.'],
      ['Spectral Resolution', 'How finely a spectrograph separates wavelengths; it sets which molecular bands can be told apart at all.'],
      ['Doppler Shift', 'Motion along the line of sight moves spectral features in wavelength, which is what makes a stellar wobble measurable.'],
      ['Orbital Eccentricity', 'How far an orbit departs from circular. It shapes the transit duration and the planet irradiation over a year.'],
    ],
    entities: [
      ['Space-Based Transit Survey', 'A wide-field photometric survey satellite that monitors bright stars for transit dips.'],
      ['Ground-Based Spectrograph Network', 'A set of high-resolution spectrographs used for radial-velocity follow-up of transit candidates.'],
      ['Infrared Space Observatory', 'A cooled space telescope whose infrared spectrographs are used for atmospheric characterisation.'],
      ['Exoplanet Archive', 'A public catalogue of confirmed planets and their measured parameters.'],
    ],
    sources: [
      'Transit Photometry Survey Methods (review)',
      'Radial Velocity Precision Limits (review)',
      'Atmospheric Retrieval Techniques (methods paper)',
      'The Radius Valley in Small Planets (analysis)',
      'Stellar Activity and False Positives (review)',
    ],
    questions: [
      'How is a planet radius actually measured?',
      'Why does stellar activity limit radial velocity precision?',
    ],
  },
  'climate-science': {
    color: 'the carbon cycle, ocean circulation and the proxy record',
    tags: ['climate', 'carbon-cycle', 'paleoclimate', 'ocean', 'modelling'],
    concepts: [
      ['Carbon Cycle', 'The exchange of carbon between atmosphere, ocean, land biosphere and rock, on timescales from a season to a hundred million years.'],
      ['Ocean Carbon Sink', 'The ocean takes up a quarter of emitted carbon dioxide; its capacity depends on temperature, alkalinity and circulation.'],
      ['Thermohaline Circulation', 'Density-driven overturning that moves heat poleward and carbon into the deep ocean.'],
      ['Ice Core Proxies', 'Trapped air bubbles give past atmospheric composition directly; isotope ratios in the ice give temperature indirectly.'],
      ['Isotope Fractionation', 'Physical and biological processes prefer lighter isotopes, so ratios record the process that moved the material.'],
      ['Radiative Forcing', 'The change in net energy flux at the tropopause from a perturbation, the common currency for comparing drivers.'],
      ['Climate Sensitivity', 'The equilibrium warming per doubling of carbon dioxide, constrained jointly by models, the record and process studies.'],
      ['Feedback Loops', 'Water vapour, ice albedo and clouds amplify or damp a forcing, and clouds remain the largest uncertainty.'],
      ['Proxy Calibration', 'Turning a measured proxy into a physical variable requires a modern calibration set, and its errors propagate into every reconstruction.'],
      ['General Circulation Model', 'A discretised atmosphere and ocean on a rotating sphere, integrated forward with parameterised sub-grid physics.'],
      ['Ensemble Spread', 'Running many perturbed models to separate structural uncertainty from internal variability.'],
      ['Ocean Acidification', 'Dissolved carbon dioxide lowers seawater pH and carbonate saturation, which stresses calcifying organisms.'],
    ],
    entities: [
      ['Global Ocean Observing Array', 'A network of autonomous profiling floats reporting temperature and salinity worldwide.'],
      ['Polar Ice Core Archive', 'A repository holding deep ice cores and their sampling records.'],
      ['Climate Model Intercomparison Project', 'A coordinated framework in which modelling groups run a common set of experiments.'],
    ],
    sources: [
      'Ocean Carbon Uptake Since 1990 (synthesis)',
      'Deep Ice Core Isotope Record (dataset description)',
      'Cloud Feedback Uncertainty (review)',
      'Model Intercomparison Protocol (technical note)',
    ],
    questions: ['What limits how far back proxies can reach?'],
  },
  computing: {
    color: 'distributed systems and the data structures under them',
    tags: ['computing', 'distributed-systems', 'algorithms', 'databases', 'concurrency'],
    concepts: [
      ['Consensus Algorithm', 'A protocol letting a set of unreliable machines agree on one value, and by extension on one ordered log.'],
      ['Write-Ahead Log', 'Durability by writing the intent before the change, so a crash can be replayed rather than guessed at.'],
      ['Log-Structured Merge Tree', 'Buffer writes in memory, flush sorted runs to disk, merge them in the background. Fast writes, amplified reads.'],
      ['B-Tree Index', 'A balanced, high-fanout tree that keeps range scans cheap and stays the default for read-heavy stores.'],
      ['Vector Clock', 'Per-node counters that make causality between events comparable without a shared clock.'],
      ['Eventual Consistency', 'Replicas converge if writes stop. Everything interesting is about what a reader may observe before they do.'],
      ['Quorum Read', 'Reading from enough replicas that the read set intersects the write set, trading latency for freshness.'],
      ['Idempotency Key', 'A client-supplied identifier that makes a retried request safe to apply exactly once.'],
      ['Backpressure', 'Letting a saturated consumer slow its producer, instead of letting a queue grow until something dies.'],
      ['Content-Addressed Storage', 'Naming a blob by the hash of its bytes, which makes deduplication and integrity checking the same operation.'],
      ['Bloom Filter', 'A compact probabilistic set: no false negatives, tunable false positives, which is enough to skip most disk reads.'],
      ['Copy-on-Write Snapshot', 'A consistent point-in-time view taken without copying, by sharing pages until one of them is written.'],
      ['Chunking Strategy', 'How a document is split before indexing, which decides what a retrieval system can return at all.'],
      ['Inverted Index', 'A term-to-document map, the structure under keyword search and under BM25 ranking.'],
    ],
    entities: [
      ['Embedded Key-Value Store', 'A single-file storage engine embedded directly in the application process.'],
      ['Distributed Log Service', 'A partitioned, replicated append-only log used as a system backbone.'],
      ['Full-Text Search Library', 'An embeddable library providing tokenisation, an inverted index and ranked retrieval.'],
    ],
    sources: [
      'Consensus in Practice (engineering report)',
      'Storage Engine Trade-offs (benchmark study)',
      'Retrieval Ranking Functions (survey)',
    ],
    questions: ['When is a log-structured store the wrong choice?'],
  },
  cooking: {
    color: 'technique, fermentation and why recipes work',
    tags: ['cooking', 'fermentation', 'baking', 'technique', 'food-science'],
    concepts: [
      ['Maillard Reaction', 'Amino acids and reducing sugars rearranging above roughly 140 degrees into hundreds of flavour compounds.'],
      ['Gluten Development', 'Hydrated wheat proteins forming an elastic network under mechanical work or simply over time.'],
      ['Sourdough Fermentation', 'A stable culture of wild yeast and lactic acid bacteria leavening dough and acidifying it as it goes.'],
      ['Emulsification', 'Holding fat and water together with a surfactant, which is what a sauce is when it has not broken.'],
      ['Brining', 'Salt solution changing protein structure so muscle holds more water through cooking.'],
      ['Starch Gelatinisation', 'Starch granules swelling and bursting in hot water, which is thickening and also what makes a sauce cloudy.'],
      ['Carryover Cooking', 'Heat continuing to move inward after the pan comes off, which is why resting is part of the method.'],
      ['Autolyse', 'A rest of flour and water before salt and leaven, letting enzymes start what mixing would otherwise have to finish.'],
      ['Lamination', 'Alternating dough and fat in many thin layers so trapped steam lifts them apart.'],
      ['Acid Balance', 'Acidity as a structural element rather than a flavour note: it sets gels, keeps colour and cuts fat.'],
    ],
    entities: [
      ['Standard Kitchen Reference', 'A general-purpose reference work on technique and ratios.'],
      ['Fermentation Culture Collection', 'A catalogue of starter cultures with handling notes.'],
    ],
    sources: [
      'Bread Dough Rheology (technical note)',
      'Fermentation Temperature Effects (study)',
      'Emulsion Stability in Sauces (review)',
    ],
    questions: ['Why does the same recipe behave differently in a different kitchen?'],
  },
  'knowledge-management': {
    color: 'how the wiki itself is supposed to work',
    tags: ['knowledge-management', 'llm-wiki', 'method', 'retrieval', 'compounding'],
    concepts: [
      ['LLM Wiki Pattern', 'Let a model write the wiki and a human read it: pages are dense, linked and rewritten in place rather than appended to.'],
      ['Compounding Knowledge', 'Each ingest is worth more than the last because it links into what is already there.'],
      ['Hot Cache', 'A short, always-loaded digest of the vault so a model starts a session already knowing its shape.'],
      ['Atomic Note', 'One page, one idea, named by the idea. It is what makes a link mean something specific.'],
      ['Knowledge Gap', 'A page other pages link to that does not exist yet, which is a research backlog the wiki wrote for itself.'],
      ['Contextual Retrieval', 'Prefixing each chunk with what it is and where it came from, so a fragment retrieves as well as a page.'],
      ['Domain Registry', 'A closed list of meta-categories, so classification stays comparable instead of drifting per ingest.'],
      ['Orphan Page', 'A page nothing links to. Usually a naming mismatch rather than an idea nobody needed.'],
    ],
    entities: [['Wiki Skill Suite', 'The set of skills a vault ships for ingesting, linting and querying itself.']],
    sources: ['Contextual Retrieval Method (article)', 'Note-Taking Systems Compared (essay)'],
    questions: ['When should a page be split rather than extended?'],
  },
}

/** Cross-domain links: the pairs that make the graph one object instead of five. */
const CROSS_LINKS = [
  ['Chunking Strategy', 'Contextual Retrieval'],
  ['Inverted Index', 'Contextual Retrieval'],
  ['Content-Addressed Storage', 'Knowledge Gap'],
  ['Isotope Fractionation', 'Spectral Resolution'],
  ['General Circulation Model', 'Ensemble Spread'],
  ['Photometric Precision', 'Stellar Activity Noise'],
  ['Starch Gelatinisation', 'Emulsification'],
  ['Proxy Calibration', 'Spectral Resolution'],
  ['Bloom Filter', 'Hot Cache'],
  ['Atomic Note', 'Domain Registry'],
]

/* ------------------------------------------------------------------------ page writing */

/**
 * A page's filename IS its title in a claude-obsidian vault - that is also the label the
 * graph renders and the target `[[wikilinks]]` resolve against. Only characters the
 * filesystem dislikes get dropped.
 */
const fileName = (title) => title.replace(/[\\/:*?"<>|]/g, '').trim()

/**
 * Page names that are LINKED but never written. A real vault accumulates these constantly -
 * they are the backlog the graph surfaces as ghost nodes.
 */
const GAPS = [
  'Planetary Albedo', 'Stellar Metallicity', 'Occultation Timing', 'Bolometric Correction',
  'Carbonate Compensation Depth', 'Meridional Heat Transport', 'Aerosol Indirect Effect',
  'Consistency Model', 'Read Repair', 'Merge Policy', 'Tombstone Compaction',
  'Enzymatic Browning', 'Hydration Ratio', 'Retrieval Evaluation', 'Link Rot',
]
let gapSeq = 0

const pages = []
let seq = 0
/**
 * Spread creation dates over the last 40 days, oldest first. The step is chosen so the
 * last page lands a couple of days back rather than in the future: at ~105 pages, 0.37
 * days per page covers 39 of the 40.
 */
const nextDate = () => day(Math.max(2, 40 - Math.floor(seq++ * 0.37)))

function page({ dir, title, type, domain, tags, body, related = [], sources = [], status = 'evergreen' }) {
  const created = nextDate()
  const fm = [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    `domain: ${domain}`,
    `created: ${iso(created)}`,
    `updated: ${iso(created)}`,
    'tags:',
    ...tags.map((t) => `  - ${t}`),
    `status: ${status}`,
    ...(related.length ? ['related:', ...related.map((r) => `  - "[[${r}]]"`)] : []),
    ...(sources.length ? ['sources:', ...sources.map((s) => `  - "[[${s}]]"`)] : []),
    '---',
    '',
  ].join('\n')
  const rel = dir === '.' ? `wiki/${fileName(title)}.md` : `wiki/${dir}/${fileName(title)}.md`
  pages.push({ path: rel, content: fm + body + '\n', created })
}

/** Pick n items around an index, wrapping - gives every page neighbours without randomness. */
const around = (arr, i, n) => Array.from({ length: n }, (_, k) => arr[(i + k + 1) % arr.length]).filter(Boolean)

for (const [domain, spec] of Object.entries(DOMAINS)) {
  const conceptTitles = spec.concepts.map(([t]) => t)
  const sourceTitles = spec.sources
  const entityTitles = (spec.entities ?? []).map(([t]) => t)

  spec.concepts.forEach(([title, lead], i) => {
    const related = around(conceptTitles, i, i % 3 === 0 ? 3 : 2)
    const cross = CROSS_LINKS.find(([a]) => a === title)
    if (cross) related.push(cross[1])
    const src = [sourceTitles[i % sourceTitles.length]]
    // Every fourth concept points at a page that does not exist - that is what the Gaps
    // overlay and the "linked but not written" figure are counting.
    const gap = i % 4 === 1 ? GAPS[(gapSeq++) % GAPS.length] : null
    const linked = around(conceptTitles, i + 3, 2)
    page({
      dir: 'concepts',
      title,
      type: 'concept',
      domain,
      tags: ['concept', ...spec.tags.slice(0, 3)],
      related,
      sources: src,
      body: [
        `# ${title}`,
        '',
        lead,
        '',
        '## Why it matters',
        '',
        `It sits directly under ${linked.map((l) => `[[${l}]]`).join(' and ')}, which is why it shows up`,
        `whenever ${spec.color} is discussed at any depth.`,
        '',
        '## Detail',
        '',
        `The practical consequence is a trade-off rather than a rule. Push one side and ${linked[0] ? `[[${linked[0]}]]` : 'the neighbouring effect'}`,
        'starts to dominate; push the other and the measurement stops being sensitive to what you',
        'actually wanted to know. Most working practice sits in the middle, and says so explicitly.',
        '',
        'The usual failure is to treat the middle as a fixed number rather than as something that',
        'depends on the instrument, the sample and the question. Two groups reporting different',
        'values are frequently both right and simply not measuring the same thing, which is why',
        'the method section matters more than the headline figure.',
        '',
        '## In practice',
        '',
        '- State the assumption that makes the simple form valid, and check it holds.',
        '- Report the quantity actually measured, not the one it is usually converted into.',
        '- Keep the raw observable around: conversions are lossy and conventions change.',
        `- When results disagree, compare methods before comparing numbers.`,
        '',
        '## See also',
        '',
        ...related.map((r) => `- [[${r}]]`),
        ...(gap ? ['', `Still to write: [[${gap}]].`] : []),
      ].join('\n'),
    })
  })

  ;(spec.entities ?? []).forEach(([title, lead], i) => {
    page({
      dir: 'entities',
      title,
      type: 'entity',
      domain,
      tags: ['entity', 'organization', ...spec.tags.slice(0, 2)],
      related: around(conceptTitles, i * 3, 3),
      body: [
        `# ${title}`,
        '',
        lead,
        '',
        '## Role',
        '',
        `Appears throughout the ${domain} material as the thing that produced or holds the data.`,
        'Pages cite it when the provenance of a number matters: what was measured, under which',
        'programme, and which release of the data the figure came from.',
        '',
        '## What it constrains',
        '',
        'Its coverage and cadence set what questions can be asked at all. A gap in the record is',
        'not a null result, and treating it as one is the most common way conclusions drift from',
        'what the data can actually support.',
        '',
        '## Related',
        '',
        ...around(conceptTitles, i * 3, 3).map((c) => `- [[${c}]]`),
      ].join('\n'),
    })
  })

  sourceTitles.forEach((title, i) => {
    page({
      dir: 'sources',
      title,
      type: 'source',
      domain,
      tags: ['source', ...spec.tags.slice(0, 2)],
      related: around(conceptTitles, i * 2, 4),
      status: 'reference',
      body: [
        `# ${title}`,
        '',
        `A synthetic stand-in for an ingested document about ${spec.color}. It exists so the`,
        'dashboard has provenance to show: the pages below were written from it.',
        '',
        '## Summary',
        '',
        'The document reviews the established method, states where it breaks down, and proposes',
        'a correction that trades a little precision for a good deal of robustness. Its useful',
        'contribution is the failure catalogue rather than the correction itself.',
        '',
        '## Extracted claims',
        '',
        ...around(conceptTitles, i * 2, 4).map((c) => `- Supports [[${c}]].`),
        '',
        '## Caveats',
        '',
        '- The sample is convenient rather than representative.',
        '- Uncertainties are quoted as statistical only; the systematic term is larger.',
      ].join('\n'),
    })
  })

  ;(spec.questions ?? []).forEach((title, i) => {
    page({
      dir: 'questions',
      title,
      type: 'question',
      domain,
      tags: ['question', ...spec.tags.slice(0, 2)],
      related: around(conceptTitles, i * 5, 3),
      status: 'open',
      body: [
        `# ${title}`,
        '',
        'Asked while reading, answered from the pages below.',
        '',
        '## Working answer',
        '',
        'Not one mechanism but two that are easy to confuse, because they produce the same',
        'signature in the usual summary plot and separate only when the raw observable is kept.',
        'The pages below cover each in turn; the comparison between them is where the answer is.',
        '',
        '## Sources of the answer',
        '',
        ...around(conceptTitles, i * 5, 3).map((c) => `- [[${c}]]`),
        '',
        'Still open: whether the distinction matters at the precision most work reports.',
      ].join('\n'),
    })
  })
}

/* A couple of comparisons and references, so those buckets are not empty in the library. */
page({
  dir: 'comparisons',
  title: 'Transit Photometry vs Radial Velocity',
  type: 'comparison',
  domain: 'astronomy',
  tags: ['comparison', 'astronomy', 'exoplanet'],
  related: ['Transit Photometry', 'Radial Velocity Method', 'Transit Depth'],
  body: ['# Transit Photometry vs Radial Velocity', '', 'The two detection methods measure different quantities and fail in different ways.', '', '| | [[Transit Photometry]] | [[Radial Velocity Method]] |', '|---|---|---|', '| Measures | radius ratio | minimum mass |', '| Needs | favourable orbital alignment | bright, quiet star |', '| Fails on | grazing geometry | active stars |'].join('\n'),
})
page({
  dir: 'comparisons',
  title: 'B-Tree vs Log-Structured Merge Tree',
  type: 'comparison',
  domain: 'computing',
  tags: ['comparison', 'computing', 'databases'],
  related: ['B-Tree Index', 'Log-Structured Merge Tree', 'Write-Ahead Log'],
  body: ['# B-Tree vs Log-Structured Merge Tree', '', 'Two storage engines, two amplification profiles.', '', '| | [[B-Tree Index]] | [[Log-Structured Merge Tree]] |', '|---|---|---|', '| Write path | in place | append then merge |', '| Amplifies | writes | reads |', '| Range scans | cheap | needs merging |'].join('\n'),
})
page({
  dir: 'references',
  title: 'Unit Conventions',
  type: 'reference',
  domain: 'meta',
  tags: ['reference', 'meta'],
  status: 'reference',
  body: ['# Unit Conventions', '', 'Which units pages use when a field could reasonably take several.', '', '- Radii in Earth radii for rocky planets, Jupiter radii above.', '- Temperatures in kelvin in [[Secondary Eclipse]] contexts, Celsius in [[Maillard Reaction]] ones.'].join('\n'),
})

/* Meta pages: the wiki's own machinery, which is what the System toggle hides in the graph. */
page({
  dir: '.',
  title: 'index',
  type: 'meta',
  domain: 'meta',
  tags: ['meta', 'index'],
  body: ['# Index', '', 'Entry point to the wiki.', '', ...Object.keys(DOMAINS).map((d) => `- **${d}** - ${DOMAINS[d].color}`)].join('\n'),
})
page({
  dir: '.',
  title: 'hot',
  type: 'meta',
  domain: 'meta',
  tags: ['meta', 'hot-cache'],
  body: ['# Hot Cache', '', 'A digest of the vault, refreshed after ingests.', '', `Currently ${pages.length + 3} pages across ${Object.keys(DOMAINS).length} domains.`].join('\n'),
})

/** The domain registry, in the shape install-domain-registry.sh seeds. */
const registry = [
  '---',
  'type: meta',
  'title: "Domain Registry"',
  'domain: meta',
  `created: ${iso(day(40))}`,
  `updated: ${iso(day(4))}`,
  'tags:',
  '  - meta',
  '  - domains',
  'status: evergreen',
  '---',
  '',
  '# Domain Registry',
  '',
  'The list of meta-categories this wiki uses. Every page carries exactly one of these keys',
  'in its `domain:` frontmatter field. This page is the single source of truth for that list.',
  '',
  '## Domains',
  '',
  ...Object.entries(DOMAINS).flatMap(([key, spec]) => [
    `## ${key}`,
    '',
    spec.color.charAt(0).toUpperCase() + spec.color.slice(1) + '.',
    '',
    `**Tags:** ${spec.tags.map((t) => `\`${t}\``).join(', ')}`,
    '',
  ]),
  '## meta',
  '',
  "The wiki's own machinery rather than a subject: index and overview pages, the hot cache,",
  'and this page.',
  '',
  '**Tags:** `meta`, `index`, `hot-cache`',
  '',
].join('\n')
pages.push({ path: 'wiki/meta/domains.md', content: registry, created: day(40) })

/* Two pages left deliberately unfiled, so the "unassigned" bucket is not empty. */
for (const [title, lead] of [
  ['Signal Averaging', 'Repeating a measurement to beat down uncorrelated noise as the square root of the count.'],
  ['Calibration Drift', 'Slow movement of an instrument zero point, which looks like a trend in whatever it measures.'],
]) {
  page({
    dir: 'concepts',
    title,
    type: 'concept',
    domain: 'unassigned',
    tags: ['concept', 'measurement'],
    related: ['Photometric Precision', 'Proxy Calibration'],
    body: [`# ${title}`, '', lead, '', 'Filed nowhere yet: it belongs to measurement in general rather than to one subject.'].join('\n'),
  })
}

/* A stub and an orphan, so the health filters in the library have something to find. */
page({
  dir: 'concepts',
  title: 'Phase Curve',
  type: 'concept',
  domain: 'astronomy',
  tags: ['concept', 'astronomy'],
  status: 'stub',
  body: ['# Phase Curve', '', 'Brightness variation over a full orbit. Stub - needs writing.'].join('\n'),
})

/* ------------------------------------------------------------------------- write it out */

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
for (const dir of ['wiki/concepts', 'wiki/entities', 'wiki/sources', 'wiki/questions', 'wiki/comparisons', 'wiki/references', 'wiki/meta', 'skills/ingest', '.raw']) {
  mkdirSync(join(OUT, dir), { recursive: true })
}
writeFileSync(join(OUT, 'skills/ingest/SKILL.md'), '---\nname: ingest\ndescription: Demo placeholder so the vault shape validates.\n---\n\n# ingest\n\nPlaceholder.\n')
writeFileSync(join(OUT, 'README.md'), '# Demo vault\n\nGenerated by `scripts/demo-vault.mjs`. Every page here is synthetic.\n')

for (const p of pages) {
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
const INGEST_NAMES = [
  'transit-photometry-survey.pdf', 'radial-velocity-limits.pdf', 'atmospheric-retrieval.pdf',
  'radius-valley-analysis.pdf', 'stellar-activity-review.pdf', 'ocean-carbon-uptake.pdf',
  'ice-core-isotopes.pdf', 'cloud-feedback-review.pdf', 'model-intercomparison.pdf',
  'consensus-in-practice.pdf', 'storage-engine-tradeoffs.pdf', 'ranking-functions.pdf',
  'dough-rheology.pdf', 'fermentation-temperature.pdf', 'emulsion-stability.pdf',
  'contextual-retrieval.html', 'note-taking-systems.html', 'unit-conventions.md',
]

/** A valid, one-page PDF - small enough to inline here, real enough for a viewer to open. */
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

const rawSources = {}
const sourcePageList = pages.filter((p) => p.path.startsWith('wiki/sources/'))
sourcePageList.forEach((sp, i) => {
  const jobId = `demo-${String(i + 1).padStart(3, '0')}`
  const name = INGEST_NAMES[i % INGEST_NAMES.length]
  const isWeb = name.endsWith('.html')
  mkdirSync(join(OUT, '.raw', jobId), { recursive: true })
  writeFileSync(
    join(OUT, '.raw', jobId, name),
    isWeb
      ? '<!doctype html><title>Synthetic demo document</title><p>Generated for screenshots.</p>\n'
      : name.endsWith('.md')
        ? '# Synthetic demo document\n\nGenerated for screenshots.\n'
        : STUB_PDF,
  )
  writeFileSync(
    join(OUT, '.raw', jobId, 'manifest.json'),
    JSON.stringify(
      { original: name, type: isWeb ? 'web' : name.endsWith('.md') ? 'text' : 'pdf', url: isWeb ? `https://example.invalid/${name}` : null },
      null,
      2,
    ) + '\n',
  )
  // The source page itself, plus the concepts that cite it - "created because of this".
  const title = /^title: "(.+)"$/m.exec(sp.content)?.[1] ?? ''
  const created = [sp.path, ...pages.filter((q) => q.path.startsWith('wiki/concepts/') && q.content.includes(`[[${title}]]`)).slice(0, 4).map((q) => q.path)]
  rawSources[`.raw/${jobId}/${name}`] = { ingested_at: sp.created.toISOString(), pages_created: created }
})
writeFileSync(join(OUT, '.raw', '.manifest.json'), JSON.stringify({ sources: rawSources }, null, 2) + '\n')

/* --------------------------------------------------------------- backdated git history */

const git = (args, env = {}) =>
  execFileSync('git', args, { cwd: OUT, env: { ...process.env, ...env }, stdio: 'pipe' })

git(['init', '-q', '-b', 'vault-main'])
git(['config', 'user.name', 'BrainVault Demo'])
git(['config', 'user.email', 'demo@example.invalid'])

/**
 * Group the pages into ingest-sized commits and date them backwards, so the growth chart
 * rises instead of jumping and the commit list reads like real work.
 */
const commitPlan = []
let bucket = []
/**
 * Chronological, because `git log --since` walks the parent chain and stops at the first
 * commit older than the window. A single out-of-order date (the registry page is built
 * last but dated first) truncates the history the growth chart can see to one day.
 */
const ordered = [...pages].sort((a, b) => a.created - b.created)
for (const p of ordered) {
  bucket.push(p)
  if (bucket.length >= 4) {
    commitPlan.push(bucket)
    bucket = []
  }
}
if (bucket.length) commitPlan.push(bucket)

git(['add', 'README.md', 'skills', '.raw'])
git(['commit', '-q', '-m', 'chore: vault scaffold'], {
  GIT_AUTHOR_DATE: day(41).toISOString(),
  GIT_COMMITTER_DATE: day(41).toISOString(),
})

commitPlan.forEach((group, i) => {
  const when = group[group.length - 1].created
  const stamp = new Date(when.getTime() + (i % 8) * 3_600_000).toISOString()
  for (const p of group) git(['add', '--', p.path])
  const name = INGEST_NAMES[i % INGEST_NAMES.length]
  git(['commit', '-q', '-m', `ingest: ${name}`], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp })
})

console.log(`vault:  ${OUT}  (${pages.length} pages, ${commitPlan.length + 1} commits)`)

/* ------------------------------------------------------------- the operational database */

const { default: Database } = await import('better-sqlite3')
mkdirSync(dirname(DB), { recursive: true })
rmSync(DB, { force: true })
rmSync(`${DB}-wal`, { force: true })
rmSync(`${DB}-shm`, { force: true })

const { migrate } = await import(join(process.cwd(), 'server/dist/db/index.js'))
const db = new Database(DB)
migrate(db)

const ulid = (n) => `01DEMO${String(n).padStart(20, '0')}`
const at = (d) => d.toISOString()

/** Jobs: the ingest history behind Home's stream and the library's source column. */
const jobStmt = db.prepare(
  `INSERT INTO jobs (id, user_id, source, type, original_name, url, sha256, status, created_pages,
                     attempts, tokens_in, tokens_out, cost_usd, created_at, started_at, finished_at, error)
   VALUES (@id, 'local', @source, @type, @original_name, @url, @sha256, @status, @created_pages,
           @attempts, @tokens_in, @tokens_out, @cost_usd, @created_at, @started_at, @finished_at, @error)`,
)

const byDomain = {}
for (const p of pages) {
  const m = /^domain: (.+)$/m.exec(p.content)
  if (m) (byDomain[m[1]] ??= []).push(p.path)
}
const sourcePages = pages.filter((p) => p.path.startsWith('wiki/sources/'))

sourcePages.forEach((p, i) => {
  const created = day(20 - i)
  const title = /^title: "(.+)"$/m.exec(p.content)?.[1] ?? 'document'
  const name = INGEST_NAMES[i % INGEST_NAMES.length]
  const related = pages
    .filter((q) => q.path.startsWith('wiki/concepts/') && q.content.includes(title))
    .slice(0, 3)
    .map((q) => q.path)
  jobStmt.run({
    id: ulid(i + 1),
    source: i % 5 === 0 ? 'watch' : i % 7 === 0 ? 'url' : 'drop',
    type: name.endsWith('.html') ? 'web' : name.endsWith('.md') ? 'text' : 'pdf',
    original_name: name,
    url: name.endsWith('.html') ? `https://example.invalid/${name}` : null,
    sha256: `demo${String(i).padStart(60, '0')}`,
    status: 'done',
    created_pages: JSON.stringify([p.path, ...related]),
    attempts: 1,
    tokens_in: 38_000 + i * 2_400,
    tokens_out: 5_200 + i * 310,
    cost_usd: 0.21 + i * 0.035,
    created_at: at(created),
    started_at: at(new Date(created.getTime() + 20_000)),
    finished_at: at(new Date(created.getTime() + 210_000 + i * 9_000)),
    error: null,
  })
})

/* One failure and one duplicate, so the filters and the status vocabulary are visible. */
jobStmt.run({
  id: ulid(90),
  source: 'drop',
  type: 'pdf',
  original_name: 'scanned-handout.pdf',
  url: null,
  sha256: `demo${String(90).padStart(60, '0')}`,
  status: 'failed',
  created_pages: '[]',
  attempts: 2,
  tokens_in: 4_100,
  tokens_out: 200,
  cost_usd: 0.02,
  created_at: at(day(3)),
  started_at: at(day(3)),
  finished_at: at(new Date(day(3).getTime() + 64_000)),
  error: 'preprocessing: no extractable text layer (OCR produced 12 characters)',
})
jobStmt.run({
  id: ulid(91),
  source: 'watch',
  type: 'pdf',
  original_name: 'ice-core-isotopes.pdf',
  url: null,
  sha256: `demo${String(6).padStart(60, '0')}`.slice(0, 64) + 'x',
  status: 'duplicate',
  created_pages: '[]',
  attempts: 1,
  tokens_in: null,
  tokens_out: null,
  cost_usd: null,
  created_at: at(day(2)),
  started_at: at(day(2)),
  finished_at: at(new Date(day(2).getTime() + 1_400)),
  error: null,
})

/** Agent runs: what System's usage section and Home's stream read. */
const runStmt = db.prepare(
  `INSERT INTO agent_runs (id, user_id, kind, label, profile_key, ok, pages, tokens_in, tokens_out,
                           cost_usd, error, started_at, finished_at)
   VALUES (@id, 'local', @kind, @label, @profile_key, @ok, @pages, @tokens_in, @tokens_out,
           @cost_usd, NULL, @started_at, @finished_at)`,
)
const RUNS = [
  ['research', 'Atmospheric retrieval techniques', 'sota', 6, 214_000, 18_400, 1.94, 5],
  ['research', 'Ocean carbon sink capacity', 'broad', 4, 168_000, 14_100, 1.42, 9],
  ['lint', null, null, 0, 96_000, 3_200, 0.41, 1],
  ['hot-cache', null, null, 1, 41_000, 2_100, 0.19, 1],
  ['domain-backfill', null, null, 12, 88_000, 6_400, 0.52, 6],
  ['lint-fix', null, null, 5, 74_000, 5_900, 0.44, 2],
  ['research', 'Storage engine trade-offs', 'broad', 3, 151_000, 12_800, 1.28, 14],
]
RUNS.forEach(([kind, label, profile, pageCount, tin, tout, cost, daysAgo], i) => {
  const started = day(daysAgo)
  const domainPages = Object.values(byDomain).flat()
  runStmt.run({
    id: ulid(200 + i),
    kind,
    label,
    profile_key: profile,
    ok: 1,
    pages: JSON.stringify(domainPages.slice(i * 3, i * 3 + pageCount)),
    tokens_in: tin,
    tokens_out: tout,
    cost_usd: cost,
    started_at: at(started),
    finished_at: at(new Date(started.getTime() + 300_000 + i * 40_000)),
  })
})

/** One saved conversation, so Research opens with a ledger rather than an empty state. */
const sess = db.prepare(
  `INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (?, 'local', ?, ?, ?)`,
)
const msg = db.prepare(
  `INSERT INTO messages (session_id, role, content, citations, ts) VALUES (?, ?, ?, ?, ?)`,
)
const CONVOS = [
  ['What sets the noise floor of a transit survey?', 4],
  ['How do proxy records constrain climate sensitivity?', 8],
  ['Why prefix chunks before indexing them?', 2],
]
CONVOS.forEach(([title, daysAgo], i) => {
  const id = ulid(300 + i)
  const when = day(daysAgo)
  sess.run(id, title, at(when), at(new Date(when.getTime() + 120_000)))
  msg.run(id, 'user', title, '[]', at(when))
  msg.run(
    id,
    'assistant',
    `Short answer first, then the pages it came from.\n\nThe limit is set by a combination of photon statistics and the star itself; see the linked pages for the split between the two.`,
    JSON.stringify(
      pages.filter((p) => p.path.startsWith('wiki/concepts/')).slice(i * 4, i * 4 + 3).map((p) => ({ path: p.path, title: /^title: "(.+)"$/m.exec(p.content)?.[1] ?? p.path })),
    ),
    at(new Date(when.getTime() + 60_000)),
  )
})

db.close()
console.log(`db:     ${DB}  (${sourcePages.length + 2} jobs, ${RUNS.length} runs, ${CONVOS.length} conversations)`)
