#!/usr/bin/env node
/**
 * Export a sanitized copy of a vault for public demo use.
 *
 * Reads the source vault (never writes to it), applies an allowlist/blocklist
 * filter, and builds a fresh vault from a clean claude-obsidian skeleton:
 *
 *   node scripts/export-sanitized-vault.mjs \
 *     --source ~/vault \
 *     --skeleton /path/to/fresh-claude-obsidian-clone \
 *     --dest ~/vault-demo \
 *     --config ~/vault-export-filter.json
 *
 * The config file stays OUTSIDE this repository on purpose: it names private
 * domains, titles, and patterns that must never appear in a public commit.
 * Shape:
 *   {
 *     "domains": ["cooking", ...],            // wiki domains to export
 *     "excludeEntityTypes": ["person"],       // entity_type values to drop
 *     "excludeTypes": ["session"],            // page type values to drop
 *     "excludeTitlePatterns": ["..."],        // case-insensitive regexes vs title/aliases/filename
 *     "excludeBodyPatterns": ["..."],         // case-insensitive regexes vs the full page text - hard exclusion
 *     "reviewBodyPatterns": ["..."]           // exported pages matching these are flagged for review
 *   }
 *
 * What the export guarantees:
 *   - only pages whose `domain:` is allowlisted, minus every page matching an
 *     exclusion rule (entity type, page type, title pattern)
 *   - wikilinks to non-exported pages are flattened to plain text, so the demo
 *     leaks no private titles through dead links or knowledge-gap ghost nodes
 *   - only attachments referenced by exported pages are copied; `.raw/`,
 *     `.vault-meta/`, and the source git history are never copied
 *   - the domain registry page keeps only allowlisted domain keys
 *   - a report directory lists every exported, excluded, and review-flagged
 *     page so a human can make the final call
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------- arguments

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || i === process.argv.length - 1) return null
  return process.argv[i + 1]
}

const sourceArg = arg('source')
const skeletonArg = arg('skeleton')
const destArg = arg('dest')
const configArg = arg('config')
if (!sourceArg || !skeletonArg || !destArg || !configArg) {
  console.error('usage: export-sanitized-vault.mjs --source <vault> --skeleton <clean-clone> --dest <new-vault> --config <filter.json>')
  process.exit(1)
}

const source = path.resolve(sourceArg)
const skeleton = path.resolve(skeletonArg)
const dest = path.resolve(destArg)
const config = JSON.parse(await fs.readFile(path.resolve(configArg), 'utf8'))

const allowedDomains = new Set(config.domains ?? [])
const excludeEntityTypes = new Set(config.excludeEntityTypes ?? [])
const excludeTypes = new Set(config.excludeTypes ?? [])
const excludeTitlePatterns = (config.excludeTitlePatterns ?? []).map((p) => new RegExp(p, 'i'))
const excludeBodyPatterns = (config.excludeBodyPatterns ?? []).map((p) => new RegExp(p, 'i'))
const reviewBodyPatterns = (config.reviewBodyPatterns ?? []).map((p) => new RegExp(p, 'i'))

// ------------------------------------------------------------------- guards

if (dest === source || dest.startsWith(source + path.sep)) {
  console.error('refusing: --dest must not be the source vault or live inside it')
  process.exit(1)
}
try {
  const entries = await fs.readdir(dest)
  if (entries.length > 0) {
    console.error(`refusing: --dest ${dest} exists and is not empty`)
    process.exit(1)
  }
} catch {
  /* dest does not exist - fine */
}
await fs.access(path.join(source, 'wiki'))
await fs.access(path.join(skeleton, 'wiki'))

// -------------------------------------------------------- frontmatter (lite)

/** Minimal frontmatter reader for the fields the filter needs. */
function readFrontmatter(text) {
  if (!text.startsWith('---')) return { fields: {}, aliases: [] }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { fields: {}, aliases: [] }
  const block = text.slice(3, end)
  const fields = {}
  const aliases = []
  let inAliases = false
  for (const line of block.split('\n')) {
    const item = line.match(/^\s+-\s+"?([^"]*)"?\s*$/)
    if (inAliases && item) {
      aliases.push(item[1])
      continue
    }
    inAliases = false
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/)
    if (!kv) continue
    const [, key, raw] = kv
    if (key === 'aliases') {
      inAliases = true
      continue
    }
    fields[key] = raw.replace(/^"|"$/g, '').trim()
  }
  return { fields, aliases }
}

// --------------------------------------------------------------- scan pages

const wikiDir = path.join(source, 'wiki')

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else yield p
  }
}

/** All candidate pages: wiki/**\/*.md, except the generated meta/ area. */
const pages = []
for await (const file of walk(wikiDir)) {
  if (!file.endsWith('.md')) continue
  const rel = path.relative(wikiDir, file)
  if (rel.startsWith('meta' + path.sep)) continue
  if (path.basename(file) === '_index.md') continue
  if (['index.md', 'hot.md', 'log.md', 'getting-started.md', 'dashboard.md'].includes(rel)) continue
  const text = await fs.readFile(file, 'utf8')
  const { fields, aliases } = readFrontmatter(text)
  pages.push({ file, rel, text, fields, aliases })
}

// ------------------------------------------------------------------- decide

const exported = []
const excluded = []
for (const page of pages) {
  const { fields, aliases, rel } = page
  const names = [fields.title ?? '', ...aliases, path.basename(rel, '.md')]
  const titleHit = excludeTitlePatterns.find((re) => names.some((n) => re.test(n)))
  let reason = null
  if (!allowedDomains.has(fields.domain ?? '')) reason = `domain: ${fields.domain ?? '(none)'}`
  else if (excludeTypes.has(fields.type ?? '')) reason = `type: ${fields.type}`
  else if (excludeEntityTypes.has(fields.entity_type ?? '')) reason = `entity_type: ${fields.entity_type}`
  else if (titleHit) reason = `title pattern: ${titleHit.source}`
  else {
    // Body match runs last: it is the broadest rule, applied to the ORIGINAL text so a
    // page linking to an excluded page (the link text carries the term) is caught too.
    const bodyHit = excludeBodyPatterns.find((re) => re.test(page.text))
    if (bodyHit) reason = `body pattern: ${bodyHit.source}`
  }
  if (reason) excluded.push({ page, reason })
  else exported.push(page)
}

// -------------------------------------------------- link + attachment tools

/** Every name a wikilink may use to reach an exported page. */
const reachable = new Set()
for (const page of exported) {
  const stem = page.rel.replace(/\.md$/, '')
  for (const name of [page.fields.title, ...page.aliases, path.basename(stem), stem]) {
    if (name) reachable.add(name.toLowerCase())
  }
}
// Structural pages count as reachable only when the skeleton actually ships them,
// otherwise links pointing at them would survive as knowledge-gap ghosts.
const structuralAliases = new Map([
  ['index.md', ['index', 'wiki index']],
  ['hot.md', ['hot', 'hot cache']],
  ['log.md', ['log', 'operation log']],
  ['getting-started.md', ['getting-started']],
  ['dashboard.md', ['dashboard']],
])
const presentStructural = []
for (const [file, names] of structuralAliases) {
  try {
    await fs.access(path.join(skeleton, 'wiki', file))
    presentStructural.push(file)
    for (const n of names) reachable.add(n)
  } catch {
    /* not shipped by this skeleton version */
  }
}
// The domain registry is copied (filtered) from the source further down.
for (const n of ['domain registry', 'domains', 'meta/domains']) reachable.add(n)
for (const dir of ['concepts', 'entities', 'sources', 'folds', 'comparisons', 'canvases']) {
  reachable.add(`${dir}/_index`)
  reachable.add('_index')
}

const linkTarget = (inner) => inner.split('|')[0].split('#')[0].trim().toLowerCase()

/** Flatten wikilinks whose target is not exported; keep attachment embeds. */
function rewriteLinks(text, attachmentsOut) {
  return text.replace(/(!?)\[\[([^\]]+)\]\]/g, (whole, bang, inner) => {
    const target = inner.split('|')[0].split('#')[0].trim()
    if (bang === '!' && /\.[a-z0-9]{2,5}$/i.test(target)) {
      attachmentsOut.add(path.basename(target))
      return whole
    }
    if (reachable.has(linkTarget(inner))) return whole
    const label = inner.includes('|') ? inner.split('|').slice(1).join('|') : target
    return label
  })
}

// ------------------------------------------------------------ build the dest

await fs.mkdir(dest, { recursive: true })
// The skeleton ships its own documentation wiki (example entities included), which must
// not ride into the export unfiltered: copy everything EXCEPT .git and wiki/, then take
// only the structural wiki files from it. All content pages come from the filtered source.
await fs.cp(skeleton, dest, {
  recursive: true,
  filter: (src) => {
    const parts = path.relative(skeleton, src).split(path.sep)
    return !parts.includes('.git') && parts[0] !== 'wiki'
  },
})
for (const dir of ['concepts', 'entities', 'sources', 'folds', 'comparisons', 'canvases', 'meta']) {
  await fs.mkdir(path.join(dest, 'wiki', dir), { recursive: true })
}

const attachments = new Set()
// Structural pages from the skeleton go through the same link flattening as content
// pages - they reference skeleton documentation that is deliberately not exported.
for (const name of presentStructural) {
  const text = await fs.readFile(path.join(skeleton, 'wiki', name), 'utf8')
  await fs.writeFile(path.join(dest, 'wiki', name), rewriteLinks(text, attachments))
}
const review = []
for (const page of exported) {
  let text = rewriteLinks(page.text, attachments)
  text = text.replace(/(!?)\[([^\]]*)\]\((?:\.\.\/)*_attachments\/([^)]+)\)/g, (whole, _bang, _label, file) => {
    attachments.add(decodeURIComponent(path.basename(file)))
    return whole
  })
  const bodyHit = reviewBodyPatterns.find((re) => re.test(text))
  if (bodyHit) review.push({ page, reason: `body pattern: ${bodyHit.source}` })
  const out = path.join(dest, 'wiki', page.rel)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, text)
}

// Referenced attachments only.
for (const name of attachments) {
  const from = path.join(source, '_attachments', name)
  try {
    await fs.mkdir(path.join(dest, '_attachments'), { recursive: true })
    await fs.copyFile(from, path.join(dest, '_attachments', name))
  } catch {
    /* embed that is not an _attachments file - nothing to copy */
  }
}

// Per-folder _index pages regenerated from what was exported.
const byDir = new Map()
for (const page of exported) {
  const dir = path.dirname(page.rel)
  if (dir === '.') continue
  ;(byDir.get(dir) ?? byDir.set(dir, []).get(dir)).push(page)
}
const today = new Date().toISOString().slice(0, 10)
for (const [dir, list] of byDir) {
  const label = dir.charAt(0).toUpperCase() + dir.slice(1)
  const lines = list
    .map((p) => p.fields.title || path.basename(p.rel, '.md'))
    .sort((a, b) => a.localeCompare(b))
    .map((t) => `- [[${t}]]`)
  const out = [
    '---',
    'type: meta',
    `title: "${label} Index"`,
    'domain: meta',
    `created: ${today}`,
    `updated: ${today}`,
    'tags:',
    '  - meta',
    '  - index',
    'status: evergreen',
    '---',
    '',
    `# ${label} Index`,
    '',
    ...lines,
    '',
  ].join('\n')
  await fs.writeFile(path.join(dest, 'wiki', dir, '_index.md'), out)
}

// Domain registry: keep the page, drop list items naming non-allowlisted domains.
const registrySrc = path.join(source, 'wiki', 'meta', 'domains.md')
try {
  const registry = await fs.readFile(registrySrc, 'utf8')
  const filtered = registry
    .split('\n')
    .filter((line) => {
      const item = line.match(/^\s*-\s+`?([a-z0-9-]+)`?\s*(?:[-—:].*)?$/)
      if (!item) return true
      const key = item[1]
      if (key === 'unassigned') return true
      if (!/^[a-z0-9-]{3,}$/.test(key)) return true
      return allowedDomains.has(key)
    })
    .join('\n')
  await fs.mkdir(path.join(dest, 'wiki', 'meta'), { recursive: true })
  await fs.writeFile(path.join(dest, 'wiki', 'meta', 'domains.md'), filtered)
} catch {
  console.warn('no domain registry page found in source; skipping')
}

// Fresh git history, so nothing from the private vault rides along.
execFileSync('git', ['init', '-q', '-b', 'vault-main'], { cwd: dest })
execFileSync('git', ['add', '-A'], { cwd: dest })
execFileSync('git', ['-c', 'user.name=demo-vault-export', '-c', 'user.email=demo@localhost', 'commit', '-q', '-m', 'chore: sanitized demo vault export'], { cwd: dest })

// ------------------------------------------------------------------ reports

const reportDir = `${dest}-report`
await fs.mkdir(reportDir, { recursive: true })
const line = (p) => `${p.fields.title || path.basename(p.rel, '.md')}  (${p.rel})`
await fs.writeFile(path.join(reportDir, 'exported.txt'), exported.map(line).sort().join('\n') + '\n')
await fs.writeFile(
  path.join(reportDir, 'excluded.txt'),
  excluded.map(({ page, reason }) => `${line(page)}  [${reason}]`).sort().join('\n') + '\n',
)
await fs.writeFile(
  path.join(reportDir, 'review.txt'),
  review.map(({ page, reason }) => `${line(page)}  [${reason}]`).sort().join('\n') + '\n',
)
await fs.writeFile(path.join(reportDir, 'attachments.txt'), [...attachments].sort().join('\n') + '\n')

console.log(`exported: ${exported.length} pages`)
console.log(`excluded: ${excluded.length} pages`)
console.log(`flagged for review: ${review.length} pages`)
console.log(`attachments copied: ${attachments.size}`)
console.log(`reports: ${reportDir}`)
