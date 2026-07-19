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

import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import {
  SETTINGS_SCHEMA,
  RESTART_REQUIRED_KEYS,
  baselineSettings,
  effectiveSettings,
  type SettingsPatch,
} from '../../db/settings.js'
import { CREDENTIAL_ENV_VARS, DEFAULT_ENV_FILE, type CredentialEnvVar } from '../../config.js'
import { writeCredentialFile } from '../credential-file.js'

/**
 * The credential submission (first-run onboarding + key replacement, SPEC.md §7.1).
 * Shape-checked hard so a pasted shell line, a quoted token, or the wrong kind of key
 * fails with guidance instead of landing in the env file and failing the next start.
 * The value itself must never be echoed back in any error.
 */
const CREDENTIAL_SCHEMA = z.object({
  kind: z.enum(['oauth', 'api-key']),
  value: z
    .string()
    .trim()
    .min(20, 'the value is too short to be a credential')
    .max(1024, 'the value is too long to be a credential')
    .regex(/^[\x21-\x7e]+$/, 'the value must be a single token without spaces'),
})

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

  /**
   * First-run onboarding / key replacement: writes the credential into the service env file
   * (the sanctioned storage per hard rule 3 — see credential-file.ts) and, under systemd,
   * exits so `Restart=on-failure` brings the service back up configured. The credential is
   * start-time-bound state everywhere (queue, maintenance, SDK subprocess env), so a restart
   * is the honest activation, exactly like watchFolder/maxUploadBytes.
   */
  app.post('/api/v1/settings/credential', async (req, reply) => {
    const parsed = CREDENTIAL_SCHEMA.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid credential submission',
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      })
    }
    const { kind, value } = parsed.data

    // The two kinds have distinct prefixes; catching a swap here beats a failed restart.
    if (kind === 'oauth' && !value.startsWith('sk-ant-oat')) {
      return reply.code(400).send({
        error: value.startsWith('sk-ant-api')
          ? 'this looks like an ANTHROPIC API key — choose "API key" instead of "subscription"'
          : 'a subscription token starts with sk-ant-oat… (from `claude setup-token`)',
      })
    }
    if (kind === 'api-key' && (!value.startsWith('sk-ant-') || value.startsWith('sk-ant-oat'))) {
      return reply.code(400).send({
        error: value.startsWith('sk-ant-oat')
          ? 'this looks like a subscription token — choose "subscription" instead of "API key"'
          : 'an Anthropic API key starts with sk-ant-… (from console.anthropic.com)',
      })
    }

    // A credential in the PROCESS environment (systemd Environment=, the shell) wins over the
    // file at load time — writing the file would either be shadowed or trip the
    // both-credentials-set startup guard. Refuse with the real fix instead.
    const fromProcess = CREDENTIAL_ENV_VARS.filter((name) => (process.env[name] ?? '').trim() !== '')
    if (fromProcess.length > 0) {
      return reply.code(409).send({
        error:
          `${fromProcess.join(' and ')} is set in the service's process environment, which overrides ` +
          `the credential file — change it where it is set (shell profile or systemd unit), not here`,
      })
    }

    // Never yank the credential out from under in-flight agent runs.
    if (queue.stats().inFlight > 0) {
      return reply.code(409).send({
        error: 'agent runs are in flight — wait for the queue to be idle before changing the credential',
      })
    }

    const envVar: CredentialEnvVar = kind === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'
    writeCredentialFile(ctx.credentialFile ?? DEFAULT_ENV_FILE, envVar, value)

    // Under systemd a deliberate non-zero exit is the restart mechanism (Restart=on-failure).
    // Elsewhere (npm start, dev) the process stays up and the UI shows the manual step.
    const underSystemd = (process.env['INVOCATION_ID'] ?? '') !== ''
    const scheduleRestart =
      ctx.scheduleRestart ??
      ((): void => {
        // Give the response time to flush before the process dies.
        setTimeout(() => process.exit(64), 500).unref()
      })
    if (underSystemd) scheduleRestart()

    return reply.send({ ok: true, envVar, restart: underSystemd ? 'auto' : 'manual' })
  })
}
