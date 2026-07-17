/**
 * M0 CLI trigger: `npm run ingest -- <path-to-file>`
 *
 * Copies the file into `VAULT_ROOT/.raw/m0-test/` and runs `ingest .raw/m0-test/<file>`.
 * This is the manual trigger the M0 acceptance criterion asks for (SPEC.md §10);
 * the watcher and queue replace it in M1/M2, but the agent-runner underneath stays.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, describeConfig, ConfigError } from '../config.js'
import { runAgent, DEFAULT_TIMEOUT_MS } from '../pipeline/agent-runner.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const RAW_SUBDIR = path.join('.raw', 'm0-test')

/**
 * Resolves the user's path argument against the directory they actually typed it in.
 *
 * `npm run ingest -- ./x.pdf` runs the script with cwd = `server/` (the workspace),
 * not the directory the user was standing in — so resolving against `process.cwd()`
 * silently looks in the wrong place. npm exports `INIT_CWD` for exactly this.
 */
export function resolveInputPath(arg: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path.isAbsolute(arg)) return arg
  const base = env['INIT_CWD'] ?? process.cwd()
  return path.resolve(base, arg)
}

/** Renders one streamed SDK message as a compact log line. */
function formatMessage(message: SDKMessage): string | undefined {
  switch (message.type) {
    case 'assistant':
    case 'user': {
      const content = (message.message as { content?: unknown }).content
      if (typeof content === 'string') return `[${message.type}] ${content}`
      if (!Array.isArray(content)) return undefined
      const parts: string[] = []
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          parts.push(block['text'] as string)
        } else if (block['type'] === 'tool_use') {
          parts.push(`→ ${String(block['name'])}(${JSON.stringify(block['input']).slice(0, 160)})`)
        } else if (block['type'] === 'tool_result') {
          const isError = block['is_error'] === true
          parts.push(isError ? '← tool error' : '← tool ok')
        }
      }
      return parts.length > 0 ? `[${message.type}] ${parts.join('\n')}` : undefined
    }
    case 'system':
      return `[system] ${message.subtype}`
    case 'result':
      return undefined // summarised separately below
    default:
      return undefined
  }
}

async function main(): Promise<number> {
  const inputArg = process.argv[2]
  if (inputArg === undefined || inputArg === '' || inputArg === '--help') {
    console.error('usage: npm run ingest -- <path-to-file>')
    return 2
  }

  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`configuration error:\n${err.message}`)
      return 2
    }
    throw err
  }

  const sourcePath = resolveInputPath(inputArg)
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    console.error(`not a file: ${sourcePath}`)
    return 2
  }

  const fileName = path.basename(sourcePath)
  const targetDir = path.join(config.vaultRoot, RAW_SUBDIR)
  fs.mkdirSync(targetDir, { recursive: true })
  const targetPath = path.join(targetDir, fileName)
  fs.copyFileSync(sourcePath, targetPath)

  // Vault-relative, POSIX-style: this string goes into the prompt, and the agent
  // reads it as a vault path, not a host path.
  const vaultRelative = path.posix.join('.raw', 'm0-test', fileName)
  const prompt = `ingest ${vaultRelative}`

  console.log('vault-service ingest (M0)')
  for (const [key, value] of Object.entries(describeConfig(config))) {
    console.log(`  ${key}: ${value}`)
  }
  console.log(`  source:    ${sourcePath}`)
  console.log(`  copied to: ${targetPath}`)
  console.log(`  prompt:    ${prompt}`)
  console.log(`  timeout:   ${Math.round(DEFAULT_TIMEOUT_MS / 60000)} min`)
  console.log('---')

  const run = await runAgent({
    vaultRoot: config.vaultRoot,
    prompt,
    auth: config.auth,
    onMessage: (message) => {
      const line = formatMessage(message)
      if (line !== undefined) console.log(line)
    },
  })

  console.log('---')
  console.log(run.ok ? '✓ ingest completed' : '✗ ingest failed')
  if (run.error !== undefined) console.log(`  error:    ${run.error}`)
  console.log(`  duration: ${(run.durationMs / 1000).toFixed(1)}s over ${run.numTurns} turns`)
  console.log(`  tokens:   ${run.usage.tokensIn} in / ${run.usage.tokensOut} out`)
  console.log(
    `  cost:     $${run.usage.costUsd.toFixed(4)}` +
      (config.auth.mode === 'oauth' ? '  (estimate — subscription mode, not billed)' : ''),
  )
  console.log(`  session:  ${run.sessionId}`)
  if (run.ok) console.log(`\n${run.result}`)

  return run.ok ? 0 : 1
}

// Only run when invoked as a program. Without this guard, importing the module
// from a test executes main() and calls process.exit(), which vitest flags as an
// unhandled error and warns can produce false positives.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('unexpected failure:', err)
      process.exit(1)
    })
}
