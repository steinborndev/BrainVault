import { describe, it, expect } from 'vitest'
import { isLoopbackHost, assertBindAllowed, ConfigError, type ServerConfig } from '../src/config.js'

const base: ServerConfig = {
  host: '127.0.0.1',
  port: 8420,
  watchFolder: '/mnt/c/inbox',
  maxUploadBytes: 200 * 1024 * 1024,
  authMode: 'local-single-user',
}

describe('isLoopbackHost', () => {
  it('recognises loopback addresses', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
  })
})

describe('assertBindAllowed (hard rule 2 / SPEC §9)', () => {
  it('allows a loopback bind in local-single-user mode', () => {
    expect(() => assertBindAllowed(base)).not.toThrow()
  })

  it('refuses a non-loopback bind without a token', () => {
    expect(() => assertBindAllowed({ ...base, host: '0.0.0.0' })).toThrow(ConfigError)
    expect(() => assertBindAllowed({ ...base, host: '192.168.1.10' })).toThrow(/non-localhost bind requires/)
  })

  it('refuses a non-loopback bind in token mode with no token set', () => {
    expect(() => assertBindAllowed({ ...base, host: '0.0.0.0', authMode: 'token' })).toThrow(ConfigError)
  })

  it('allows a non-loopback bind in token mode with a token', () => {
    expect(() =>
      assertBindAllowed({ ...base, host: '0.0.0.0', authMode: 'token', authToken: 'secret' }),
    ).not.toThrow()
  })
})
