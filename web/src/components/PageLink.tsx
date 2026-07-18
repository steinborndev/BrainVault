/**
 * A created/updated wiki page rendered as an Obsidian deep-link (TASKS-M3 §0, §3, §4) with
 * a copy-path fallback: if the `obsidian://` handler isn't wired across the WSLg boundary,
 * the copy button still gives the user the vault-relative path. This is the DoD's "result
 * page links open in Obsidian — or the documented fallback".
 */

import { useState } from 'react'
import { obsidianUri, pageLabel, pageBucket } from '../lib/obsidian.ts'
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

  const copy = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    void copyText(path).then((ok) => {
      setCopied(ok ? 'ok' : 'failed')
      setTimeout(() => setCopied(null), 1600)
    })
  }

  return (
    <a className="pagelink" href={obsidianUri(vaultName, path)} title={`In Obsidian öffnen: ${path}`}>
      <span className="bucket">{pageBucket(path)}</span>
      {pageLabel(path)}
      <button
        className="copy"
        onClick={copy}
        title={copied === 'failed' ? `Kopieren fehlgeschlagen — Pfad: ${path}` : 'Vault-Pfad kopieren'}
        aria-label="Pfad kopieren"
      >
        {copied === 'ok' ? <Icon name="check" /> : copied === 'failed' ? <Icon name="x" /> : <Icon name="copy" />}
      </button>
    </a>
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
