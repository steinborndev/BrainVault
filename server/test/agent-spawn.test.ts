import { describe, it, expect } from 'vitest'
import { createDetachedSpawn } from '../src/pipeline/agent-spawn.js'

// No SDK, no tokens: this exercises the real OS behaviour the hang fix depends on —
// a detached spawn + process-group SIGKILL reaps grandchildren the SDK's single-PID
// abort would orphan (TASKS-M5 Finding F1; mirrors scratchpad/spike-abort.mjs).

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('createDetachedSpawn', () => {
  it('hardKill SIGKILLs the whole process group, reaping a grandchild', async () => {
    const handle = createDetachedSpawn()
    const ac = new AbortController()
    // bash (child) backgrounds `sleep` (grandchild) and prints its pid, then waits —
    // the "long bash blocks the run" shape from the lint hang.
    const child = handle.spawn({
      command: 'bash',
      args: ['-c', 'sleep 300 & echo GCPID=$!; wait'],
      cwd: process.cwd(),
      env: process.env,
      signal: ac.signal,
    })
    child.on('error', () => {})

    let gcPid = 0
    try {
      gcPid = await new Promise<number>((resolve) => {
        child.stdout.on('data', (b: Buffer) => {
          const m = /GCPID=(\d+)/.exec(b.toString())
          if (m) resolve(Number(m[1]))
        })
      })
      expect(alive(gcPid)).toBe(true)

      handle.hardKill()
      await wait(500)
      expect(alive(gcPid)).toBe(false)
    } finally {
      if (gcPid) try { process.kill(gcPid, 'SIGKILL') } catch { /* already gone */ }
    }
  })

  it('hardKill is a no-op before anything is spawned', () => {
    expect(() => createDetachedSpawn().hardKill()).not.toThrow()
  })
})
