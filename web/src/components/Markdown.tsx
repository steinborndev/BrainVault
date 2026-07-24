/**
 * A deliberately small, safe Markdown renderer. It builds React elements (never raw HTML),
 * so ingested content can't inject markup. Grown for the vault viewer (SPEC.md §12.4) beyond
 * the original hot-cache scope: headings, ul/ol lists, hr, bold, italic, inline code, fenced
 * code blocks, blockquotes, tables, http links, and `[[wikilinks]]`.
 *
 * Wikilinks render as plain emphasized text by default (the hot-cache/chat behaviour); the
 * vault viewer passes `renderWikilink` to turn them into in-app navigation. Still not a full
 * CommonMark implementation — by design.
 */

import type { ReactNode } from 'react'
import { linkifyText } from '../lib/linkify.tsx'

export type WikilinkRenderer = (target: string, label: string, key: string) => ReactNode

interface InlineCtx {
  renderWikilink?: WikilinkRenderer
}

function inline(text: string, keyBase: string, ctx: InlineCtx): ReactNode[] {
  const nodes: ReactNode[] = []
  // Order matters: code first (so ** inside code stays literal), then wikilinks, links, bold, italic.
  const re = /(`[^`]+`)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    // Plain text between tokens: auto-link bare URLs and patent numbers.
    if (m.index > last) nodes.push(...linkifyText(text.slice(last, m.index), `${keyBase}-t${i}`))
    const tok = m[0]
    const key = `${keyBase}-${i++}`
    if (tok.startsWith('`')) {
      nodes.push(<code key={key}>{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('[[')) {
      // [[Target]], [[Target|Alias]], [[Target#Heading]] — label shows the alias if present.
      const body = tok.slice(2, -2)
      const target = body.split('|')[0]!.split('#')[0]!.trim()
      const label = (body.split('|')[1] ?? body.split('#')[0])!.trim()
      if (ctx.renderWikilink && target !== '') {
        nodes.push(ctx.renderWikilink(target, label || target, key))
      } else {
        nodes.push(<em key={key}>{label || body}</em>)
      }
    } else if (tok.startsWith('[')) {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!
      const href = lm[2]!
      const safe = /^https?:\/\//i.test(href) ? href : undefined
      nodes.push(
        safe ? (
          <a key={key} href={safe} target="_blank" rel="noreferrer">
            {lm[1]}
          </a>
        ) : (
          <span key={key}>{lm[1]}</span>
        ),
      )
    } else if (tok.startsWith('**')) {
      nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>)
    } else {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(...linkifyText(text.slice(last), `${keyBase}-t${i}`))
  return nodes
}

/** True when a line looks like a table row (`| a | b |`). */
const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line)
const isTableSeparator = (line: string): boolean => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line)

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

export function Markdown({
  source,
  renderWikilink,
}: {
  source: string
  renderWikilink?: WikilinkRenderer
}): React.ReactElement {
  const ctx: InlineCtx = renderWikilink ? { renderWikilink } : {}
  const lines = source.split('\n')
  const blocks: ReactNode[] = []
  let list: ReactNode[] = []
  let orderedList: ReactNode[] = []
  let quote: string[] = []
  let para: string[] = []
  let key = 0

  const flushList = (): void => {
    if (list.length) {
      blocks.push(<ul key={`ul-${key++}`}>{list}</ul>)
      list = []
    }
    if (orderedList.length) {
      blocks.push(<ol key={`ol-${key++}`}>{orderedList}</ol>)
      orderedList = []
    }
  }
  const flushPara = (): void => {
    if (para.length) {
      const text = para.join(' ')
      blocks.push(<p key={`p-${key++}`}>{inline(text, `p${key}`, ctx)}</p>)
      para = []
    }
  }
  const flushQuote = (): void => {
    if (quote.length) {
      blocks.push(<blockquote key={`q-${key++}`}>{inline(quote.join(' '), `q${key}`, ctx)}</blockquote>)
      quote = []
    }
  }
  const flushAll = (): void => {
    flushPara()
    flushList()
    flushQuote()
  }

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]!
    const line = raw.replace(/\s+$/, '')

    // Fenced code block: swallow lines until the closing fence.
    if (/^```/.test(line.trim())) {
      flushAll()
      const code: string[] = []
      let j = li + 1
      while (j < lines.length && !/^```/.test(lines[j]!.trim())) {
        code.push(lines[j]!)
        j++
      }
      blocks.push(
        <pre key={`pre-${key++}`}>
          <code>{code.join('\n')}</code>
        </pre>,
      )
      li = j // skip past the closing fence (or EOF)
      continue
    }

    // Table: a row line followed by a separator line starts one.
    if (isTableRow(line) && li + 1 < lines.length && isTableSeparator(lines[li + 1]!)) {
      flushAll()
      const header = tableCells(line)
      const rows: string[][] = []
      let j = li + 2
      while (j < lines.length && isTableRow(lines[j]!)) {
        rows.push(tableCells(lines[j]!))
        j++
      }
      blocks.push(
        <div className="md-table" key={`tw-${key++}`}>
          <table>
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{inline(h, `th${key}-${hi}`, ctx)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, ri) => (
                <tr key={ri}>
                  {cells.map((c, ci) => (
                    <td key={ci}>{inline(c, `td${key}-${ri}-${ci}`, ctx)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      li = j - 1
      continue
    }

    if (line.trim() === '') {
      flushAll()
      continue
    }
    const bq = /^\s*>\s?(.*)$/.exec(line)
    if (bq) {
      flushPara()
      flushList()
      quote.push(bq[1]!)
      continue
    }
    flushQuote()
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushAll()
      const level = h[1]!.length
      const content = inline(h[2]!, `h${key}`, ctx)
      blocks.push(
        level === 1 ? (
          <h1 key={`h-${key++}`}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={`h-${key++}`}>{content}</h2>
        ) : level === 3 ? (
          <h3 key={`h-${key++}`}>{content}</h3>
        ) : (
          <h4 key={`h-${key++}`}>{content}</h4>
        ),
      )
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll()
      blocks.push(<hr key={`hr-${key++}`} />)
      continue
    }
    const uli = /^\s*[-*]\s+(.*)$/.exec(line)
    if (uli) {
      flushPara()
      flushQuote()
      list.push(<li key={`li-${key++}`}>{inline(uli[1]!, `li${key}`, ctx)}</li>)
      continue
    }
    const oli = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (oli) {
      flushPara()
      flushQuote()
      orderedList.push(<li key={`oli-${key++}`}>{inline(oli[1]!, `oli${key}`, ctx)}</li>)
      continue
    }
    para.push(line.trim())
  }
  flushAll()

  return <div className="md">{blocks}</div>
}
