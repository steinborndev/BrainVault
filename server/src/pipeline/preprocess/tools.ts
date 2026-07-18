/**
 * External-tool detection and invocation for the preprocessing plugins.
 *
 * The toolchain (poppler, tesseract, pandoc, exiftool, defuddle) is installed out of
 * band by `scripts/install-preprocessing-tools.sh` — most of it needs `apt` and thus
 * sudo. Plugins ask `detectTools()` what is present and degrade gracefully (record a
 * note) rather than crashing when an optional tool is missing; a REQUIRED tool that is
 * absent (e.g. pdftotext for a PDF) is the plugin's own error to raise.
 */

import { execFile } from 'node:child_process'
import type { ToolAvailability } from './types.js'

const TOOL_BINARIES = {
  pdftotext: 'pdftotext',
  pdfinfo: 'pdfinfo',
  ocrmypdf: 'ocrmypdf',
  pandoc: 'pandoc',
  python3: 'python3',
  exiftool: 'exiftool',
  defuddle: 'defuddle',
  ytDlp: 'yt-dlp',
} as const satisfies Record<keyof ToolAvailability, string>

export interface RunResult {
  readonly stdout: string
  readonly stderr: string
}

/** Runs a tool with a hard timeout and an output cap; rejects on non-zero exit. */
export function runTool(
  bin: string,
  args: readonly string[],
  opts: { readonly timeoutMs?: number; readonly maxBuffer?: number; readonly cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args as string[],
      {
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        cwd: opts.cwd,
        // No shell: args are passed to execve directly, so a filename with a space or a
        // `;` is an argument, never a second command.
        shell: false,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${bin} failed: ${err.message}${stderr ? `\n${stderr}` : ''}`))
          return
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
      },
    )
  })
}

/** True if `bin` resolves on PATH. */
export async function hasTool(bin: string): Promise<boolean> {
  try {
    await runTool('sh', ['-c', `command -v ${bin}`], { timeoutMs: 5000 })
    return true
  } catch {
    return false
  }
}

/** Probes the whole toolchain once. Callers should cache the result per pipeline run. */
export async function detectTools(): Promise<ToolAvailability> {
  const entries = await Promise.all(
    (Object.entries(TOOL_BINARIES) as Array<[keyof ToolAvailability, string]>).map(
      async ([key, bin]) => [key, await hasTool(bin)] as const,
    ),
  )
  return Object.fromEntries(entries) as unknown as ToolAvailability
}
