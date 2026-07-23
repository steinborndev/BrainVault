/**
 * Renders one streamed SDK message as a compact one-line log entry. Shared by the CLI
 * (stdout) and the queue (persisted to job_logs and, later, streamed over SSE) so the
 * two never drift in how a run reads back.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * The visible text of one partial-assistant message, for live chat streaming (SPEC.md §6.3).
 * Returns undefined for everything that is not a text delta — tool calls, thinking blocks and
 * every non-`stream_event` message — so the caller can pipe the whole SDK stream through it.
 *
 * Enabled only for the read-only `query` profile (`includePartialMessages`), so ingest and
 * research runs keep the exact message stream (and job_logs volume) they had before.
 *
 * Note this streams what the model TYPES, including any narration before a tool call. The
 * authoritative answer is still the run's final result — the UI swaps the streamed text for it
 * on completion, so a divergence here is cosmetic, never the persisted answer.
 */
export function textDelta(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event') return undefined
  const event = (message as { event?: unknown }).event as
    | { type?: unknown; delta?: { type?: unknown; text?: unknown } }
    | undefined
  if (event?.type !== 'content_block_delta') return undefined
  if (event.delta?.type !== 'text_delta') return undefined
  return typeof event.delta.text === 'string' && event.delta.text !== '' ? event.delta.text : undefined
}

export function formatMessage(message: SDKMessage): string | undefined {
  switch (message.type) {
    case 'assistant':
    case 'user': {
      const content = (message.message as { content?: unknown }).content
      if (typeof content === 'string') return `[${message.type}] ${content}`
      if (!Array.isArray(content)) return undefined
      const parts: string[] = []
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          parts.push(block['text'] as string)
        } else if (block['type'] === 'tool_use') {
          parts.push(`→ ${String(block['name'])}(${JSON.stringify(block['input']).slice(0, 160)})`)
        } else if (block['type'] === 'tool_result') {
          parts.push(block['is_error'] === true ? '← tool error' : '← tool ok')
        }
      }
      return parts.length > 0 ? `[${message.type}] ${parts.join('\n')}` : undefined
    }
    case 'system':
      return `[system] ${message.subtype}`
    case 'result':
      return undefined // summarised separately by the caller
    default:
      return undefined
  }
}
