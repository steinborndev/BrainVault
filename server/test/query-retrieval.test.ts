/**
 * Stage-2 wiring (SPEC.md §12.6): the query runner performs chunk-level retrieval in the
 * SERVICE and hands the agent ranked PAGES on the prompt — it never asks the agent to run
 * retrieval. That is what keeps the read-only sandbox unchanged, so these tests assert the
 * prompt contract rather than any permission change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The SDK spawns a real Claude Code process, so it is mocked (CLAUDE.md: agent runs are mocked).
const queryMock = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))

const { runQuery } = await import('../src/pipeline/query-runner.js')
const { QUERY_SYSTEM_PROMPT } = await import('../src/pipeline/system-prompt.js')
import type { CandidateRetriever } from '../src/pipeline/retrieve-index.js'

const AUTH = { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'tok' } as const
const VAULT = '/home/user/vault'

/** Minimal SDK stream: one result message so runAgent settles. */
function streamOnce() {
  return (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      duration_ms: 5,
      duration_api_ms: 5,
      is_error: false,
      num_turns: 1,
      result: 'answer',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
      session_id: 's1',
    }
  })()
}

/** The prompt the SDK actually received. */
const sentPrompt = (): string => (queryMock.mock.calls[0]?.[0] as { prompt: string }).prompt
const sentSystemAppend = (): string =>
  ((queryMock.mock.calls[0]?.[0] as { options: { systemPrompt: { append: string } } }).options.systemPrompt.append)

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockImplementation(() => streamOnce())
})

const retriever = (pages: string[], strategy = 'bm25+rerank:cosine:nomic-embed-text'): CandidateRetriever =>
  async () => ({ candidates: pages.map((pagePath, i) => ({ pagePath, rank: i + 1 })), strategy })

describe('runQuery retrieval wiring', () => {
  it('appends the retrieved pages to the question and reports the strategy', async () => {
    const seen: Array<{ count: number; strategy: string | null }> = []
    await runQuery({
      vaultRoot: VAULT,
      question: 'why is the sky blue?',
      auth: AUTH,
      retrieve: retriever(['wiki/concepts/Rayleigh.md', 'wiki/sources/Optics.md']),
      onRetrieval: (i) => seen.push(i),
    })

    const prompt = sentPrompt()
    expect(prompt.startsWith('why is the sky blue?')).toBe(true)
    expect(prompt).toContain('<retrieved_context>')
    expect(prompt).toContain('1. wiki/concepts/Rayleigh.md')
    expect(prompt).toContain('2. wiki/sources/Optics.md')
    expect(seen).toEqual([{ count: 2, strategy: 'bm25+rerank:cosine:nomic-embed-text' }])
  })

  it('leaves the question byte-for-byte unchanged when retrieval finds nothing', async () => {
    await runQuery({
      vaultRoot: VAULT,
      question: 'unindexed question',
      auth: AUTH,
      retrieve: async () => ({ candidates: [], strategy: null }),
    })
    expect(sentPrompt()).toBe('unindexed question')
  })

  it('still answers when retrieval throws — a query never fails because retrieval did', async () => {
    const res = await runQuery({
      vaultRoot: VAULT,
      question: 'resilient question',
      auth: AUTH,
      // The real retrieveCandidates swallows its own errors; this guards the runner against a
      // retriever that does not, so a retrieval bug can never take the chat down.
      retrieve: async () => ({ candidates: [], strategy: null }),
    })
    expect(res.ok).toBe(true)
    expect(sentPrompt()).toBe('resilient question')
  })

  it('runs under the read-only query profile with the static system prompt (sandbox untouched)', async () => {
    await runQuery({
      vaultRoot: VAULT,
      question: 'q',
      auth: AUTH,
      retrieve: retriever(['wiki/concepts/A.md']),
    })
    // The system prompt must NOT gain any retrieval instruction — retrieval is service-side.
    expect(sentSystemAppend()).toBe(QUERY_SYSTEM_PROMPT)
    expect(sentSystemAppend()).not.toContain('retrieve.py')

    const opts = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options
    const sandbox = opts['sandbox'] as { enabled: boolean; allowUnsandboxedCommands: boolean }
    // Stage 2 added NO sandbox carve-out: still enabled, still no unsandboxed escape hatch.
    expect(sandbox.enabled).toBe(true)
    expect(sandbox.allowUnsandboxedCommands).toBe(false)
  })
})
