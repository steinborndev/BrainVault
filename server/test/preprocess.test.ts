import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { preprocess, PreprocessError, type ToolAvailability } from '../src/pipeline/preprocess/index.js'
import { assertNotExecutable, isPdf, isZip, isPng } from '../src/pipeline/preprocess/detect.js'

const NO_TOOLS: ToolAvailability = {
  pdftotext: false,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: false,
  python3: false,
  exiftool: false,
  defuddle: false,
  ytDlp: false,
}

let vaultRoot: string

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

/** Writes a source file into .raw/<jobId>/ and returns the preprocess input. */
function stage(jobId: string, name: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  const jobDir = path.join(vaultRoot, '.raw', jobId)
  fs.mkdirSync(jobDir, { recursive: true })
  const sourcePath = path.join(jobDir, name)
  fs.writeFileSync(sourcePath, bytes)
  return {
    jobId,
    source: 'drop' as const,
    sourcePath,
    originalName: name,
    vaultRoot,
    jobDir,
    tools: NO_TOOLS,
    ...overrides,
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PDF_MAGIC = Buffer.from('%PDF-1.7\n')
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])

describe('detect predicates', () => {
  it('recognises magic bytes', () => {
    expect(isPdf(PDF_MAGIC)).toBe(true)
    expect(isZip(ZIP_MAGIC)).toBe(true)
    expect(isPng(PNG_MAGIC)).toBe(true)
    expect(isPdf(PNG_MAGIC)).toBe(false)
  })

  it('refuses executables regardless of extension', () => {
    expect(() => assertNotExecutable(ELF_MAGIC, 'report.pdf')).toThrow(PreprocessError)
    expect(() => assertNotExecutable(Buffer.from([0x4d, 0x5a]), 'invoice.docx')).toThrow(/executable/i)
    expect(() => assertNotExecutable(PDF_MAGIC, 'x.pdf')).not.toThrow()
  })
})

describe('preprocess chain', () => {
  it('passes markdown through and writes a manifest', async () => {
    const r = await preprocess(stage('j1', 'note.md', Buffer.from('# Hello\nbody')))
    expect(r.type).toBe('text')
    expect(r.deferred).toBe(false)
    expect(r.primaryArtifact).toBe('.raw/j1/note.md')
    expect(r.manifest.normalized).toBeUndefined()
    const written = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'))
    expect(written.type).toBe('text')
    expect(written.original).toBe('note.md')
    expect(written.notes.join(' ')).toMatch(/passthrough/)
  })

  it('defers audio/video', async () => {
    const r = await preprocess(stage('j2', 'talk.mp3', Buffer.from('ID3 fake')))
    expect(r.type).toBe('av')
    expect(r.deferred).toBe(true)
    expect(r.manifest.deferred).toBe(true)
  })

  it('defers archives without extracting them', async () => {
    const r = await preprocess(stage('j3', 'bundle.zip', ZIP_MAGIC))
    expect(r.type).toBe('other')
    expect(r.deferred).toBe(true)
    expect(r.manifest.notes.join(' ')).toMatch(/not auto-extracted/)
  })

  it('routes images to the agent with no local OCR', async () => {
    const r = await preprocess(stage('j4', 'shot.png', PNG_MAGIC))
    expect(r.type).toBe('image')
    expect(r.manifest.passImageToAgent).toBe(true)
    expect(r.primaryArtifact).toBe('.raw/j4/shot.png') // original, not a text extraction
    expect(r.manifest.notes.join(' ')).toMatch(/exiftool not installed/)
  })

  it('refuses a disguised executable before any plugin runs', async () => {
    await expect(preprocess(stage('j5', 'report.pdf', ELF_MAGIC))).rejects.toThrow(/hard rule 6/)
  })

  it('fails a PDF when pdftotext is missing (required tool, not passthrough)', async () => {
    await expect(preprocess(stage('j6', 'paper.pdf', PDF_MAGIC))).rejects.toThrow(/pdftotext/)
  })

  it('fails an xlsx when python3 is missing', async () => {
    await expect(preprocess(stage('j7', 'data.xlsx', ZIP_MAGIC))).rejects.toThrow(/python3/)
  })

  it('carries sha256 and source into the manifest', async () => {
    const r = await preprocess(stage('j8', 'note.txt', Buffer.from('x'), { sha256: 'abc123' }))
    expect(r.manifest.sha256).toBe('abc123')
    expect(r.manifest.source).toBe('drop')
  })

  it('routes a docx (zip magic + extension) to office, failing without pandoc', async () => {
    await expect(preprocess(stage('j9', 'letter.docx', ZIP_MAGIC))).rejects.toThrow(/pandoc/)
  })
})
