/**
 * Content hashing for dedupe (SPEC.md §3.2). SHA-256 over the raw bytes is the dedupe
 * key: the same file dropped twice is recognised regardless of its name or source.
 */

import fs from 'node:fs'
import crypto from 'node:crypto'

/** SHA-256 of a buffer, lowercase hex. */
export function sha256Buffer(data: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** Streams a file through SHA-256 so large uploads never sit fully in memory. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
