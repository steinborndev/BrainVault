import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, MEMORY_DB, type Db } from '../src/db/index.js'
import {
  SettingsStore,
  SETTINGS_SCHEMA,
  RESTART_REQUIRED_KEYS,
  baselineSettings,
  effectiveSettings,
  DEFAULT_CONCURRENCY,
} from '../src/db/settings.js'
import type { Config } from '../src/config.js'

let db: Db
let store: SettingsStore

const config = {
  vaultRoot: '/home/user/vault',
  obsidianVaultName: 'vault',
  auth: { mode: 'oauth', credential: 'tok', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
  server: {
    host: '127.0.0.1',
    port: 8420,
    watchFolder: '/mnt/c/inbox',
    maxUploadBytes: 200 * 1024 * 1024,
    authMode: 'local-single-user',
  },
} as Config

beforeEach(() => {
  db = openDb(MEMORY_DB)
  store = new SettingsStore(db)
})

describe('precedence: env baseline, table overrides', () => {
  it('falls back to the baseline when nothing is overridden', () => {
    expect(store.overrides()).toEqual({})
    expect(store.effective(config)).toEqual(baselineSettings(config))
    expect(store.effective(config).concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(store.effective(config).watchFolder).toBe('/mnt/c/inbox')
  })

  it('an override wins over the baseline and survives a new store instance', () => {
    store.set({ concurrency: 4, watchFolder: '/tmp/drop' })
    expect(store.effective(config).concurrency).toBe(4)
    expect(store.effective(config).watchFolder).toBe('/tmp/drop')
    // Same DB, fresh store — overrides are persisted, not in-memory.
    expect(new SettingsStore(db).effective(config).concurrency).toBe(4)
    // Untouched keys still come from the baseline.
    expect(store.effective(config).maxUploadBytes).toBe(config.server.maxUploadBytes)
  })

  it('writing null clears an override back to the baseline', () => {
    store.set({ concurrency: 8 })
    expect(store.effective(config).concurrency).toBe(8)
    store.set({ concurrency: null })
    expect(store.overrides().concurrency).toBeUndefined()
    expect(store.effective(config).concurrency).toBe(DEFAULT_CONCURRENCY)
  })
})

describe('validation (hard rules 2/3)', () => {
  it('rejects keys that are not runtime-settable — bind and credentials', () => {
    // A settings write must never move the service off localhost or touch a credential.
    for (const bad of [
      { host: '0.0.0.0' },
      { port: 80 },
      { CLAUDE_CODE_OAUTH_TOKEN: 'leak' },
      { ANTHROPIC_API_KEY: 'leak' },
      { authToken: 'x' },
    ]) {
      expect(SETTINGS_SCHEMA.safeParse(bad).success).toBe(false)
    }
  })

  it('rejects out-of-range values', () => {
    expect(SETTINGS_SCHEMA.safeParse({ concurrency: 0 }).success).toBe(false)
    expect(SETTINGS_SCHEMA.safeParse({ concurrency: 99 }).success).toBe(false)
    expect(SETTINGS_SCHEMA.safeParse({ concurrency: 1.5 }).success).toBe(false)
    expect(SETTINGS_SCHEMA.safeParse({ maxUploadBytes: -1 }).success).toBe(false)
    expect(SETTINGS_SCHEMA.safeParse({ watchFolder: '' }).success).toBe(false)
    expect(SETTINGS_SCHEMA.safeParse({ gitAutoCommit: 'yes' }).success).toBe(false)
  })

  it('accepts the settable keys', () => {
    const ok = SETTINGS_SCHEMA.safeParse({
      watchFolder: '/tmp/x',
      concurrency: 3,
      maxUploadBytes: 1024,
      gitAutoCommit: false,
    })
    expect(ok.success).toBe(true)
  })
})

describe('robustness', () => {
  it('ignores an unparseable or invalid stored row instead of failing to start', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('concurrency', 'not json')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('gitAutoCommit', 'false')
    // The bad row is dropped; the good one still applies.
    expect(store.effective(config).concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(store.effective(config).gitAutoCommit).toBe(false)
  })

  it('salvages valid keys when one stored value is out of range', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('concurrency', '999')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('watchFolder', '"/tmp/ok"')
    expect(store.effective(config).concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(store.effective(config).watchFolder).toBe('/tmp/ok')
  })
})

describe('restart-required classification', () => {
  it('flags exactly the keys bound at startup', () => {
    expect([...RESTART_REQUIRED_KEYS].sort()).toEqual(['maxUploadBytes', 'watchFolder'])
    // concurrency + gitAutoCommit are applied live, so they are NOT in the list.
    expect(RESTART_REQUIRED_KEYS as readonly string[]).not.toContain('concurrency')
    expect(RESTART_REQUIRED_KEYS as readonly string[]).not.toContain('gitAutoCommit')
  })

  it('effectiveSettings is a pure baseline+override merge', () => {
    expect(effectiveSettings(config, { concurrency: 5 })).toEqual({
      ...baselineSettings(config),
      concurrency: 5,
    })
  })
})
