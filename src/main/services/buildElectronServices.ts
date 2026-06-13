import { join } from 'node:path'
import { app } from 'electron'
import { SettingsService } from '@core/config'
import { openDb } from '@core/persistence/sqlite/openDb'
import { SqliteCheckpointer } from '@core/persistence/sqlite/SqliteCheckpointer'
import { SqliteEventLog } from '@core/persistence/sqlite/SqliteEventLog'
import { SqliteThreadStore } from '@core/persistence/sqlite/SqliteThreadStore'
import { SqliteRunStore } from '@core/persistence/sqlite/SqliteRunStore'
import { ElectronConfigStore } from '../store/ElectronConfigStore'
import { SafeStorageSecretStore } from '../store/SafeStorageSecretStore'
import { AppServices } from './AppServices'

/**
 * Wires the Electron-specific adapters (electron-store, safeStorage, sqlite under
 * userData) into a fully-formed {@link AppServices}. Called once from `main/index.ts`.
 */
export function buildElectronServices(): AppServices {
  const dbPath = join(app.getPath('userData'), 'state.sqlite')
  const db = openDb(dbPath)

  return new AppServices({
    settings: new SettingsService(new ElectronConfigStore(), new SafeStorageSecretStore()),
    checkpointer: new SqliteCheckpointer(db),
    threadStore: new SqliteThreadStore(db),
    runStore: new SqliteRunStore(db),
    eventLog: new SqliteEventLog(db)
  })
}
