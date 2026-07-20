/**
 * Telegram message formatting for completion notifications (SPEC.md §4.3).
 *
 * Everything user- or vault-derived (file names, page titles, error lines) is escaped
 * for MarkdownV2 — Telegram rejects the whole message on a single unescaped reserved
 * character, and file names love dots and dashes. Notifications carry page TITLES only,
 * never content excerpts (SPEC.md §9).
 */

import path from 'node:path'
import type { JobRow } from '../db/jobs.js'

/** Telegram's hard cap per message. */
export const MAX_MESSAGE_CHARS = 4096

/** Every character MarkdownV2 reserves (https://core.telegram.org/bots/api#markdownv2-style). */
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g

export function escapeMd(text: string): string {
  return text.replace(RESERVED, (c) => `\\${c}`)
}

/** Hard-truncates to Telegram's limit, marking the cut. */
export function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text
  return `${text.slice(0, MAX_MESSAGE_CHARS - 2)}\n…`
}

/** 'wiki/concepts/Milk Steaming.md' → 'Milk Steaming' — the title, not the path (§9). */
export function pageTitle(pagePath: string): string {
  return path.basename(pagePath).replace(/\.md$/i, '')
}

function parsePages(job: JobRow): string[] {
  if (job.created_pages === null) return []
  try {
    const parsed = JSON.parse(job.created_pages) as unknown
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function jobName(job: JobRow): string {
  return job.original_name ?? job.url ?? job.id
}

/**
 * Vault maintenance pages the ingest touches on every run (indexes, hot cache, log). They are
 * real entries in `created_pages`, but as notification "titles" they are pure noise — filtered
 * HERE only (live acceptance observation, 2026-07-20); the DB keeps the full list. Matched by
 * PATH, not title, so a genuine content page named "Index" or "Log" still shows.
 */
const MAINTENANCE_PATHS = new Set(['wiki/index.md', 'wiki/hot.md', 'wiki/log.md'])
const isMaintenancePage = (pagePath: string): boolean =>
  MAINTENANCE_PATHS.has(pagePath) || path.basename(pagePath) === '_index.md'

function pagesBlock(pages: readonly string[]): string {
  const content = pages.filter((p) => !isMaintenancePage(p))
  if (content.length === 0) return ''
  const titles = [...new Set(content.map(pageTitle))]
  return `\nPages:\n${titles.map((t) => `• ${escapeMd(t)}`).join('\n')}`
}

/** One finished job → one MarkdownV2 message. Only done/failed/deferred are notified. */
export function formatJobOutcome(job: JobRow): string {
  const name = escapeMd(jobName(job))
  if (job.status === 'done') {
    return truncateMessage(`✅ *${name}* ingested${pagesBlock(parsePages(job))}`)
  }
  if (job.status === 'failed') {
    const error = job.error === null ? 'unknown error' : job.error
    return truncateMessage(`❌ *${name}* failed:\n${escapeMd(error)}\n\nRetry it from the dashboard\\.`)
  }
  return truncateMessage(
    `⏸ *${name}* was deferred — this type is not supported yet\\. It is parked in the dashboard\\.`,
  )
}

/** One finished batch → ONE message listing members and the union of created pages. */
export function formatBatchOutcome(members: readonly JobRow[]): string {
  const done = members.filter((m) => m.status === 'done').length
  const icon = done === members.length ? '✅' : done > 0 ? '⚠️' : '❌'
  const lines = members.map((m) => {
    const suffix = m.status === 'failed' && m.error !== null ? `: ${escapeMd(m.error)}` : ''
    return `• ${escapeMd(jobName(m))} — ${escapeMd(m.status)}${suffix}`
  })
  const pages = [...new Set(members.flatMap(parsePages))]
  return truncateMessage(
    `${icon} *Batch finished* \\(${done}/${members.length} done\\)\n${lines.join('\n')}${pagesBlock(pages)}`,
  )
}
