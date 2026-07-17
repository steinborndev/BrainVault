import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadConfig,
  parseEnvFile,
  describeConfig,
  ConfigError,
  CREDENTIAL_ENV_VARS,
} from '../src/config.js'

/** A directory that passes the structural vault check. */
function makeFakeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'))
  fs.mkdirSync(path.join(dir, 'wiki'))
  fs.mkdirSync(path.join(dir, 'skills'))
  return dir
}

let vault: string
const created: string[] = []

beforeEach(() => {
  vault = makeFakeVault()
  created.push(vault)
})

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('parseEnvFile', () => {
  it('parses KEY=VALUE lines and ignores comments and blanks', () => {
    expect(parseEnvFile('# note\n\nA=1\nB=two\n')).toEqual({ A: '1', B: 'two' })
  })

  it('strips matching surrounding quotes', () => {
    expect(parseEnvFile(`A="q"\nB='s'\n`)).toEqual({ A: 'q', B: 's' })
  })

  it('keeps "=" inside values', () => {
    expect(parseEnvFile('TOKEN=abc=def==\n')).toEqual({ TOKEN: 'abc=def==' })
  })

  it('keeps an empty assignment as an empty string', () => {
    expect(parseEnvFile('A=\n')).toEqual({ A: '' })
  })
})

describe('loadConfig — credential rules (CLAUDE.md hard rule 3)', () => {
  it('refuses to start when BOTH credentials are set', () => {
    expect(() =>
      loadConfig({
        envFile: false,
        env: { VAULT_ROOT: vault, CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key' },
      }),
    ).toThrow(/both .* are set/i)
  })

  it('refuses when the two credentials arrive from DIFFERENT sources (file + env)', () => {
    // The dangerous real-world case: a token parked in the env file while an
    // API key lingers in the shell. Per-source validation would miss this.
    const envFile = path.join(vault, 'env')
    fs.writeFileSync(envFile, 'CLAUDE_CODE_OAUTH_TOKEN=from-file\n')

    expect(() => loadConfig({ envFile, env: { VAULT_ROOT: vault, ANTHROPIC_API_KEY: 'from-env' } }))
      .toThrow(ConfigError)
  })

  it('refuses when NO credential is set', () => {
    expect(() => loadConfig({ envFile: false, env: { VAULT_ROOT: vault } })).toThrow(
      /no anthropic credential/i,
    )
  })

  it('treats an empty credential value as unset, not as configured', () => {
    // The scaffolded env file ships `CLAUDE_CODE_OAUTH_TOKEN=` with no value.
    expect(() =>
      loadConfig({
        envFile: false,
        env: { VAULT_ROOT: vault, CLAUDE_CODE_OAUTH_TOKEN: '   ', ANTHROPIC_API_KEY: 'key' },
      }),
    ).not.toThrow()
  })

  it('accepts the OAuth token alone and reports mode "oauth"', () => {
    const config = loadConfig({
      envFile: false,
      env: { VAULT_ROOT: vault, CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    })
    expect(config.auth).toMatchObject({ mode: 'oauth', envVar: 'CLAUDE_CODE_OAUTH_TOKEN', credential: 'tok' })
  })

  it('accepts the API key alone and reports mode "api-key"', () => {
    const config = loadConfig({ envFile: false, env: { VAULT_ROOT: vault, ANTHROPIC_API_KEY: 'key' } })
    expect(config.auth).toMatchObject({ mode: 'api-key', envVar: 'ANTHROPIC_API_KEY' })
  })

  it('names both credential vars in the double-credential message', () => {
    // The operator has to know which two to look at; a vague message costs a debug cycle.
    try {
      loadConfig({
        envFile: false,
        env: { VAULT_ROOT: vault, CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key' },
      })
      expect.unreachable('should have refused')
    } catch (err) {
      for (const name of CREDENTIAL_ENV_VARS) expect((err as Error).message).toContain(name)
    }
  })
})

describe('loadConfig — env file handling', () => {
  it('reads the credential from the env file when the environment has none', () => {
    const envFile = path.join(vault, 'env')
    fs.writeFileSync(envFile, '# comment\nCLAUDE_CODE_OAUTH_TOKEN=from-file\n')
    const config = loadConfig({ envFile, env: { VAULT_ROOT: vault } })
    expect(config.auth.credential).toBe('from-file')
  })

  it('lets the process environment win over the file for the same var', () => {
    const envFile = path.join(vault, 'env')
    fs.writeFileSync(envFile, 'CLAUDE_CODE_OAUTH_TOKEN=from-file\n')
    const config = loadConfig({ envFile, env: { VAULT_ROOT: vault, CLAUDE_CODE_OAUTH_TOKEN: 'from-env' } })
    expect(config.auth.credential).toBe('from-env')
  })

  it('ignores a missing env file rather than failing', () => {
    const config = loadConfig({
      envFile: path.join(vault, 'does-not-exist'),
      env: { VAULT_ROOT: vault, CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    })
    expect(config.auth.credential).toBe('tok')
  })
})

describe('loadConfig — server config', () => {
  const base = (extra: Record<string, string>) => ({
    envFile: false as const,
    env: { VAULT_ROOT: vault, CLAUDE_CODE_OAUTH_TOKEN: 'tok', ...extra },
  })

  it('defaults host/port/watchFolder and leaves watchPolling unset (auto)', () => {
    const { server } = loadConfig(base({}))
    expect(server.host).toBe('127.0.0.1')
    expect(server.port).toBe(8420)
    expect(server.watchFolder).toBe('/mnt/c/inbox')
    expect(server.authMode).toBe('local-single-user')
    expect(server.watchPolling).toBeUndefined()
  })

  it('parses WATCH_POLLING true/false', () => {
    expect(loadConfig(base({ WATCH_POLLING: 'true' })).server.watchPolling).toBe(true)
    expect(loadConfig(base({ WATCH_POLLING: 'false' })).server.watchPolling).toBe(false)
  })

  it('honours HOST/PORT/WATCH_FOLDER overrides', () => {
    const { server } = loadConfig(base({ HOST: '0.0.0.0', PORT: '9000', WATCH_FOLDER: '/mnt/m/drop' }))
    expect(server.host).toBe('0.0.0.0')
    expect(server.port).toBe(9000)
    expect(server.watchFolder).toBe('/mnt/m/drop')
  })
})

describe('loadConfig — VAULT_ROOT validation', () => {
  it('requires VAULT_ROOT', () => {
    expect(() => loadConfig({ envFile: false, env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } })).toThrow(
      /VAULT_ROOT/,
    )
  })

  it('rejects a non-existent path', () => {
    expect(() =>
      loadConfig({ envFile: false, env: { VAULT_ROOT: '/nope/nowhere', CLAUDE_CODE_OAUTH_TOKEN: 'tok' } }),
    ).toThrow(/does not exist/)
  })

  it('rejects a directory that is not a claude-obsidian vault', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'))
    created.push(plain)
    expect(() =>
      loadConfig({ envFile: false, env: { VAULT_ROOT: plain, CLAUDE_CODE_OAUTH_TOKEN: 'tok' } }),
    ).toThrow(/does not look like a claude-obsidian vault/)
  })

  it('resolves VAULT_ROOT to an absolute path', () => {
    const config = loadConfig({
      envFile: false,
      env: { VAULT_ROOT: `${vault}/./`, CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    })
    expect(config.vaultRoot).toBe(fs.realpathSync(vault) === vault ? vault : config.vaultRoot)
    expect(path.isAbsolute(config.vaultRoot)).toBe(true)
  })
})

describe('describeConfig', () => {
  it('never exposes the credential value', () => {
    const config = loadConfig({
      envFile: false,
      env: { VAULT_ROOT: vault, CLAUDE_CODE_OAUTH_TOKEN: 'super-secret-token' },
    })
    const described = describeConfig(config)
    expect(JSON.stringify(described)).not.toContain('super-secret-token')
    expect(described['credential']).toBe('<redacted, 18 chars>')
    expect(described['authMode']).toBe('oauth')
  })
})
