/**
 * Permission enforcement for agent runs (CLAUDE.md hard rule 4):
 *   - write access only under VAULT_ROOT
 *   - bash restricted to a whitelist of the vault's own scripts/*.sh
 *   - no web egress in ingest runs
 *
 * Why this is a `canUseTool` callback rather than `permissionMode: 'acceptEdits'`:
 * `acceptEdits` auto-accepts edits **anywhere the process can write**, with no path
 * condition — it would satisfy "don't prompt" but not "only under VAULT_ROOT". A
 * single decision point that both scopes and auto-accepts is the only way to make
 * the rule enforceable rather than aspirational.
 *
 * `disallowedTools` still lists the web tools as defense in depth: if a future SDK
 * version stops routing some tool through canUseTool, the deny survives.
 */

import path from 'node:path'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

/** Web tools are hard-denied for ingest runs (SPEC.md §9; autoresearch re-enables them in M4). */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const

/** Tools whose input names a path we must confine to the vault. */
const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path'] as const

/**
 * Shell metacharacters that allow chaining a second command onto a whitelisted one.
 * `bash scripts/wiki-lock.sh x; rm -rf ~` must not pass because it starts with an
 * allowed prefix — so any command containing these is rejected outright.
 */
const SHELL_CHAINING = /[;&|><`$(){}\n\r]|\|\||&&/

/** `cd`-free invocation of a vault script, with or without a `bash`/`sh` prefix. */
const VAULT_SCRIPT_COMMAND = /^(?:(?:ba)?sh\s+)?(?:\.\/)?scripts\/[A-Za-z0-9._-]+\.sh(?:\s|$)/

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

/**
 * Resolves a tool-supplied path against the vault root.
 * Relative paths are vault-relative because the run's cwd is the vault root.
 */
function resolveToolPath(vaultRoot: string, value: string): string {
  return path.resolve(vaultRoot, value)
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

/** Decides whether a Bash command is on the vault-script whitelist. */
export function isWhitelistedBashCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === '') return false
  if (SHELL_CHAINING.test(trimmed)) return false
  return VAULT_SCRIPT_COMMAND.test(trimmed)
}

/**
 * The single permission decision point for an ingest run.
 * Deny-by-default is deliberate: an unknown tool is refused rather than allowed,
 * so a future SDK tool cannot silently gain vault write access.
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
    const command = input['command']
    if (typeof command !== 'string') {
      return { behavior: 'deny', message: 'Bash called without a string command.' }
    }
    if (!isWhitelistedBashCommand(command)) {
      return {
        behavior: 'deny',
        message:
          `Bash is restricted to the vault's own scripts (e.g. \`bash scripts/wiki-lock.sh …\`), ` +
          `with no shell chaining. Refused: ${command}`,
      }
    }
    return { behavior: 'allow' }
  }

  // Any tool naming a path must stay inside the vault, whatever it is.
  const paths = extractPaths(input)
  for (const raw of paths) {
    const resolved = resolveToolPath(ctx.vaultRoot, raw)
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
