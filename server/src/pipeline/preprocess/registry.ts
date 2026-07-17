/**
 * Plugin registry. ORDER MATTERS: the chain picks the first plugin whose `matches`
 * returns true, so more specific plugins come before broader ones, and the catch-all
 * `otherPlugin` is always last. Adding a material type means adding a plugin here — the
 * chain core (`index.ts`) never learns any type's name.
 */

import type { PreprocessPlugin, NormalizeResult } from './types.js'
import { textPlugin } from './plugins/text.js'
import { avPlugin, archivePlugin } from './plugins/deferred.js'
import { pdfPlugin } from './plugins/pdf.js'
import { officePlugin } from './plugins/office.js'
import { imagePlugin } from './plugins/image.js'

/** Last-resort plugin: passes an unrecognised file through untouched for the agent to judge. */
export const otherPlugin: PreprocessPlugin = {
  name: 'other',
  type: 'other',
  matches: (): boolean => true,
  normalize: async (): Promise<NormalizeResult> => ({
    notes: ['unrecognised type — original passed through as-is'],
  }),
}

/**
 * Default file-preprocessing chain. `office` precedes `archive` because a .docx is a zip
 * container; `text` precedes `other` so known text keeps its `text` type. URL jobs use a
 * separate path (see `../web.ts`), not this file registry.
 */
export const DEFAULT_REGISTRY: readonly PreprocessPlugin[] = [
  pdfPlugin,
  officePlugin,
  imagePlugin,
  avPlugin,
  archivePlugin,
  textPlugin,
  otherPlugin,
]
