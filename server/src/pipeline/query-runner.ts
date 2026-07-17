/**
 * The read-only query runner (SPEC.md §5, §6.3). A thin wrapper over `runAgent` pinned to
 * the `query` profile: no web egress, no vault writes (enforced by the sandbox + permission
 * hook), and SDK session resume so chat follow-ups keep context. Everything money- and
 * safety-relevant lives in the agent-runner/permissions; this module just names the intent
 * and is the single seam the query route and tests mock.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { runAgent, DEFAULT_TIMEOUT_MS, type AgentAuth, type AgentRunResult } from './agent-runner.js'

/** Query runs are interactive; a shorter default keeps a stuck chat from hanging 15 min. */
export const DEFAULT_QUERY_TIMEOUT_MS = 5 * 60 * 1000

export interface QueryRunInput {
  readonly vaultRoot: string
  readonly question: string
  readonly auth: AgentAuth
  /** Resume a prior SDK session for a follow-up; omit to start fresh. */
  readonly resumeSessionId?: string
  readonly timeoutMs?: number
  readonly onMessage?: (message: SDKMessage) => void
  readonly signal?: AbortSignal
}

/** Signature the query route depends on — injectable so tests supply a fake (no real SDK). */
export type QueryRunner = (input: QueryRunInput) => Promise<AgentRunResult>

export const runQuery: QueryRunner = (input) =>
  runAgent({
    vaultRoot: input.vaultRoot,
    prompt: input.question,
    auth: input.auth,
    profile: 'query',
    timeoutMs: input.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    ...(input.onMessage ? { onMessage: input.onMessage } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })

export { DEFAULT_TIMEOUT_MS }
