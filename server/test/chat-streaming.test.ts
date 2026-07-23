/**
 * Live chat streaming (SPEC.md §6.3): the query run emits partial-assistant messages, the route
 * turns their text deltas into coalesced `chat` bus events, and the UI renders them as a preview
 * it discards once the authoritative answer lands.
 *
 * These tests pin the two things that could silently break: what counts as a text delta, and
 * that partial messages are enabled for the READ-ONLY query profile only — a writing run
 * persists every streamed message to job_logs, so leaking partials into ingest would multiply
 * that volume for nobody's benefit.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))

const { textDelta, formatMessage } = await import('../src/pipeline/format-message.js')
const { buildOptions } = await import('../src/pipeline/agent-runner.js')

const AUTH = { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'tok' } as const
const VAULT = '/home/user/vault'

/** A partial-assistant message carrying one raw streaming event. */
const partial = (event: unknown): SDKMessage =>
  ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: 'u', session_id: 's' }) as unknown as SDKMessage

describe('textDelta', () => {
  it('extracts the text of a content_block_delta', () => {
    const m = partial({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } })
    expect(textDelta(m)).toBe('Hello')
  })

  it('ignores everything that is not visible answer text', () => {
    // Thinking blocks, tool-call argument streaming, block boundaries and empty chunks all
    // reach the same callback — none of them belong in the answer preview.
    expect(textDelta(partial({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } }))).toBeUndefined()
    expect(textDelta(partial({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }))).toBeUndefined()
    expect(textDelta(partial({ type: 'content_block_start', delta: { type: 'text_delta', text: 'x' } }))).toBeUndefined()
    expect(textDelta(partial({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }))).toBeUndefined()
    expect(textDelta(partial({}))).toBeUndefined()
    expect(textDelta(partial(undefined))).toBeUndefined()
  })

  it('ignores non-partial messages, so the whole SDK stream can be piped through it', () => {
    expect(textDelta({ type: 'result', subtype: 'success' } as unknown as SDKMessage)).toBeUndefined()
    expect(textDelta({ type: 'system', subtype: 'init' } as unknown as SDKMessage)).toBeUndefined()
    expect(
      textDelta({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } as unknown as SDKMessage),
    ).toBeUndefined()
  })

  it('leaves formatMessage untouched — a partial must not become a job_logs line', () => {
    const m = partial({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } })
    expect(formatMessage(m)).toBeUndefined()
  })
})

describe('includePartialMessages is query-only', () => {
  const optionsFor = (profile: 'ingest' | 'query' | 'research') =>
    buildOptions({ vaultRoot: VAULT, prompt: 'p', auth: AUTH, profile }, new AbortController()) as unknown as Record<
      string,
      unknown
    >

  it('is on for the read-only query profile', () => {
    expect(optionsFor('query')['includePartialMessages']).toBe(true)
  })

  it('is absent for the writing profiles, whose messages are persisted per line', () => {
    expect(optionsFor('ingest')['includePartialMessages']).toBeUndefined()
    expect(optionsFor('research')['includePartialMessages']).toBeUndefined()
  })

  it('does not disturb the query profile’s sandbox', () => {
    const sandbox = optionsFor('query')['sandbox'] as { enabled: boolean; allowUnsandboxedCommands: boolean }
    expect(sandbox.enabled).toBe(true)
    expect(sandbox.allowUnsandboxedCommands).toBe(false)
  })
})
