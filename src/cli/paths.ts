import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_NAME = 'aras-harness'

/**
 * Per-OS data + config directories. Lightweight hand-rolled replacement for
 * `env-paths` so we avoid its ESM-only constraint while staying CJS-friendly.
 */
export function cliPaths(): { config: string; data: string } {
  const home = homedir()
  switch (process.platform) {
    case 'win32': {
      const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
      const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
      return {
        config: join(appData, APP_NAME, 'Config'),
        data: join(localAppData, APP_NAME, 'Data')
      }
    }
    case 'darwin':
      return {
        config: join(home, 'Library', 'Preferences', APP_NAME),
        data: join(home, 'Library', 'Application Support', APP_NAME)
      }
    default: {
      const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config')
      const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share')
      return {
        config: join(xdgConfig, APP_NAME),
        data: join(xdgData, APP_NAME)
      }
    }
  }
}
