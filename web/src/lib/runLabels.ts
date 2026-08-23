/** Friendly names for maintenance run kinds — shared by the Home feed and Health history. */
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
