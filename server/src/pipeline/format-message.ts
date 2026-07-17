/**
 * Renders one streamed SDK message as a compact one-line log entry. Shared by the CLI
 * (stdout) and the queue (persisted to job_logs and, later, streamed over SSE) so the
 * two never drift in how a run reads back.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

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
