/**
 * Keeps the vault's `.vault-meta/transport.json` pin fresh (TASKS-M1 F1 / TASKS-M2 §0).
 *
 * Why: on this host `scripts/detect-transport.sh` hangs (it runs `obsidian --version`,
 * which launches the WSLg GUI instead of returning). The script's own freshness check
 * short-circuits — but only if `transport.json` is younger than 7 days. So the service
 * bumps its mtime on every startup, guaranteeing the script never reaches the hang.
 */

import fs from 'node:fs'
import path from 'node:path'

export type TransportPinResult = 'refreshed' | 'absent'

export function transportPinPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.vault-meta', 'transport.json')
}

/** Bumps the pin's mtime so detect-transport.sh stays hang-proof. No-op if absent. */
export function refreshTransportPin(vaultRoot: string): TransportPinResult {
  const p = transportPinPath(vaultRoot)
  if (!fs.existsSync(p)) return 'absent'
  const now = new Date()
  fs.utimesSync(p, now, now)
  return 'refreshed'
}
