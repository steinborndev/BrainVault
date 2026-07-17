/**
 * A created/updated wiki page rendered as an Obsidian deep-link (TASKS-M3 §0, §3, §4) with
 * a copy-path fallback: if the `obsidian://` handler isn't wired across the WSLg boundary,
 * the copy button still gives the user the vault-relative path. This is the DoD's "result
 * page links open in Obsidian — or the documented fallback".
 */

import { useState } from 'react'
import { obsidianUri, pageLabel, pageBucket } from '../lib/obsidian.ts'
import { Icon } from './Icon.tsx'

export function PageLink({ vaultName, path }: { vaultName: string; path: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)

  const copy = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard?.writeText(path).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => {},
    )
  }

  return (
    <a className="pagelink" href={obsidianUri(vaultName, path)} title={`In Obsidian öffnen: ${path}`}>
      <span className="bucket">{pageBucket(path)}</span>
      {pageLabel(path)}
      <button className="copy" onClick={copy} title="Vault-Pfad kopieren" aria-label="Pfad kopieren">
        <Icon name={copied ? 'file' : 'copy'} />
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
