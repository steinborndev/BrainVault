/**
 * Service configuration: vault location + Anthropic credentials.
 *
 * Two invariants from CLAUDE.md are enforced here rather than at call sites,
 * so there is exactly one place that can get them wrong:
 *
 *  - Hard rule 1/"vault root is a config value": VAULT_ROOT is resolved and
 *    validated once, then passed explicitly. Nothing else may hardcode a path.
 *  - Hard rule 3: exactly one credential may be set. Both set => refuse to
 *    start, because ANTHROPIC_API_KEY silently overrides the OAuth token
 *    (SPEC.md §7.1) and the operator would not notice which one was billed.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'

/** Env vars that carry a credential. Order matters only for messages. */
export const CREDENTIAL_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const
export type CredentialEnvVar = (typeof CREDENTIAL_ENV_VARS)[number]

/** Default location of the service credential file (chmod 600, outside the repo). */
export const DEFAULT_ENV_FILE = path.join(os.homedir(), '.config', 'vault-service', 'env')

export type AuthMode = 'oauth' | 'api-key'

/**
 * HTTP auth mode for the dashboard/API (distinct from the Anthropic credential above).
 * v1 ships only `local-single-user` (pass-through). `token` is the seam the localhost
 * guard (SPEC.md §9) requires before a non-localhost bind is permitted.
 */
export type HttpAuthMode = 'local-single-user' | 'token'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8420
export const DEFAULT_WATCH_FOLDER = '/mnt/c/inbox'
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024

export interface ServerConfig {
  readonly host: string
  readonly port: number
  readonly watchFolder: string
  readonly maxUploadBytes: number
  readonly authMode: HttpAuthMode
  /** Present only in `token` mode. Never logged. */
  readonly authToken?: string
}

export interface Config {
  readonly vaultRoot: string
  readonly auth: {
    readonly mode: AuthMode
    /** The credential value. Never log this — use describeConfig(). */
    readonly credential: string
    readonly envVar: CredentialEnvVar
  }
  readonly server: ServerConfig
}

/** True for a loopback bind — the only bind allowed without an HTTP auth token (hard rule 2). */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * Enforces hard rule 2 / SPEC.md §9: a non-loopback bind is refused unless an HTTP auth
 * mode with a token is active. Called at server startup, never silently weakened.
 */
export function assertBindAllowed(server: ServerConfig): void {
  if (isLoopbackHost(server.host)) return
  if (server.authMode === 'token' && (server.authToken?.length ?? 0) > 0) return
  throw new ConfigError(
    `refusing to bind ${server.host}:${server.port}: a non-localhost bind requires an HTTP auth ` +
      `mode with a token (SPEC.md §9). Set HTTP_AUTH_MODE=token and HTTP_AUTH_TOKEN=<secret>, ` +
      `or bind ${DEFAULT_HOST} (the default).`,
  )
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/**
 * Parses a dotenv-style file. Intentionally minimal: KEY=VALUE lines, `#`
 * comments, optional surrounding quotes. No interpolation, no `export`, because
 * the file is written by our own setup and a full dotenv parser is a dependency
 * we would only use to be surprised by.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (key !== '') out[key] = value
  }
  return out
}

/** Reads the env file if present. A missing file is not an error — the vars may come from systemd. */
export function readEnvFile(filePath: string): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ConfigError(`cannot read env file ${filePath}: ${(err as Error).message}`)
  }
}

/**
 * An empty or whitespace-only value means "not set". The scaffolded env file
 * ships `CLAUDE_CODE_OAUTH_TOKEN=` with no value; treating that as a present
 * credential would trip the double-credential guard for no reason.
 */
function presence(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

const schema = z.object({
  VAULT_ROOT: z
    .string({ error: 'VAULT_ROOT is required (path to the claude-obsidian vault)' })
    .min(1, 'VAULT_ROOT must not be empty'),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  HOST: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().max(65535).optional(),
  WATCH_FOLDER: z.string().min(1).optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().optional(),
  HTTP_AUTH_MODE: z.enum(['local-single-user', 'token']).optional(),
  HTTP_AUTH_TOKEN: z.string().min(1).optional(),
})

/** Verifies the path is a real claude-obsidian vault, not just any directory. */
function validateVaultRoot(candidate: string): string {
  const resolved = path.resolve(candidate)

  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new ConfigError(`VAULT_ROOT does not exist: ${resolved}`)
  }
  if (!stat.isDirectory()) throw new ConfigError(`VAULT_ROOT is not a directory: ${resolved}`)

  // Cheap structural check. Catches the common misconfiguration (pointing at a
  // parent dir, or at the service repo) long before an agent run writes anywhere.
  const markers = ['wiki', 'skills']
  const missing = markers.filter((m) => !fs.existsSync(path.join(resolved, m)))
  if (missing.length > 0) {
    throw new ConfigError(
      `VAULT_ROOT does not look like a claude-obsidian vault (missing: ${missing.join(', ')}): ${resolved}`,
    )
  }
  return resolved
}

export interface LoadConfigOptions {
  /** Process environment. Injected for tests. */
  readonly env?: NodeJS.ProcessEnv
  /** Credential file path; set false to skip file loading entirely. */
  readonly envFile?: string | false
}

/**
 * Builds the config from the env file plus the process environment.
 *
 * Precedence: the real environment wins over the file, so an operator can
 * override for one run. The double-credential check runs on the MERGED view —
 * a token in the file plus a key in the environment is exactly the dangerous
 * case the rule exists for, and per-source checking would miss it.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const processEnv = options.env ?? process.env
  const fileEnv = options.envFile === false ? {} : readEnvFile(options.envFile ?? DEFAULT_ENV_FILE)

  const merged: Record<string, string | undefined> = { ...fileEnv }
  for (const key of Object.keys(processEnv)) {
    const value = processEnv[key]
    if (value !== undefined) merged[key] = value
  }

  const parsed = schema.safeParse({
    VAULT_ROOT: presence(merged['VAULT_ROOT']),
    CLAUDE_CODE_OAUTH_TOKEN: presence(merged['CLAUDE_CODE_OAUTH_TOKEN']),
    ANTHROPIC_API_KEY: presence(merged['ANTHROPIC_API_KEY']),
    HOST: presence(merged['HOST']),
    PORT: presence(merged['PORT']),
    WATCH_FOLDER: presence(merged['WATCH_FOLDER']),
    MAX_UPLOAD_BYTES: presence(merged['MAX_UPLOAD_BYTES']),
    HTTP_AUTH_MODE: presence(merged['HTTP_AUTH_MODE']),
    HTTP_AUTH_TOKEN: presence(merged['HTTP_AUTH_TOKEN']),
  })

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new ConfigError(`invalid configuration:\n  - ${issues.join('\n  - ')}`)
  }

  const present = CREDENTIAL_ENV_VARS.filter((name) => parsed.data[name] !== undefined)

  if (present.length > 1) {
    throw new ConfigError(
      `both ${CREDENTIAL_ENV_VARS.join(' and ')} are set. Exactly one credential may be configured: ` +
        `ANTHROPIC_API_KEY silently overrides the OAuth token, so leaving both set means billing ` +
        `and usage limits do not match what you configured (SPEC.md §7.1). ` +
        `Unset one of them — e.g. clear it in ${typeof options.envFile === 'string' ? options.envFile : DEFAULT_ENV_FILE}.`,
    )
  }

  if (present.length === 0) {
    throw new ConfigError(
      `no Anthropic credential configured. Set exactly one of ${CREDENTIAL_ENV_VARS.join(' or ')} ` +
        `(subscription path: run \`claude setup-token\` and store the token in ${DEFAULT_ENV_FILE}).`,
    )
  }

  const envVar = present[0] as CredentialEnvVar
  const credential = parsed.data[envVar] as string

  const authMode: HttpAuthMode = parsed.data.HTTP_AUTH_MODE ?? 'local-single-user'
  const server: ServerConfig = {
    host: parsed.data.HOST ?? DEFAULT_HOST,
    port: parsed.data.PORT ?? DEFAULT_PORT,
    watchFolder: parsed.data.WATCH_FOLDER ?? DEFAULT_WATCH_FOLDER,
    maxUploadBytes: parsed.data.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES,
    authMode,
    ...(authMode === 'token' && parsed.data.HTTP_AUTH_TOKEN
      ? { authToken: parsed.data.HTTP_AUTH_TOKEN }
      : {}),
  }

  return {
    vaultRoot: validateVaultRoot(parsed.data.VAULT_ROOT),
    auth: { mode: envVar === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'oauth' : 'api-key', credential, envVar },
    server,
  }
}

/**
 * Log-safe view of the config. Everything that reports configuration to a
 * human, a log line, or the API must go through this — the credential is
 * reduced to its length so a truncated/whitespace-damaged token is still
 * diagnosable without the value ever being written down.
 */
export function describeConfig(config: Config): Record<string, string> {
  return {
    vaultRoot: config.vaultRoot,
    authMode: config.auth.mode,
    credentialSource: config.auth.envVar,
    credential: `<redacted, ${config.auth.credential.length} chars>`,
    bind: `${config.server.host}:${config.server.port}`,
    watchFolder: config.server.watchFolder,
    httpAuth: config.server.authMode,
  }
}
