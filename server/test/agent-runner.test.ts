import { describe, it, expect, vi, beforeEach } from 'vitest'

// The SDK spawns a real Claude Code process, so it is mocked here
// (CLAUDE.md: "agent runs are mocked in tests").
const queryMock = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))

const { runAgent, buildOptions, DEFAULT_TIMEOUT_MS } = await import('../src/pipeline/agent-runner.js')
const { AUTOMATION_SYSTEM_PROMPT } = await import('../src/pipeline/system-prompt.js')

const VAULT = '/home/user/vault'

/** Builds a result message matching the SDK's SDKResultSuccess shape. */
function successResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 3,
    result: 'created 9 pages',
    stop_reason: 'end_turn',
    total_cost_usd: 0.42,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 },
    modelUsage: {},
    permission_denials: [],
    uuid: 'u-1',
    session_id: 'sess-1',
    ...overrides,
  }
}

function streamOf(...messages: unknown[]) {
  return (async function* () {
    for (const m of messages) yield m
  })()
}

// Braces matter: an expression-bodied arrow would return mockReset()'s value (the
// mock itself), and vitest treats a beforeEach return value as a teardown callback —
// it would then call queryMock() with no arguments after every test.
beforeEach(() => {
  queryMock.mockReset()
})

describe('buildOptions', () => {
  const options = () => buildOptions({ vaultRoot: VAULT, prompt: 'ingest x' }, new AbortController())

  it('runs in the vault and loads project settings so the ingest skill exists', () => {
    // Without settingSources: ['project'], the vault's CLAUDE.md and skills never
    // load and `ingest` is just chat text — this is the load-bearing option.
    const o = options()
    expect(o.cwd).toBe(VAULT)
    expect(o.settingSources).toEqual(['project'])
  })

  it('appends the automation extension to the claude_code preset', () => {
    expect(options().systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: AUTOMATION_SYSTEM_PROMPT,
    })
  })

  it('does NOT use acceptEdits — permission scoping goes through canUseTool', () => {
    // acceptEdits would auto-accept edits anywhere on disk, not just under VAULT_ROOT.
    const o = options()
    expect(o.permissionMode).toBe('default')
    expect(o.canUseTool).toBeTypeOf('function')
  })

  it('disallows web tools as defense in depth', () => {
    expect(options().disallowedTools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']))
  })

  it('wires canUseTool to the vault scope', async () => {
    const canUseTool = options().canUseTool!
    const ctx = {
      signal: new AbortController().signal,
      toolUseID: 'tu-1',
      requestId: 'req-1',
    }
    await expect(canUseTool('Write', { file_path: '/etc/passwd' }, ctx)).resolves.toMatchObject({
      behavior: 'deny',
    })
    await expect(
      canUseTool('Write', { file_path: `${VAULT}/wiki/a.md` }, ctx),
    ).resolves.toMatchObject({ behavior: 'allow' })
  })
})

describe('runAgent', () => {
  it('returns the result and usage from a successful run', async () => {
    queryMock.mockReturnValue(streamOf(successResult()))
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'ingest x' })

    expect(run.ok).toBe(true)
    expect(run.result).toBe('created 9 pages')
    expect(run.numTurns).toBe(3)
    expect(run.sessionId).toBe('sess-1')
    expect(run.timedOut).toBe(false)
  })

  it('counts cached input tokens in tokensIn rather than under-reporting them', () => {
    queryMock.mockReturnValue(streamOf(successResult()))
    return runAgent({ vaultRoot: VAULT, prompt: 'x' }).then((run) => {
      // 100 fresh + 900 cache read
      expect(run.usage.tokensIn).toBe(1000)
      expect(run.usage.tokensOut).toBe(50)
      expect(run.usage.costUsd).toBe(0.42)
    })
  })

  it('streams every message to onMessage', async () => {
    const assistant = { type: 'assistant', message: { content: [] }, uuid: 'a', session_id: 's' }
    queryMock.mockReturnValue(streamOf(assistant, successResult()))
    const seen: string[] = []
    await runAgent({ vaultRoot: VAULT, prompt: 'x', onMessage: (m) => seen.push(m.type) })
    expect(seen).toEqual(['assistant', 'result'])
  })

  it('treats is_error: true as a failed run even on a success subtype', async () => {
    queryMock.mockReturnValue(streamOf(successResult({ is_error: true })))
    expect((await runAgent({ vaultRoot: VAULT, prompt: 'x' })).ok).toBe(false)
  })

  it('reports usage even when the run failed', async () => {
    queryMock.mockReturnValue(
      streamOf(successResult({ subtype: 'error_max_turns', is_error: true })),
    )
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x' })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('error_max_turns')
    // A failed run still burned tokens; the dashboard must see them.
    expect(run.usage.tokensIn).toBe(1000)
  })

  it('fails cleanly when the stream ends with no result message', async () => {
    queryMock.mockReturnValue(streamOf())
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x' })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('no result message')
  })

  it('does not throw when the SDK throws — a failed run is a result', async () => {
    queryMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x' })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('spawn failed')
  })

  it('aborts the run when the timeout fires', async () => {
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      // Never yields: it models an SDK call that hangs until aborted, which is
      // exactly the case the timeout has to rescue.
      // eslint-disable-next-line require-yield
      (async function* () {
        await new Promise((resolve) => {
          options.abortController.signal.addEventListener('abort', resolve, { once: true })
        })
        throw new Error('aborted')
      })(),
    )

    const run = await runAgent({ vaultRoot: VAULT, prompt: 'x', timeoutMs: 20 })
    expect(run.timedOut).toBe(true)
    expect(run.ok).toBe(false)
    expect(run.error).toContain('timeout')
  })

  it('aborts when the caller signal fires', async () => {
    const controller = new AbortController()
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      // Never yields: it models an SDK call that hangs until aborted, which is
      // exactly the case the timeout has to rescue.
      // eslint-disable-next-line require-yield
      (async function* () {
        await new Promise((resolve) => {
          options.abortController.signal.addEventListener('abort', resolve, { once: true })
        })
        throw new Error('aborted')
      })(),
    )

    const promise = runAgent({ vaultRoot: VAULT, prompt: 'x', signal: controller.signal })
    controller.abort()
    const run = await promise
    expect(run.ok).toBe(false)
    // Caller-cancelled, not timed out — the queue must distinguish these in M1.
    expect(run.timedOut).toBe(false)
  })

  it('defaults to the 15-minute timeout from SPEC.md §3.1', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15 * 60 * 1000)
  })
})
