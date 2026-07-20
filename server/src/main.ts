/**
 * Service entrypoint (SPEC.md §3.1): one process hosting the queue, the watcher, and the
 * HTTP API. `startService` wires them and is returned so tests and the systemd unit (M5)
 * can stop it cleanly; the direct-run block adds signal handling.
 */

import { pathToFileURL } from 'node:url'
import { loadConfig, describeConfig, assertBindAllowed, ConfigError, type Config } from './config.js'
import { openDb, defaultDbPath } from './db/index.js'
import { JobStore } from './db/jobs.js'
import { ChatStore } from './db/chat.js'
import { SettingsStore } from './db/settings.js'
import { DomainDismissalStore } from './db/domain-dismissals.js'
import { TelegramDropStore } from './db/telegram-drops.js'
import { IngestQueue } from './pipeline/queue.js'
import { EventBus } from './pipeline/events.js'
import { MaintenanceRunner } from './pipeline/maintenance.js'
import { RunRegistry } from './pipeline/run-registry.js'
import { budgetStatus } from './pipeline/budget.js'
import { Mutex } from './util/mutex.js'
import { refreshTransportPin } from './pipeline/transport.js'
import { buildServer } from './api/server.js'
import { startWatcher, type Watcher } from './pipeline/watcher.js'
import { startVaultWatcher, type VaultWatcher } from './pipeline/vault-watcher.js'
import { startTelegramBot, type TelegramBot } from './telegram/bot.js'
import type { FastifyInstance } from 'fastify'

export interface RunningService {
  readonly app: FastifyInstance
  readonly queue: IngestQueue
  readonly store: JobStore
  readonly watcher: Watcher
  readonly vaultWatcher: VaultWatcher
  /** `null` unless TELEGRAM_BOT_TOKEN is configured (SPEC.md §4.3). */
  readonly telegram: TelegramBot | null
  readonly url: string
  stop(): Promise<void>
}

export async function startService(config: Config = loadConfig()): Promise<RunningService> {
  // Fail fast, before opening anything, if the bind policy is violated (hard rule 2).
  assertBindAllowed(config.server)

  const pin = refreshTransportPin(config.vaultRoot)

  const db = openDb(defaultDbPath())
  // The live-update bus is shared: the store publishes job/log events, the queue publishes
  // stats, and the SSE route (via the app) is the sole subscriber (SPEC.md §6.5).
  const events = new EventBus()
  const store = new JobStore(db, events)
  const chat = new ChatStore(db)
  // One commit mutex shared by the ingest queue and the maintenance runner so their commits
  // never interleave (one vault writer at a time, TASKS-M4 §2).
  const commitMutex = new Mutex()
  // Shared so ingest and maintenance can see each other's in-flight runs: a run may only sweep
  // unattributed vault changes into its commit while it is the SOLE writer (finding F4).
  const runRegistry = new RunRegistry()
  // Runtime settings (SPEC.md §6.4): env is the start-time baseline, these are the overrides.
  // `watchFolder`/`maxUploadBytes` are read once here (they bind at startup — changing them is
  // flagged "restart required"); `concurrency`/`gitAutoCommit` apply live via the queue.
  const settings = new SettingsStore(db)
  const effective = settings.effective(config)
  const queue = new IngestQueue({
    store,
    vaultRoot: config.vaultRoot,
    auth: config.auth,
    events,
    commitMutex,
    concurrency: effective.concurrency,
    runRegistry,
    // A provider, not a value: a settings change takes effect on the next commit, no restart.
    autoCommit: () => settings.effective(config).gitAutoCommit,
    // Same pattern for the daily budget — evaluated through the shared budget module so the
    // queue's pause decision and the dashboard's display can never disagree (SPEC.md §11.3).
    budgetExceeded: () => budgetStatus(config, settings.effective(config), store).exceeded,
  })
  // SETUP MODE (config.auth === null): serve the dashboard so the user can enter the
  // credential there, but start nothing that could spawn an agent — the queue never claims
  // and the inbox watcher stays off. A restart after the credential is written picks
  // everything up (queued rows included).
  const setupMode = config.auth === null
  if (!setupMode) queue.start()

  // Dropped-sender counters (SPEC.md §9): written by the bot, read by the settings route.
  const telegramDrops = new TelegramDropStore(db)

  const maintenance = new MaintenanceRunner({
    vaultRoot: config.vaultRoot,
    auth: config.auth,
    events,
    commitMutex,
    runRegistry,
  })

  // The start-time-bound settings folded into the config the watcher and HTTP server see. The
  // bind (host/port) is deliberately NOT overridable — it stays whatever assertBindAllowed
  // approved above (hard rule 2).
  const effectiveConfig: Config = {
    ...config,
    server: {
      ...config.server,
      watchFolder: effective.watchFolder,
      maxUploadBytes: effective.maxUploadBytes,
    },
  }

  const watcher: Watcher = setupMode
    ? { close: async () => {} }
    : startWatcher({
        queue,
        config: effectiveConfig,
        ...(config.server.watchPolling !== undefined ? { usePolling: config.server.watchPolling } : {}),
      })

  // Live-graph signal (SPEC.md §12.4): wiki file changes → debounced `vault` SSE event.
  const vaultWatcher = startVaultWatcher({ vaultRoot: config.vaultRoot, events })

  const app = await buildServer({
    config: effectiveConfig,
    store,
    chat,
    queue,
    events,
    maintenance,
    settings,
    // User page edits/deletes commit behind the same mutex as ingest + maintenance, and
    // honour the live gitAutoCommit setting exactly like the queue does.
    commitMutex,
    autoCommit: () => settings.effective(config).gitAutoCommit,
    // Persistent, so a rejected domain candidate stays rejected across restarts.
    domainDismissals: new DomainDismissalStore(db),
    telegramDrops,
  })
  await app.listen({ host: config.server.host, port: config.server.port })
  const url = `http://${config.server.host}:${config.server.port}`

  // Log what the service actually runs with (overrides applied), not the bare baseline.
  app.log.info({ ...describeConfig(effectiveConfig), transportPin: pin }, 'vault-service started')
  if (setupMode) {
    app.log.warn(
      `SETUP MODE: no Anthropic credential configured — ingestion, watcher, query and maintenance ` +
        `are disabled. Open ${url} and add the credential under Maintenance → Settings.`,
    )
  }

  // Telegram channel (SPEC.md §4.3), symmetric to the watcher but ALSO alive in setup mode:
  // /status still answers there (reporting setup mode) while ingests are refused — the bot
  // gates them itself. Started after listen so its log lines go through the app logger.
  const telegram: TelegramBot | null = config.telegram
    ? startTelegramBot({
        telegram: config.telegram,
        queue,
        store,
        setupMode,
        // Completion notifications ride the same bus as the dashboard's SSE stream.
        events,
        drops: telegramDrops,
        // Same provider pattern (and the same budget module) as the queue and the stats
        // route, so all three always agree (SPEC.md §11.3).
        budget: () => budgetStatus(config, settings.effective(config), store),
        log: (level, message) => app.log[level](`[telegram] ${message}`),
      })
    : null

  const stop = async (): Promise<void> => {
    // Bot first: no new updates may reach the queue while it is draining/stopping.
    if (telegram) await telegram.stop()
    await watcher.close()
    await vaultWatcher.close()
    queue.stop()
    await app.close()
    db.close()
  }

  return { app, queue, store, watcher, vaultWatcher, telegram, url, stop }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  startService()
    .then((service) => {
      const shutdown = (signal: string): void => {
        service.app.log.info(`received ${signal}, shutting down`)
        service.stop().then(
          () => process.exit(0),
          (err: unknown) => {
            console.error('error during shutdown:', err)
            process.exit(1)
          },
        )
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigError) {
        console.error(`configuration error:\n${err.message}`)
        process.exit(2)
      }
      console.error('failed to start vault-service:', err)
      process.exit(1)
    })
}
