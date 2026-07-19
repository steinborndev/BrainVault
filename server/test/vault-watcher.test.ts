import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventBus, type BusEvent } from '../src/pipeline/events.js'
import { startVaultWatcher, type VaultWatcher } from '../src/pipeline/vault-watcher.js'

const silent = (): void => undefined

/** Polls until `count()` reaches `n` or the timeout passes; returns the final count. */
async function waitFor(count: () => number, n: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (count() < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  return count()
}

describe('vault watcher', () => {
  let vault: string
  let bus: EventBus
  let events: BusEvent[]
  let watcher: VaultWatcher | undefined

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-watch-'))
    fs.mkdirSync(path.join(vault, 'wiki', 'concepts'), { recursive: true })
    // A page that exists BEFORE the watcher starts must not fire (ignoreInitial).
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'preexisting.md'), '# old')
    bus = new EventBus()
    events = []
    bus.subscribe((e) => events.push(e))
  })

  afterEach(async () => {
    await watcher?.close()
    watcher = undefined
    fs.rmSync(vault, { recursive: true, force: true })
  })

  const vaultEvents = (): number => events.filter((e) => e.kind === 'vault').length

  it('publishes ONE debounced vault event for a burst of page writes', async () => {
    watcher = startVaultWatcher({ vaultRoot: vault, events: bus, log: silent, debounceMs: 100 })
    // chokidar needs a beat to establish its initial scan before changes register.
    await new Promise((r) => setTimeout(r, 300))
    expect(vaultEvents()).toBe(0) // preexisting page did not fire

    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'a.md'), '# a')
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'b.md'), '# b')
    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'c.md'), '# c')

    expect(await waitFor(vaultEvents, 1)).toBe(1)
    // The debounce must have coalesced the burst — give a stray second event time to appear.
    await new Promise((r) => setTimeout(r, 300))
    expect(vaultEvents()).toBe(1)
  })

  it('fires on change and unlink, ignores non-markdown files', async () => {
    watcher = startVaultWatcher({ vaultRoot: vault, events: bus, log: silent, debounceMs: 100 })
    await new Promise((r) => setTimeout(r, 300))

    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'preexisting.md'), '# edited')
    expect(await waitFor(vaultEvents, 1)).toBe(1)

    fs.rmSync(path.join(vault, 'wiki', 'concepts', 'preexisting.md'))
    expect(await waitFor(vaultEvents, 2)).toBe(2)

    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'image.png'), 'not a page')
    await new Promise((r) => setTimeout(r, 400))
    expect(vaultEvents()).toBe(2)
  })

  it('stops publishing after close', async () => {
    watcher = startVaultWatcher({ vaultRoot: vault, events: bus, log: silent, debounceMs: 100 })
    await new Promise((r) => setTimeout(r, 300))
    await watcher.close()
    watcher = undefined

    fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'late.md'), '# late')
    await new Promise((r) => setTimeout(r, 400))
    expect(vaultEvents()).toBe(0)
  })
})
