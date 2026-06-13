import keytar from 'keytar'
import type { SecretStore } from '@core/config'

/**
 * SecretStore backed by the OS keychain (Windows Credential Manager, macOS
 * Keychain, Linux libsecret). All keys live under a single service name so
 * they group together in the keychain UI.
 */
export class KeytarSecretStore implements SecretStore {
  constructor(private readonly service = 'aras-harness') {}

  async get(key: string): Promise<string | null> {
    return keytar.getPassword(this.service, key)
  }

  async set(key: string, value: string): Promise<void> {
    await keytar.setPassword(this.service, key, value)
  }

  async delete(key: string): Promise<void> {
    await keytar.deletePassword(this.service, key)
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null
  }
}
