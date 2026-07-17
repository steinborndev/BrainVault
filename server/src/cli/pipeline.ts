/**
 * M1 batch trigger: `npm run pipeline -- <file-or-dir> [more...]`
 *
 * Runs files through the real ingestion queue — preprocessing, headless agent ingest,
 * git commit — at the configured concurrency. This is the M1 acceptance harness
 * (SPEC.md §10: "10 mixed files → all done, no vault corruption at concurrency 2") and
 * the precursor to the M2 watcher, which enqueues into the same queue.
 *
 * Unlike the M0 `ingest` CLI (one file, no DB), this drives the full pipeline: jobs are
 * recorded in SQLite, deduped, retried, and committed. Requires the preprocessing
 * toolchain for PDF/Office/image sources — run scripts/install-preprocessing-tools.sh.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, describeConfig, ConfigError } from '../config.js'
import { openDb, defaultDbPath } from '../db/index.js'
import { JobStore } from '../db/jobs.js'
import { IngestQueue } from '../pipeline/queue.js'
import { detectTools } from '../pipeline/preprocess/index.js'
import { isShortcut, readShortcutUrl } from '../pipeline/shortcut.js'

/** Expands each argument (file or directory) into a flat list of files to enqueue. */
function collectFiles(args: string[], cwd: string): string[] {
  const out: string[] = []
  for (const arg of args) {
    const abs = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg)
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        const child = path.join(abs, name)
        if (fs.statSync(child).isFile()) out.push(child)
      }
    } else if (stat.isFile()) {
      out.push(abs)
    }
  }
  return out
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== '')
  if (args.length === 0 || args[0] === '--help') {
    console.error('usage: npm run pipeline -- <file-or-dir> [more...]')
    return 2
  }

  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`configuration error:\n${err.message}`)
      return 2
    }
    throw err
  }

  const cwd = process.env['INIT_CWD'] ?? process.cwd()
  const files = collectFiles(args, cwd)
  if (files.length === 0) {
    console.error('no files found in the given paths')
    return 2
  }

  console.log('vault-service pipeline (M1)')
  for (const [k, v] of Object.entries(describeConfig(config))) console.log(`  ${k}: ${v}`)
  const dbPath = defaultDbPath()
  console.log(`  db:        ${dbPath}`)
  console.log(`  files:     ${files.length}`)

  const tools = await detectTools()
  const missing = Object.entries(tools)
    .filter(([, present]) => !present)
    .map(([name]) => name)
  if (missing.length > 0) {
    console.log(`  ⚠ missing tools: ${missing.join(', ')} — PDF/Office/image jobs will fail.`)
    console.log('    run scripts/install-preprocessing-tools.sh')
  }
  console.log('---')

  const db = openDb(dbPath)
  const store = new JobStore(db)
  const queue = new IngestQueue({ store, vaultRoot: config.vaultRoot, auth: config.auth })
  queue.start()

  const jobIds: string[] = []
  for (const file of files) {
    // A .url/.webloc shortcut is a pointer to a web page, not content — enqueue the URL.
    if (isShortcut(file)) {
      const url = readShortcutUrl(file)
      if (url === undefined) {
        console.log(`  skipped ${path.basename(file)} — shortcut has no http(s) URL`)
        continue
      }
      const { job } = queue.enqueueUrl({ url, source: 'drop' })
      jobIds.push(job.id)
      console.log(`  queued ${path.basename(file)} → ${job.id} (url: ${url})`)
      continue
    }
    const { job, duplicateOf } = await queue.enqueueFile({ sourcePath: file, source: 'drop' })
    jobIds.push(job.id)
    console.log(`  queued ${path.basename(file)} → ${job.id}${duplicateOf ? ' (duplicate)' : ''}`)
  }

  await queue.onIdle()
  console.log('---')

  const counts: Record<string, number> = {}
  for (const id of jobIds) {
    const job = store.getOrThrow(id)
    counts[job.status] = (counts[job.status] ?? 0) + 1
    const pages = JSON.parse(job.created_pages ?? '[]') as string[]
    const detail =
      job.status === 'done'
        ? `${pages.length} page(s), ${job.tokens_in ?? 0} tok in`
        : (job.error ?? '')
    console.log(`  ${job.status.padEnd(12)} ${(job.original_name ?? job.url ?? id).padEnd(32)} ${detail}`)
  }
  console.log('---')
  console.log(
    `summary: ${Object.entries(counts)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ')}`,
  )

  db.close()
  // Acceptance is "all done"; deferred/duplicate are expected non-failures.
  const done = counts['done'] ?? 0
  const failed = counts['failed'] ?? 0
  return failed > 0 ? 1 : done > 0 ? 0 : 1
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('unexpected failure:', err)
      process.exit(1)
    })
}

export { collectFiles }
