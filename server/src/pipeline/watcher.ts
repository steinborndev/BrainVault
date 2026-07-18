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
import type { IngestQueue, BatchItem } from './queue.js'
import { isShortcut, readShortcutUrl } from './shortcut.js'

export interface Watcher {
  close(): Promise<void>
}

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void

export interface StartWatcherOptions {
  readonly queue: IngestQueue
  readonly config: Config
  /** Structured log sink; defaults to console. */
  readonly log?: LogFn
  /** Flush a batch after this many ms with no new file (SPEC.md §4.2). Default 3 s. */
  readonly batchQuietMs?: number
  /** Hard cap on how long a batch window stays open. Default 60 s (SPEC.md §4.2). */
  readonly batchMaxMs?: number
  /** `awaitWriteFinish` stability threshold in ms. Default 2 s; lowered in tests. */
  readonly stabilityMs?: number
  /**
   * Force chokidar polling. Windows mounts (`/mnt/*`, 9p/drvfs) don't deliver inotify
   * events, so events never fire without it. Defaults to auto-on for `/mnt/` paths.
   */
  readonly usePolling?: boolean
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

  const quietMs = opts.batchQuietMs ?? 3000
  const maxMs = opts.batchMaxMs ?? 60_000

  // Files that stabilize within the same window are flushed together as one batch
  // (SPEC.md §4.2). The quiet timer resets on each new file; the cap bounds total latency.
  const buffer: Array<{ filePath: string; name: string }> = []
  let quietTimer: ReturnType<typeof setTimeout> | undefined
  let capTimer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (quietTimer) clearTimeout(quietTimer)
    if (capTimer) clearTimeout(capTimer)
    quietTimer = undefined
    capTimer = undefined
    const group = buffer.splice(0)
    if (group.length > 0) void handleGroup(group, opts.queue, log, maxBytes)
  }

  const schedule = (): void => {
    if (quietTimer) clearTimeout(quietTimer)
    quietTimer = setTimeout(flush, quietMs)
    capTimer ??= setTimeout(flush, maxMs) // opened on the window's first file, not reset
  }

  // Windows mounts (9p/drvfs) don't deliver inotify events, so poll there or nothing fires.
  const usePolling = opts.usePolling ?? folder.startsWith('/mnt/')
  const watcher = chokidar.watch(folder, {
    ignoreInitial: false, // files already sitting in the inbox at startup should be taken
    awaitWriteFinish: { stabilityThreshold: opts.stabilityMs ?? 2000, pollInterval: 50 },
    ignored: (p) => path.basename(p).startsWith('.'), // skip dotfiles / partials
    depth: 10,
    usePolling,
    ...(usePolling ? { interval: 500, binaryInterval: 1000 } : {}),
  })
  if (usePolling) log('info', `polling mode (Windows mount) for ${folder}`)

  const maxBytes = opts.config.server.maxUploadBytes
  watcher.on('add', (filePath) => {
    buffer.push({ filePath, name: path.basename(filePath) })
    schedule()
  })
  watcher.on('error', (err) => log('error', `watch error: ${(err as Error).message}`))
  log('info', `watching ${folder}`)

  return {
    close: async () => {
      flush() // don't strand a half-collected batch on shutdown
      await watcher.close()
    },
  }
}

/** Enqueues one stabilized group: a single file goes solo, multiple files go as a batch. */
async function handleGroup(
  group: Array<{ filePath: string; name: string }>,
  queue: IngestQueue,
  log: LogFn,
  maxBytes: number,
): Promise<void> {
  const items: BatchItem[] = []
  const inboxFiles: string[] = []
  for (const { filePath, name } of group) {
    try {
      // The watch folder honours the same size cap as uploads (SPEC.md §4.2 "wie 4.1");
      // an over-limit file becomes a visible failed job and the inbox is still emptied.
      const size = fs.statSync(filePath).size
      if (size > maxBytes) {
        const job = queue.rejectOversizedFile({
          sourcePath: filePath,
          originalName: name,
          source: 'watch',
          sizeBytes: size,
          limitBytes: maxBytes,
        })
        log('warn', `refused oversized ${name} (${size} bytes > ${maxBytes}) → failed job ${job.id}`)
        fs.rmSync(filePath, { force: true })
        continue
      }
      // .url/.webloc shortcut, or a Web Clipper .md carrying a frontmatter URL → URL job.
      const url = isShortcut(name)
        ? readShortcutUrl(filePath)
        : name.toLowerCase().endsWith('.md')
          ? frontmatterUrl(filePath)
          : undefined
      items.push(url ? { kind: 'url', url } : { kind: 'file', sourcePath: filePath, originalName: name })
      inboxFiles.push(filePath)
    } catch (err) {
      log('error', `failed to read ${name}: ${(err as Error).message}`)
    }
  }
  if (items.length === 0) return

  try {
    if (items.length === 1) {
      const only = items[0]!
      if (only.kind === 'url') {
        const { job } = queue.enqueueUrl({ url: only.url, source: 'watch' })
        log('info', `enqueued URL → ${job.id}`)
      } else {
        const originalName = only.originalName ?? path.basename(only.sourcePath)
        const { job, duplicateOf } = await queue.enqueueFile({ sourcePath: only.sourcePath, source: 'watch', originalName })
        log('info', `enqueued ${originalName} → ${job.id}${duplicateOf ? ' (duplicate)' : ''}`)
      }
    } else {
      const { batchId, jobs } = await queue.enqueueBatch(items, 'watch')
      log('info', `enqueued batch ${batchId} of ${jobs.length} file(s) from watch folder`)
    }
    // Empty the inbox only after the vault has its own copies (enqueue copied them in).
    for (const p of inboxFiles) fs.rmSync(p, { force: true })
  } catch (err) {
    // Leave the files in the inbox on failure so nothing is silently lost.
    log('error', `failed to enqueue watch group: ${(err as Error).message}`)
  }
}
