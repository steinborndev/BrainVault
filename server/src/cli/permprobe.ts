/**
 * Throwaway probe: is `canUseTool` actually consulted by the SDK?
 *
 * The M0 ingest ran `find /home/benjamin/vault …` successfully even though the
 * runner's whitelist only permits the vault's own scripts/*.sh — suggesting the
 * callback is never invoked. This denies EVERY tool and asks the agent to run one
 * bash command. If the command executes, the callback is not being consulted and
 * CLAUDE.md hard rule 4 is unenforced in practice.
 */

import fs from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { loadConfig } from '../config.js'
import { buildAgentEnv } from '../pipeline/agent-runner.js'

const config = loadConfig()
let callbackInvocations = 0
let hookInvocations = 0

const controller = new AbortController()
setTimeout(() => controller.abort(), 90_000)

for await (const message of query({
  prompt: 'Run exactly this bash command, nothing else: touch /tmp/claude-1000/-home-benjamin-dev-BrainVault/61656d02-03ef-4063-b6a0-321e93a7b67e/scratchpad/canary.txt',
  options: {
    cwd: config.vaultRoot,
    env: buildAgentEnv(config.auth),
    settingSources: ['project'],
    permissionMode: 'default',
    canUseTool: async (toolName) => {
      callbackInvocations += 1
      console.log(`  [canUseTool invoked] tool=${toolName} -> DENY`)
      return { behavior: 'deny', message: 'probe: everything is denied' }
    },
    // The SDK's own shadowing warning says: "To gate every tool call, use a
    // PreToolUse hook". Testing whether the hook fires where canUseTool does not.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              hookInvocations += 1
              const name = (input as { tool_name?: string }).tool_name ?? '?'
              console.log(`  [PreToolUse hook invoked] tool=${name} -> DENY`)
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: 'probe: everything is denied',
                },
              }
            },
          ],
        },
      ],
    },
    abortController: controller,
  },
})) {
  if (message.type === 'assistant') {
    const content = (message.message as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b['type'] === 'tool_use') console.log(`  [tool_use] ${String(b['name'])}`)
      }
    }
  }
  if (message.type === 'result' && message.subtype === 'success') {
    // Check the SIDE EFFECT, not the text: the agent naturally echoes the canary
    // string when describing the command, which made the text check a false positive.
    const executed = fs.existsSync('/tmp/claude-1000/-home-benjamin-dev-BrainVault/61656d02-03ef-4063-b6a0-321e93a7b67e/scratchpad/canary.txt')
    console.log('---')
    console.log(`canUseTool invocations:  ${callbackInvocations}`)
    console.log(`PreToolUse invocations:  ${hookInvocations}`)
    console.log(`canary executed:         ${executed}`)
    console.log(
      executed
        ? '>>> VERDICT: the command RAN despite both gates — not enforceable this way.'
        : '>>> VERDICT: the command was BLOCKED.',
    )
  }
}
