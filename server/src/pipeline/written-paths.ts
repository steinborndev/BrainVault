/**
 * Observes which vault files an agent run actually wrote, by reading the file paths out
 * of its Write/Edit tool calls in the SDK message stream. This is what makes a per-ingest
 * commit possible (TASKS-M1/M2 F4): staging exactly a job's own paths means a `git revert`
 * of one ingest doesn't disturb a sibling that was committed alongside it.
 *
 * Under the vault's filesystem transport, wiki pages ARE written via the Write tool with
 * an absolute path (per the vault's save skill), so those paths appear here. Files written
 * only by Bash scripts (e.g. `.vault-meta/address-counter.txt`) do NOT — the caller stages
 * those via a small bookkeeping allowlist, and commitVault falls back to `git add -A` if a
 * targeted stage turns up empty, so nothing is ever silently left uncommitted.
 */

import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { isInside } from './permissions.js'

/** Tools whose input names a file the agent is creating or modifying. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update'])
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const

/** Vault-relative POSIX paths written by this message's tool calls (confined to the vault). */
export function extractWrittenPaths(message: SDKMessage, vaultRoot: string): string[] {
  if (message.type !== 'assistant') return []
  const content = (message.message as { content?: unknown }).content
  if (!Array.isArray(content)) return []

  const out = new Set<string>()
  const add = (raw: unknown): void => {
    if (typeof raw !== 'string' || raw === '') return
    const abs = path.resolve(vaultRoot, raw)
    if (!isInside(vaultRoot, abs)) return // defensive: sandbox already blocks this
    out.add(path.relative(vaultRoot, abs).split(path.sep).join(path.posix.sep))
  }

  for (const block of content as Array<Record<string, unknown>>) {
    if (block['type'] !== 'tool_use' || !WRITE_TOOLS.has(String(block['name']))) continue
    const input = (block['input'] ?? {}) as Record<string, unknown>
    for (const key of PATH_KEYS) add(input[key])
    const edits = input['edits']
    if (Array.isArray(edits)) {
      for (const edit of edits) {
        if (edit && typeof edit === 'object') add((edit as Record<string, unknown>)['file_path'])
      }
    }
  }
  return [...out]
}
