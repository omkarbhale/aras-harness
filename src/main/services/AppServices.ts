import { SettingsService } from '@core/config'
import { ArasClient } from '@core/aras'
import { createChatModel } from '@core/llm'
import { AgentService, ToolRegistry, createArasTools } from '@core/agent'
import { ElectronConfigStore } from '../store/ElectronConfigStore'
import { SafeStorageSecretStore } from '../store/SafeStorageSecretStore'

/**
 * Composition root for the main process. Owns the singletons, builds the active
 * ArasClient and the AgentService lazily, and rebuilds them when configuration changes.
 */
export class AppServices {
  readonly settings: SettingsService
  private activeClient: { id: string; client: ArasClient } | undefined
  private agent: AgentService | undefined

  constructor() {
    this.settings = new SettingsService(
      new ElectronConfigStore(),
      new SafeStorageSecretStore()
    )
  }

  /** Drop cached client/agent when connections or active connection change. */
  invalidateConnection(): void {
    this.activeClient = undefined
  }

  /** Drop the cached agent when LLM settings change. */
  invalidateAgent(): void {
    this.agent = undefined
  }

  /** ArasClient for the active connection. Throws a readable error if not configured. */
  getActiveClient(): ArasClient {
    const id = this.settings.getActiveConnectionId()
    if (!id) throw new Error('No active Aras connection. Add and select a connection first.')
    if (this.activeClient?.id === id) return this.activeClient.client

    const creds = this.settings.getConnectionCredentials(id)
    if (!creds) throw new Error('The active connection is missing a stored password.')
    const client = new ArasClient(creds)
    this.activeClient = { id, client }
    return client
  }

  /** Build a throwaway client for a connection (used by "Test connection"). */
  buildClientFor(id: string): ArasClient {
    const creds = this.settings.getConnectionCredentials(id)
    if (!creds) throw new Error('This connection has no stored password.')
    return new ArasClient(creds)
  }

  /** Lazily build the agent from the configured LLM provider + Aras tools. */
  getOrCreateAgent(): AgentService {
    if (this.agent) return this.agent

    const llm = this.settings.getLlmSettings()
    if (!llm) throw new Error('No LLM provider configured. Set one in Settings first.')
    const apiKey = this.settings.getLlmApiKey(llm.provider) ?? undefined
    const model = createChatModel(
      { provider: llm.provider, model: llm.model, ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}) },
      apiKey
    )

    const tools = new ToolRegistry()
      .register(createArasTools({ getClient: () => this.getActiveClient() }))
      .list()

    this.agent = new AgentService(model, tools)
    return this.agent
  }

  /** The live agent if one exists (for routing approval decisions). */
  peekAgent(): AgentService | undefined {
    return this.agent
  }
}
