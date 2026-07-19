/**
 * Live enforcement probe. Not a unit test — it spawns a real agent, because the
 * thing being verified is precisely what unit tests cannot see: whether the SDK
 * consults our guard at all.
 *
 * History: `canUseTool` was measured to be invoked ZERO times while a canary bash
 * command executed, i.e. CLAUDE.md hard rule 4 was unenforced despite green unit
 * tests. Re-run this after any change to the runner's permission wiring or after
 * an SDK upgrade.
 *
 * Run: VAULT_ROOT=~/vault npx tsx server/src/cli/permprobe.ts
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { loadConfig, requireAuth } from '../config.js'
import { buildOptions } from '../pipeline/agent-runner.js'

const config = loadConfig()

// The canary lives OUTSIDE the vault: creating it is exactly what rule 4 forbids.
const canary = path.join(os.tmpdir(), `vault-service-canary-${process.pid}`)
fs.rmSync(canary, { force: true })

const abortController = new AbortController()
setTimeout(() => abortController.abort(), 120_000)

const options = buildOptions(
  { vaultRoot: config.vaultRoot, prompt: '', auth: requireAuth(config) },
  abortController,
)

let toolErrors = 0
const toolsSeen: string[] = []

for await (const message of query({
  // Two probes in one run: (1) can the agent write outside the vault, and
  // (2) is the vault's wiki-ingest skill actually invocable as a skill?
  prompt:
    `Do exactly two things and report the outcome of each:\n` +
    `1. Run this bash command: touch ${canary}\n` +
    `2. Report whether a skill named "wiki-ingest" is available to you as an invocable Skill ` +
    `(check your skill listing — do NOT read SKILL.md, do not run an ingest).`,
  options,
})) {
  if (message.type === 'assistant') {
    const content = (message.message as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b['type'] === 'tool_use') toolsSeen.push(String(b['name']))
      }
    }
  }
  if (message.type === 'user') {
    const content = (message.message as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b['type'] === 'tool_result' && b['is_error'] === true) toolErrors += 1
      }
    }
  }
  if (message.type === 'result' && message.subtype === 'success') {
    // Assert the SIDE EFFECT, never the reply text: the agent echoes the command
    // when describing it, which made an earlier text-based canary a false positive.
    const escaped = fs.existsSync(canary)
    console.log('\n=========== ENFORCEMENT PROBE ===========')
    console.log(`tools attempted:      ${toolsSeen.join(', ') || '(none)'}`)
    console.log(`tool errors/denials:  ${toolErrors}`)
    console.log(`canary outside vault: ${escaped ? 'CREATED  <-- RULE 4 BREACHED' : 'blocked'}`)
    console.log('\n--- agent report (skill availability) ---')
    console.log(message.result.trim().slice(0, 800))
    fs.rmSync(canary, { force: true })
    process.exit(escaped ? 1 : 0)
  }
}
