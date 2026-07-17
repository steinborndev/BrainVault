/**
 * Markdown / text / code passthrough (SPEC.md §5: "Durchreichen"). No conversion — the
 * agent reads the original directly. The Obsidian Web Clipper's `.md` files are handled
 * here too; their frontmatter URL is left for the agent to read (SPEC.md §4.2).
 */

import type { PreprocessPlugin, Probe, NormalizeResult } from '../types.js'

/** Extensions treated as ingestible text with no normalization step. */
const TEXT_EXTS = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'rtf',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'log',
  'xml',
  'html',
  'htm',
  // code
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'sql',
])

export const textPlugin: PreprocessPlugin = {
  name: 'text',
  type: 'text',
  matches: (probe: Probe): boolean => TEXT_EXTS.has(probe.ext),
  normalize: async (): Promise<NormalizeResult> => ({
    notes: ['text passthrough — original ingested as-is'],
  }),
}
