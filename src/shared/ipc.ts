/**
 * IPC contract — the single source of truth shared by the Electron main and renderer
 * processes. Domain DTOs that cross the process boundary live here. Secrets (passwords,
 * API keys) are write-only: they may be sent renderer -> main, but are never returned.
 */

// ----------------------------------------------------------------------------
// Connections
// ----------------------------------------------------------------------------

/** A stored Aras connection as exposed to the UI — never contains the password. */
export interface Connection {
  id: string
  name: string
  /** Base instance URL, e.g. http://localhost/InnovatorServer */
  instanceUrl: string
  database: string
  username: string
  /** Whether a password is stored (in the OS keychain via safeStorage). */
  hasPassword: boolean
}

/** Payload to create/update a connection. `password` is only used to (re)store the secret. */
export interface ConnectionInput {
  id?: string
  name: string
  instanceUrl: string
  database: string
  username: string
  password?: string
}

export interface TestResult {
  ok: boolean
  message: string
  /** Round-trip latency in ms when ok. */
  latencyMs?: number
}

// ----------------------------------------------------------------------------
// LLM settings
// ----------------------------------------------------------------------------

export type LlmProviderId = 'anthropic' | 'openai' | 'ollama'

/** Agent behaviour settings (non-secret, persisted in config store). */
export interface AgentSettings {
  toolTimeoutSec: number
  /** Cap on retry attempts for read tools. Undefined = infinite (default). */
  maxRetryAttempts?: number
}

export interface AgentSettingsInput {
  toolTimeoutSec: number
  maxRetryAttempts?: number
}

/** LLM settings as exposed to the UI — never contains the API key. */
export interface LlmSettings {
  provider: LlmProviderId
  model: string
  /** Base URL override (used by ollama / self-hosted gateways). */
  baseUrl?: string
  hasApiKey: boolean
}

export interface LlmSettingsInput {
  provider: LlmProviderId
  model: string
  baseUrl?: string
  /** Only used to (re)store the secret; cleared after persisting. */
  apiKey?: string
}

// ----------------------------------------------------------------------------
// AML / OData query results
// ----------------------------------------------------------------------------

export interface AmlItem {
  id: string
  type: string
  properties: Record<string, string>
}

export interface AmlResult {
  /** Raw AML/XML response from the server. */
  raw: string
  items: AmlItem[]
  count: number
}

// ----------------------------------------------------------------------------
// Agent streaming events (main -> renderer, push channel)
// ----------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'run_start'; runId: string }
  | { type: 'token'; runId: string; delta: string }
  | { type: 'tool_start'; runId: string; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_end'; runId: string; toolCallId: string; result: string; isError: boolean }
  | {
      type: 'approval_request'
      runId: string
      approvalId: string
      tool: string
      summary: string
      payload: unknown
    }
  | { type: 'assistant_message'; runId: string; content: string }
  | { type: 'error'; runId: string; message: string }
  | { type: 'done'; runId: string }

// ----------------------------------------------------------------------------
// Channel names
// ----------------------------------------------------------------------------

export const IpcChannels = {
  connectionsList: 'connections:list',
  connectionsSave: 'connections:save',
  connectionsDelete: 'connections:delete',
  connectionsSetActive: 'connections:setActive',
  connectionsGetActive: 'connections:getActive',
  connectionsTest: 'connections:test',
  settingsGetLlm: 'settings:getLlm',
  settingsSaveLlm: 'settings:saveLlm',
  settingsGetAgent: 'settings:getAgent',
  settingsSaveAgent: 'settings:saveAgent',
  queryRunAml: 'query:runAml',
  agentSend: 'agent:send',
  agentApprove: 'agent:approve',
  agentCancel: 'agent:cancel',
  /** Push channel: main -> renderer AgentEvent stream. */
  agentEvent: 'agent:event'
} as const

// ----------------------------------------------------------------------------
// The typed bridge exposed on `window.api` by the preload script.
// ----------------------------------------------------------------------------

export interface HarnessApi {
  connections: {
    list(): Promise<Connection[]>
    save(input: ConnectionInput): Promise<Connection>
    remove(id: string): Promise<void>
    setActive(id: string): Promise<void>
    getActive(): Promise<string | null>
    test(id: string): Promise<TestResult>
  }
  settings: {
    getLlm(): Promise<LlmSettings | null>
    saveLlm(input: LlmSettingsInput): Promise<LlmSettings>
    getAgent(): Promise<AgentSettings>
    saveAgent(input: AgentSettingsInput): Promise<AgentSettings>
  }
  query: {
    runAml(body: string): Promise<AmlResult>
  }
  agent: {
    /** Starts a new agent run for the message; events arrive on `onEvent`. */
    send(message: string): Promise<{ runId: string }>
    /** Answer a pending approval_request. */
    approve(approvalId: string, approved: boolean): Promise<void>
    /** Cancel the running agent run. */
    cancel(runId: string): Promise<void>
    /** Subscribe to the agent event stream. Returns an unsubscribe function. */
    onEvent(cb: (event: AgentEvent) => void): () => void
  }
}

declare global {
  interface Window {
    api: HarnessApi
  }
}
