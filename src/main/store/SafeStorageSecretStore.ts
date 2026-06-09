import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { SecretStore } from '@core/config'

/**
 * Secrets (connection passwords, LLM API keys) encrypted at rest with the OS keychain
 * via Electron `safeStorage` (DPAPI on Windows). Ciphertext is stored base64-encoded in
 * <userData>/secrets.json; plaintext never touches disk and never leaves the main process.
 */
export class SafeStorageSecretStore implements SecretStore {
  private readonly store = new Store<Record<string, string>>({ name: 'secrets' })

  private ensureAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secret encryption is unavailable; cannot store secrets securely.')
    }
  }

  get(key: string): string | null {
    const encoded = this.store.get(key)
    if (!encoded) return null
    this.ensureAvailable()
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  }

  set(key: string, value: string): void {
    this.ensureAvailable()
    const cipher = safeStorage.encryptString(value).toString('base64')
    this.store.set(key, cipher)
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  has(key: string): boolean {
    return this.store.has(key)
  }
}
