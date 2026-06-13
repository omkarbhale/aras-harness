import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { SecretStore } from '@core/config'

/**
 * Secrets (connection passwords, LLM API keys) encrypted at rest with the OS keychain
 * via Electron `safeStorage` (DPAPI on Windows). Ciphertext is stored base64-encoded in
 * <userData>/secrets.json; plaintext never touches disk and never leaves the main process.
 *
 * The underlying calls are synchronous, but the interface is async to match the CLI's
 * keytar-backed implementation — keeps SettingsService free of branching.
 */
export class SafeStorageSecretStore implements SecretStore {
  private readonly store = new Store<Record<string, string>>({ name: 'secrets' })

  private ensureAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secret encryption is unavailable; cannot store secrets securely.')
    }
  }

  async get(key: string): Promise<string | null> {
    const encoded = this.store.get(key)
    if (!encoded) return null
    this.ensureAvailable()
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  }

  async set(key: string, value: string): Promise<void> {
    this.ensureAvailable()
    const cipher = safeStorage.encryptString(value).toString('base64')
    this.store.set(key, cipher)
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key)
  }
}
