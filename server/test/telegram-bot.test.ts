import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import { startTelegramBot } from '../src/telegram/bot.js'
import type { TelegramClient, TgMessage, TgUpdate } from '../src/telegram/client.js'
import type { IngestQueue } from '../src/pipeline/queue.js'
import type { JobRow, JobStore } from '../src/db/jobs.js'
import { EventBus } from '../src/pipeline/events.js'

const ALLOWED_USER = 111
const CHAT = 500

let updateSeq = 1

/** An update from the allowlisted user unless `from` is overridden. */
function update(over: Partial<TgMessage>): TgUpdate {
  return {
    update_id: updateSeq++,
    message: {
      message_id: updateSeq,
      chat: { id: CHAT },
      date: 0,
      from: { id: ALLOWED_USER },
      ...over,
    },
  }
}

/** Scripted client: serves `batches` of updates in order, then hangs abort-aware. */
function makeFakeClient(batches: TgUpdate[][]) {
  const sent: Array<{ chatId: number; text: string; parseMode?: string }> = []
  let call = 0
  const getFile = vi.fn(async (fileId: string) => ({ filePath: `files/${fileId}` }))
  const downloadFile = vi.fn(async (input: { destDir: string }) => {
    fs.mkdirSync(input.destDir, { recursive: true })
    const staged = path.join(input.destDir, `dl-${ulid()}`)
    fs.writeFileSync(staged, `bytes-${ulid()}`)
    return staged
  })
  const client = {
    getUpdates: async (input: { signal?: AbortSignal }): Promise<TgUpdate[]> => {
      if (call < batches.length) return batches[call++]!
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    },
    sendMessage: async (input: { chatId: number; text: string; parseMode?: string }): Promise<void> => {
      sent.push(input)
    },
    getFile,
    downloadFile,
  } as unknown as TelegramClient
  return { client, sent, getFile, downloadFile }
}

function makeFakeQueue() {
  const enqueueFile = vi.fn(async () => ({ job: { id: 'JOBFILE123456', status: 'queued' } }))
  const enqueueBatch = vi.fn(async (items: unknown[]) => ({
    batchId: 'BATCH00999999',
    jobs: (items as unknown[]).map((_item, i) => ({ job: { id: `MEMBER${i}`, status: 'queued' } })),
  }))
  const enqueueUrl = vi.fn(() => ({ job: { id: 'JOBURL7777777', status: 'queued' } }))
  const stats = vi.fn(() => ({ inFlight: 1, paused: false, pauseReason: null, concurrency: 2 }))
  const queue = { enqueueFile, enqueueBatch, enqueueUrl, stats } as unknown as IngestQueue
  return { queue, enqueueFile, enqueueBatch, enqueueUrl }
}

const fakeStore = {
  counts: () => ({ queued: 2, ingesting: 1, done: 40, failed: 1 }),
  recent: () => [
    { id: 'AAAAAAAA111111', status: 'ingesting', original_name: 'paper.pdf', url: null },
    { id: 'BBBBBBBB222222', status: 'done', original_name: null, url: 'https://example.org/x' },
  ],
} as unknown as JobStore

function makeBot(over: {
  batches?: TgUpdate[][]
  setupMode?: boolean
  albumWindowMs?: number
  budget?: () => { limit: number | null; unit: 'jobs' | 'usd'; spent: number; exceeded: boolean; resetsAt: string }
  store?: JobStore
  events?: EventBus
}) {
  const fake = makeFakeClient(over.batches ?? [])
  const q = makeFakeQueue()
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bot-test-'))
  const bot = startTelegramBot({
    telegram: { botToken: 't', allowedUserIds: [ALLOWED_USER] },
    queue: q.queue,
    store: over.store ?? fakeStore,
    setupMode: over.setupMode ?? false,
    ...(over.budget ? { budget: over.budget } : {}),
    ...(over.events ? { events: over.events } : {}),
    client: fake.client,
    log: () => {},
    albumWindowMs: over.albumWindowMs ?? 30,
    stagingDir,
  })
  return { bot, ...fake, ...q, stagingDir }
}

/** A full JobRow for notification tests. */
function makeJob(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 'JOB0000000001',
    user_id: 'local',
    batch_id: null,
    source: 'telegram',
    type: 'pdf',
    original_name: 'paper.pdf',
    url: null,
    sha256: null,
    status: 'done',
    raw_path: null,
    created_pages: JSON.stringify(['wiki/concepts/Espresso.md']),
    error: null,
    attempts: 1,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    created_at: '2026-07-20T00:00:00.000Z',
    started_at: null,
    finished_at: null,
    notify_channel: `telegram:${CHAT}`,
    ...over,
  }
}

/** Mutable row store for notification tests: events carry snapshots, the bot re-reads rows. */
function makeRowStore(rows: JobRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return {
    set: (row: JobRow) => byId.set(row.id, row),
    store: {
      ...fakeStore,
      get: (id: string) => byId.get(id),
      byBatch: (batchId: string) => [...byId.values()].filter((r) => r.batch_id === batchId),
    } as unknown as JobStore,
  }
}

describe('telegram bot — allowlist (SPEC.md §9)', () => {
  it('drops messages from strangers silently: no reply, no queue call', async () => {
    const b = makeBot({
      batches: [
        [update({ text: '/status', from: { id: 999 } })],
        [update({ document: { file_id: 'f1' }, from: { id: 999 } })],
        [update({ text: '/status' })], // sentinel from the allowlisted user
      ],
    })
    await vi.waitFor(() => expect(b.sent.length).toBe(1)) // only the sentinel answered
    await b.bot.stop()
    expect(b.enqueueFile).not.toHaveBeenCalled()
    expect(b.getFile).not.toHaveBeenCalled()
  })

  it('drops updates without a sender', async () => {
    const noFrom: TgUpdate = {
      update_id: updateSeq++,
      message: { message_id: 1, chat: { id: CHAT }, date: 0, text: '/status' },
    }
    const b = makeBot({ batches: [[noFrom], [update({ text: '/status' })]] })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
  })
})

describe('telegram bot — commands', () => {
  it('/status reports queue, job counts and budget', async () => {
    const b = makeBot({
      batches: [[update({ text: '/status' })]],
      budget: () => ({ limit: 10, unit: 'jobs', spent: 3, exceeded: false, resetsAt: '' }),
    })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    const text = b.sent[0]!.text
    expect(text).toContain('Status: ok')
    expect(text).toContain('1 running')
    expect(text).toContain('done 40')
    expect(text).toContain('3/10 jobs')
  })

  it('/status names setup mode', async () => {
    const b = makeBot({ batches: [[update({ text: '/status' })]], setupMode: true })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.sent[0]!.text).toContain('SETUP MODE')
  })

  it('/jobs lists recent jobs by name/url', async () => {
    const b = makeBot({ batches: [[update({ text: '/jobs' })]] })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.sent[0]!.text).toContain('paper.pdf')
    expect(b.sent[0]!.text).toContain('https://example.org/x')
  })

  it('unknown commands get the help text, not an ingest', async () => {
    const b = makeBot({ batches: [[update({ text: '/frobnicate' })]] })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.sent[0]!.text).toContain('/status')
    expect(b.enqueueFile).not.toHaveBeenCalled()
  })
})

describe('telegram bot — single-file ingest', () => {
  it('document → download → enqueueFile(telegram, notify_channel) → reply, staging cleaned', async () => {
    const b = makeBot({
      batches: [[update({ document: { file_id: 'f9', file_name: 'paper.pdf', file_size: 1234 } })]],
    })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.getFile).toHaveBeenCalledWith('f9')
    expect(b.enqueueFile).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'telegram',
        originalName: 'paper.pdf',
        notifyChannel: `telegram:${CHAT}`,
      }),
    )
    expect(b.sent[0]!.text).toContain('FILE123456'.slice(-6))
    expect(fs.readdirSync(b.stagingDir)).toEqual([]) // enqueue copies; staging is removed
  })

  it('a duplicate is reported as such', async () => {
    const b = makeBot({ batches: [[update({ document: { file_id: 'f1', file_name: 'x.pdf' } })]] })
    b.enqueueFile.mockResolvedValueOnce({
      job: { id: 'DUPJOB1111111', status: 'duplicate' },
      duplicateOf: 'ORIGINAL99999',
    } as never)
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.sent[0]!.text).toContain('duplicate')
  })

  it('over 20 MB declared → hint reply, no download, no job (SPEC.md §4.3)', async () => {
    const b = makeBot({
      batches: [[update({ document: { file_id: 'big', file_name: 'huge.iso', file_size: 21 * 1024 * 1024 } })]],
    })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.sent[0]!.text).toMatch(/20 MB/)
    expect(b.sent[0]!.text).toMatch(/dropzone|watch folder/)
    expect(b.getFile).not.toHaveBeenCalled()
    expect(b.enqueueFile).not.toHaveBeenCalled()
  })

  it('setup mode refuses the ingest with guidance, nothing downloaded', async () => {
    const b = makeBot({
      batches: [[update({ document: { file_id: 'f1', file_name: 'x.pdf' } })]],
      setupMode: true,
    })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.sent[0]!.text).toContain('setup mode')
    expect(b.getFile).not.toHaveBeenCalled()
    expect(b.enqueueFile).not.toHaveBeenCalled()
  })

  it('photos: largest size wins, name is synthesized', async () => {
    const b = makeBot({
      batches: [
        [
          update({
            photo: [
              { file_id: 'small', width: 90, height: 90 },
              { file_id: 'large', width: 1280, height: 1280 },
            ],
          }),
        ],
      ],
    })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.getFile).toHaveBeenCalledWith('large')
    expect(b.enqueueFile).toHaveBeenCalledWith(
      expect.objectContaining({ originalName: expect.stringMatching(/^photo-.*\.jpg$/) }),
    )
  })
})

describe('telegram bot — url and text ingest', () => {
  it('a lone URL becomes a URL job', async () => {
    const b = makeBot({ batches: [[update({ text: 'https://example.org/article' })]] })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.enqueueUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.org/article',
        source: 'telegram',
        notifyChannel: `telegram:${CHAT}`,
      }),
    )
  })

  it('plain text becomes a staged .md file job, staging cleaned after enqueue', async () => {
    const b = makeBot({ batches: [[update({ text: 'remember: espresso 1:2 ratio' })]] })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.enqueueFile).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'telegram',
        originalName: expect.stringMatching(/^telegram-note-.*\.md$/),
      }),
    )
    expect(fs.readdirSync(b.stagingDir)).toEqual([])
  })
})

describe('telegram bot — albums (media_group_id → ONE batch, SPEC.md §4.3)', () => {
  it('groups album members within the quiet window into one enqueueBatch + one reply', async () => {
    const b = makeBot({
      batches: [
        [
          update({ document: { file_id: 'a1', file_name: 'one.pdf' }, media_group_id: 'g1' }),
          update({ document: { file_id: 'a2', file_name: 'two.pdf' }, media_group_id: 'g1' }),
        ],
      ],
      albumWindowMs: 25,
    })
    await vi.waitFor(() => expect(b.enqueueBatch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    const [items, source, opts] = b.enqueueBatch.mock.calls[0] as unknown as [
      Array<{ kind: string; originalName?: string }>,
      string,
      { notifyChannel?: string },
    ]
    expect(items.map((i) => i.originalName)).toEqual(['one.pdf', 'two.pdf'])
    expect(source).toBe('telegram')
    expect(opts.notifyChannel).toBe(`telegram:${CHAT}`)
    expect(b.sent[0]!.text).toContain('batch')
    expect(fs.readdirSync(b.stagingDir)).toEqual([])
  })

  it('stop() flushes a pending album instead of dropping downloaded members', async () => {
    const b = makeBot({
      batches: [[update({ document: { file_id: 'a1', file_name: 'one.pdf' }, media_group_id: 'g2' })]],
      albumWindowMs: 60_000, // far beyond the test — only stop() can flush
    })
    await vi.waitFor(() => expect(b.downloadFile).toHaveBeenCalledTimes(1))
    await b.bot.stop()
    expect(b.enqueueBatch).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(b.stagingDir)).toEqual([])
  })
})

describe('telegram bot — completion notifications (SPEC.md §4.3)', () => {
  it('done → MarkdownV2 message with page titles to the recorded chat', async () => {
    const events = new EventBus()
    const job = makeJob()
    const rows = makeRowStore([job])
    const b = makeBot({ events, store: rows.store })
    events.publish({ kind: 'job', job })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.sent[0]!.chatId).toBe(CHAT)
    expect(b.sent[0]!.parseMode).toBe('MarkdownV2')
    expect(b.sent[0]!.text).toContain('Espresso')
    expect(b.sent[0]!.text).not.toContain('wiki/')
  })

  it('a FINAL failure notifies with the error; jobs without a channel stay silent', async () => {
    const events = new EventBus()
    const failed = makeJob({ id: 'F1', status: 'failed', error: 'boom' })
    const unchannelled = makeJob({ id: 'F2', status: 'done', notify_channel: null })
    const rows = makeRowStore([failed, unchannelled])
    const b = makeBot({ events, store: rows.store })
    events.publish({ kind: 'job', job: failed })
    events.publish({ kind: 'job', job: unchannelled })
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await b.bot.stop()
    expect(b.sent[0]!.text).toContain('boom')
  })

  it('an auto-retry (failed→queued in the same tick) does NOT notify', async () => {
    const events = new EventBus()
    const job = makeJob({ id: 'R1', status: 'failed', error: 'transient' })
    const rows = makeRowStore([job])
    const b = makeBot({ events, store: rows.store })
    // Mirror the queue's synchronous sequence: failed event fires, but by the time the
    // deferred check reads the row, the retry has already re-queued it.
    events.publish({ kind: 'job', job })
    rows.set({ ...job, status: 'queued' })
    events.publish({ kind: 'job', job: { ...job, status: 'queued' } })
    await new Promise((r) => setTimeout(r, 30))
    await b.bot.stop()
    expect(b.sent).toEqual([])
  })

  it('a batch notifies ONCE, when the last member settles', async () => {
    const events = new EventBus()
    const memberA = makeJob({ id: 'A', batch_id: 'BATCH1', original_name: 'one.pdf' })
    const memberB = makeJob({ id: 'B', batch_id: 'BATCH1', original_name: 'two.pdf', status: 'ingesting' })
    const rows = makeRowStore([memberA, memberB])
    const b = makeBot({ events, store: rows.store })

    // First member done while the second still runs → no message yet.
    events.publish({ kind: 'job', job: memberA })
    await new Promise((r) => setTimeout(r, 30))
    expect(b.sent).toEqual([])

    // Second member settles → exactly ONE batch message, even though two events fired.
    const doneB = { ...memberB, status: 'done' as const }
    rows.set(doneB)
    events.publish({ kind: 'job', job: doneB })
    events.publish({ kind: 'job', job: memberA }) // straggler event for the same batch
    await vi.waitFor(() => expect(b.sent.length).toBe(1))
    await new Promise((r) => setTimeout(r, 30))
    await b.bot.stop()
    expect(b.sent.length).toBe(1)
    expect(b.sent[0]!.text).toContain('one\\.pdf')
    expect(b.sent[0]!.text).toContain('two\\.pdf')
    expect(b.sent[0]!.text).toContain('2/2 done')
  })
})
