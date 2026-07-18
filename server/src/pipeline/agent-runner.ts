/**
 * Headless agent runner: wraps the Claude Agent SDK's `query()` for one vault task.
 *
 * M0 scope (docs/tasks/TASKS-M0.md §4): messages go to stdout and usage is captured
 * from the result message. Persisting the stream to `job_logs` and the SSE fan-out
 * land in M1/M3 — hence the `onMessage` sink, so that change is a call-site change
 * rather than a rewrite of this module.
 */

import {
  query,
  type Options,
  type SDKMessage,
  type SpawnOptions as SdkSpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk'
import { AUTOMATION_SYSTEM_PROMPT, QUERY_SYSTEM_PROMPT } from './system-prompt.js'
import { createDetachedSpawn } from './agent-spawn.js'
import {
  decidePermission,
  profileAllowsVaultWrite,
  profileAllowsWeb,
  WEB_TOOLS,
  WRITE_TOOLS,
  type RunProfile,
} from './permissions.js'
import { CREDENTIAL_ENV_VARS, type CredentialEnvVar } from '../config.js'

/** Default per-job timeout (SPEC.md §3.1: "Timeout pro Job (Default 15 min)"). */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Grace between the graceful abort and the hard, group-level SIGKILL. The SDK's own
 * graceful window (stdin-EOF → force) is ~2 s; we wait a little longer so a well-behaved
 * CLI still flushes its final result/usage before we reap its whole process group
 * (TASKS-M5 Finding F1). If a stuck bash grandchild is holding the run, this is what ends it.
 */
export const HARD_KILL_GRACE_MS = 5_000

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
  /**
   * The run profile (SPEC.md §5): `ingest` (default) writes to the vault with no web;
   * `query` is read-only with no web; `research` writes AND has web egress. It selects the
   * permission policy, the disallowed tools, the sandbox write allowlist, and the system
   * prompt — so a query run structurally cannot mutate the vault or reach the web.
   */
  readonly profile?: RunProfile
  /**
   * SDK session id to resume (query follow-ups keep context, SPEC.md §5). Omit to start a
   * fresh session. The resumed session's id is returned in the result either way.
   */
  readonly resumeSessionId?: string
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

export function buildOptions(
  opts: RunAgentOptions,
  abortController: AbortController,
  /**
   * Custom CLI spawner (TASKS-M5 Finding F1). When provided, the SDK starts the CLI
   * through it so the runner owns a detached process group it can hard-kill. Omitted by
   * `permprobe` (which only checks the enforcement hook), where the SDK's default spawn is fine.
   */
  spawnClaudeCodeProcess?: (options: SdkSpawnOptions) => SpawnedProcess,
): Options {
  const profile: RunProfile = opts.profile ?? 'ingest'
  const ctx = { vaultRoot: opts.vaultRoot, profile }
  // Web tools stay out of context unless this is a research run; a read-only query run
  // also drops the write tools so the model never even attempts a vault mutation.
  const disallowedTools = [
    ...(profileAllowsWeb(profile) ? [] : WEB_TOOLS),
    ...(profileAllowsVaultWrite(profile) ? [] : WRITE_TOOLS),
  ]
  return {
    cwd: opts.vaultRoot,
    env: buildAgentEnv(opts.auth),
    // Loads the vault's CLAUDE.md. NOTE: this does NOT turn skills on — that is
    // what `skills` below is for. The M0 ingest proved it: with settingSources
    // alone, Skill({skill:'wiki-ingest'}) errored and the agent fell back to
    // reading SKILL.md and improvising.
    settingSources: ['project'],
    // The vault ships `.claude-plugin/plugin.json` — claude-obsidian IS a Claude
    // Code plugin, and its skills live in `skills/`, which is not a location the
    // CLI scans on its own. Loading the vault as a local plugin is what registers
    // `wiki-ingest` et al. as invocable skills; `settingSources: ['project']` alone
    // does not (measured — the agent saw only the CLI's bundled skills).
    plugins: [{ type: 'local', path: opts.vaultRoot }],
    // "This is the single place to turn skills on" (SDK docs).
    skills: 'all',
    // Resume a prior SDK session so query follow-ups keep context (SPEC.md §5). Ignored
    // (undefined) for a fresh run.
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      // A read-only query gets the read-only prompt; ingest/research keep the automation
      // prompt (both write pages and must not stall on a question).
      append: profile === 'query' ? QUERY_SYSTEM_PROMPT : AUTOMATION_SYSTEM_PROMPT,
    },
    /**
     * OS-level confinement — the only thing that makes "writes only under
     * VAULT_ROOT" (CLAUDE.md hard rule 4) a real boundary rather than a claim.
     *
     * The tool-level hook below cannot cover Bash: deciding what an arbitrary
     * shell string writes is not tractable, and the validated ingest needs general
     * bash. A deny-everything probe confirmed `touch /tmp/canary` succeeded with
     * the hook alone. bubblewrap enforces it in the kernel instead.
     *
     * `failIfUnavailable: true` is explicit (it is also the default when `enabled`
     * is passed here): if the sandbox cannot be created, the run must fail loudly
     * rather than silently execute unconfined.
     */
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      // Without this the sandbox is decorative: the Bash tool ships a
      // `dangerouslyDisableSandbox` parameter and it is permitted by DEFAULT
      // (`allowUnsandboxedCommands` defaults to true). Measured — with the sandbox
      // enabled but this left at its default, the agent hit the write denial, set
      // the parameter, and created the canary outside the vault on its second try.
      // At false the parameter is ignored entirely and every command is sandboxed.
      allowUnsandboxedCommands: false,
      // A read-only query run gets NO vault write path — the OS sandbox is the hard floor
      // for "chat does not modify the vault" (SPEC.md §5). ingest/research write the vault.
      filesystem: { allowWrite: profileAllowsVaultWrite(profile) ? [opts.vaultRoot] : [] },
    },
    permissionMode: 'default',
    // THE enforcement point. canUseTool is advisory and was measured to be invoked
    // zero times against this SDK; a PreToolUse hook is invoked and does block.
    // See permissions.ts header and server/src/cli/permprobe.ts.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              const { tool_name, tool_input } = input as {
                tool_name: string
                tool_input: unknown
              }
              const decision = decidePermission(
                ctx,
                tool_name,
                (tool_input ?? {}) as Record<string, unknown>,
              )
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: decision.behavior === 'allow' ? 'allow' : 'deny',
                  permissionDecisionReason:
                    decision.behavior === 'deny' ? decision.message : 'allowed by vault policy',
                },
              }
            },
          ],
        },
      ],
    },
    // Redundant second layer: kept because it costs nothing, but it is NOT the
    // boundary — do not rely on it.
    canUseTool: async (toolName, input) => decidePermission(ctx, toolName, input),
    // Removes web (and, for a read-only query, write) tools from the model's context.
    disallowedTools,
    abortController,
    // Own the CLI spawn so the run has a detached process group to hard-kill (F1).
    ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
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
  const spawnHandle = createDetachedSpawn()
  const startedAt = Date.now()

  // The hard backstop (F1): a graceful abort SIGTERMs only the CLI leader, which a stuck
  // bash grandchild survives. After a grace, SIGKILL the whole process group.
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleHardKill = (): void => {
    if (hardKillTimer) return
    hardKillTimer = setTimeout(() => spawnHandle.hardKill(), HARD_KILL_GRACE_MS)
    hardKillTimer.unref?.()
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abortController.abort()
    scheduleHardKill()
  }, timeoutMs)

  const onExternalAbort = (): void => {
    abortController.abort()
    scheduleHardKill()
  }
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortController.abort()
      scheduleHardKill()
    } else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
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
    for await (const message of query({
      prompt: opts.prompt,
      options: buildOptions(opts, abortController, spawnHandle.spawn),
    })) {
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
    if (hardKillTimer) clearTimeout(hardKillTimer)
    // Once the run has resolved, make sure no descendant (a detached bash the CLI left
    // behind) leaks. hardKill() no-ops if the child already exited cleanly.
    spawnHandle.hardKill()
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
