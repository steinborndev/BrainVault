/**
 * Unsupported-type plugins (SPEC.md §4.2, hard rule 6). Audio/video and archives are
 * recognised, marked `deferred`, and NOT processed further: the job store routes a
 * deferred result to `.raw/deferred/` and status `deferred`, visible in the dashboard.
 *
 * Archives are deliberately never auto-extracted — a v1 security decision (hard rule 6),
 * not a missing feature. Audio/video transcription is a future preprocessing plugin
 * (SPEC.md §5), which is exactly why this is a plugin and not a branch in the core.
 */

import type { PreprocessPlugin, Probe, NormalizeResult } from '../types.js'
import { isZip } from '../detect.js'

const AV_EXTS = new Set([
  'mp3',
  'wav',
  'flac',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'mp4',
  'mkv',
  'mov',
  'avi',
  'webm',
  'wmv',
  'flv',
  'm4v',
])

const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', '7z', 'rar'])

export const avPlugin: PreprocessPlugin = {
  name: 'av',
  type: 'av',
  matches: (probe: Probe): boolean => AV_EXTS.has(probe.ext),
  normalize: async (): Promise<NormalizeResult> => ({
    deferred: true,
    notes: ['audio/video deferred — transcription is a future preprocessing plugin (SPEC.md §5)'],
  }),
}

export const archivePlugin: PreprocessPlugin = {
  name: 'archive',
  type: 'other',
  // Extension OR zip magic — but this plugin is registered AFTER office, so a .docx
  // (also a zip) is claimed by office first and only a bare .zip reaches here.
  matches: (probe: Probe): boolean => ARCHIVE_EXTS.has(probe.ext) || isZip(probe.head),
  normalize: async (): Promise<NormalizeResult> => ({
    deferred: true,
    notes: ['archive deferred — not auto-extracted (hard rule 6, v1 security decision)'],
  }),
}
