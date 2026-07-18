/**
 * Live hard-kill probe (TASKS-M5 finding F1). Not a unit test — the thing being verified is
 * precisely what a mocked SDK cannot show: whether our detached process group + group SIGKILL
 * actually reaps a stuck tool's descendants when the REAL Claude Code CLI is in the middle of a
 * long-running bash call.
 *
 * History: a real full-wiki lint outlived its 15-min timeout by >6 min. Root cause — the SDK
 * spawns its CLI without a dedicated process group and, on abort, signals that one PID only, so
 * a `bash → python3` embeddings grandchild was orphaned and kept running. The fix owns the spawn
 * (`Options.spawnClaudeCodeProcess`, see pipeline/agent-spawn.ts) and escalates to
 * `process.kill(-pid, 'SIGKILL')`.
 *
 * This probe forces exactly that shape: a run with a short timeout whose prompt makes the agent
 * start a long `sleep`. It then checks whether the sleep is dead once the run returns.
 *
 * Profile note: this runs under `ingest`, not `query`. That is deliberate and was measured —
 * under `query` the read-only system prompt makes the agent REFUSE ("this is framed as a
 * read-only wiki-query task"), which is correct behaviour but leaves the kill path untested.
 * `ingest` is also the profile the real hang occurred under (lint), so it is the representative
 * one. Because `ingest` grants the sandbox a vault write path, **point VAULT_ROOT at a throwaway
 * vault**, not your real one — a copy of `.claude-plugin/` + `skills/` plus an empty `wiki/` is
 * enough. The probe additionally snapshots the vault before and after and fails if anything
 * changed, so a stray write cannot pass unnoticed.
 *
 * Run: VAULT_ROOT=/path/to/throwaway-vault npx tsx server/src/cli/killprobe.ts
 */

import { execFileSync } from 'node:child_process'
import { loadConfig } from '../config.js'
import { runAgent } from '../pipeline/agent-runner.js'

/**
 * The blocking command. NOT a bare `sleep`: the Claude Code CLI has its own guard that rejects
 * standalone sleeps ("Blocked: standalone sleep … use Monitor with an until-loop"), measured
 * while building this probe. A blocking `python3` is both allowed and more representative — the
 * original hang was exactly a `bash → python3` embeddings call.
 */
const SLEEP_SECONDS = 604
const BLOCKING_COMMAND = `python3 -c "import time; time.sleep(${SLEEP_SECONDS})"`
/** ERE for pgrep -f; matches the python process and the bash/bwrap wrappers around it. */
const PATTERN = `python3.*${SLEEP_SECONDS}`
const RUN_TIMEOUT_MS = 30_000

const config = loadConfig()

/** PIDs whose command line mentions our sleep — the CLI's bash, bwrap, and the sleep itself. */
function matchingPids(): number[] {
  try {
    const out = execFileSync('pgrep', ['-f', PATTERN], { encoding: 'utf8' })
    return out
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

/**
 * Fingerprint of the vault's CONTENT (`wiki/`), taken before and after the run.
 *
 * Scoped to wiki/ on purpose. A sandboxed run leaves housekeeping in the project root that is
 * not the agent writing anything: the CLI scaffolds `.claude/`, and bubblewrap creates 0-byte
 * read-only bind-mount targets (`.bashrc`, `.gitconfig`, `.mcp.json`, …). Those survive here
 * precisely BECAUSE this probe group-SIGKILLs the sandbox, so bwrap never runs its own cleanup —
 * they do not appear after a normally-completed run. Watching the whole root would therefore
 * always report a change and drown the assertion that matters: did the agent write content?
 */
function vaultSnapshot(root: string): string {
  try {
    return execFileSync('find', [`${root}/wiki`, '-type', 'f', '-printf', '%P %s %T@\\n'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .sort()
      .join('\n')
  } catch {
    return ''
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Watch for the descendants while the run is in flight; keep every PID we ever saw, because the
// whole point is to check afterwards that none of them survived.
const seen = new Set<number>()
const watcher = setInterval(() => {
  for (const pid of matchingPids()) seen.add(pid)
}, 250)

const vaultBefore = vaultSnapshot(config.vaultRoot)
const startedAt = Date.now()
console.log(`starting a run with a ${RUN_TIMEOUT_MS / 1000}s timeout that will get stuck in \`${BLOCKING_COMMAND}\`…`)

const result = await runAgent({
  vaultRoot: config.vaultRoot,
  auth: config.auth,
  // See the header: `query` makes the agent refuse the blocking command, so this uses `ingest`
  // (also the profile the real hang occurred under). Point VAULT_ROOT at a throwaway vault.
  profile: 'ingest',
  timeoutMs: RUN_TIMEOUT_MS,
  prompt:
    `Run exactly this bash command and wait for it to complete: ${BLOCKING_COMMAND}\n` +
    `Use the Bash tool with its timeout parameter set to 600000 (10 minutes) so it does NOT ` +
    `return early. Do not background it, do not wrap it in \`timeout\`, do not substitute a ` +
    `different command, do not do anything else first, and do not explain — just start it and wait.`,
  // Surface what the agent actually did: an INCONCLUSIVE probe is almost always "the agent ran
  // something other than the blocking command", and without this you cannot tell what.
  onMessage: (m) => {
    if (m.type === 'assistant') {
      const content = (m.message as { content?: unknown }).content
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b['type'] === 'tool_use') {
            console.log(`  [tool] ${String(b['name'])} ${JSON.stringify(b['input']).slice(0, 160)}`)
          } else if (b['type'] === 'text' && String(b['text']).trim() !== '') {
            console.log(`  [text] ${String(b['text']).trim().slice(0, 160)}`)
          }
        }
      }
    }
    if (m.type === 'user') {
      const content = (m.message as { content?: unknown }).content
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b['type'] === 'tool_result') {
            const text = JSON.stringify(b['content']).slice(0, 160)
            console.log(`  [result]${b['is_error'] === true ? ' ERROR' : ''} ${text}`)
          }
        }
      }
    }
  },
})

const elapsedMs = Date.now() - startedAt
clearInterval(watcher)

// Give the escalation its grace window (abort → ~5 s → group SIGKILL) before judging.
await new Promise((r) => setTimeout(r, 8_000))

const survivors = [...seen].filter(alive)
const vaultChanged = vaultSnapshot(config.vaultRoot) !== vaultBefore

console.log('\n=========== HARD-KILL PROBE ===========')
console.log(`run returned after:    ${(elapsedMs / 1000).toFixed(1)}s (timeout was ${RUN_TIMEOUT_MS / 1000}s)`)
console.log(`timed out:             ${result.timedOut}`)
console.log(`ok:                    ${result.ok}`)
console.log(`error:                 ${result.error ?? '(none)'}`)
console.log(`descendants observed:  ${seen.size > 0 ? [...seen].join(', ') : '(none — see note)'}`)
console.log(`survivors after kill:  ${survivors.length > 0 ? survivors.join(', ') + '  <-- LEAKED' : 'none'}`)
console.log(`vault content (wiki/) changed: ${vaultChanged ? 'YES  <-- unexpected' : 'no'}`)

if (seen.size === 0) {
  console.log(
    '\nINCONCLUSIVE: never saw the sleep process. The agent probably did not run the command ' +
      '(refused, backgrounded it, or finished early). Check the run error above and re-try.',
  )
  process.exit(2)
}

// Clean up anything that leaked, so a failed probe does not leave processes behind.
for (const pid of survivors) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

if (survivors.length > 0) {
  console.log('\nFAIL: a descendant outlived the run — the group kill did not reap the tree.')
  process.exit(1)
}
if (vaultChanged) {
  console.log('\nFAIL: the run wrote vault content. The kill path may be fine, but the probe is')
  console.log('meant to be side-effect free — inspect wiki/ before trusting this result.')
  process.exit(1)
}
console.log('\nPASS: the stuck tool and its descendants were reaped with the run.')
process.exit(0)
