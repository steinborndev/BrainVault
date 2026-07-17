/**
 * Headless agent runner: wraps the Claude Agent SDK's `query()` for one vault task.
 *
 * M0 scope (docs/tasks/TASKS-M0.md §4): messages go to stdout and usage is captured
 * from the result message. Persisting the stream to `job_logs` and the SSE fan-out
 * land in M1/M3 — hence the `onMessage` sink, so that change is a call-site change
 * rather than a rewrite of this module.
 */

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AUTOMATION_SYSTEM_PROMPT } from './system-prompt.js'
import { decidePermission, WEB_TOOLS } from './permissions.js'
import { CREDENTIAL_ENV_VARS, type CredentialEnvVar } from '../config.js'

/** Default per-job timeout (SPEC.md §3.1: "Timeout pro Job (Default 15 min)"). */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

export interface AgentUsage {
  readonly tokensIn: number
  readonly tokensOut: number
  /**
   * In subscription (OAuth) mode this is the SDK's computed API-price equivalent, not
   * money actually charged — SPEC.md §7.1 requires it be labelled "Schätzwert (Abo)"
   * wherever it is shown. Do not present it as a real cost in oauth mode.
   */
  readonly costUsd: number
}

export interface AgentRunResult {
  readonly ok: boolean
  /** The agent's final text. Empty when the run errored before producing one. */
  readonly result: string
  readonly usage: AgentUsage
  readonly durationMs: number
  readonly numTurns: number
  readonly sessionId: string
  /** Set when the run failed or was aborted. */
  readonly error?: string
  /** True when the timeout fired rather than the agent finishing. */
  readonly timedOut: boolean
}

export interface AgentAuth {
  readonly envVar: CredentialEnvVar
  readonly credential: string
}

export interface RunAgentOptions {
  /** Absolute, validated vault root. Becomes the run's cwd. */
  readonly vaultRoot: string
  /** The prompt, e.g. `ingest .raw/m0-test/paper.pdf`. */
  readonly prompt: string
  /**
   * Credential for the spawned Claude Code process.
   *
   * Required: the SDK spawns a subprocess that reads the credential from ITS
   * environment. Holding the token in our own config object does nothing for it —
   * without this the subprocess runs unauthenticated and replies
   * "Not logged in · Please run /login" as a *successful* result.
   */
  readonly auth: AgentAuth
  readonly timeoutMs?: number
  /** Sink for streamed SDK messages. M1 swaps stdout for job_logs here. */
  readonly onMessage?: (message: SDKMessage) => void
  /** Caller-owned abort (e.g. job cancellation). Composed with the timeout. */
  readonly signal?: AbortSignal
}

const EMPTY_USAGE: AgentUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 }

/** Pulls token counts out of the SDK usage shape without assuming optional fields exist. */
function readUsage(usage: unknown, costUsd: number): AgentUsage {
  const u = (usage ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  // Cache reads/writes are input tokens that were billed differently; counting them
  // keeps the dashboard's "tokens in" honest rather than under-reporting a cached run.
  const tokensIn =
    num(u['input_tokens']) +
    num(u['cache_read_input_tokens']) +
    num(u['cache_creation_input_tokens'])
  return { tokensIn, tokensOut: num(u['output_tokens']), costUsd }
}

/**
 * Builds the subprocess environment with exactly one credential in it.
 *
 * `Options.env` REPLACES the child environment rather than merging, so process.env
 * is spread in for PATH/HOME. Both credential vars are then stripped and only the
 * configured one re-added: config already refuses to start when both are set, but
 * this makes it structurally impossible for a stray ANTHROPIC_API_KEY in the
 * service's own environment to override the token we chose (SPEC.md §7.1).
 */
export function buildAgentEnv(
  auth: AgentAuth,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  for (const name of CREDENTIAL_ENV_VARS) delete env[name]
  env[auth.envVar] = auth.credential
  return env
}

export function buildOptions(opts: RunAgentOptions, abortController: AbortController): Options {
  return {
    cwd: opts.vaultRoot,
    env: buildAgentEnv(opts.auth),
    // Must include 'project' or the vault's CLAUDE.md and its skills never load —
    // without it the `ingest` skill does not exist and the run is a plain chat.
    settingSources: ['project'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: AUTOMATION_SYSTEM_PROMPT,
    },
    // 'default' + canUseTool, NOT 'acceptEdits': see permissions.ts — acceptEdits
    // would auto-accept edits anywhere, which is not the rule we have to enforce.
    permissionMode: 'default',
    canUseTool: async (toolName, input) =>
      decidePermission({ vaultRoot: opts.vaultRoot }, toolName, input),
    // Defense in depth; canUseTool denies these too.
    disallowedTools: [...WEB_TOOLS],
    abortController,
  }
}

/**
 * Runs one agent task to completion.
 *
 * Never throws for agent-level failures — a failed run is a result, because the
 * caller (the queue, in M1) has to record it either way. It throws only on
 * programmer error in constructing the run.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const abortController = new AbortController()
  const startedAt = Date.now()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, timeoutMs)

  const onExternalAbort = (): void => abortController.abort()
  if (opts.signal) {
    if (opts.signal.aborted) abortController.abort()
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  let result: AgentRunResult = {
    ok: false,
    result: '',
    usage: EMPTY_USAGE,
    durationMs: 0,
    numTurns: 0,
    sessionId: '',
    error: 'run produced no result message',
    timedOut: false,
  }

  try {
    for await (const message of query({ prompt: opts.prompt, options: buildOptions(opts, abortController) })) {
      opts.onMessage?.(message)

      if (message.type !== 'result') continue

      if (message.subtype === 'success') {
        const usage = readUsage(message.usage, message.total_cost_usd)
        // A run that spent zero tokens never reached the model, yet the SDK still
        // reports subtype 'success' with is_error: false — an unauthenticated
        // subprocess answers "Not logged in · Please run /login" exactly this way.
        // Trusting the subtype alone would record a no-op as a completed ingest.
        const reachedModel = usage.tokensIn > 0 || usage.tokensOut > 0
        result = {
          ok: !message.is_error && reachedModel,
          result: message.result,
          usage,
          durationMs: message.duration_ms,
          numTurns: message.num_turns,
          sessionId: message.session_id,
          timedOut: false,
          ...(reachedModel
            ? {}
            : {
                error:
                  'run consumed zero tokens — the agent never reached the model. ' +
                  `Usually an authentication failure; the agent replied: ${JSON.stringify(message.result.trim().slice(0, 120))}`,
              }),
        }
      } else {
        // Error subtypes (e.g. max turns, execution error) still carry usage —
        // a failed run costs tokens and the dashboard must show them.
        result = {
          ok: false,
          result: '',
          usage: readUsage(message.usage, message.total_cost_usd),
          durationMs: message.duration_ms,
          numTurns: message.num_turns,
          sessionId: message.session_id,
          error: `agent run failed: ${message.subtype}`,
          timedOut: false,
        }
      }
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt
    return {
      ...result,
      ok: false,
      durationMs: result.durationMs || durationMs,
      timedOut,
      error: timedOut
        ? `agent run aborted after ${Math.round(timeoutMs / 1000)}s timeout`
        : `agent run threw: ${(err as Error).message}`,
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onExternalAbort)
  }

  // An abort during a clean iteration exit still means the run did not finish.
  if (timedOut) {
    return {
      ...result,
      ok: false,
      timedOut: true,
      error: `agent run aborted after ${Math.round(timeoutMs / 1000)}s timeout`,
    }
  }
  return result
}
