/**
 * A created/updated wiki page as a chip. The PRIMARY action is the in-dashboard vault viewer
 * (`/vault/page/…`) — it works from any browser, including Windows, where the obsidian://
 * handler routes to Windows-Obsidian, which cannot open a WSL vault over `\\wsl$` (EISDIR,
 * won't-fix; SPEC.md §3/§11). Obsidian stays available as a secondary action for WSLg
 * setups, plus the copy-path fallback.
 */

import { useState } from 'react'
import { obsidianUri, pageLabel, pageBucket } from '../lib/obsidian.ts'
import { navigate, pageRoute } from '../lib/router.ts'
import { Icon } from './Icon.tsx'

/**
 * Copies text with a legacy fallback: `navigator.clipboard` is undefined outside secure
 * contexts (and in some WSLg browsers), and this copy IS the documented fallback when the
 * obsidian:// handler isn't wired — it must not fail silently.
 */
function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => copyTextLegacy(text),
    )
  }
  return Promise.resolve(copyTextLegacy(text))
}

function copyTextLegacy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
  }
}

export function PageLink({ vaultName, path }: { vaultName: string; path: string }): React.ReactElement {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)

  const copy = (): void => {
    void copyText(path).then((ok) => {
      setCopied(ok ? 'ok' : 'failed')
      setTimeout(() => setCopied(null), 1600)
    })
  }

  const openObsidian = (): void => {
    // Assigning the protocol URI triggers the handler without leaving the page.
    window.location.href = obsidianUri(vaultName, path)
  }

  // The chip is a <span> holding an <a> plus sibling <button>s — interactive elements must
  // not nest inside the anchor (invalid HTML; breaks keyboard/screen-reader activation).
  return (
    <span className="pagelink">
      <a
        className="pagelink-main"
        href={pageRoute(path)}
        onClick={(e) => {
          e.preventDefault()
          navigate(pageRoute(path))
        }}
        title={`Open in the vault viewer: ${path}`}
      >
        <span className="bucket">{pageBucket(path)}</span>
        {pageLabel(path)}
      </a>
      <button className="copy" onClick={openObsidian} title="Open in Obsidian" aria-label="Open in Obsidian">
        <Icon name="link" />
      </button>
      <button
        className="copy"
        onClick={copy}
        title={copied === 'failed' ? `Copy failed — path: ${path}` : 'Copy vault path'}
        aria-label="Copy path"
      >
        {copied === 'ok' ? <Icon name="check" /> : copied === 'failed' ? <Icon name="x" /> : <Icon name="copy" />}
      </button>
    </span>
  )
}

export function PageLinks({ vaultName, paths }: { vaultName: string; paths: string[] }): React.ReactElement | null {
  if (paths.length === 0) return null
  return (
    <div className="pages">
      {paths.map((p) => (
        <PageLink key={p} vaultName={vaultName} path={p} />
      ))}
    </div>
  )
}
