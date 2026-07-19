/**
 * Vault change watcher (SPEC.md §12.4, live graph). chokidar watches `VAULT_ROOT/wiki` and
 * publishes a debounced `vault` event on the bus whenever a wiki page is added, changed, or
 * removed — regardless of WHO wrote it (agent run mid-ingest, dashboard edit, manual edit in
 * Obsidian). The SSE stream forwards it and the graph view refetches.
 *
 * Strictly a notification: this module never reads page contents and never writes anything
 * (hard rule 1). A missed event only means a stale graph until the next refetch — the
 * GraphBuilder re-stats the vault on every request anyway, so correctness never depends on
 * this signal.
 */

import path from 'node:path'
import chokidar from 'chokidar'
import type { EventBus } from './events.js'

export interface VaultWatcher {
  close(): Promise<void>
}

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void

export interface StartVaultWatcherOptions {
  readonly vaultRoot: string
  readonly events: EventBus
  /** Structured log sink; defaults to console (stderr). */
  readonly log?: LogFn
  /**
   * Quiet period before a burst of file events becomes ONE `vault` event. An agent run
   * writes several pages in quick succession; per-write events would refetch the graph
   * once per page. Default 1 s — fast enough to feel live, coarse enough to coalesce.
   */
  readonly debounceMs?: number
  /** Force chokidar polling (Windows mounts). Defaults to auto-on for `/mnt/` paths. */
  readonly usePolling?: boolean
}

export function startVaultWatcher(opts: StartVaultWatcherOptions): VaultWatcher {
  const wikiRoot = path.join(opts.vaultRoot, 'wiki')
  const log = opts.log ?? ((level, message) => console.error(`[vault-watcher:${level}] ${message}`))
  const debounceMs = opts.debounceMs ?? 1000

  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const bump = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      opts.events.publish({ kind: 'vault' })
    }, debounceMs)
  }

  // Same heuristic as the inbox watcher: 9p/drvfs mounts deliver no inotify events.
  const usePolling = opts.usePolling ?? opts.vaultRoot.startsWith('/mnt/')
  const watcher = chokidar.watch(wikiRoot, {
    // Pages already on disk are not a "change" — the graph view fetches its baseline itself.
    ignoreInitial: true,
    ignored: (p) => path.basename(p).startsWith('.'),
    depth: 10,
    usePolling,
    ...(usePolling ? { interval: 500, binaryInterval: 1000 } : {}),
  })

  const onFile = (filePath: string): void => {
    if (filePath.endsWith('.md')) bump()
  }
  watcher.on('add', onFile)
  watcher.on('change', onFile)
  watcher.on('unlink', onFile)
  watcher.on('error', (err) => log('error', `vault watch error: ${(err as Error).message}`))
  log('info', `watching vault wiki at ${wikiRoot}`)

  return {
    close: async () => {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      await watcher.close()
    },
  }
}
