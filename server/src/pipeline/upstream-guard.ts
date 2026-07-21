/**
 * Upstream-protection guard for vault-writing agent runs (CLAUDE.md hard rule 5).
 *
 * The vault is a CLONE of the claude-obsidian repo: the plugin's machinery (skills/,
 * scripts/, bin/, docs/, hooks/, commands/, agents/, _templates/, root files like
 * CLAUDE.md) lives side by side with the user's knowledge under wiki/. Hard rule 5
 * forbids modifying the plugin's internals — but until now nothing ENFORCED that for
 * agent runs, whose sandbox legitimately allows writing anywhere under VAULT_ROOT.
 *
 * Two-part policy, deliberately narrow so no sanctioned flow is affected:
 *
 *  1. WRITABLE AREAS (allowlist, robust against future upstream additions): write tools
 *     may only touch wiki/, .raw/, .vault-meta/, assets/ and _attachments/. Everything
 *     else — plugin machinery and repo-root files — is refused. Reads stay unrestricted
 *     (skills READ their own docs constantly).
 *
 *  2. PROTECTED WIKI PAGES: the plugin ships documentation INSIDE wiki/ that skills
 *     consult by exact path (wiki/references/transport-fallback.md is read by 7 skills
 *     before vault mutations; methodology-modes by wiki-mode; getting-started is the
 *     onboarding page). These are derived from git — the files present under
 *     wiki/references/ + wiki/getting-started.md at the nearest reachable upstream tag
 *     (`git describe --tags`) — with a static fallback when the vault has no usable git
 *     history. NOT protected: the upstream demo wiki content and the mutable hubs
 *     (index/log/hot/overview/_index) — domain backfill, lint-fix and every ingest
 *     legitimately edit those.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** Top-level vault areas agent write tools may touch. Everything else is the plugin's. */
export const WRITABLE_AREAS: ReadonlySet<string> = new Set([
  'wiki',
  '.raw',
  '.vault-meta',
  'assets',
  '_attachments',
])

/**
 * The known plugin-doc pages inside wiki/, used when git can't answer (no repo, no
 * reachable tag). Kept in sync with claude-obsidian v1.9.2 — the derivation from git is
 * what keeps this honest across upgrades.
 */
export const FALLBACK_PROTECTED_WIKI: readonly string[] = [
  'wiki/getting-started.md',
  'wiki/references/methodology-modes.md',
  'wiki/references/transport-fallback.md',
]

/** Paths (vault-relative POSIX) whose files at the upstream tag count as protected. */
const PROTECTED_WIKI_SCOPES = ['wiki/references', 'wiki/getting-started.md'] as const

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep)

function git(vaultRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: vaultRoot,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/**
 * The plugin-shipped wiki pages, derived from the vault's own git history: whatever
 * lived under the protected scopes at the nearest reachable upstream tag. Falls back to
 * the static list on ANY failure — protection must never silently vanish because git
 * misbehaved.
 */
export function protectedWikiPages(vaultRoot: string): ReadonlySet<string> {
  try {
    const tag = git(vaultRoot, ['describe', '--tags', '--abbrev=0'])
    if (tag === '') return new Set(FALLBACK_PROTECTED_WIKI)
    const listing = git(vaultRoot, ['ls-tree', '-r', '--name-only', tag, '--', ...PROTECTED_WIKI_SCOPES])
    const files = listing.split('\n').map((l) => l.trim()).filter(Boolean)
    return files.length > 0 ? new Set(files) : new Set(FALLBACK_PROTECTED_WIKI)
  } catch {
    return new Set(FALLBACK_PROTECTED_WIKI)
  }
}

export interface UpstreamGuard {
  /** Refusal reason for a WRITE to `resolvedPath` (absolute), or undefined to allow. */
  writeRefusalReason(resolvedPath: string): string | undefined
}

/** One guard per vault root; the protected set is derived once (a plugin upgrade means a service restart anyway). */
const guards = new Map<string, UpstreamGuard>()

export function createUpstreamGuard(vaultRoot: string): UpstreamGuard {
  const cached = guards.get(vaultRoot)
  if (cached !== undefined) return cached

  const protectedPages = protectedWikiPages(vaultRoot)
  const guard: UpstreamGuard = {
    writeRefusalReason(resolvedPath: string): string | undefined {
      const rel = toPosix(path.relative(vaultRoot, resolvedPath))
      // Outside the vault (or the root itself) is the confinement check's business,
      // not this guard's — never double-report it here.
      if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
        return undefined
      }
      const top = rel.split('/')[0]!
      if (!WRITABLE_AREAS.has(top)) {
        return (
          `"${rel}" belongs to the claude-obsidian plugin, not the knowledge base. ` +
          `Agent runs may write only under wiki/, .raw/, .vault-meta/, assets/ and _attachments/.`
        )
      }
      if (protectedPages.has(rel)) {
        return (
          `"${rel}" is plugin-shipped documentation that skills consult by exact path ` +
          `(claude-obsidian upstream). It must not be edited by agent runs.`
        )
      }
      return undefined
    },
  }
  guards.set(vaultRoot, guard)
  return guard
}
