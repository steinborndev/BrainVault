/**
 * The preprocessing chain: `detect → normalize → manifest` (SPEC.md §3.1, §5).
 *
 * This core is deliberately type-agnostic — it never names a material type. It runs the
 * safety guard, finds the first plugin that claims the input, lets it normalize, and
 * writes `manifest.json` (source, type, hashes, timestamps) into `.raw/<job-id>/`. New
 * types are added by registering a plugin, never by editing this file.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { JobSource, JobType } from '../../db/jobs.js'
import { nowIso } from '../../db/index.js'
import type { Manifest, PreprocessPlugin, PreprocessResult, ToolAvailability } from './types.js'
import { PreprocessError } from './types.js'
import { assertNotExecutable, buildProbe } from './detect.js'
import { DEFAULT_REGISTRY } from './registry.js'
import { detectTools } from './tools.js'

export * from './types.js'
export { detectTools } from './tools.js'
export { DEFAULT_REGISTRY } from './registry.js'

export interface PreprocessInput {
  readonly jobId: string
  readonly source: JobSource
  /** Absolute path to the original file. Expected to already live inside `jobDir`. */
  readonly sourcePath: string
  readonly originalName: string
  /** Absolute vault root — used to make the returned artifact path vault-relative. */
  readonly vaultRoot: string
  /** Absolute path to `.raw/<job-id>/`. Created if missing. */
  readonly jobDir: string
  readonly sha256?: string
  readonly url?: string
  /** Injected for tests. Defaults to the standard chain. */
  readonly registry?: readonly PreprocessPlugin[]
  /** Injected for tests / caching. Defaults to probing the toolchain. */
  readonly tools?: ToolAvailability
}

/** POSIX, vault-relative — this string goes into the agent prompt as a vault path. */
function vaultRelative(vaultRoot: string, absPath: string): string {
  return path.relative(vaultRoot, absPath).split(path.sep).join(path.posix.sep)
}

export async function preprocess(input: PreprocessInput): Promise<PreprocessResult> {
  fs.mkdirSync(input.jobDir, { recursive: true })

  if (!fs.existsSync(input.sourcePath)) {
    throw new PreprocessError(`source file missing: ${input.sourcePath}`)
  }

  const probe = buildProbe(input.sourcePath, input.originalName)
  // Core safety guard — runs for EVERY input before any plugin (hard rule 6).
  assertNotExecutable(probe.head, input.originalName)

  const registry = input.registry ?? DEFAULT_REGISTRY
  const plugin = registry.find((p) => p.matches(probe))
  if (plugin === undefined) {
    // Only reachable if a caller supplies a registry without a catch-all.
    throw new PreprocessError(`no preprocessing plugin matched ${input.originalName}`)
  }

  const tools = input.tools ?? (await detectTools())
  const result = await plugin.normalize({ probe, jobDir: input.jobDir, tools })

  const originalRel = path.basename(input.sourcePath)
  const normalizedRel =
    result.normalizedPath !== undefined ? path.basename(result.normalizedPath) : undefined

  const manifest: Manifest = {
    jobId: input.jobId,
    source: input.source,
    type: plugin.type as JobType,
    originalName: input.originalName,
    ...(input.url ? { url: input.url } : {}),
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    createdAt: nowIso(),
    original: originalRel,
    ...(normalizedRel ? { normalized: normalizedRel } : {}),
    ...(result.normalizedChars !== undefined ? { normalizedChars: result.normalizedChars } : {}),
    ocrApplied: result.ocrApplied ?? false,
    passImageToAgent: result.passImageToAgent ?? false,
    deferred: result.deferred ?? false,
    ...(result.exif ? { exif: result.exif } : {}),
    notes: result.notes,
  }

  const manifestPath = path.join(input.jobDir, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  // The agent ingests the normalized artifact when there is one, else the original.
  const primaryAbs = result.normalizedPath ?? input.sourcePath

  return {
    type: plugin.type,
    deferred: result.deferred ?? false,
    manifestPath,
    primaryArtifact: vaultRelative(input.vaultRoot, primaryAbs),
    manifest,
  }
}
