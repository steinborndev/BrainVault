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
import { IngestQueue } from './pipeline/queue.js'
import { EventBus } from './pipeline/events.js'
import { MaintenanceRunner } from './pipeline/maintenance.js'
import { RunRegistry } from './pipeline/run-registry.js'
import { budgetStatus } from './pipeline/budget.js'
import { Mutex } from './util/mutex.js'
import { refreshTransportPin } from './pipeline/transport.js'
import { buildServer } from './api/server.js'
import { startWatcher, type Watcher } from './pipeline/watcher.js'
import type { FastifyInstance } from 'fastify'

export interface RunningService {
  readonly app: FastifyInstance
  readonly queue: IngestQueue
  readonly store: JobStore
  readonly watcher: Watcher
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
  queue.start()

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

  const watcher = startWatcher({
    queue,
    config: effectiveConfig,
    ...(config.server.watchPolling !== undefined ? { usePolling: config.server.watchPolling } : {}),
  })

  const app = await buildServer({ config: effectiveConfig, store, chat, queue, events, maintenance, settings })
  await app.listen({ host: config.server.host, port: config.server.port })
  const url = `http://${config.server.host}:${config.server.port}`

  // Log what the service actually runs with (overrides applied), not the bare baseline.
  app.log.info({ ...describeConfig(effectiveConfig), transportPin: pin }, 'vault-service started')

  const stop = async (): Promise<void> => {
    await watcher.close()
    queue.stop()
    await app.close()
    db.close()
  }

  return { app, queue, store, watcher, url, stop }
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
