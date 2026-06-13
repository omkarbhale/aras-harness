import { describe, it, expect, beforeEach } from 'vitest'
import { SettingsService } from './SettingsService'
import { defaultAppConfig, type AppConfig, type ConfigStore, type SecretStore } from './settings'

class MemoryConfigStore implements ConfigStore {
  private state: AppConfig = structuredClone(defaultAppConfig)
  load(): AppConfig {
    return structuredClone(this.state)
  }
  save(config: AppConfig): void {
    this.state = structuredClone(config)
  }
}

class MemorySecretStore implements SecretStore {
  private map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async has(key: string): Promise<boolean> {
    return this.map.has(key)
  }
}

let config: MemoryConfigStore
let secrets: MemorySecretStore
let service: SettingsService
let counter: number

beforeEach(() => {
  config = new MemoryConfigStore()
  secrets = new MemorySecretStore()
  counter = 0
  service = new SettingsService(config, secrets, () => `id-${++counter}`)
})

describe('SettingsService connections', () => {
  it('creates a connection, stores the password as a secret, and never returns it', async () => {
    const dto = await service.saveConnection({
      name: 'Dev',
      instanceUrl: 'http://localhost/InnovatorServer',
      database: 'InnovatorSolutions',
      username: 'admin',
      password: 'hunter2'
    })
    expect(dto.id).toBe('id-1')
    expect(dto.hasPassword).toBe(true)
    expect(dto as unknown as Record<string, unknown>).not.toHaveProperty('password')

    const creds = await service.getConnectionCredentials('id-1')
    expect(creds?.password).toBe('hunter2')
  })

  it('marks the first connection active automatically', async () => {
    await service.saveConnection({
      name: 'Dev',
      instanceUrl: 'http://localhost/InnovatorServer',
      database: 'DB',
      username: 'admin',
      password: 'x'
    })
    expect(service.getActiveConnectionId()).toBe('id-1')
  })

  it('updates an existing connection without wiping the password when omitted', async () => {
    await service.saveConnection({
      name: 'Dev',
      instanceUrl: 'http://localhost/InnovatorServer',
      database: 'DB',
      username: 'admin',
      password: 'x'
    })
    await service.saveConnection({
      id: 'id-1',
      name: 'Dev Renamed',
      instanceUrl: 'http://localhost/InnovatorServer',
      database: 'DB',
      username: 'admin'
    })
    const list = await service.listConnections()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('Dev Renamed')
    expect(list[0]!.hasPassword).toBe(true)
    const creds = await service.getConnectionCredentials('id-1')
    expect(creds?.password).toBe('x')
  })

  it('deletes a connection and its secret, reassigning the active id', async () => {
    await service.saveConnection({
      name: 'A',
      instanceUrl: 'http://localhost/InnovatorServer',
      database: 'DB',
      username: 'admin',
      password: 'a'
    })
    await service.saveConnection({
      name: 'B',
      instanceUrl: 'http://localhost/InnovatorServer',
      database: 'DB',
      username: 'admin',
      password: 'b'
    })
    service.setActiveConnection('id-1')
    await service.deleteConnection('id-1')
    expect(await service.listConnections()).toHaveLength(1)
    expect(service.getActiveConnectionId()).toBe('id-2')
    expect(await service.getConnectionCredentials('id-1')).toBeNull()
  })
})

describe('SettingsService LLM settings', () => {
  it('saves provider/model and stores the api key separately', async () => {
    const dto = await service.saveLlmSettings({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      apiKey: 'sk-ant-123'
    })
    expect(dto).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8', hasApiKey: true })
    expect(await service.getLlmApiKey('anthropic')).toBe('sk-ant-123')
  })

  it('returns null settings before anything is configured', async () => {
    expect(await service.getLlmSettings()).toBeNull()
  })

  it('keeps the api key when re-saving without one', async () => {
    await service.saveLlmSettings({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-1' })
    const dto = await service.saveLlmSettings({ provider: 'openai', model: 'gpt-4o-mini' })
    expect(dto.hasApiKey).toBe(true)
    expect(await service.getLlmApiKey('openai')).toBe('sk-1')
  })
})
