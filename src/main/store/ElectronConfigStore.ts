import Store from 'electron-store'
import { parseAppConfig, type AppConfig, type ConfigStore } from '@core/config'

/** Non-secret app config persisted to <userData>/config.json. */
export class ElectronConfigStore implements ConfigStore {
  private readonly store = new Store({ name: 'config' })

  load(): AppConfig {
    return parseAppConfig(this.store.get('app'))
  }

  save(config: AppConfig): void {
    this.store.set('app', config)
  }
}
