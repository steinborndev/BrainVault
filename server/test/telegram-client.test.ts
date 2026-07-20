import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TelegramClient,
  TelegramApiError,
  TelegramNetworkError,
  startPolling,
  type TgUpdate,
} from '../src/telegram/client.js'

const TOKEN = '12345:secret-bot-token'

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ok(result: unknown): Response {
  return jsonResponse({ ok: true, result })
}

/** A scripted fetch: consumes `responses` in order; aborts reject like real fetch. */
function fakeFetch(responses: Array<Response | Error | (() => Response | Error)>) {
  const calls: Array<{ url: string; body?: unknown }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const next = responses.shift()
    if (next === undefined) {
      // Script exhausted: behave like a hanging long poll that honours abort.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    }
    const value = typeof next === 'function' ? next() : next
    if (value instanceof Error) throw value
    return value
  }) as typeof fetch
  return { impl, calls }
}

function makeClient(responses: Array<Response | Error | (() => Response | Error)>) {
  const { impl, calls } = fakeFetch(responses)
  const client = new TelegramClient({ botToken: TOKEN, fetchImpl: impl })
  return { client, calls }
}

describe('TelegramClient — calls', () => {
  it('sendMessage posts the expected payload', async () => {
    const { client, calls } = makeClient([ok({})])
    await client.sendMessage({ chatId: 42, text: 'hi', parseMode: 'MarkdownV2' })
    expect(calls[0]!.url).toContain('/sendMessage')
    expect(calls[0]!.body).toMatchObject({ chat_id: 42, text: 'hi', parse_mode: 'MarkdownV2' })
  })

  it('surfaces API errors with method + code + description, retry_after included', async () => {
    const { client } = makeClient([
      jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }),
    ])
    const err = await client.sendMessage({ chatId: 1, text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TelegramApiError)
    expect((err as TelegramApiError).code).toBe(429)
    expect((err as TelegramApiError).retryAfterSec).toBe(7)
    expect((err as Error).message).toContain('sendMessage')
  })

  it('NEVER leaks the token in errors — api, network, or non-JSON (SPEC.md §9)', async () => {
    const cases: Array<Response | Error> = [
      jsonResponse({ ok: false, error_code: 400, description: 'Bad Request' }),
      new TypeError('fetch failed'),
      new Response('<html>gateway error</html>', { status: 502 }),
    ]
    for (const c of cases) {
      const { client } = makeClient([c])
      const err = (await client.getFile('f1').catch((e: unknown) => e)) as Error
      expect(err.message).not.toContain(TOKEN)
      expect(err.message).not.toContain('secret')
      expect(err.message).not.toContain('https://')
    }
  })

  it('wraps network failures as TelegramNetworkError naming only the method', async () => {
    const { client } = makeClient([new TypeError('fetch failed')])
    const err = await client.getUpdates({}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TelegramNetworkError)
    expect((err as Error).message).toContain('getUpdates')
  })

  it('getFile unwraps file_path and file_size', async () => {
    const { client } = makeClient([ok({ file_path: 'documents/f.pdf', file_size: 123 })])
    await expect(client.getFile('abc')).resolves.toEqual({ filePath: 'documents/f.pdf', fileSize: 123 })
  })
})

describe('TelegramClient — downloadFile', () => {
  const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dl-test-'))

  it('stages the file bytes into destDir', async () => {
    const { client } = makeClient([new Response(Buffer.from('hello pdf'))])
    const dir = tmpDir()
    try {
      const staged = await client.downloadFile({ filePath: 'documents/f.pdf', destDir: dir })
      expect(fs.readFileSync(staged, 'utf8')).toBe('hello pdf')
      expect(path.dirname(staged)).toBe(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses via Content-Length before reading the body', async () => {
    const body = new ReadableStream({ start: (c) => c.error(new Error('body must not be read')) })
    const res = new Response(body, { headers: { 'content-length': '999999' } })
    const { client } = makeClient([res])
    const dir = tmpDir()
    try {
      await expect(
        client.downloadFile({ filePath: 'f', destDir: dir, maxBytes: 10 }),
      ).rejects.toThrow(/exceeds/)
      expect(fs.readdirSync(dir)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces the cap on RECEIVED bytes when no Content-Length is present, leaving no file', async () => {
    // A streamed body carries no content-length; the cap must still hold.
    const chunk = new Uint8Array(8)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      },
    })
    const { client } = makeClient([new Response(body)])
    const dir = tmpDir()
    try {
      await expect(
        client.downloadFile({ filePath: 'f', destDir: dir, maxBytes: 10 }),
      ).rejects.toThrow(/exceeds/)
      expect(fs.readdirSync(dir)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('startPolling', () => {
  const update = (id: number, text = 'hi'): TgUpdate => ({
    update_id: id,
    message: { message_id: id, chat: { id: 7 }, date: 0, text },
  })

  it('delivers updates in order and acknowledges via the next offset', async () => {
    const { client, calls } = makeClient([ok([update(5), update(6)]), ok([])])
    const seen: number[] = []
    const poller = startPolling({
      client,
      onUpdate: (u) => {
        seen.push(u.update_id)
      },
      log: () => {},
    })
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2))
    await poller.stop()
    expect(seen).toEqual([5, 6])
    expect(calls[1]!.body).toMatchObject({ offset: 7 })
  })

  it('backs off on transient errors and resumes', async () => {
    const { client, calls } = makeClient([new TypeError('fetch failed'), ok([update(1)]), ok([])])
    const sleeps: number[] = []
    const seen: number[] = []
    const poller = startPolling({
      client,
      onUpdate: (u) => {
        seen.push(u.update_id)
      },
      log: () => {},
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
    })
    await vi.waitFor(() => expect(seen).toEqual([1]))
    await poller.stop()
    expect(sleeps).toEqual([1000])
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('honours retry_after on 429 instead of the exponential backoff', async () => {
    const { client } = makeClient([
      jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 9 } }),
      ok([]),
    ])
    const sleeps: number[] = []
    const poller = startPolling({
      client,
      onUpdate: () => {},
      log: () => {},
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
    })
    await vi.waitFor(() => expect(sleeps).toEqual([9000]))
    await poller.stop()
  })

  it('stops PERMANENTLY on 409 conflict, with actionable guidance, service unaffected', async () => {
    const { client, calls } = makeClient([
      jsonResponse({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }),
      ok([update(99)]), // must never be fetched
    ])
    const logs: string[] = []
    const seen: number[] = []
    const poller = startPolling({
      client,
      onUpdate: (u) => {
        seen.push(u.update_id)
      },
      log: (_level, message) => {
        logs.push(message)
      },
    })
    await vi.waitFor(() => expect(logs.join('\n')).toContain('stops permanently'))
    await poller.stop()
    expect(seen).toEqual([])
    expect(calls.length).toBe(1)
    expect(logs.join('\n')).toMatch(/dev instance|other instance/)
  })

  it('stops permanently on 401 (bad token)', async () => {
    const { client, calls } = makeClient([
      jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }),
      ok([]),
    ])
    const logs: string[] = []
    const poller = startPolling({ client, onUpdate: () => {}, log: (_l, m) => logs.push(m) })
    await vi.waitFor(() => expect(logs.join('\n')).toContain('TELEGRAM_BOT_TOKEN'))
    await poller.stop()
    expect(calls.length).toBe(1)
  })

  it('a throwing handler is logged, the loop continues, and the update is NOT redelivered', async () => {
    const { client, calls } = makeClient([ok([update(1)]), ok([update(2)]), ok([])])
    const logs: string[] = []
    const seen: number[] = []
    const poller = startPolling({
      client,
      onUpdate: (u) => {
        seen.push(u.update_id)
        if (u.update_id === 1) throw new Error('boom')
      },
      log: (_level, message) => {
        logs.push(message)
      },
    })
    await vi.waitFor(() => expect(seen).toEqual([1, 2]))
    await poller.stop()
    expect(logs.join('\n')).toContain('boom')
    // The poisonous update 1 was acknowledged: the second poll asked for offset 2.
    expect(calls[1]!.body).toMatchObject({ offset: 2 })
  })

  it('stop() aborts a hanging long poll promptly', async () => {
    const { client } = makeClient([]) // script exhausted → hanging abortable poll
    const poller = startPolling({ client, onUpdate: () => {}, log: () => {} })
    await new Promise((r) => setTimeout(r, 20)) // let the loop enter the long poll
    await expect(
      Promise.race([
        poller.stop().then(() => 'stopped'),
        new Promise((r) => setTimeout(() => r('timeout'), 1000)),
      ]),
    ).resolves.toBe('stopped')
  })
})
