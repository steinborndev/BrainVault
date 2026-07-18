/**
 * Runtime settings (SPEC.md §6.4 "Einstellungen", §6.5 `GET/PUT /api/v1/settings`) stored in
 * the key/value `settings` table.
 *
 * PRECEDENCE — one model, decided and enforced here so no call site has to guess:
 *
 *   env / env-file (config.ts)  =  START-TIME BASELINE
 *   settings table              =  RUNTIME OVERRIDES, for an explicit allowlist of keys
 *   effective value             =  override ?? baseline
 *
 * An override outlives a restart (it is in SQLite); clearing one (write `null`) falls back to
 * the baseline. Losing the DB therefore only loses overrides, never the vault (hard rule 1).
 *
 * What is deliberately NOT settable at runtime, and why:
 *  - bind host/port — hard rule 2 / SPEC.md §9: a settings write must never be able to move the
 *    service off localhost. The bind stays a start-time decision guarded by assertBindAllowed().
 *  - the Anthropic credential and HTTP auth token — hard rule 3: credentials live only in the
 *    service environment, are never stored in SQLite, and are never returned by the API.
 * The schema below is `.strict()`, so a PUT naming any of those is a 400 rather than a silent no-op.
 *
 * This table holds service configuration rather than per-user data, so unlike the other tables
 * it carries no `user_id`.
 */

import { z } from 'zod'
import type { Db } from './index.js'
import type { Config } from '../config.js'

/** Queue worker default when nothing overrides it (SPEC.md §3.1 "Parallelität", default 2). */
export const DEFAULT_CONCURRENCY = 2
/** Whether the service commits after each ingest by default (SPEC.md §7 "Git-Auto-Commit"). */
export const DEFAULT_GIT_AUTO_COMMIT = true

/**
 * The settable keys. `null` clears an override (falls back to the baseline). `.strict()` makes
 * an unknown key — notably `host`, `port`, or any credential — a validation error.
 */
export const SETTINGS_SCHEMA = z
  .object({
    /** Folder watched for drops. Bound at startup by the watcher → restart required. */
    watchFolder: z.string().min(1).nullable(),
    /** Concurrent ingest workers. Applied live to the running queue. */
    concurrency: z.number().int().min(1).max(8).nullable(),
    /** Upload size limit. Registered with the multipart plugin at startup → restart required. */
    maxUploadBytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024)
      .nullable(),
    /** Whether an ingest auto-commits to the vault. Applied live. */
    gitAutoCommit: z.boolean().nullable(),
  })
  .partial()
  .strict()

export type SettingsPatch = z.infer<typeof SETTINGS_SCHEMA>
/** Stored overrides — same keys, but never null (a null write deletes the row instead). */
export type SettingsOverrides = { -readonly [K in keyof SettingsPatch]?: NonNullable<SettingsPatch[K]> }

/** Keys whose change only takes effect after a service restart (bound at startup). */
export const RESTART_REQUIRED_KEYS = ['watchFolder', 'maxUploadBytes'] as const
export type RestartRequiredKey = (typeof RESTART_REQUIRED_KEYS)[number]

/** The fully-resolved configuration the service actually runs with. */
export interface EffectiveSettings {
  readonly watchFolder: string
  readonly concurrency: number
  readonly maxUploadBytes: number
  readonly gitAutoCommit: boolean
}

/** Baseline (start-time) values, before any override is applied. */
export function baselineSettings(config: Config): EffectiveSettings {
  return {
    watchFolder: config.server.watchFolder,
    concurrency: DEFAULT_CONCURRENCY,
    maxUploadBytes: config.server.maxUploadBytes,
    gitAutoCommit: DEFAULT_GIT_AUTO_COMMIT,
  }
}

/** Applies overrides on top of the baseline — the single definition of "effective". */
export function effectiveSettings(config: Config, overrides: SettingsOverrides): EffectiveSettings {
  const base = baselineSettings(config)
  return {
    watchFolder: overrides.watchFolder ?? base.watchFolder,
    concurrency: overrides.concurrency ?? base.concurrency,
    maxUploadBytes: overrides.maxUploadBytes ?? base.maxUploadBytes,
    gitAutoCommit: overrides.gitAutoCommit ?? base.gitAutoCommit,
  }
}

export class SettingsStore {
  constructor(private readonly db: Db) {}

  /**
   * All stored overrides. Values that no longer validate (e.g. written by an older build, or
   * hand-edited in the DB) are ignored rather than thrown: a bad row must not stop the service
   * from starting — it simply falls back to the baseline.
   */
  overrides(): SettingsOverrides {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string
      value: string | null
    }>
    const raw: Record<string, unknown> = {}
    for (const row of rows) {
      if (row.value === null) continue
      try {
        raw[row.key] = JSON.parse(row.value)
      } catch {
        // Unparseable row — ignore it, the baseline applies.
      }
    }
    const parsed = SETTINGS_SCHEMA.safeParse(raw)
    if (parsed.success) return stripNulls(parsed.data)
    // Salvage the keys that do validate individually so one bad row can't blank the rest.
    const salvaged: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      const one = SETTINGS_SCHEMA.safeParse({ [key]: value })
      if (one.success) Object.assign(salvaged, stripNulls(one.data))
    }
    return salvaged as SettingsOverrides
  }

  /**
   * Applies a validated patch: a value writes/updates an override, `null` deletes it (falling
   * back to the baseline). Returns the resulting override set.
   */
  set(patch: SettingsPatch): SettingsOverrides {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    const remove = this.db.prepare('DELETE FROM settings WHERE key = ?')
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) remove.run(key)
        else if (value !== undefined) upsert.run(key, JSON.stringify(value))
      }
    })()
    return this.overrides()
  }

  /** The effective configuration (baseline + overrides). */
  effective(config: Config): EffectiveSettings {
    return effectiveSettings(config, this.overrides())
  }
}

/** Drops explicit nulls so the override map only carries real values. */
function stripNulls(data: SettingsPatch): SettingsOverrides {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) out[key] = value
  }
  return out as SettingsOverrides
}
