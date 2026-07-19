/**
 * Settings API (SPEC.md §6.4 "Einstellungen", §6.5 `GET/PUT /api/v1/settings`).
 *
 * Precedence is defined once in `db/settings.ts`: env/env-file is the start-time baseline,
 * this table holds runtime overrides, effective = override ?? baseline. The response carries
 * all three so the UI can show "overridden" vs "from environment" without guessing.
 *
 * Two hard rules shape this route and must not be relaxed:
 *  - Hard rule 2 / SPEC.md §9: bind host/port are NOT settable — a settings write can never move
 *    the service off localhost. They are reported read-only.
 *  - Hard rule 3: credentials are never stored in SQLite and never returned. Only the KEY STATUS
 *    (auth mode + which env var supplied it) is exposed, via describeConfig's redacted view.
 * The zod schema is `.strict()`, so a PUT naming a non-settable key is a 400, not a silent no-op.
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import {
  SETTINGS_SCHEMA,
  RESTART_REQUIRED_KEYS,
  baselineSettings,
  effectiveSettings,
  type SettingsPatch,
} from '../../db/settings.js'

export function registerSettingsRoute(app: FastifyInstance, ctx: AppContext): void {
  const { settings, config, queue } = ctx
  if (!settings) return

  /** Key status only — never the credential itself (hard rule 3). */
  const readOnlyView = (): Record<string, string> => ({
    vaultRoot: config.vaultRoot,
    bind: `${config.server.host}:${config.server.port}`,
    httpAuthMode: config.server.authMode,
    // "API-Key-Status (Key selbst wird nie angezeigt)" — SPEC.md §6.4. In setup mode
    // (no credential yet) the UI uses this to show the onboarding form.
    authMode: config.auth?.mode ?? 'none',
    credentialSource: config.auth?.envVar ?? 'none',
    credentialConfigured: config.auth !== null ? 'yes' : 'no',
  })

  const snapshot = (): object => {
    const overrides = settings.overrides()
    return {
      effective: effectiveSettings(config, overrides),
      baseline: baselineSettings(config),
      overrides,
      readOnly: readOnlyView(),
      /** Keys that only take effect after a service restart (bound at startup). */
      restartRequiredKeys: RESTART_REQUIRED_KEYS,
    }
  }

  app.get('/api/v1/settings', async (_req, reply) => reply.send(snapshot()))

  app.put('/api/v1/settings', async (req, reply) => {
    const parsed = SETTINGS_SCHEMA.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid settings',
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      })
    }

    const patch: SettingsPatch = parsed.data
    const before = effectiveSettings(config, settings.overrides())
    settings.set(patch)
    const after = effectiveSettings(config, settings.overrides())

    // Apply live where it is safe to do so; the rest is flagged for a restart.
    if (after.concurrency !== before.concurrency) queue.setConcurrency(after.concurrency)
    // gitAutoCommit needs no action: the queue reads it through a provider on every commit.

    const touched = Object.keys(patch)
    const pendingRestart = RESTART_REQUIRED_KEYS.filter(
      (key) => touched.includes(key) && after[key] !== before[key],
    )
    return reply.send({ ...snapshot(), pendingRestart })
  })
}
