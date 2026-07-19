/**
 * Domain-specific URL handlers (SPEC.md §5). Some sites cannot be ingested by fetching
 * their HTML: X/Twitter serves a JavaScript shell behind a login wall, and YouTube's
 * watch page carries no transcript. A handler produces the content through a better
 * channel instead — FxTwitter's public JSON API for tweets, yt-dlp subtitle download
 * for videos — and runs BEFORE the generic fetch+extract path. New domains are added
 * here as handlers, never as special cases in `preprocessUrl`, mirroring the plugin
 * rule for file types.
 *
 * Handlers never open sockets themselves: HTTP goes through the injected `fetchText`
 * (the pipeline's SSRF-guarded, size-capped fetch), and yt-dlp is the one deliberate
 * exception — an external tool with its own egress, invoked only for YouTube hosts.
 */

import fs from 'node:fs'
import path from 'node:path'
import { PreprocessError } from './types.js'
import type { ToolAvailability } from './types.js'
import { runTool } from './tools.js'

export interface UrlHandlerContext {
  readonly url: URL
  /** Absolute path to `.raw/<job-id>/` — handlers write raw artifacts here. */
  readonly jobDir: string
  readonly tools: ToolAvailability
  /** SSRF-guarded, size-capped fetch provided by `preprocessUrl`. */
  readonly fetchText: (url: string) => Promise<string>
}

export interface UrlHandlerResult {
  readonly markdown: string
  /** Job-dir-relative name of the raw artifact the handler wrote. */
  readonly original: string
  readonly notes: readonly string[]
}

export interface UrlHandler {
  readonly name: string
  matches(url: URL): boolean
  handle(ctx: UrlHandlerContext): Promise<UrlHandlerResult>
}

// ---------------------------------------------------------------------------
// X / Twitter via FxTwitter (https://docs.fxtwitter.com) — public posts only,
// no credentials involved. Private/deleted posts surface as a clear failure
// instead of an ingested login-wall shell.
// ---------------------------------------------------------------------------

const TWEET_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
])
const TWEET_PATH = /^\/(\w{1,15})\/status(?:es)?\/(\d+)/

export function matchTweetUrl(url: URL): { user: string; id: string } | undefined {
  if (!TWEET_HOSTS.has(url.hostname.toLowerCase())) return undefined
  const m = TWEET_PATH.exec(url.pathname)
  if (!m) return undefined
  return { user: m[1]!, id: m[2]! }
}

/** The subset of FxTwitter's status payload we render. Everything is optional on purpose. */
export interface FxTweet {
  readonly url?: string
  readonly text?: string
  readonly created_at?: string
  readonly author?: { readonly name?: string; readonly screen_name?: string }
  readonly likes?: number
  readonly retweets?: number
  readonly replies?: number
  readonly views?: number
  readonly quote?: FxTweet
  readonly media?: {
    readonly photos?: ReadonlyArray<{ readonly url?: string }>
    readonly videos?: ReadonlyArray<{ readonly url?: string }>
  }
}

export function formatTweetMarkdown(tweet: FxTweet, sourceUrl: string): string {
  const author = tweet.author ?? {}
  const handle = author.screen_name ? `@${author.screen_name}` : 'unknown author'
  const lines: string[] = [`# Tweet by ${handle}${author.name ? ` (${author.name})` : ''}`, '']
  const quoted = (text: string) =>
    text
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
  if (tweet.text) lines.push(quoted(tweet.text), '')
  const stats: string[] = []
  if (typeof tweet.likes === 'number') stats.push(`${tweet.likes} likes`)
  if (typeof tweet.retweets === 'number') stats.push(`${tweet.retweets} retweets`)
  if (typeof tweet.replies === 'number') stats.push(`${tweet.replies} replies`)
  if (typeof tweet.views === 'number') stats.push(`${tweet.views} views`)
  if (tweet.created_at) lines.push(`- Posted: ${tweet.created_at}`)
  if (stats.length > 0) lines.push(`- Stats: ${stats.join(', ')}`)
  lines.push(`- Source: ${tweet.url ?? sourceUrl}`)
  const media = [...(tweet.media?.photos ?? []), ...(tweet.media?.videos ?? [])]
    .map((m) => m.url)
    .filter((u): u is string => typeof u === 'string')
  if (media.length > 0) {
    lines.push('', '## Media', ...media.map((u) => `- ${u}`))
  }
  if (tweet.quote) {
    const quoteHandle = tweet.quote.author?.screen_name ? `@${tweet.quote.author.screen_name}` : 'unknown author'
    lines.push('', `## Quoted tweet (${quoteHandle})`, '')
    if (tweet.quote.text) lines.push(quoted(tweet.quote.text))
    if (tweet.quote.url) lines.push('', `- Source: ${tweet.quote.url}`)
  }
  return lines.join('\n')
}

export const twitterHandler: UrlHandler = {
  name: 'fxtwitter',
  matches: (url) => matchTweetUrl(url) !== undefined,
  async handle(ctx) {
    const m = matchTweetUrl(ctx.url)
    if (!m) throw new PreprocessError(`not a tweet URL: ${ctx.url.href}`)
    const api = `https://api.fxtwitter.com/${m.user}/status/${m.id}`
    let body: string
    try {
      body = await ctx.fetchText(api)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/HTTP 4\d\d/.test(msg)) {
        throw new PreprocessError(
          `tweet ${m.id} is not accessible via FxTwitter (${msg}) — the post is likely private, deleted, or age-restricted. Only public posts can be ingested without a login.`,
        )
      }
      throw err
    }
    let payload: { code?: number; message?: string; tweet?: FxTweet }
    try {
      payload = JSON.parse(body) as typeof payload
    } catch {
      throw new PreprocessError(`FxTwitter returned a non-JSON response for ${api}`)
    }
    if (payload.code !== 200 || !payload.tweet) {
      throw new PreprocessError(
        `FxTwitter could not resolve tweet ${m.id} (code ${payload.code ?? 'unknown'}: ${payload.message ?? 'no message'}) — the post is likely private or deleted.`,
      )
    }
    const original = 'tweet.json'
    fs.writeFileSync(path.join(ctx.jobDir, original), JSON.stringify(payload.tweet, null, 2), 'utf8')
    return {
      markdown: formatTweetMarkdown(payload.tweet, ctx.url.href),
      original,
      notes: ['fetched via FxTwitter public API (no login)'],
    }
  },
}

// ---------------------------------------------------------------------------
// YouTube via yt-dlp — metadata plus subtitles/auto-captions instead of the
// (content-free) watch page HTML.
// ---------------------------------------------------------------------------

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])
const YT_ID = /^[\w-]{6,20}$/

export function matchYoutubeUrl(url: URL): { videoId: string; videoUrl: string } | undefined {
  const host = url.hostname.toLowerCase()
  if (!YT_HOSTS.has(host)) return undefined
  let id: string | undefined
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1]
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v') ?? undefined
  } else {
    const m = /^\/(?:shorts|live|embed)\/([\w-]+)/.exec(url.pathname)
    if (m) id = m[1]
  }
  if (!id || !YT_ID.test(id)) return undefined
  return { videoId: id, videoUrl: `https://www.youtube.com/watch?v=${id}` }
}

/** Subtitle language preference: original-language German first, then English, then anything. */
export function pickSubtitleLang(langs: readonly string[]): string | undefined {
  return (
    langs.find((l) => l === 'de') ??
    langs.find((l) => l.startsWith('de')) ??
    langs.find((l) => l === 'en') ??
    langs.find((l) => l.startsWith('en')) ??
    langs[0]
  )
}

/** Converts WebVTT to plain text: drops headers, cue timings and inline tags, dedupes roll-up repeats. */
export function vttToText(vtt: string): string {
  const out: string[] = []
  let inMetaBlock = false
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line === 'WEBVTT' || line.startsWith('WEBVTT ')) continue
    if (/^(NOTE|STYLE|REGION)\b/.test(line)) {
      inMetaBlock = true
      continue
    }
    if (line.includes('-->')) {
      inMetaBlock = false
      continue
    }
    if (inMetaBlock) continue
    if (/^(Kind|Language):/i.test(line)) continue
    if (/^\d+$/.test(line)) continue // cue number
    const text = line
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim()
    if (!text) continue
    if (out[out.length - 1] === text) continue // auto-caption roll-up repeats
    out.push(text)
  }
  return out.join('\n')
}

interface YtMetadata {
  readonly id?: string
  readonly title?: string
  readonly channel?: string
  readonly uploader?: string
  readonly upload_date?: string
  readonly duration_string?: string
  readonly view_count?: number
  readonly description?: string
  readonly webpage_url?: string
}

function formatUploadDate(yyyymmdd: string | undefined): string | undefined {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return yyyymmdd
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

export const youtubeHandler: UrlHandler = {
  name: 'yt-dlp',
  matches: (url) => matchYoutubeUrl(url) !== undefined,
  async handle(ctx) {
    const m = matchYoutubeUrl(ctx.url)
    if (!m) throw new PreprocessError(`not a YouTube video URL: ${ctx.url.href}`)
    if (!ctx.tools.ytDlp) {
      throw new PreprocessError(
        'yt-dlp is not installed — required to ingest YouTube URLs (metadata + subtitle extraction). Install it (e.g. `pipx install yt-dlp`) and retry the job.',
      )
    }

    const notes: string[] = []
    let meta: YtMetadata
    try {
      const { stdout } = await runTool(
        'yt-dlp',
        ['--dump-json', '--skip-download', '--no-playlist', m.videoUrl],
        { timeoutMs: 90_000 },
      )
      meta = JSON.parse(stdout) as YtMetadata
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new PreprocessError(
        `yt-dlp could not read video ${m.videoId}: ${msg.split('\n')[0]} — the video may be private, members-only, or region-locked.`,
      )
    }

    // Subtitles are best-effort: a video without captions still has title + description.
    try {
      await runTool(
        'yt-dlp',
        [
          '--skip-download',
          '--no-playlist',
          '--write-subs',
          '--write-auto-subs',
          '--sub-langs',
          'de,en',
          '--sub-format',
          'vtt',
          '-P',
          ctx.jobDir,
          '-o',
          'subs',
          m.videoUrl,
        ],
        { timeoutMs: 120_000 },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notes.push(`subtitle download failed: ${msg.split('\n')[0]}`)
    }

    const subFiles = fs
      .readdirSync(ctx.jobDir)
      .map((f) => /^subs\.(.+)\.vtt$/.exec(f))
      .filter((x): x is RegExpExecArray => x !== null)
    const langs = subFiles.map((x) => x[1]!)
    const lang = pickSubtitleLang(langs)
    let transcript: string | undefined
    if (lang) {
      const file = subFiles.find((x) => x[1] === lang)![0]
      transcript = vttToText(fs.readFileSync(path.join(ctx.jobDir, file), 'utf8'))
      notes.push(`transcript from subtitles (${lang}); available: ${langs.join(', ')}`)
    } else {
      notes.push('no subtitles/auto-captions available — metadata and description only')
    }

    const reduced = {
      id: meta.id,
      title: meta.title,
      channel: meta.channel ?? meta.uploader,
      upload_date: meta.upload_date,
      duration_string: meta.duration_string,
      view_count: meta.view_count,
      description: meta.description,
      webpage_url: meta.webpage_url,
      subtitle_langs: langs,
    }
    const original = 'video.json'
    fs.writeFileSync(path.join(ctx.jobDir, original), JSON.stringify(reduced, null, 2), 'utf8')

    const lines: string[] = [`# ${meta.title ?? m.videoUrl}`, '']
    if (reduced.channel) lines.push(`- Channel: ${reduced.channel}`)
    const date = formatUploadDate(meta.upload_date)
    if (date) lines.push(`- Uploaded: ${date}`)
    if (meta.duration_string) lines.push(`- Duration: ${meta.duration_string}`)
    lines.push(`- Source: ${meta.webpage_url ?? m.videoUrl}`)
    if (meta.description) lines.push('', '## Description', '', meta.description)
    if (transcript) {
      lines.push('', `## Transcript (${lang})`, '', transcript)
    }
    return { markdown: lines.join('\n'), original, notes }
  },
}

// ---------------------------------------------------------------------------
// Notion — fail fast with guidance instead of a redirect-loop error. App pages
// (app.notion.com, notion.so page ids) bounce through a cookie-based
// session-sync redirect chain (/p/… → sessionSync → sessionSyncCallback →
// /p/…), which our cookie-less fetch reports as "too many redirects"; and even
// a cookie-carrying fetch only receives an ~18 KB JavaScript shell with zero
// page content (verified 2026-07-19). There is no anonymous content channel,
// so the handler's job is a clear, actionable error — not a fetch.
// ---------------------------------------------------------------------------

const NOTION_SO_HOSTS = new Set(['notion.so', 'www.notion.so'])
/** 32-hex Notion page id somewhere in the path (dashed or not). */
const NOTION_PAGE_ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?:$|[/?#])/i

/**
 * True for Notion APP pages: all of app.notion.com, and notion.so paths that carry a page id
 * or the /p/ share prefix. notion.so marketing pages (e.g. /blog/…) stay on the generic
 * fetch path — those are ordinary server-rendered articles and ingest fine.
 */
export function matchNotionAppUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  if (host === 'app.notion.com') return true
  if (!NOTION_SO_HOSTS.has(host)) return false
  return url.pathname.startsWith('/p/') || NOTION_PAGE_ID.test(url.pathname)
}

export const notionHandler: UrlHandler = {
  name: 'notion',
  matches: matchNotionAppUrl,
  handle(ctx) {
    return Promise.reject(
      new PreprocessError(
        `Notion app pages cannot be ingested from a URL (${ctx.url.href}): Notion serves a ` +
          'JavaScript-only shell — the HTML contains no page content, even for public pages. ' +
          'Export the page instead (Notion: ••• → Export → Markdown & CSV) and drop the file here, ' +
          'or paste the content as text.',
      ),
    )
  },
}

// ---------------------------------------------------------------------------

export const URL_HANDLERS: readonly UrlHandler[] = [twitterHandler, youtubeHandler, notionHandler]

export function findUrlHandler(url: URL): UrlHandler | undefined {
  return URL_HANDLERS.find((h) => h.matches(url))
}
