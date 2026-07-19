/**
 * Writes the Anthropic credential into the service env file (`~/.config/vault-service/env`)
 * on behalf of the settings UI (first-run onboarding, SPEC.md §7.1).
 *
 * Hard rule 3 context: the env file IS the sanctioned "service environment" — the same file
 * the manual setup asks the user to create. This module only moves who types it. The value
 * must never appear in logs, API responses, SQLite, or error messages; nothing here
 * interpolates it into anything but the file content.
 */

import fs from 'node:fs'
import path from 'node:path'
import { CREDENTIAL_ENV_VARS, parseEnvFile, type CredentialEnvVar } from '../config.js'

/**
 * Rewrites the env file with exactly one credential var, preserving every non-credential
 * entry (HOST, PORT, … may legitimately live there). Comments are not preserved — the file
 * is machine-managed the moment the UI writes it, and a stale comment above a swapped key
 * would mislead more than help. 0600/0700 modes, write-then-rename so a crash mid-write
 * cannot leave a truncated credential file.
 */
export function writeCredentialFile(filePath: string, envVar: CredentialEnvVar, value: string): void {
  let existing: Record<string, string> = {}
  try {
    existing = parseEnvFile(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  for (const name of CREDENTIAL_ENV_VARS) delete existing[name]

  const lines = [
    '# vault-service environment — credential managed via the dashboard (Maintenance → Settings).',
    `${envVar}=${value}`,
    ...Object.entries(existing).map(([k, v]) => `${k}=${v}`),
    '',
  ]

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 })
  fs.renameSync(tmp, filePath)
}
