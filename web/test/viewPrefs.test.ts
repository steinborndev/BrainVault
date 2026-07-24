import { describe, it, expect, beforeEach } from 'vitest'
import { loadViewPrefs } from '../src/tabs/Vault.tsx'

/**
 * loadViewPrefs must never let a stale, foreign or corrupt localStorage payload half-apply:
 * every field is validated on its own and degrades to undefined (= the caller's default).
 * localStorage is stubbed per test — the node environment has none, which is itself the
 * "storage unavailable" case the loader must survive.
 */

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  }
})

describe('loadViewPrefs', () => {
  it('migrates the legacy standalone System key when no prefs exist', () => {
    store.set('vault.showSystem', '1')
    expect(loadViewPrefs()).toEqual({ showSystem: true })
    store.set('vault.showSystem', '0')
    expect(loadViewPrefs()).toEqual({ showSystem: false })
  })

  it('round-trips a valid payload', () => {
    store.set(
      'vault.graphPrefs',
      JSON.stringify({
        v: 2,
        lens: 'authority',
        selectedTypes: ['concepts'],
        selectedDomains: ['alpha', 'beta'],
        showClusters: true,
        showGaps: false,
        showNetwork: true,
        spotlight: true,
        showSystem: true,
      }),
    )
    expect(loadViewPrefs()).toEqual({
      lens: 'authority',
      selectedTypes: ['concepts'],
      selectedDomains: ['alpha', 'beta'],
      showClusters: true,
      showGaps: false,
      showNetwork: true,
      spotlight: true,
      showSystem: true,
    })
  })

  it('rejects a payload with the wrong version wholesale', () => {
    // A v1 payload's `hiddenTypes` carries the OPPOSITE meaning of v2's `selectedTypes`, so
    // it must be discarded outright rather than half-read.
    store.set('vault.graphPrefs', JSON.stringify({ v: 1, lens: 'type', hiddenTypes: ['sources'] }))
    expect(loadViewPrefs()).toEqual({})
    store.set('vault.graphPrefs', JSON.stringify({ v: 3, lens: 'type' }))
    expect(loadViewPrefs()).toEqual({})
  })

  it('survives corrupt JSON and a missing localStorage', () => {
    store.set('vault.graphPrefs', '{not json')
    expect(loadViewPrefs()).toEqual({})
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(loadViewPrefs()).toEqual({})
  })

  it('drops invalid fields individually, keeping the valid rest', () => {
    store.set(
      'vault.graphPrefs',
      JSON.stringify({
        v: 2,
        lens: 'bogus',
        selectedTypes: [1, 'concepts', null],
        selectedDomains: 'not-an-array',
        showClusters: 'yes',
        spotlight: true,
      }),
    )
    const p = loadViewPrefs()
    expect(p.lens).toBeUndefined()
    expect(p.selectedTypes).toEqual(['concepts'])
    expect(p.selectedDomains).toBeUndefined()
    expect(p.showClusters).toBeUndefined()
    expect(p.spotlight).toBe(true)
  })
})
