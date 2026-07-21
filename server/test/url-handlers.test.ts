import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { assessExtractedContent, MIN_WEB_CONTENT_CHARS } from '../src/pipeline/preprocess/web.js'
import {
  diagnoseYtDlpFailure,
  findUrlHandler,
  formatTweetMarkdown,
  matchTweetUrl,
  matchNotionAppUrl,
  matchYoutubeUrl,
  notionHandler,
  pickSubtitleLang,
  twitterHandler,
  youtubeHandler,
  vttToText,
} from '../src/pipeline/preprocess/url-handlers.js'
import { PreprocessError, type ToolAvailability } from '../src/pipeline/preprocess/index.js'

const NO_TOOLS: ToolAvailability = {
  pdftotext: false,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: false,
  python3: false,
  exiftool: false,
  defuddle: false,
  ytDlp: false,
  deno: false,
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'url-handlers-'))

describe('assessExtractedContent (sanity gate)', () => {
  const longArticle = 'Sentence about an actual topic with substance. '.repeat(200)

  it('rejects near-empty extractions', () => {
    const reason = assessExtractedContent('X (formerly Twitter)')
    expect(reason).toMatch(/characters of extractable content/)
  })

  it('rejects the X/Twitter JavaScript shell', () => {
    const shell = `JavaScript is not available. We've detected that JavaScript is disabled in this browser. ${'Help Center Terms of Service Privacy Policy Cookie Policy Imprint Ads info. '.repeat(6)}`
    expect(shell.length).toBeGreaterThanOrEqual(MIN_WEB_CONTENT_CHARS)
    expect(assessExtractedContent(shell)).toMatch(/JavaScript-only shell/)
  })

  it('rejects short login-wall pages (English and German)', () => {
    const pad = 'Footer navigation imprint contact newsletter. '.repeat(10)
    expect(assessExtractedContent(`Please log in to continue reading this story. ${pad}`)).toMatch(/login/)
    expect(assessExtractedContent(`Melden Sie sich an, um den Artikel zu lesen. ${pad}`)).toMatch(/login/i)
  })

  it('rejects anti-bot interstitials', () => {
    const pad = 'Ray ID and security details follow here for the visitor. '.repeat(10)
    expect(assessExtractedContent(`Just a moment... Checking your browser before accessing. ${pad}`)).toMatch(/anti-bot/)
  })

  it('accepts a normal long article', () => {
    expect(assessExtractedContent(longArticle)).toBeNull()
  })

  it('does not flag a long article that merely quotes a login prompt', () => {
    expect(assessExtractedContent(`${longArticle} The site showed "log in to continue" banners. ${longArticle}`)).toBeNull()
  })
})

describe('matchTweetUrl', () => {
  it('matches x.com and twitter.com status URLs', () => {
    for (const href of [
      'https://x.com/someuser/status/1234567890123456789',
      'https://twitter.com/someuser/status/1234567890123456789',
      'https://mobile.twitter.com/someuser/statuses/1234567890123456789',
      'https://x.com/someuser/status/1234567890123456789?s=20&t=abc',
    ]) {
      expect(matchTweetUrl(new URL(href)), href).toEqual({ user: 'someuser', id: '1234567890123456789' })
    }
  })

  it('ignores non-status and non-twitter URLs', () => {
    for (const href of [
      'https://x.com/someuser',
      'https://x.com/i/lists/123',
      'https://example.com/someuser/status/123',
    ]) {
      expect(matchTweetUrl(new URL(href)), href).toBeUndefined()
    }
  })
})

describe('twitterHandler', () => {
  const url = new URL('https://x.com/someuser/status/42')

  it('formats a FxTwitter payload as markdown and writes the raw artifact', async () => {
    const jobDir = tmpDir()
    const payload = {
      code: 200,
      message: 'OK',
      tweet: {
        url: 'https://x.com/someuser/status/42',
        text: 'Hello world\nsecond line',
        created_at: 'Mon Jul 14 12:00:00 +0000 2026',
        author: { name: 'Some User', screen_name: 'someuser' },
        likes: 5,
        retweets: 2,
        media: { photos: [{ url: 'https://pbs.twimg.com/p.jpg' }] },
      },
    }
    let fetched = ''
    const result = await twitterHandler.handle({
      url,
      jobDir,
      tools: NO_TOOLS,
      fetchText: async (u) => {
        fetched = u
        return JSON.stringify(payload)
      },
    })
    expect(fetched).toBe('https://api.fxtwitter.com/someuser/status/42')
    expect(result.markdown).toContain('# Tweet by @someuser (Some User)')
    expect(result.markdown).toContain('> Hello world')
    expect(result.markdown).toContain('> second line')
    expect(result.markdown).toContain('https://pbs.twimg.com/p.jpg')
    expect(fs.existsSync(path.join(jobDir, 'tweet.json'))).toBe(true)
  })

  it('fails with a clear message for private/deleted tweets (HTTP 404)', async () => {
    await expect(
      twitterHandler.handle({
        url,
        jobDir: tmpDir(),
        tools: NO_TOOLS,
        fetchText: async () => {
          throw new PreprocessError('fetch failed: HTTP 404 for https://api.fxtwitter.com/someuser/status/42')
        },
      }),
    ).rejects.toThrow(/private, deleted/)
  })

  it('fails when FxTwitter reports a non-200 code', async () => {
    await expect(
      twitterHandler.handle({
        url,
        jobDir: tmpDir(),
        tools: NO_TOOLS,
        fetchText: async () => JSON.stringify({ code: 401, message: 'PRIVATE_TWEET' }),
      }),
    ).rejects.toThrow(/PRIVATE_TWEET/)
  })
})

describe('formatTweetMarkdown', () => {
  it('renders quoted tweets', () => {
    const md = formatTweetMarkdown(
      {
        text: 'Look at this',
        author: { screen_name: 'a' },
        quote: { text: 'Original insight', author: { screen_name: 'b' }, url: 'https://x.com/b/status/1' },
      },
      'https://x.com/a/status/2',
    )
    expect(md).toContain('## Quoted tweet (@b)')
    expect(md).toContain('> Original insight')
  })
})

describe('matchYoutubeUrl', () => {
  it('matches watch, short-link, shorts and live URLs', () => {
    for (const href of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ?feature=share',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    ]) {
      expect(matchYoutubeUrl(new URL(href))?.videoId, href).toBe('dQw4w9WgXcQ')
    }
  })

  it('ignores channel/playlist and non-youtube URLs', () => {
    for (const href of [
      'https://www.youtube.com/@somechannel',
      'https://www.youtube.com/playlist?list=PL123',
      'https://example.com/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(matchYoutubeUrl(new URL(href)), href).toBeUndefined()
    }
  })
})

describe('diagnoseYtDlpFailure', () => {
  // What runTool actually produces: Node's "Command failed" line first, stderr appended.
  const wrap = (stderr: string) => `yt-dlp failed: Command failed: yt-dlp --skip-download …\n${stderr}`

  it('classifies the bot check as transient and surfaces the ERROR line, not the command line', () => {
    const d = diagnoseYtDlpFailure(
      wrap('ERROR: [youtube] abc123: Sign in to confirm you’re not a bot. Use --cookies-from-browser …'),
    )
    expect(d.kind).toBe('bot-check')
    expect(d.transient).toBe(true)
    expect(d.detail).toMatch(/^ERROR: .*Sign in to confirm/)
  })

  it('classifies HTTP 429 as transient', () => {
    const d = diagnoseYtDlpFailure(wrap('ERROR: [youtube] abc123: HTTP Error 429: Too Many Requests'))
    expect(d.kind).toBe('rate-limited')
    expect(d.transient).toBe(true)
  })

  it('classifies definitive failures as permanent', () => {
    const cases: Array<[string, string]> = [
      ['ERROR: [youtube] abc123: Private video. Sign in if you’ve been granted access', 'private'],
      ['ERROR: [youtube] abc123: Join this channel to get access to members-only content', 'members-only'],
      ['ERROR: [youtube] abc123: The uploader has not made this video available in your country', 'geo-blocked'],
      ['ERROR: [youtube] abc123: Video unavailable', 'unavailable'],
      ['ERROR: [youtube] abc123: Sign in to confirm your age. This video may be inappropriate for some users.', 'age-restricted'],
    ]
    for (const [stderr, kind] of cases) {
      const d = diagnoseYtDlpFailure(wrap(stderr))
      expect(d.kind, stderr).toBe(kind)
      expect(d.transient, stderr).toBe(false)
    }
  })

  it('uses the LAST ERROR line (warnings and earlier errors are context, not cause)', () => {
    const d = diagnoseYtDlpFailure(
      wrap(
        'WARNING: [youtube] abc123: Unable to download webpage: HTTP Error 429: Too Many Requests\nERROR: [youtube] abc123: Sign in to confirm you’re not a bot.',
      ),
    )
    expect(d.kind).toBe('bot-check')
  })

  it('falls back to unknown/permanent with an update hint', () => {
    const d = diagnoseYtDlpFailure(wrap('ERROR: [youtube] abc123: Unsupported gizmo frobnication'))
    expect(d.kind).toBe('unknown')
    expect(d.transient).toBe(false)
    expect(d.advice).toMatch(/updating yt-dlp/)
  })
})

describe('youtubeHandler', () => {
  const TOOLS = { ...NO_TOOLS, ytDlp: true, deno: true }
  const BOT_CHECK = 'yt-dlp failed: Command failed: yt-dlp\nERROR: [youtube] x: Sign in to confirm you’re not a bot.'
  const clientOf = (args: readonly string[]) => {
    const i = args.indexOf('--extractor-args')
    return i === -1 ? undefined : /player_client=(\w+)/.exec(args[i + 1] ?? '')?.[1]
  }
  const writeArtifacts = (jobDir: string) => {
    fs.writeFileSync(
      path.join(jobDir, 'video.info.json'),
      JSON.stringify({
        id: 'dQw4w9WgXcQ',
        title: 'A Video',
        channel: 'A Channel',
        upload_date: '20260101',
        duration_string: '3:32',
        description: 'About things.',
        webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        formats: [{ url: 'https://signed.example/ephemeral' }],
      }),
    )
    fs.writeFileSync(path.join(jobDir, 'video.en.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.000\nhello world\n')
  }

  it('fails with an actionable message when yt-dlp is missing', async () => {
    await expect(
      youtubeHandler.handle({
        url: new URL('https://youtu.be/dQw4w9WgXcQ'),
        jobDir: tmpDir(),
        tools: NO_TOOLS,
        fetchText: async () => '',
      }),
    ).rejects.toThrow(/yt-dlp is not installed/)
  })

  it('falls back to the android player client when the web client hits the bot check', async () => {
    const jobDir = tmpDir()
    const calls: string[][] = []
    const result = await youtubeHandler.handle({
      url: new URL('https://youtu.be/dQw4w9WgXcQ'),
      jobDir,
      tools: TOOLS,
      fetchText: async () => '',
      runTool: async (_bin, args) => {
        calls.push([...args])
        if (clientOf(args) === undefined) throw new Error(BOT_CHECK)
        writeArtifacts(jobDir)
        return { stdout: '', stderr: '' }
      },
    })
    expect(calls).toHaveLength(2)
    expect(clientOf(calls[1]!)).toBe('android')
    expect(result.markdown).toContain('# A Video')
    expect(result.markdown).toContain('hello world')
    expect(result.notes.join('; ')).toMatch(/blocked \(bot-check\).*android/)
    // Raw artifact is the reduced video.json; the huge info dump with signed URLs is gone.
    expect(JSON.parse(fs.readFileSync(path.join(jobDir, 'video.json'), 'utf8')).title).toBe('A Video')
    expect(fs.existsSync(path.join(jobDir, 'video.info.json'))).toBe(false)
  })

  it('throws a TRANSIENT PreprocessError when every client is bot-checked', async () => {
    const err = await youtubeHandler
      .handle({
        url: new URL('https://youtu.be/dQw4w9WgXcQ'),
        jobDir: tmpDir(),
        tools: TOOLS,
        fetchText: async () => '',
        runTool: async () => {
          throw new Error(BOT_CHECK)
        },
      })
      .then(
        () => undefined,
        (e: unknown) => e as PreprocessError,
      )
    expect(err).toBeInstanceOf(PreprocessError)
    expect(err!.transient).toBe(true)
    expect(err!.message).toMatch(/bot check/i)
    expect(err!.message).not.toMatch(/may be private/)
  })

  it('fails fast and permanently on a private video — no client chain, no retry flag', async () => {
    const calls: string[][] = []
    const err = await youtubeHandler
      .handle({
        url: new URL('https://youtu.be/dQw4w9WgXcQ'),
        jobDir: tmpDir(),
        tools: TOOLS,
        fetchText: async () => '',
        runTool: async (_bin, args) => {
          calls.push([...args])
          throw new Error('yt-dlp failed: Command failed: yt-dlp\nERROR: [youtube] x: Private video.')
        },
      })
      .then(
        () => undefined,
        (e: unknown) => e as PreprocessError,
      )
    expect(calls).toHaveLength(1)
    expect(err!.transient).toBe(false)
    expect(err!.message).toMatch(/private/i)
  })

  it('notes missing deno instead of failing', async () => {
    const jobDir = tmpDir()
    const result = await youtubeHandler.handle({
      url: new URL('https://youtu.be/dQw4w9WgXcQ'),
      jobDir,
      tools: { ...TOOLS, deno: false },
      fetchText: async () => '',
      runTool: async () => {
        writeArtifacts(jobDir)
        return { stdout: '', stderr: '' }
      },
    })
    expect(result.notes.join('; ')).toMatch(/deno .*not installed/)
  })
})

describe('pickSubtitleLang', () => {
  it('prefers de, then en, then anything', () => {
    expect(pickSubtitleLang(['en', 'de', 'fr'])).toBe('de')
    expect(pickSubtitleLang(['fr', 'en-US'])).toBe('en-US')
    expect(pickSubtitleLang(['ja'])).toBe('ja')
    expect(pickSubtitleLang([])).toBeUndefined()
  })
})

describe('vttToText', () => {
  it('strips headers, timings and inline tags, and dedupes roll-up repeats', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: en',
      '',
      '00:00:00.000 --> 00:00:02.000 align:start position:0%',
      'Hello<00:00:01.000><c> world</c>',
      '',
      '00:00:02.000 --> 00:00:04.000',
      'Hello world',
      'Second line &amp; more',
      '',
      'NOTE some metadata',
      'that should vanish',
      '',
      '00:00:04.000 --> 00:00:06.000',
      'Third line',
    ].join('\n')
    expect(vttToText(vtt)).toBe('Hello world\nSecond line & more\nThird line')
  })
})

describe('matchNotionAppUrl', () => {
  it('matches app.notion.com always and notion.so app-page paths', () => {
    expect(matchNotionAppUrl(new URL('https://app.notion.com/p/Cooking-280006f7aa9880edbbaec5eb6649eccc'))).toBe(true)
    expect(matchNotionAppUrl(new URL('https://app.notion.com/anything'))).toBe(true)
    expect(matchNotionAppUrl(new URL('https://www.notion.so/p/some-share-link'))).toBe(true)
    expect(matchNotionAppUrl(new URL('https://www.notion.so/ws/My-Page-280006f7aa9880edbbaec5eb6649eccc'))).toBe(true)
    expect(
      matchNotionAppUrl(new URL('https://www.notion.so/My-Page-280006f7-aa98-80ed-bbae-c5eb6649eccc')),
    ).toBe(true)
  })

  it('leaves notion.so marketing pages and other hosts to the generic path', () => {
    expect(matchNotionAppUrl(new URL('https://www.notion.so/blog/some-article'))).toBe(false)
    expect(matchNotionAppUrl(new URL('https://www.notion.so/pricing'))).toBe(false)
    expect(matchNotionAppUrl(new URL('https://example.com/280006f7aa9880edbbaec5eb6649eccc'))).toBe(false)
  })
})

describe('notionHandler', () => {
  it('fails fast with an actionable message instead of a redirect-loop error', async () => {
    const url = new URL('https://app.notion.com/p/Cooking-280006f7aa9880edbbaec5eb6649eccc')
    await expect(
      notionHandler.handle({ url, jobDir: tmpDir(), tools: NO_TOOLS, fetchText: () => Promise.reject(new Error('no fetch')) }),
    ).rejects.toThrowError(/Export the page instead/)
    await expect(
      notionHandler.handle({ url, jobDir: tmpDir(), tools: NO_TOOLS, fetchText: () => Promise.reject(new Error('no fetch')) }),
    ).rejects.toBeInstanceOf(PreprocessError)
  })
})

describe('findUrlHandler', () => {
  it('routes tweets, videos and Notion app pages, leaves ordinary pages to the generic path', () => {
    expect(findUrlHandler(new URL('https://x.com/a/status/1'))?.name).toBe('fxtwitter')
    expect(findUrlHandler(new URL('https://youtu.be/dQw4w9WgXcQ'))?.name).toBe('yt-dlp')
    expect(findUrlHandler(new URL('https://app.notion.com/p/X-280006f7aa9880edbbaec5eb6649eccc'))?.name).toBe('notion')
    expect(findUrlHandler(new URL('https://example.com/article'))).toBeUndefined()
  })
})
