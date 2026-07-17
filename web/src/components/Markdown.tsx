/**
 * A deliberately small, safe Markdown renderer for the Overview hot-cache panel (SPEC.md
 * §6.1). It builds React elements (never raw HTML), so ingested content can't inject markup.
 * Scope is what `wiki/hot.md` actually uses: headings, lists, hr, bold, inline code, links,
 * and `[[wikilinks]]` (shown as plain emphasized text). Not a full CommonMark implementation.
 */

import type { ReactNode } from 'react'

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // Order matters: code first (so ** inside code stays literal), then links, then bold.
  const re = /(`[^`]+`)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyBase}-${i++}`
    if (tok.startsWith('`')) {
      nodes.push(<code key={key}>{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('[[')) {
      nodes.push(<em key={key}>{tok.slice(2, -2)}</em>)
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
    } else {
      nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function Markdown({ source }: { source: string }): React.ReactElement {
  const lines = source.split('\n')
  const blocks: ReactNode[] = []
  let list: ReactNode[] = []
  let para: string[] = []
  let key = 0

  const flushList = (): void => {
    if (list.length) {
      blocks.push(<ul key={`ul-${key++}`}>{list}</ul>)
      list = []
    }
  }
  const flushPara = (): void => {
    if (para.length) {
      const text = para.join(' ')
      blocks.push(<p key={`p-${key++}`}>{inline(text, `p${key}`)}</p>)
      para = []
    }
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      flushList()
      const level = h[1]!.length
      const content = inline(h[2]!, `h${key}`)
      blocks.push(
        level === 1 ? <h1 key={`h-${key++}`}>{content}</h1> : level === 2 ? <h2 key={`h-${key++}`}>{content}</h2> : <h3 key={`h-${key++}`}>{content}</h3>,
      )
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushPara()
      flushList()
      blocks.push(<hr key={`hr-${key++}`} />)
      continue
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) {
      flushPara()
      list.push(<li key={`li-${key++}`}>{inline(li[1]!, `li${key}`)}</li>)
      continue
    }
    para.push(line.trim())
  }
  flushPara()
  flushList()

  return <div className="md">{blocks}</div>
}
