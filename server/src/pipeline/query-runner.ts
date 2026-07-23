/**
 * The read-only query runner (SPEC.md §5, §6.3). A thin wrapper over `runAgent` pinned to
 * the `query` profile: no web egress, no vault writes (enforced by the sandbox + permission
 * hook), and SDK session resume so chat follow-ups keep context. Everything money- and
 * safety-relevant lives in the agent-runner/permissions; this module just names the intent
 * and is the single seam the query route and tests mock.
 *
 * It also owns the read path (SPEC.md §12.6 stage 2): chunk-level retrieval runs HERE, in the
 * service process, before the agent starts, and its hits ride in on the question as a
 * `<retrieved_context>` block. That placement is the whole point — the rerank stage needs the
 * local ollama and writes an embed cache, so running it outside the sandbox is what lets the
 * read-only profile stay exactly as strict as it is (no network hole, no write exception).
 * Retrieval never fails a query: when it is unprovisioned or errors, the question goes through
 * unchanged and the system prompt's legacy hot-cache → index path applies.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { runAgent, DEFAULT_TIMEOUT_MS, type AgentAuth, type AgentRunResult } from './agent-runner.js'
import { renderRetrievalBlock } from './system-prompt.js'
import { retrieveCandidates, type CandidateRetriever } from './retrieve-index.js'

/** Query runs are interactive; a shorter default keeps a stuck chat from hanging 15 min. */
export const DEFAULT_QUERY_TIMEOUT_MS = 5 * 60 * 1000

/** How many ranked pages the agent is pointed at. Enough to cover a question, short enough
 * that the agent still reads them all rather than skimming a wall of paths. */
const RETRIEVAL_TOP_K = 5

export interface QueryRunInput {
  readonly vaultRoot: string
  readonly question: string
  readonly auth: AgentAuth
  /** Resume a prior SDK session for a follow-up; omit to start fresh. */
  readonly resumeSessionId?: string
  readonly timeoutMs?: number
  readonly onMessage?: (message: SDKMessage) => void
  readonly signal?: AbortSignal
  /** Injectable so tests never spawn python; defaults to the real retrieval. */
  readonly retrieve?: CandidateRetriever
  /** Reports what retrieval did (page count + `retrieve.py`'s strategy label), for logging. */
  readonly onRetrieval?: (info: { readonly count: number; readonly strategy: string | null }) => void
}

/** Signature the query route depends on — injectable so tests supply a fake (no real SDK). */
export type QueryRunner = (input: QueryRunInput) => Promise<AgentRunResult>

export const runQuery: QueryRunner = async (input) => {
  const retrieve = input.retrieve ?? retrieveCandidates
  const { candidates, strategy } = await retrieve({
    vaultRoot: input.vaultRoot,
    question: input.question,
    topK: RETRIEVAL_TOP_K,
  })
  input.onRetrieval?.({ count: candidates.length, strategy })

  return runAgent({
    vaultRoot: input.vaultRoot,
    prompt: input.question + renderRetrievalBlock(candidates.map((c) => c.pagePath)),
    auth: input.auth,
    profile: 'query',
    timeoutMs: input.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    ...(input.onMessage ? { onMessage: input.onMessage } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
}

export { DEFAULT_TIMEOUT_MS }
