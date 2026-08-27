/** Friendly names for maintenance run kinds - shared by the Home feed and Health history. */
export const RUN_TITLES: Record<string, string> = {
  lint: 'Lint report written',
  'lint-fix': 'Safe lint fixes applied',
  'hot-cache': 'Hot cache refreshed',
  'tag-fix': 'Tag repairs applied',
  'domain-backfill': 'Domain backfill',
  'domain-review': 'Domain candidates reviewed',
  research: 'Research run',
  save: 'Conversation saved to the vault',
  cleanup: 'Reference cleanup',
  repair: 'Graph repair',
  'retrieve-index': 'Retrieval index rebuilt',
}

/**
 * What a run is called while it is still RUNNING - the present-tense form, for the
 * in-flight surfaces (Home, the inbox, the sidebar). `RUN_TITLES` above names the
 * ARTIFACT a settled run left behind, which reads wrong on something still in progress.
 */
export const RUN_RUNNING_TITLES: Record<string, string> = {
  lint: 'Linting the wiki',
  'lint-fix': 'Applying safe lint fixes',
  'hot-cache': 'Refreshing the hot cache',
  'tag-fix': 'Applying tag repairs',
  'domain-backfill': 'Filing pages into domains',
  'domain-review': 'Reviewing domain candidates',
  research: 'Research run',
  save: 'Saving the conversation to the vault',
  cleanup: 'Cleaning up references',
  repair: 'Repairing the graph',
  'retrieve-index': 'Rebuilding the retrieval index',
}

/**
 * Which tab announces a run while it is in flight.
 *
 * Research shows its own runs and the conversation-save that belongs to them; every other
 * kind is machine-room work and belongs to System. The split has to be exhaustive, or a run
 * goes unannounced - which is what a domain backfill did until 2026-08-25: it appeared in
 * Home's activity table but no tab said anything, so starting one from System and switching
 * away left no trace that the vault was being written to.
 */
export const RESEARCH_RUN_KINDS: ReadonlySet<string> = new Set(['research', 'save'])

/** True for the runs the System tab is responsible for announcing. */
export function isMaintenanceRun(kind: string): boolean {
  return !RESEARCH_RUN_KINDS.has(kind)
}

/**
 * A settled run's title, stated as what it PRODUCED rather than as whether it threw.
 *
 * The distinction matters because most of these titles name an artifact ("Lint report
 * written"), and a run can exit cleanly without producing one - which is exactly the case
 * that made the dashboard contradict itself: the feed announced a written lint report in
 * the same session the Health badge said no fresh report existed. A failed run of an
 * artifact-producing kind now says the artifact is missing, in those words.
 */
export function runTitle(kind: string, ok: boolean): string {
  if (ok) return RUN_TITLES[kind] ?? kind
  const failed: Record<string, string> = {
    lint: 'Lint finished, no report written',
    'lint-fix': 'Safe lint fixes failed',
    'hot-cache': 'Hot cache refresh failed',
    'tag-fix': 'Tag repairs failed',
    research: 'Research run failed',
    'retrieve-index': 'Retrieval index rebuild failed',
  }
  return failed[kind] ?? `${RUN_TITLES[kind] ?? kind} failed`
}
