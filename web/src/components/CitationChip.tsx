/**
 * A citation chip with an inline page preview (SPEC.md §6.3: "klickbare Chips … Obsidian-
 * Deep-Link + Inline-Preview des Seiteninhalts").
 *
 * The deep link stays the chip's primary action — the preview is a separate toggle, so clicking
 * the chip still opens Obsidian as before. The page content is fetched lazily on first expand
 * (and cached by TanStack afterwards), because a long answer can cite a dozen pages and eagerly
 * loading all of them would be wasted work for previews nobody opens.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { PageLink } from './PageLink.tsx'
import { Markdown } from './Markdown.tsx'
import { Icon } from './Icon.tsx'

export function CitationChip({
  vaultName,
  path,
}: {
  vaultName: string
  path: string
}): React.ReactElement {
  const [open, setOpen] = useState(false)

  const preview = useQuery({
    queryKey: ['page', path],
    queryFn: () => api.page(path),
    enabled: open,
    staleTime: 60_000,
  })

  return (
    <span className="cite-chip">
      <span className="cite-chip-row">
        <PageLink vaultName={vaultName} path={path} />
        <button
          className="cite-peek"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Close preview' : 'Show page content'}
          aria-expanded={open}
        >
          <Icon name={open ? 'x' : 'file'} />
        </button>
      </span>

      {open && (
        <div className="cite-preview">
          {preview.isLoading && <div className="tab-hint">Loading preview…</div>}
          {preview.isError && <div className="toast err">{(preview.error as Error).message}</div>}
          {preview.data && (
            <>
              <Markdown source={preview.data.markdown} />
              {preview.data.truncated && <div className="tab-hint">… truncated — open in Obsidian for the full page.</div>}
            </>
          )}
        </div>
      )}
    </span>
  )
}
