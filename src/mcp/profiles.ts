import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ArasCredentials } from '../aras'

/** A saved connection profile — non-secret fields only. Passwords come from env. */
export interface ProfileConfig {
  url: string
  database: string
  username: string
}

interface ProfilesFile {
  profiles?: Record<string, ProfileConfig>
}

/** Inputs accepted by `aras_connect`: a saved profile name and/or inline overrides. */
export interface ConnectInput {
  profile?: string
  url?: string
  database?: string
  username?: string
  password?: string
}

/** Path to the profiles config. Override with `ARAS_MCP_CONFIG`. */
export function profilesPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARAS_MCP_CONFIG ?? join(homedir(), '.aras-mcp', 'profiles.json')
}

/** Load saved profiles. Missing or corrupt file → empty map (env-only still works). */
export function loadProfiles(
  path: string = profilesPath(),
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
  exists: (p: string) => boolean = existsSync
): Record<string, ProfileConfig> {
  if (!exists(path)) return {}
  try {
    const parsed = JSON.parse(read(path)) as ProfilesFile
    return parsed.profiles ?? {}
  } catch {
    return {}
  }
}

/** Env var that holds a profile's password, e.g. profile "dev-1" -> ARAS_PASSWORD_DEV_1. */
export function passwordEnvKey(profile: string): string {
  return `ARAS_PASSWORD_${profile.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * Resolve full {@link ArasCredentials} from connect input + saved profiles + env.
 *
 * Precedence, by field:
 *  - profile named: url/database/username come from the saved profile; inline
 *    overrides win where provided.
 *  - no profile, no inline: fall back to the default env profile
 *    (ARAS_URL / ARAS_DATABASE / ARAS_USERNAME).
 *  - password: inline `password` > `ARAS_PASSWORD_<PROFILE>` > `ARAS_PASSWORD`.
 *
 * Throws a readable error listing exactly what's missing.
 */
export function resolveCredentials(
  input: ConnectInput,
  profiles: Record<string, ProfileConfig>,
  env: NodeJS.ProcessEnv = process.env
): ArasCredentials & { name?: string } {
  const name = input.profile
  const saved = name ? profiles[name] : undefined
  if (name && !saved) {
    const known = Object.keys(profiles)
    throw new Error(
      `Unknown profile "${name}".` +
        (known.length ? ` Known profiles: ${known.join(', ')}.` : ' No profiles are configured.')
    )
  }

  const instanceUrl = input.url ?? saved?.url ?? env.ARAS_URL
  const database = input.database ?? saved?.database ?? env.ARAS_DATABASE
  const username = input.username ?? saved?.username ?? env.ARAS_USERNAME
  const password =
    input.password ??
    (name ? env[passwordEnvKey(name)] : undefined) ??
    env.ARAS_PASSWORD

  const missing: string[] = []
  if (!instanceUrl) missing.push('url')
  if (!database) missing.push('database')
  if (!username) missing.push('username')
  if (!password) missing.push('password')
  if (missing.length) {
    throw new Error(
      `Cannot connect — missing: ${missing.join(', ')}. ` +
        'Provide them inline to aras_connect, in a profile, or via ARAS_URL/ARAS_DATABASE/ARAS_USERNAME and ' +
        (name ? `${passwordEnvKey(name)} (or ARAS_PASSWORD).` : 'ARAS_PASSWORD.')
    )
  }

  return { instanceUrl: instanceUrl!, database: database!, username: username!, password: password!, name }
}
