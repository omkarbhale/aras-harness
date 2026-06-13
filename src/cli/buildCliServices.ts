import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsService } from '@core/config'
import { openDb } from '@core/persistence/sqlite/openDb'
import { SqliteCheckpointer } from '@core/persistence/sqlite/SqliteCheckpointer'
import { SqliteEventLog } from '@core/persistence/sqlite/SqliteEventLog'
import { SqliteThreadStore } from '@core/persistence/sqlite/SqliteThreadStore'
import { SqliteRunStore } from '@core/persistence/sqlite/SqliteRunStore'
import { AppServices } from '@core/services'
import { FileConfigStore } from './store/FileConfigStore'
import { KeytarSecretStore } from './store/KeytarSecretStore'
import { cliPaths } from './paths'

/**
 * CLI wiring: file-based config, OS keychain for secrets, sqlite for agent state.
 * Mirrors {@link buildElectronServices} shape so AppServices, registerIpc-style code,
 * and any future shared infrastructure don't care which front-end built the deps.
 */
export function buildCliServices(): AppServices {
  const { config: configDir, data: dataDir } = cliPaths()
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'state.sqlite')
  const db = openDb(dbPath)

  return new AppServices({
    settings: new SettingsService(new FileConfigStore(configDir), new KeytarSecretStore()),
    checkpointer: new SqliteCheckpointer(db),
    threadStore: new SqliteThreadStore(db),
    runStore: new SqliteRunStore(db),
    eventLog: new SqliteEventLog(db)
  })
}
