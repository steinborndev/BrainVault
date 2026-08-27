/**
 * What a finished job produced, as opposed to what it cost (2026-08-27).
 *
 * Opening a settled row used to land on the job record: timestamps, token counts, the log.
 * Those answer "did it work" - and by the time you are clicking the row you already know it
 * did, because the row said so. What you actually want is the page it wrote.
 *
 * Which page that is depends on what kind of run it was, and both kinds name it by where
 * they file it:
 *
 *   research run   `wiki/questions/Research: <topic>` - the synthesis it was started for
 *   ingest         `wiki/sources/<title>` - the source it read, whose concepts are the rest
 *
 * A run that produced neither (an index rebuild, a lint pass, a domain review) has no
 * article, and its detail opens on the log instead - which for those IS the record.
 *
 * A pure function over the page list the job already carries: no fetching, no guessing from
 * a title the agent may not have used.
 */

const RESEARCH_PREFIX = 'Research: '

const basename = (path: string): string => path.split('/').pop() ?? path

/** Index hubs and MOCs - written by every run, asked for by nobody. */
export function isHubPage(path: string): boolean {
  const base = basename(path)
  if (base.startsWith('_')) return true
  return /^wiki\/(hot|index|log|overview)\.md$/.test(path)
}

/**
 * The one page a job's detail should open on, or null when it wrote none. Order matters: a
 * research run that also filed a source page is still about its synthesis.
 */
export function mainArticle(pages: readonly string[]): string | null {
  const content = pages.filter((p) => !isHubPage(p))
  const synthesis = content.find(
    (p) => p.startsWith('wiki/questions/') && basename(p).startsWith(RESEARCH_PREFIX),
  )
  if (synthesis !== undefined) return synthesis
  const source = content.find((p) => p.startsWith('wiki/sources/'))
  if (source !== undefined) return source
  return null
}

/**
 * The pages worth listing for the reader, with the article it opens on first - it is the one
 * the others hang off, so it leads rather than sitting wherever the commit happened to put it.
 */
export function readerPages(pages: readonly string[]): string[] {
  const content = pages.filter((p) => !isHubPage(p))
  const lead = mainArticle(pages)
  if (lead === null) return content
  return [lead, ...content.filter((p) => p !== lead)]
}
