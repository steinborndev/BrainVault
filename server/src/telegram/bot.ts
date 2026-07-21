/**
 * Telegram update router (SPEC.md §4.3): turns allowlisted messages into queue jobs and
 * status replies. Everything ingestable goes through the EXISTING pipeline entry points
 * (`enqueueFile`/`enqueueBatch`/`enqueueUrl`) — the bot is an input channel like the
 * dropzone and the watch folder, never a second ingestion path.
 *
 * SECURITY (SPEC.md §9): the allowlist guard runs before EVERYTHING else. Messages from
 * senders outside it are dropped with no reply and no log line — an answer (or a loud
 * log) would confirm the bot exists, and every accepted command can start a paid agent
 * run. Replies to allowlisted users are plain text and carry page/job names only, never
 * vault content.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import type { IngestQueue, BatchItem } from '../pipeline/queue.js'
import { FINISHED_STATES, type JobRow, type JobStore } from '../db/jobs.js'
import type { TelegramConfig } from '../config.js'
import type { BudgetStatus } from '../pipeline/budget.js'
import type { EventBus, BusEvent } from '../pipeline/events.js'
import type { MaintenanceRun } from '../pipeline/maintenance.js'
import type { TelegramDropStore } from '../db/telegram-drops.js'
import { formatJobOutcome, formatBatchOutcome, formatResearchOutcome } from './format.js'
import {
  TelegramClient,
  startPolling,
  MAX_BOT_DOWNLOAD_BYTES,
  type TelegramPoller,
  type TgMessage,
  type TgUpdate,
} from './client.js'

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void

/** Same staging dir as the upload route: bytes never touch the vault before enqueue. */
function defaultStagingDir(): string {
  return path.join(os.tmpdir(), 'vault-service-uploads')
}

const SETUP_MODE_REPLY =
  'The service is in setup mode — no Anthropic credential is configured yet, so nothing ' +
  'can be ingested. Open the dashboard, add the credential under Maintenance → Settings, ' +
  'and restart the service.'

const HELP_REPLY =
  'Send me a file, a URL, or plain text to queue it for ingestion.\n' +
  'Commands:\n' +
  '/research <topic> — research a topic on the web and file it into the vault\n' +
  '/status — service, queue and budget state\n' +
  '/jobs — the most recent jobs'

/** One album member, downloaded and waiting for the quiet window to close. */
interface AlbumMember {
  readonly sourcePath: string
  readonly originalName: string
}

interface AlbumBuffer {
  readonly chatId: number
  readonly members: AlbumMember[]
  timer: NodeJS.Timeout
}

export interface StartTelegramBotOptions {
  readonly telegram: TelegramConfig
  readonly queue: IngestQueue
  readonly store: JobStore
  /** True when no Anthropic credential is configured: status still answers, ingests refuse. */
  readonly setupMode: boolean
  /** Live-update bus; when passed, terminal telegram jobs notify their chat (SPEC.md §4.3). */
  readonly events?: EventBus
  /** Dropped-sender counters for the Maintenance card (migration v8); optional in tests/CLIs. */
  readonly drops?: Pick<TelegramDropStore, 'record'>
  /** Budget provider for /status; a provider so settings changes apply live (like the queue's). */
  readonly budget?: () => BudgetStatus
  /**
   * Starts an autoresearch run for `/research <topic>` and registers `onSettled` so the chat is
   * notified when it finishes. Optional: absent in tests/CLIs (and in setup mode the bot gates
   * the command before this is reached). The maintenance runner — not the ingest queue — owns
   * research, so it is injected rather than derived from the queue.
   */
  readonly startResearch?: (topic: string, onSettled: (run: MaintenanceRun) => void) => MaintenanceRun
  readonly log?: LogFn
  /** Injected by tests. */
  readonly client?: TelegramClient
  /** Album quiet window (Telegram delivers album parts as separate updates). */
  readonly albumWindowMs?: number
  readonly pollTimeoutSec?: number
  readonly stagingDir?: string
}

export interface TelegramBot {
  /** Stops polling, flushes pending albums into the queue, resolves when fully down. */
  stop(): Promise<void>
}

export function startTelegramBot(options: StartTelegramBotOptions): TelegramBot {
  const log: LogFn =
    options.log ?? ((level, message) => console.error(`[telegram:${level}] ${message}`))
  const client = options.client ?? new TelegramClient({ botToken: options.telegram.botToken })
  const allowed = new Set(options.telegram.allowedUserIds)
  const albumWindowMs = options.albumWindowMs ?? 2_000
  const stagingDir = options.stagingDir ?? defaultStagingDir()
  const albums = new Map<string, AlbumBuffer>()

  const notifyChannel = (chatId: number): string => `telegram:${chatId}`

  const reply = async (chatId: number, text: string): Promise<void> => {
    try {
      await client.sendMessage({ chatId, text })
    } catch (err) {
      log('warn', `could not send reply: ${(err as Error).message}`)
    }
  }

  /** MarkdownV2 send with a plain-text fallback — a lost notification is worse than a plain one. */
  const notify = async (chatId: number, text: string): Promise<void> => {
    try {
      await client.sendMessage({ chatId, text, parseMode: 'MarkdownV2' })
    } catch {
      await reply(chatId, text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1'))
    }
  }

  /* ---------------------------------- commands ---------------------------------- */

  const statusText = (): string => {
    const stats = options.queue.stats()
    const counts = options.store.counts()
    const lines: string[] = []
    lines.push(options.setupMode ? 'Status: SETUP MODE (no credential — ingestion disabled)' : 'Status: ok')
    const queueLine = stats.paused
      ? `Queue: paused (${stats.pauseReason ?? 'unknown'}), ${stats.inFlight} running`
      : `Queue: ${stats.inFlight} running (concurrency ${stats.concurrency})`
    lines.push(queueLine)
    const order = ['queued', 'preprocessing', 'ingesting', 'done', 'failed', 'deferred', 'duplicate', 'cancelled']
    const jobsLine = order
      .filter((s) => (counts[s] ?? 0) > 0)
      .map((s) => `${s} ${counts[s]}`)
      .join(' · ')
    lines.push(`Jobs: ${jobsLine === '' ? 'none yet' : jobsLine}`)
    if (options.budget) {
      const b = options.budget()
      lines.push(
        b.limit === null
          ? 'Budget: no daily limit'
          : `Budget: ${b.spent}/${b.limit} ${b.unit} today${b.exceeded ? ' — EXCEEDED, queue paused' : ''}`,
      )
    }
    return lines.join('\n')
  }

  const jobsText = (): string => {
    const recent = options.store.recent(8)
    if (recent.length === 0) return 'No jobs yet.'
    return recent
      .map((j) => `${j.status.padEnd(13)} ${j.original_name ?? j.url ?? j.id} (${j.id.slice(-6)})`)
      .join('\n')
  }

  /* ---------------------------------- ingestion ---------------------------------- */

  /** Setup-mode gate for anything that would end in an agent run (mirror of the 503). */
  const ingestAllowed = async (chatId: number): Promise<boolean> => {
    if (!options.setupMode) return true
    await reply(chatId, SETUP_MODE_REPLY)
    return false
  }

  /**
   * `/research <topic>`: starts a web-egress research run (the one flow allowed the web) and
   * reports back when it settles. Gated behind the setup-mode check by the caller like every
   * other agent-spawning path. The completion notice is plain text (page titles only, §9).
   */
  const handleResearch = async (chatId: number, topic: string): Promise<void> => {
    if (options.startResearch === undefined) {
      await reply(chatId, 'Research is not available on this service.')
      return
    }
    if (topic === '') {
      await reply(chatId, 'Usage: /research <topic> — e.g. /research ionizable lipids')
      return
    }
    const run = options.startResearch(topic, (settled) => {
      void runSafely(() => reply(chatId, formatResearchOutcome(topic, settled)))
    })
    await reply(
      chatId,
      `Started research on "${topic}" (run ${run.id.slice(-6)}). It searches the web, can run ` +
        `for several minutes and uses a chunk of today's budget — I'll report back when it's done.`,
    )
  }

  const handleUrl = async (chatId: number, url: string): Promise<void> => {
    const { job } = options.queue.enqueueUrl({
      url,
      source: 'telegram',
      notifyChannel: notifyChannel(chatId),
    })
    await reply(chatId, `Queued URL as job ${job.id.slice(-6)} — I'll report back when it's done.`)
  }

  const handleText = async (chatId: number, text: string): Promise<void> => {
    const name = `telegram-note-${ulid().slice(-6).toLowerCase()}.md`
    fs.mkdirSync(stagingDir, { recursive: true })
    const tempPath = path.join(stagingDir, `${ulid()}-${name}`)
    await fs.promises.writeFile(tempPath, text, 'utf8')
    try {
      const { job, duplicateOf } = await options.queue.enqueueFile({
        sourcePath: tempPath,
        source: 'telegram',
        originalName: name,
        notifyChannel: notifyChannel(chatId),
      })
      await reply(
        chatId,
        duplicateOf
          ? `That text is already in the vault (duplicate of job ${duplicateOf.slice(-6)}).`
          : `Queued your note as job ${job.id.slice(-6)} — I'll report back when it's done.`,
      )
    } finally {
      fs.rmSync(tempPath, { force: true })
    }
  }

  /** Resolves the downloadable file of a message: a document, or the largest photo size. */
  const pickAttachment = (
    message: TgMessage,
  ): { fileId: string; name: string; declaredSize?: number } | undefined => {
    if (message.document) {
      return {
        fileId: message.document.file_id,
        name: message.document.file_name ?? `document-${ulid().slice(-6).toLowerCase()}`,
        ...(message.document.file_size !== undefined ? { declaredSize: message.document.file_size } : {}),
      }
    }
    // Photos arrive as a size array (largest last) and carry no filename.
    const largest = message.photo?.[message.photo.length - 1]
    if (largest) {
      return {
        fileId: largest.file_id,
        name: `photo-${ulid().slice(-6).toLowerCase()}.jpg`,
        ...(largest.file_size !== undefined ? { declaredSize: largest.file_size } : {}),
      }
    }
    return undefined
  }

  const download = async (fileId: string): Promise<string> => {
    const { filePath } = await client.getFile(fileId)
    return client.downloadFile({ filePath, destDir: stagingDir })
  }

  const handleSingleFile = async (
    chatId: number,
    file: { fileId: string; name: string },
  ): Promise<void> => {
    const staged = await download(file.fileId)
    try {
      const { job, duplicateOf } = await options.queue.enqueueFile({
        sourcePath: staged,
        source: 'telegram',
        originalName: file.name,
        notifyChannel: notifyChannel(chatId),
      })
      await reply(
        chatId,
        duplicateOf
          ? `${file.name} is already in the vault (duplicate of job ${duplicateOf.slice(-6)}).`
          : `Queued ${file.name} as job ${job.id.slice(-6)} — I'll report back when it's done.`,
      )
    } finally {
      fs.rmSync(staged, { force: true })
    }
  }

  /* ----------------------------------- albums ----------------------------------- */

  const flushAlbum = async (key: string): Promise<void> => {
    const album = albums.get(key)
    if (album === undefined) return
    albums.delete(key)
    const items: BatchItem[] = album.members.map((m) => ({
      kind: 'file',
      sourcePath: m.sourcePath,
      originalName: m.originalName,
    }))
    try {
      const { batchId, jobs } = await options.queue.enqueueBatch(items, 'telegram', {
        notifyChannel: notifyChannel(album.chatId),
      })
      await reply(
        album.chatId,
        `Queued your album as one batch of ${jobs.length} file(s) (${batchId.slice(-6)}) — ` +
          `it will be ingested in a single combined run.`,
      )
    } finally {
      for (const m of album.members) fs.rmSync(m.sourcePath, { force: true })
    }
  }

  /** Album members share a media_group_id; collect within a quiet window → ONE batch (§4.1 analogue). */
  const handleAlbumFile = async (
    chatId: number,
    groupId: string,
    file: { fileId: string; name: string },
  ): Promise<void> => {
    const staged = await download(file.fileId)
    const key = `${chatId}:${groupId}`
    const existing = albums.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      existing.members.push({ sourcePath: staged, originalName: file.name })
      existing.timer = setTimeout(() => void runSafely(() => flushAlbum(key)), albumWindowMs)
    } else {
      albums.set(key, {
        chatId,
        members: [{ sourcePath: staged, originalName: file.name }],
        timer: setTimeout(() => void runSafely(() => flushAlbum(key)), albumWindowMs),
      })
    }
  }

  /* ---------------------------------- dispatch ----------------------------------- */

  const runSafely = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      log('error', `telegram handler failed: ${(err as Error).message}`)
    }
  }

  /* -------------------------- completion notifications --------------------------- */

  // `duplicate` is terminal but never transitions (decided at creation), so it can't fire
  // here — the router already answered it synchronously. `cancelled` is the user's own
  // dashboard action and deliberately not echoed (SPEC.md §4.3 lists done/failed/deferred).
  const TERMINAL_NOTIFY: ReadonlySet<string> = new Set(['done', 'failed', 'deferred'])
  const notifiedBatches = new Set<string>()
  const pendingNotifies = new Set<NodeJS.Timeout>()

  const chatIdOf = (channel: string | null): number | undefined => {
    if (channel === null || !channel.startsWith('telegram:')) return undefined
    const id = Number(channel.slice('telegram:'.length))
    return Number.isFinite(id) ? id : undefined
  }

  const notifyOutcome = async (jobId: string, batchId: string | null): Promise<void> => {
    if (batchId !== null) {
      // Batches notify ONCE, when the LAST member settles (SPEC.md §4.3).
      if (notifiedBatches.has(batchId)) return
      const members = options.store.byBatch(batchId)
      if (members.length === 0 || !members.every((m) => FINISHED_STATES.includes(m.status))) return
      const chatId = chatIdOf(members.find((m) => m.notify_channel !== null)?.notify_channel ?? null)
      if (chatId === undefined) return
      notifiedBatches.add(batchId)
      await notify(chatId, formatBatchOutcome(members))
      return
    }
    const job = options.store.get(jobId)
    if (job === undefined) return
    // Re-read the CURRENT status: an auto-retry transitions failed→queued synchronously
    // right after the failed event — the deferred check sees the requeue and stays quiet,
    // so only the FINAL failure (retries exhausted) reaches the chat.
    if (!TERMINAL_NOTIFY.has(job.status)) return
    const chatId = chatIdOf(job.notify_channel)
    if (chatId === undefined) return
    await notify(chatId, formatJobOutcome(job))
  }

  const onBusEvent = (event: BusEvent): void => {
    if (event.kind !== 'job') return
    const job: JobRow = event.job
    if (job.notify_channel === null || !job.notify_channel.startsWith('telegram:')) return
    if (!TERMINAL_NOTIFY.has(job.status)) return
    // One tick later — see notifyOutcome. Tracked so stop() can drop what hasn't fired.
    const timer = setTimeout(() => {
      pendingNotifies.delete(timer)
      void runSafely(() => notifyOutcome(job.id, job.batch_id))
    }, 0)
    pendingNotifies.add(timer)
  }

  const unsubscribe = options.events?.subscribe(onBusEvent)

  const dispatch = async (message: TgMessage): Promise<void> => {
    const chatId = message.chat.id

    const file = pickAttachment(message)
    if (file) {
      if (!(await ingestAllowed(chatId))) return
      // Polite pre-check on the DECLARED size (the client's cap is the hard backstop):
      // users may send up to 2 GB, bots may only download 20 MB (SPEC.md §4.3).
      if (file.declaredSize !== undefined && file.declaredSize > MAX_BOT_DOWNLOAD_BYTES) {
        const mb = Math.round(file.declaredSize / 1024 / 1024)
        await reply(
          message.chat.id,
          `${file.name} is ~${mb} MB — Telegram lets bots download at most 20 MB. ` +
            `Use the dashboard dropzone or the watch folder for large files.`,
        )
        return
      }
      if (message.media_group_id !== undefined) {
        await handleAlbumFile(chatId, message.media_group_id, file)
      } else {
        await handleSingleFile(chatId, file)
      }
      return
    }

    const text = message.text?.trim() ?? ''
    if (text === '') return

    if (text.startsWith('/')) {
      const command = text.split(/[\s@]/, 1)[0]
      if (command === '/status') return reply(chatId, statusText())
      if (command === '/jobs') return reply(chatId, jobsText())
      if (command === '/start' || command === '/help') return reply(chatId, HELP_REPLY)
      if (command === '/research') {
        // Strip the command (and an optional @botname suffix) to leave the bare topic.
        const topic = text.slice(command.length).replace(/^@\S+/, '').trim()
        if (!(await ingestAllowed(chatId))) return
        return handleResearch(chatId, topic)
      }
      return reply(chatId, `Unknown command ${command}.\n\n${HELP_REPLY}`)
    }

    if (!(await ingestAllowed(chatId))) return
    // A message that IS a URL (and nothing else) becomes a URL job, like a dropzone paste.
    if (/^https?:\/\/\S+$/i.test(text)) return handleUrl(chatId, text)
    return handleText(chatId, text)
  }

  // Operator visibility for the drop (user decision 2026-07-20): the SENDER still gets no
  // reaction, but the journal records the FIRST attempt per sender id — id and username
  // only, never the message content. One line per id guards the journal against flooding.
  const loggedStrangers = new Set<number>()

  const onUpdate = async (update: TgUpdate): Promise<void> => {
    const message = update.message
    // THE guard (SPEC.md §9): no sender id, or one outside the allowlist → drop, no reply.
    if (message?.from === undefined) return
    if (!allowed.has(message.from.id)) {
      // The DB counts EVERY attempt (the Maintenance card shows the live picture); the
      // journal keeps its one-line-per-id flood guard.
      try {
        options.drops?.record(message.from.id, message.from.username)
      } catch (err) {
        log('warn', `could not record dropped sender: ${(err as Error).message}`)
      }
      if (!loggedStrangers.has(message.from.id)) {
        loggedStrangers.add(message.from.id)
        const who = message.from.username
          ? `${message.from.id} (@${message.from.username})`
          : `${message.from.id}`
        log(
          'warn',
          `dropped message from non-allowlisted telegram user ${who} — the sender gets no reply ` +
            `(SPEC.md §9); add the id to TELEGRAM_ALLOWED_USER_IDS to allow it. Further messages ` +
            `from this id are dropped without logging.`,
        )
      }
      return
    }
    await runSafely(() => dispatch(message))
  }

  const poller: TelegramPoller = startPolling({
    client,
    onUpdate,
    log,
    ...(options.pollTimeoutSec !== undefined ? { pollTimeoutSec: options.pollTimeoutSec } : {}),
  })
  log('info', `telegram bot polling started (${allowed.size} allowlisted user(s))`)

  return {
    stop: async (): Promise<void> => {
      // Notifications first: unhook the bus and drop un-fired timers. A notification lost
      // to shutdown is the accepted gap (SPEC.md §4.3) — the job row keeps the truth.
      unsubscribe?.()
      for (const timer of pendingNotifies) clearTimeout(timer)
      pendingNotifies.clear()
      await poller.stop()
      // Flush pending albums instead of dropping already-downloaded members. Their quiet
      // window is moot now — nothing more can arrive once polling has stopped.
      for (const [key, album] of [...albums]) {
        clearTimeout(album.timer)
        await runSafely(() => flushAlbum(key))
      }
    },
  }
}
