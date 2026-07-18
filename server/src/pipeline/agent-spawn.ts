/**
 * Hard, tool-interrupting kill for agent runs (TASKS-M5 §0 / Finding F1).
 *
 * Why this exists: the Agent SDK spawns its CLI subprocess WITHOUT a dedicated
 * process group and, on abort, sends SIGTERM to that one CLI PID only. A long-lived
 * grandchild (a `bash → python3` embeddings call from the lint tiling pass) is NOT
 * reaped — it is orphaned and keeps running, so `abortController.abort()` cannot end
 * the run and it outlives the timeout (the observed >21-min lint "hang"). Proven with
 * `scratchpad/spike-abort.mjs`: SDK-style abort orphans the grandchild; a process-group
 * SIGKILL reaps the whole tree.
 *
 * The fix uses the SDK's `Options.spawnClaudeCodeProcess` hook (`sdk.d.ts`): we own the
 * spawn, start the CLI as its own process-group leader (`detached: true`), and expose a
 * `hardKill()` that SIGKILLs the whole group (`process.kill(-pid, ...)`) — CLI + bash +
 * every descendant. This is spawn-level, so it generalizes to ingest, query and research.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'

/**
 * PIDs of live detached agent process-group leaders. If the SERVICE crashes or is
 * terminated, our detached children are NOT in the SDK's own exit reaper — this set +
 * the `exit` hook below group-kill them so a stuck run can never survive the service.
 */
const liveGroups = new Set<number>()
let reaperInstalled = false

function installReaper(): void {
  if (reaperInstalled) return
  reaperInstalled = true
  // `exit` handlers may only do synchronous work — `process.kill` is synchronous.
  process.once('exit', () => {
    for (const pid of liveGroups) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    liveGroups.clear()
  })
}

export interface SpawnHandle {
  /** Pass as `Options.spawnClaudeCodeProcess`; the SDK calls it to start the CLI. */
  readonly spawn: (options: SdkSpawnOptions) => SpawnedProcess
  /**
   * SIGKILL the CLI's whole process group — reaps the CLI and every descendant
   * (bash, python3, …). No-op before the SDK spawns, or once the child has exited
   * (guards against a PID-reuse group-kill after a clean run).
   */
  readonly hardKill: () => void
}

/**
 * Creates a one-shot detached spawner + group-killer for a single agent run.
 * The returned `spawn` is handed to the SDK; `hardKill` is the runner's backstop.
 */
export function createDetachedSpawn(): SpawnHandle {
  installReaper()
  let current: ChildProcess | null = null

  return {
    spawn(options: SdkSpawnOptions): SpawnedProcess {
      const child = nodeSpawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        // Same stdio contract as the SDK's built-in spawn: it reads stdout, writes
        // stdin, and drains stderr for its exit-error tail.
        stdio: ['pipe', 'pipe', 'pipe'],
        // Forwarded grace signal — the SDK only aborts it AFTER its stdin-EOF + ~2s
        // graceful window, so wiring it to Node's spawn (SIGTERM to the leader) is safe
        // and preserves the CLI's graceful shutdown. Our group SIGKILL is the backstop.
        signal: options.signal,
        windowsHide: true,
        // The load-bearing change: own process group so `process.kill(-pid, ...)` reaps
        // the CLI's descendants, which the SDK's single-PID SIGTERM never touches.
        detached: true,
      })
      current = child
      const pid = child.pid
      if (pid !== undefined) {
        liveGroups.add(pid)
        child.once('exit', () => liveGroups.delete(pid))
      }
      // ChildProcess satisfies SpawnedProcess (stdio pipes make stdin/stdout non-null);
      // the cast bridges ChildProcess's `Writable | null` stream types.
      return child as unknown as SpawnedProcess
    },

    hardKill(): void {
      const child = current
      if (!child || child.pid === undefined) return
      // Skip a group-kill once the child has already exited — its PID may have been
      // reused by an unrelated process group, and signalling `-pid` would hit that.
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* group already gone */
      }
    },
  }
}
