/**
 * Image handling (SPEC.md §5). No local OCR: the image itself is handed to the agent
 * run, which reads screenshot text and visual content directly (Claude vision). We only
 * extract EXIF here — via `exiftool`, into the manifest — as context for the agent.
 *
 * `exiftool` is OPTIONAL: without it the image still ingests, just without metadata.
 */

import type { PreprocessPlugin, Probe, NormalizeContext, NormalizeResult } from '../types.js'
import { isPng, isJpeg, isWebp, isGif } from '../detect.js'
import { runTool } from '../tools.js'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic'])

/** EXIF fields that carry no signal for ingestion — dropped to keep the manifest small. */
const EXIF_NOISE = new Set(['SourceFile', 'ExifToolVersion', 'Directory', 'FilePermissions'])

export const imagePlugin: PreprocessPlugin = {
  name: 'image',
  type: 'image',
  matches: (probe: Probe): boolean =>
    IMAGE_EXTS.has(probe.ext) ||
    isPng(probe.head) ||
    isJpeg(probe.head) ||
    isWebp(probe.head) ||
    isGif(probe.head),

  async normalize(ctx: NormalizeContext): Promise<NormalizeResult> {
    const notes = ['image passed to the agent run directly (Claude reads it); no local OCR']
    let exif: Record<string, unknown> | undefined

    if (ctx.tools.exiftool) {
      try {
        const { stdout } = await runTool('exiftool', ['-json', '-n', ctx.probe.filePath], {
          timeoutMs: 30_000,
        })
        const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>
        if (parsed[0]) {
          exif = Object.fromEntries(
            Object.entries(parsed[0]).filter(([k]) => !EXIF_NOISE.has(k)),
          )
        }
      } catch {
        notes.push('EXIF extraction failed — continuing without metadata')
      }
    } else {
      notes.push('exiftool not installed — no EXIF metadata captured')
    }

    return { passImageToAgent: true, ...(exif ? { exif } : {}), notes }
  },
}
