/**
 * Detection helpers: the safety guard that runs before any plugin, plus the probe
 * builder and magic-byte predicates the plugins share.
 *
 * Hard rule 6 (CLAUDE.md): incoming files are never executed, and a magic-byte check
 * guards against executables disguised behind an innocent extension. That check is
 * CORE, not a plugin — it must run for every input regardless of which plugin later
 * claims it, so a `report.pdf` that is really an ELF binary is refused outright.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Probe } from './types.js'
import { PreprocessError } from './types.js'

/** How many leading bytes to sniff. Enough for every magic number we check. */
export const HEAD_BYTES = 512

/** Executable magic numbers, refused on sight whatever the extension claims. */
const EXECUTABLE_MAGICS: ReadonlyArray<{ readonly bytes: readonly number[]; readonly kind: string }> = [
  { bytes: [0x7f, 0x45, 0x4c, 0x46], kind: 'ELF binary' }, // \x7fELF (Linux)
  { bytes: [0x4d, 0x5a], kind: 'DOS/PE executable' }, // MZ (Windows .exe/.dll)
  { bytes: [0xfe, 0xed, 0xfa, 0xce], kind: 'Mach-O binary' }, // 32-bit BE
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], kind: 'Mach-O binary' }, // 64-bit BE
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], kind: 'Mach-O binary' }, // 64-bit LE
  { bytes: [0xca, 0xfe, 0xba, 0xbe], kind: 'Mach-O/Java executable' }, // fat binary / .class
]

function startsWith(head: Buffer, bytes: readonly number[]): boolean {
  if (head.length < bytes.length) return false
  for (let i = 0; i < bytes.length; i++) if (head[i] !== bytes[i]) return false
  return true
}

/** Throws `PreprocessError(refused)` when the bytes are an executable. */
export function assertNotExecutable(head: Buffer, name: string): void {
  for (const { bytes, kind } of EXECUTABLE_MAGICS) {
    if (startsWith(head, bytes)) {
      throw new PreprocessError(
        `refused: ${name} is a ${kind} disguised as a document; incoming files are never executed or ingested (hard rule 6)`,
        true,
      )
    }
  }
}

export function extensionOf(name: string): string {
  const ext = path.extname(name).toLowerCase()
  return ext.startsWith('.') ? ext.slice(1) : ext
}

/** Reads the head bytes and assembles a probe for the plugin chain. */
export function buildProbe(filePath: string, originalName: string): Probe {
  const stat = fs.statSync(filePath)
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size))
    if (head.length > 0) fs.readSync(fd, head, 0, head.length, 0)
    return {
      filePath,
      originalName,
      ext: extensionOf(originalName),
      head,
      size: stat.size,
    }
  } finally {
    fs.closeSync(fd)
  }
}

// --- shared magic-byte predicates for plugins --------------------------------

export const isPdf = (head: Buffer): boolean => startsWith(head, [0x25, 0x50, 0x44, 0x46]) // %PDF
export const isZip = (head: Buffer): boolean =>
  startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ||
  startsWith(head, [0x50, 0x4b, 0x05, 0x06]) || // empty archive
  startsWith(head, [0x50, 0x4b, 0x07, 0x08])
export const isOle = (head: Buffer): boolean =>
  startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) // legacy .doc/.xls/.ppt
export const isPng = (head: Buffer): boolean => startsWith(head, [0x89, 0x50, 0x4e, 0x47])
export const isJpeg = (head: Buffer): boolean => startsWith(head, [0xff, 0xd8, 0xff])
export const isGif = (head: Buffer): boolean => startsWith(head, [0x47, 0x49, 0x46, 0x38])
export const isWebp = (head: Buffer): boolean =>
  startsWith(head, [0x52, 0x49, 0x46, 0x46]) && // RIFF
  head.length >= 12 &&
  head.subarray(8, 12).toString('ascii') === 'WEBP'
