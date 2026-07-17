/**
 * Watch-folder ingestion (SPEC.md §3.1, §4.2). chokidar watches the configured inbox
 * (default `/mnt/c/inbox`); a file is only taken once its size has been stable for 2 s
 * (`awaitWriteFinish`) so half-copied files are never ingested. On stabilize the file is
 * enqueued and then REMOVED from the inbox — the watch folder is an inbox, kept empty, so
 * a restart never re-processes what was already taken.
 *
 * Batching (files arriving together within 60 s → one combined run) is layered on top in
 * the batching task; this module enqueues each stabilized file on its own.
 */

import fs from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import type { Config } from '../config.js'
import type { IngestQueue } from './queue.js'
import { isShortcut, readShortcutUrl } from './shortcut.js'

export interface Watcher {
  close(): Promise<void>
}

export interface StartWatcherOptions {
  readonly queue: IngestQueue
  readonly config: Config
  /** Structured log sink; defaults to console. */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** Reads a `url:`/`source:` field from a markdown file's YAML frontmatter, if any. */
export function frontmatterUrl(filePath: string): string | undefined {
  const head = readHead(filePath, 4096)
  const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return undefined
  const url = m[1]!.match(/^\s*(?:url|source)\s*:\s*["']?(https?:\/\/[^\s"']+)/im)
  return url ? url[1] : undefined
}

function readHead(filePath: string, bytes: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

export function startWatcher(opts: StartWatcherOptions): Watcher {
  const folder = opts.config.server.watchFolder
  // Fallback sink only — the service injects Fastify's logger. console.error keeps all
  // watcher output on stderr (and satisfies the no-console lint rule).
  const log = opts.log ?? ((level, message) => console.error(`[watcher:${level}] ${message}`))

  // Ensure the inbox exists so a fresh machine can receive drops immediately. On WSL the
  // drive may not be mounted yet; treat that as non-fatal — chokidar will pick it up later.
  try {
    fs.mkdirSync(folder, { recursive: true })
  } catch (err) {
    log('warn', `could not create watch folder ${folder}: ${(err as Error).message}`)
  }

  const watcher = chokidar.watch(folder, {
    ignoreInitial: false, // files already sitting in the inbox at startup should be taken
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    ignored: (p) => path.basename(p).startsWith('.'), // skip dotfiles / partials
    depth: 10,
  })

  watcher.on('add', (filePath) => {
    void handleFile(filePath, opts.queue, log)
  })
  watcher.on('error', (err) => log('error', `watch error: ${(err as Error).message}`))
  log('info', `watching ${folder}`)

  return { close: () => watcher.close() }
}

async function handleFile(
  filePath: string,
  queue: IngestQueue,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<void> {
  const name = path.basename(filePath)
  try {
    // .url/.webloc shortcut, or a Web Clipper .md carrying a frontmatter URL → URL job.
    const url = isShortcut(name)
      ? readShortcutUrl(filePath)
      : name.toLowerCase().endsWith('.md')
        ? frontmatterUrl(filePath)
        : undefined

    if (url) {
      const { job } = queue.enqueueUrl({ url, source: 'watch' })
      log('info', `enqueued URL from ${name} → ${job.id}`)
    } else {
      const { job, duplicateOf } = await queue.enqueueFile({ sourcePath: filePath, source: 'watch', originalName: name })
      log('info', `enqueued ${name} → ${job.id}${duplicateOf ? ' (duplicate)' : ''}`)
    }
    // The inbox is emptied after the vault has its own copy (enqueueFile copied it in).
    fs.rmSync(filePath, { force: true })
  } catch (err) {
    // Leave the file in the inbox on failure so it is not silently lost; log for the operator.
    log('error', `failed to enqueue ${name}: ${(err as Error).message}`)
  }
}
