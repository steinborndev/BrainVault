/**
 * M0 task 2.3 — minimal Agent SDK smoke test.
 *
 * Verifies that the configured credential authenticates and that `query()` returns
 * a result, with a trivial prompt and no tools. Deliberately does not touch the
 * vault: this isolates "auth works" from "ingest works", so a failure in the real
 * ingest run cannot be blamed on the token.
 *
 * Run: npm run smoke --workspace server
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { loadConfig, describeConfig, ConfigError } from '../config.js'
import { buildAgentEnv } from '../pipeline/agent-runner.js'

async function main(): Promise<number> {
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

  console.log('config:')
  for (const [key, value] of Object.entries(describeConfig(config))) {
    console.log(`  ${key}: ${value}`)
  }
  console.log('---')
  console.log('sending trivial prompt (no tools, no vault access)...')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)

  try {
    for await (const message of query({
      prompt: 'Reply with exactly the word: pong',
      options: {
        // Isolate the smoke test from filesystem settings and the vault entirely.
        settingSources: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'WebSearch', 'WebFetch'],
        abortController: controller,
        // Without this the subprocess has no credential and answers
        // "Not logged in" as a *successful* result.
        env: buildAgentEnv(config.auth),
      },
    })) {
      if (message.type !== 'result') continue

      if (message.subtype === 'success') {
        const tokens = message.usage.input_tokens + message.usage.output_tokens
        // Zero tokens means the subprocess never called the API. The SDK reports
        // that as success, so checking the subtype alone would report a green
        // smoke test against a token that does not work.
        if (tokens === 0) {
          console.error(`✗ auth FAILED — zero tokens spent; agent replied: ${JSON.stringify(message.result.trim())}`)
          return 1
        }
        console.log(`✓ auth OK — agent replied: ${JSON.stringify(message.result.trim())}`)
        console.log(`  turns:  ${message.num_turns}`)
        console.log(`  tokens: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`)
        console.log(
          `  cost:   $${message.total_cost_usd.toFixed(4)}` +
            (config.auth.mode === 'oauth' ? '  (estimate — subscription mode)' : ''),
        )
        return 0
      }
      console.error(`✗ run failed: ${message.subtype}`)
      return 1
    }
    console.error('✗ stream ended with no result message')
    return 1
  } catch (err) {
    console.error(`✗ smoke test threw: ${(err as Error).message}`)
    return 1
  } finally {
    clearTimeout(timer)
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('unexpected failure:', err)
    process.exit(1)
  })
