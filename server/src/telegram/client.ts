/**
 * Minimal Telegram Bot API client + long-poll loop (SPEC.md §4.3).
 *
 * Hand-rolled on fetch, deliberately no framework: the surface this service consumes
 * is four calls (getUpdates, sendMessage, getFile, file download), and a bot framework
 * would be more attack surface than help (same reasoning as the minimal env parser in
 * config.ts). Transport is OUTBOUND long polling only — no webhook, no listening port,
 * the localhost guard (SPEC.md §9) is never touched.
 *
 * SECURITY (SPEC.md §9): the bot token is embedded in every request URL
 * (`/bot<token>/<method>`). Nothing in this module may ever log a URL or let one into
 * an error message — errors carry the METHOD NAME only. Telegram's own `description`
 * strings are safe to relay (they never contain our token).
 */

import fs from 'node:fs'
import path from 'node:path'
import { ulid } from 'ulid'

/**
 * Hard Bot API limit: bots may only download files up to 20 MB via getFile
 * (users can SEND up to 2 GB — the router replies with a hint instead, SPEC.md §4.3).
 */
export const MAX_BOT_DOWNLOAD_BYTES = 20 * 1024 * 1024

export const TELEGRAM_API_BASE = 'https://api.telegram.org'

/* ------------------------------------------------------------------------------------
 * Wire types — ONLY the fields this service consumes (the real objects are far larger).
 * ---------------------------------------------------------------------------------- */

export interface TgUser {
  readonly id: number
  readonly first_name?: string
  readonly username?: string
}

export interface TgChat {
  readonly id: number
}

export interface TgDocument {
  readonly file_id: string
  readonly file_name?: string
  readonly file_size?: number
  readonly mime_type?: string
}

/** One resolution of a photo; Telegram sends an array, largest last. */
export interface TgPhotoSize {
  readonly file_id: string
  readonly file_size?: number
  readonly width: number
  readonly height: number
}

export interface TgMessage {
  readonly message_id: number
  readonly from?: TgUser
  readonly chat: TgChat
  readonly date: number
  readonly text?: string
  readonly caption?: string
  readonly document?: TgDocument
  readonly photo?: readonly TgPhotoSize[]
  /** Set on album members — the router groups these into one batch (SPEC.md §4.3). */
  readonly media_group_id?: string
}

export interface TgUpdate {
  readonly update_id: number
  readonly message?: TgMessage
}

interface TgResponse<T> {
  readonly ok: boolean
  readonly result?: T
  readonly error_code?: number
  readonly description?: string
  readonly parameters?: { readonly retry_after?: number }
}

/* ------------------------------------------------------------------------------------
 * Errors — method name only, never a URL (the URL contains the token).
 * ---------------------------------------------------------------------------------- */

/** Telegram answered, but with ok=false (or a broken body). */
export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError'
  constructor(
    readonly method: string,
    readonly code: number,
    description: string,
    /** Seconds Telegram asked us to back off (429 responses). */
    readonly retryAfterSec?: number,
  ) {
    super(`telegram ${method} failed: ${code} ${description}`)
  }
}

/** The HTTP request itself failed (DNS, TLS, connection reset …). */
export class TelegramNetworkError extends Error {
  override readonly name = 'TelegramNetworkError'
  constructor(method: string, cause: Error) {
    // fetch's own errors ("fetch failed") carry no URL; keep it that way.
    super(`telegram ${method}: network error (${cause.message})`)
  }
}

/* ------------------------------------------------------------------------------------
 * Client
 * ---------------------------------------------------------------------------------- */

export interface TelegramClientOptions {
  readonly botToken: string
  /** Injected by tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Overridden by tests only. */
  readonly apiBase?: string
}

export class TelegramClient {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly apiBase: string

  constructor(options: TelegramClientOptions) {
    this.token = options.botToken
    this.fetchImpl = options.fetchImpl ?? fetch
    this.apiBase = options.apiBase ?? TELEGRAM_API_BASE
  }

  /** POSTs one Bot API method. Abort errors pass through untouched (shutdown signal). */
  private async call<T>(method: string, payload: object, signal?: AbortSignal): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new TelegramNetworkError(method, err as Error)
    }
    let body: TgResponse<T>
    try {
      body = (await res.json()) as TgResponse<T>
    } catch {
      throw new TelegramApiError(method, res.status, 'non-JSON response')
    }
    if (!body.ok || body.result === undefined) {
      throw new TelegramApiError(
        method,
        body.error_code ?? res.status,
        body.description ?? 'unknown error',
        body.parameters?.retry_after,
      )
    }
    return body.result
  }

  /** Long-polls for updates. `offset` acknowledges everything below it. */
  getUpdates(input: {
    readonly offset?: number
    readonly timeoutSec?: number
    readonly signal?: AbortSignal
  }): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      'getUpdates',
      {
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        timeout: input.timeoutSec ?? 50,
        allowed_updates: ['message'],
      },
      input.signal,
    )
  }

  async sendMessage(input: {
    readonly chatId: number
    readonly text: string
    readonly parseMode?: 'MarkdownV2'
  }): Promise<void> {
    await this.call<unknown>('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
      link_preview_options: { is_disabled: true },
    })
  }

  /** Resolves a file_id to a server-side path for download. */
  async getFile(fileId: string): Promise<{ filePath: string; fileSize?: number }> {
    const result = await this.call<{ file_path?: string; file_size?: number }>('getFile', {
      file_id: fileId,
    })
    if (result.file_path === undefined) {
      throw new TelegramApiError('getFile', 0, 'response carried no file_path')
    }
    return {
      filePath: result.file_path,
      ...(result.file_size !== undefined ? { fileSize: result.file_size } : {}),
    }
  }

  /**
   * Downloads a file (previously resolved via getFile) into `destDir` and returns the
   * staged path. The body is buffered, not streamed to disk: the hard 20 MB cap makes
   * buffering bounded, and it means an oversize or aborted download never leaves a
   * partial file behind. The cap is enforced twice — on Content-Length when present,
   * and on actual received bytes regardless (Telegram serves without the header too).
   */
  async downloadFile(input: {
    readonly filePath: string
    readonly destDir: string
    readonly maxBytes?: number
  }): Promise<string> {
    const maxBytes = input.maxBytes ?? MAX_BOT_DOWNLOAD_BYTES
    let res: Response
    try {
      res = await this.fetchImpl(`${this.apiBase}/file/bot${this.token}/${input.filePath}`)
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new TelegramNetworkError('downloadFile', err as Error)
    }
    if (!res.ok || res.body === null) {
      throw new TelegramApiError('downloadFile', res.status, 'file download failed')
    }
    const declared = Number(res.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new TelegramApiError('downloadFile', 413, `file exceeds the ${maxBytes}-byte bot limit`)
    }

    const chunks: Uint8Array[] = []
    let received = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel()
        throw new TelegramApiError('downloadFile', 413, `file exceeds the ${maxBytes}-byte bot limit`)
      }
      chunks.push(value)
    }

    fs.mkdirSync(input.destDir, { recursive: true })
    const dest = path.join(input.destDir, `telegram-${ulid()}`)
    fs.writeFileSync(dest, Buffer.concat(chunks))
    return dest
  }
}

/* ------------------------------------------------------------------------------------
 * Long-poll loop
 * ---------------------------------------------------------------------------------- */

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

export interface StartPollingOptions {
  readonly client: TelegramClient
  /** Called once per update, in order. A throwing handler is logged, never fatal. */
  readonly onUpdate: (update: TgUpdate) => void | Promise<void>
  /** Structured log sink; defaults to console (the service injects Fastify's logger). */
  readonly log?: LogFn
  readonly pollTimeoutSec?: number
  /** Injected by tests to fast-forward waits. Default sleep wakes early on stop(). */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface TelegramPoller {
  /** Aborts the in-flight long poll and resolves once the loop has fully exited. */
  stop(): Promise<void>
}

/**
 * Runs the getUpdates loop until stop() or a PERMANENT failure:
 *
 *  - 409 Conflict — a second consumer is polling this token (Telegram allows exactly
 *    one; typical cause: a dev instance next to the systemd service). We stop instead
 *    of fighting over updates; the service itself keeps running (SPEC.md §4.3).
 *  - 401 Unauthorized — the token is wrong/revoked; retrying cannot fix it.
 *
 * Transient failures (network, 5xx) back off exponentially (1 s → 60 s cap) and
 * resume; 429 honours Telegram's retry_after. Handler errors are logged and the
 * offset still advances — one poisonous update must not wedge the loop forever.
 */
export function startPolling(options: StartPollingOptions): TelegramPoller {
  const log: LogFn =
    options.log ?? ((level, message) => console.error(`[telegram:${level}] ${message}`))
  const abort = new AbortController()
  let running = true

  const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        abort.signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      abort.signal.addEventListener('abort', finish, { once: true })
    })
  const sleep = options.sleep ?? defaultSleep

  const done = (async (): Promise<void> => {
    let offset: number | undefined
    let backoffMs = INITIAL_BACKOFF_MS
    while (running) {
      let updates: TgUpdate[]
      try {
        updates = await options.client.getUpdates({
          ...(offset !== undefined ? { offset } : {}),
          timeoutSec: options.pollTimeoutSec ?? 50,
          signal: abort.signal,
        })
        backoffMs = INITIAL_BACKOFF_MS
      } catch (err) {
        if (!running || (err as Error).name === 'AbortError') break
        if (err instanceof TelegramApiError && err.code === 409) {
          log(
            'error',
            'getUpdates conflict (409): another consumer is polling this bot token — ' +
              'Telegram allows exactly one (typical cause: a dev instance running next to ' +
              'the systemd service). Polling stops permanently; the service keeps running. ' +
              'Stop the other instance and restart.',
          )
          break
        }
        if (err instanceof TelegramApiError && err.code === 401) {
          log(
            'error',
            'telegram rejected the bot token (401 Unauthorized) — polling stops permanently. ' +
              'Fix TELEGRAM_BOT_TOKEN and restart.',
          )
          break
        }
        const waitMs =
          err instanceof TelegramApiError && err.retryAfterSec !== undefined
            ? err.retryAfterSec * 1000
            : backoffMs
        log('warn', `${(err as Error).message} — retrying in ${Math.ceil(waitMs / 1000)}s`)
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
        await sleep(waitMs)
        continue
      }
      for (const update of updates) {
        // Advance BEFORE handling: a throwing handler must not make Telegram redeliver
        // the same update forever.
        offset = update.update_id + 1
        try {
          await options.onUpdate(update)
        } catch (err) {
          log('error', `update handler failed: ${(err as Error).message}`)
        }
      }
    }
  })()

  return {
    stop: async (): Promise<void> => {
      running = false
      abort.abort()
      await done
    },
  }
}
