import type {
  AgentSettings,
  AgentSettingsInput,
  Connection,
  ConnectionInput,
  LlmSettings,
  LlmSettingsInput
} from '@shared/ipc'
import type { ArasCredentials } from '../aras'
import {
  agentConfigSchema,
  connectionRecordSchema,
  llmConfigSchema,
  secretKeys,
  type ConfigStore,
  type ConnectionRecord,
  type SecretStore
} from './settings'

/**
 * Orchestrates non-secret config (via {@link ConfigStore}) and secrets (via
 * {@link SecretStore}) to provide connection + LLM management. Returns only
 * secret-free DTOs to the rest of the app; raw secrets stay inside this service.
 *
 * Methods that touch secrets are async because the CLI's keychain adapter is
 * async (keytar); the Electron adapter is sync underneath but adapts to the
 * same shape so SettingsService is portable.
 */
export class SettingsService {
  constructor(
    private readonly config: ConfigStore,
    private readonly secrets: SecretStore,
    private readonly genId: () => string = () => globalThis.crypto.randomUUID()
  ) {}

  // -- Connections ----------------------------------------------------------

  async listConnections(): Promise<Connection[]> {
    const records = this.config.load().connections
    return Promise.all(records.map((record) => this.toConnectionDto(record)))
  }

  async saveConnection(input: ConnectionInput): Promise<Connection> {
    const cfg = this.config.load()
    const id = input.id ?? this.genId()
    const record: ConnectionRecord = connectionRecordSchema.parse({
      id,
      name: input.name,
      instanceUrl: input.instanceUrl,
      database: input.database,
      username: input.username
    })

    const existingIndex = cfg.connections.findIndex((c) => c.id === id)
    if (existingIndex >= 0) {
      cfg.connections[existingIndex] = record
    } else {
      cfg.connections.push(record)
    }
    if (cfg.activeConnectionId === null) {
      cfg.activeConnectionId = id
    }
    this.config.save(cfg)

    if (input.password !== undefined && input.password !== '') {
      await this.secrets.set(secretKeys.connectionPassword(id), input.password)
    }
    return this.toConnectionDto(record)
  }

  async deleteConnection(id: string): Promise<void> {
    const cfg = this.config.load()
    cfg.connections = cfg.connections.filter((c) => c.id !== id)
    if (cfg.activeConnectionId === id) {
      cfg.activeConnectionId = cfg.connections[0]?.id ?? null
    }
    this.config.save(cfg)
    await this.secrets.delete(secretKeys.connectionPassword(id))
  }

  setActiveConnection(id: string): void {
    const cfg = this.config.load()
    if (!cfg.connections.some((c) => c.id === id)) {
      throw new Error(`Unknown connection id: ${id}`)
    }
    cfg.activeConnectionId = id
    this.config.save(cfg)
  }

  getActiveConnectionId(): string | null {
    return this.config.load().activeConnectionId
  }

  /** Full credentials (incl. password) for a connection, or null if missing. */
  async getConnectionCredentials(id: string): Promise<ArasCredentials | null> {
    const record = this.config.load().connections.find((c) => c.id === id)
    if (!record) return null
    const password = await this.secrets.get(secretKeys.connectionPassword(id))
    if (password === null) return null
    return {
      instanceUrl: record.instanceUrl,
      database: record.database,
      username: record.username,
      password
    }
  }

  // -- LLM settings ---------------------------------------------------------

  async getLlmSettings(): Promise<LlmSettings | null> {
    const llm = this.config.load().llm
    if (!llm) return null
    return {
      provider: llm.provider,
      model: llm.model,
      ...(llm.baseUrl !== undefined ? { baseUrl: llm.baseUrl } : {}),
      hasApiKey: await this.secrets.has(secretKeys.llmApiKey(llm.provider))
    }
  }

  async saveLlmSettings(input: LlmSettingsInput): Promise<LlmSettings> {
    const cfg = this.config.load()
    cfg.llm = llmConfigSchema.parse({
      provider: input.provider,
      model: input.model,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {})
    })
    this.config.save(cfg)

    if (input.apiKey !== undefined && input.apiKey !== '') {
      await this.secrets.set(secretKeys.llmApiKey(input.provider), input.apiKey)
    }
    return (await this.getLlmSettings())!
  }

  async getLlmApiKey(provider: string): Promise<string | null> {
    return this.secrets.get(secretKeys.llmApiKey(provider))
  }

  // -- Agent settings -------------------------------------------------------

  getAgentSettings(): AgentSettings {
    const a = this.config.load().agent
    return {
      toolTimeoutSec: a.toolTimeoutSec,
      ...(a.maxRetryAttempts !== undefined ? { maxRetryAttempts: a.maxRetryAttempts } : {})
    }
  }

  saveAgentSettings(input: AgentSettingsInput): AgentSettings {
    const cfg = this.config.load()
    cfg.agent = agentConfigSchema.parse({
      toolTimeoutSec: input.toolTimeoutSec,
      ...(input.maxRetryAttempts !== undefined ? { maxRetryAttempts: input.maxRetryAttempts } : {})
    })
    this.config.save(cfg)
    return this.getAgentSettings()
  }

  // -- helpers --------------------------------------------------------------

  private async toConnectionDto(record: ConnectionRecord): Promise<Connection> {
    return {
      id: record.id,
      name: record.name,
      instanceUrl: record.instanceUrl,
      database: record.database,
      username: record.username,
      hasPassword: await this.secrets.has(secretKeys.connectionPassword(record.id))
    }
  }
}
