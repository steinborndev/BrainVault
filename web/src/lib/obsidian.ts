/**
 * Obsidian deep-links (TASKS-M3 §0). A vault page opens in Obsidian via
 * `obsidian://open?vault=<name>&file=<vault-relative-path>`. Whether the browser can hand
 * this off to the WSLg Obsidian is verified by the §0 probe; the UI always offers a
 * copy-path fallback (see PageLink) so a result is reachable even if the handler isn't wired.
 *
 * `file` is the vault-relative path WITHOUT the `.md` extension (Obsidian resolves the note
 * by name), URL-encoded. `vault` comes from the server (`stats.vaultName`).
 */

export function obsidianUri(vaultName: string, vaultRelativePath: string): string {
  const noExt = vaultRelativePath.replace(/\.md$/i, '')
  const params = new URLSearchParams({ vault: vaultName, file: noExt })
  return `obsidian://open?${params.toString()}`
}

/** The short display label for a vault page path, e.g. `wiki/concepts/Foo.md` → `Foo`. */
export function pageLabel(vaultRelativePath: string): string {
  const base = vaultRelativePath.split('/').pop() ?? vaultRelativePath
  return base.replace(/\.md$/i, '')
}

/** Which wiki bucket a page lives in (concepts/entities/sources/…), for grouping/icons. */
export function pageBucket(vaultRelativePath: string): string {
  const m = vaultRelativePath.match(/^wiki\/([^/]+)\//)
  return m ? m[1]! : 'wiki'
}
