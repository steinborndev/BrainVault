/**
 * PDF normalization (SPEC.md §5). Text extraction via poppler's `pdftotext`; when the
 * yield is below 100 characters per page the PDF is treated as scanned and re-run
 * through OCR (`ocrmypdf`, deu+eng) before a second extraction.
 *
 * `pdftotext` is REQUIRED — a PDF we cannot read is a failed job, not a passthrough
 * (handing raw PDF bytes to the agent wastes a very expensive run). `ocrmypdf` is
 * optional: without it a low-yield PDF still ingests, just with a note that OCR was
 * skipped.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { PreprocessPlugin, Probe, NormalizeContext, NormalizeResult } from '../types.js'
import { PreprocessError } from '../types.js'
import { isPdf } from '../detect.js'
import { runTool } from '../tools.js'

/** Below this many chars/page the text layer is assumed missing and OCR kicks in. */
const OCR_YIELD_THRESHOLD = 100

async function pageCount(pdfPath: string, hasPdfinfo: boolean): Promise<number> {
  if (hasPdfinfo) {
    try {
      const { stdout } = await runTool('pdfinfo', [pdfPath], { timeoutMs: 30_000 })
      const m = stdout.match(/^Pages:\s+(\d+)/m)
      if (m) return Math.max(1, Number(m[1]))
    } catch {
      // fall through to the form-feed estimate
    }
  }
  return 1
}

async function extract(pdfPath: string, outPath: string): Promise<string> {
  // -layout keeps columns/tables readable; -enc UTF-8 avoids latin1 mojibake.
  await runTool('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, outPath], { timeoutMs: 120_000 })
  return fs.readFileSync(outPath, 'utf8')
}

export const pdfPlugin: PreprocessPlugin = {
  name: 'pdf',
  type: 'pdf',
  matches: (probe: Probe): boolean => probe.ext === 'pdf' || isPdf(probe.head),

  async normalize(ctx: NormalizeContext): Promise<NormalizeResult> {
    if (!ctx.tools.pdftotext) {
      throw new PreprocessError(
        'pdftotext (poppler-utils) is not installed — run scripts/install-preprocessing-tools.sh',
      )
    }
    const src = ctx.probe.filePath
    const outPath = path.join(ctx.jobDir, 'normalized.txt')
    const notes: string[] = []

    let text = await extract(src, outPath)
    const pages = await pageCount(src, ctx.tools.pdfinfo)
    // A form-feed per page is what pdftotext emits; use it when pdfinfo was unavailable.
    const estPages = ctx.tools.pdfinfo ? pages : Math.max(pages, (text.match(/\f/g)?.length ?? 0) + 1)
    const yieldPerPage = text.trim().length / estPages
    let ocrApplied = false

    if (yieldPerPage < OCR_YIELD_THRESHOLD) {
      if (ctx.tools.ocrmypdf) {
        const ocrPdf = path.join(ctx.jobDir, 'ocr.pdf')
        // --force-ocr rasterizes and re-OCRs even pages that carry a thin/garbage text
        // layer, which is exactly the low-yield case that got us here.
        await runTool('ocrmypdf', ['--force-ocr', '--language', 'deu+eng', src, ocrPdf], {
          timeoutMs: 300_000,
        })
        text = await extract(ocrPdf, outPath)
        ocrApplied = true
        notes.push(`OCR applied (yield was ${yieldPerPage.toFixed(0)} chars/page over ${estPages} pages)`)
      } else {
        notes.push(
          `low text yield (${yieldPerPage.toFixed(0)} chars/page) but ocrmypdf is not installed — ingesting the thin text layer`,
        )
      }
    }

    return {
      normalizedPath: outPath,
      normalizedChars: text.trim().length,
      ocrApplied,
      notes,
    }
  },
}
