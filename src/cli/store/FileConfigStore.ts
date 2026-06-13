import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  defaultAppConfig,
  parseAppConfig,
  type AppConfig,
  type ConfigStore
} from '@core/config'

/**
 * JSON config file at <configDir>/config.json. Atomic writes (tmp + rename) so a
 * crash mid-save can't corrupt the file. Missing file falls back to defaults.
 */
export class FileConfigStore implements ConfigStore {
  private readonly path: string

  constructor(configDir: string) {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    this.path = join(configDir, 'config.json')
  }

  load(): AppConfig {
    if (!existsSync(this.path)) return defaultAppConfig
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      return parseAppConfig(raw)
    } catch {
      // Corrupted file — return defaults; user can re-save to overwrite.
      return defaultAppConfig
    }
  }

  save(config: AppConfig): void {
    const tmp = `${this.path}.tmp`
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }
}
