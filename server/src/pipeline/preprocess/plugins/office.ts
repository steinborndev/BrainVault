/**
 * Office document normalization (SPEC.md §5). Word/ODT go through `pandoc` to Markdown;
 * PowerPoint and Excel go through a small Python extractor (`python-pptx` / `openpyxl`)
 * because pandoc does not read those formats. The relevant tool is REQUIRED for its
 * format — a document we cannot convert is a failed job, not a raw-bytes passthrough.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PreprocessPlugin, Probe, NormalizeContext, NormalizeResult } from '../types.js'
import { PreprocessError } from '../types.js'
import { isOle, isZip } from '../detect.js'
import { runTool } from '../tools.js'

const PANDOC_EXTS = new Set(['docx', 'doc', 'odt'])
const PY_EXTS = new Set(['pptx', 'ppt', 'xlsx', 'xls', 'ods', 'odp'])
const OFFICE_EXTS = new Set([...PANDOC_EXTS, ...PY_EXTS])

/** Absolute path to the bundled Python extractor shipped in this repo's scripts/. */
const EXTRACT_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../scripts/extract-office.py',
)

export const officePlugin: PreprocessPlugin = {
  name: 'office',
  type: 'office',
  // Extension-driven: OLE/zip magic only disambiguates a mislabelled file. A bare .zip
  // is NOT office (archive plugin handles it); office requires an office extension.
  matches: (probe: Probe): boolean =>
    OFFICE_EXTS.has(probe.ext) && (isZip(probe.head) || isOle(probe.head) || probe.ext.length > 0),

  async normalize(ctx: NormalizeContext): Promise<NormalizeResult> {
    const src = ctx.probe.filePath
    const ext = ctx.probe.ext

    if (PANDOC_EXTS.has(ext)) {
      if (!ctx.tools.pandoc) {
        throw new PreprocessError(
          'pandoc is not installed — run scripts/install-preprocessing-tools.sh',
        )
      }
      const outPath = path.join(ctx.jobDir, 'normalized.md')
      await runTool('pandoc', [src, '-t', 'gfm', '-o', outPath], { timeoutMs: 120_000 })
      const text = fs.readFileSync(outPath, 'utf8')
      return { normalizedPath: outPath, normalizedChars: text.trim().length, notes: ['converted via pandoc'] }
    }

    // pptx / xlsx / ods / odp
    if (!ctx.tools.python3) {
      throw new PreprocessError(
        'python3 (with python-pptx/openpyxl) is not installed — run scripts/install-preprocessing-tools.sh',
      )
    }
    const outPath = path.join(ctx.jobDir, 'normalized.txt')
    const { stdout } = await runTool('python3', [EXTRACT_SCRIPT, src], { timeoutMs: 120_000 })
    fs.writeFileSync(outPath, stdout, 'utf8')
    return {
      normalizedPath: outPath,
      normalizedChars: stdout.trim().length,
      notes: [`extracted via ${PY_EXTS.has(ext) ? 'python extractor' : 'extractor'}`],
    }
  },
}
