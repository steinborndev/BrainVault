/**
 * Service entrypoint (SPEC.md §3.1): one process hosting the queue, the watcher, and the
 * HTTP API. `startService` wires them and is returned so tests and the systemd unit (M5)
 * can stop it cleanly; the direct-run block adds signal handling.
 */

import { pathToFileURL } from 'node:url'
import { loadConfig, describeConfig, assertBindAllowed, ConfigError, type Config } from './config.js'
import { openDb, defaultDbPath } from './db/index.js'
import { JobStore } from './db/jobs.js'
import { IngestQueue } from './pipeline/queue.js'
import { EventBus } from './pipeline/events.js'
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
  const queue = new IngestQueue({ store, vaultRoot: config.vaultRoot, auth: config.auth, events })
  queue.start()

  const watcher = startWatcher({
    queue,
    config,
    ...(config.server.watchPolling !== undefined ? { usePolling: config.server.watchPolling } : {}),
  })

  const app = await buildServer({ config, store, queue, events })
  await app.listen({ host: config.server.host, port: config.server.port })
  const url = `http://${config.server.host}:${config.server.port}`

  app.log.info({ ...describeConfig(config), transportPin: pin }, 'vault-service started')

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
