import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { SettingsService } from '@core/config'
import { ArasClient } from '@core/aras'
import { createChatModel } from '@core/llm'
import { AgentService, ToolRegistry, createArasTools } from '@core/agent'
import type { AgentEventLog } from '@core/agent/eventLog'
import type { SqliteThreadStore } from '@core/persistence/sqlite/SqliteThreadStore'
import type { SqliteRunStore } from '@core/persistence/sqlite/SqliteRunStore'

/**
 * Dependencies injected by the front-end wiring (Electron's buildElectronServices,
 * or — later — the CLI's buildCliServices). AppServices itself touches no framework.
 */
export interface AppServicesDeps {
  settings: SettingsService
  checkpointer: BaseCheckpointSaver
  threadStore: SqliteThreadStore
  runStore: SqliteRunStore
  eventLog: AgentEventLog
}

/**
 * Composition root. Owns the singletons, builds the active ArasClient and the
 * AgentService lazily, and rebuilds them when configuration changes.
 */
export class AppServices {
  readonly settings: SettingsService
  readonly threadStore: SqliteThreadStore
  readonly runStore: SqliteRunStore
  readonly eventLog: AgentEventLog
  private readonly checkpointer: BaseCheckpointSaver
  private activeClient: { id: string; client: ArasClient } | undefined
  private agent: AgentService | undefined

  constructor(deps: AppServicesDeps) {
    this.settings = deps.settings
    this.checkpointer = deps.checkpointer
    this.threadStore = deps.threadStore
    this.runStore = deps.runStore
    this.eventLog = deps.eventLog
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

    const agentSettings = this.settings.getAgentSettings()
    // `agentRef` is set after construction; the closure captures the variable binding so
    // `getSignal` always reads the live instance even though tools are built first.
    let agentRef: AgentService | undefined
    const tools = new ToolRegistry()
      .register(
        createArasTools({
          getClient: () => this.getActiveClient(),
          getSignal: () => agentRef?.getCurrentSignal(),
          toolTimeoutMs: agentSettings.toolTimeoutSec * 1000,
          ...(agentSettings.maxRetryAttempts !== undefined
            ? { maxRetryAttempts: agentSettings.maxRetryAttempts }
            : {})
        })
      )
      .list()

    const agent = new AgentService(model, tools, this.checkpointer)
    agentRef = agent
    this.agent = agent
    return this.agent
  }

  /**
   * Delete a thread and all of its persisted state (event log + runs + thread row).
   * Checkpointer rows are left in place — they're keyed by threadId, so a new thread
   * will not collide with them; a periodic sweep can reap orphans later.
   */
  deleteThread(id: string): void {
    this.eventLog.deleteByThread(id)
    this.runStore.deleteByThread(id)
    this.threadStore.delete(id)
  }

  /** Cancel the currently running agent turn. */
  cancelCurrentRun(): void {
    this.agent?.cancel()
  }

  /** The live agent if one exists (for routing approval decisions). */
  peekAgent(): AgentService | undefined {
    return this.agent
  }
}
