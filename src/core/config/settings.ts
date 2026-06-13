import { z } from 'zod'

/**
 * Persisted application configuration schema (non-secret). Secrets — connection
 * passwords and LLM API keys — are stored separately in the OS keychain and are
 * never part of this object.
 */

export const connectionRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instanceUrl: z.string().url(),
  database: z.string().min(1),
  username: z.string().min(1)
})
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>

export const llmProviderSchema = z.enum(['anthropic', 'openai', 'ollama'])

export const llmConfigSchema = z.object({
  provider: llmProviderSchema,
  model: z.string().min(1),
  baseUrl: z.string().url().optional()
})
export type LlmConfig = z.infer<typeof llmConfigSchema>

export const agentConfigSchema = z.object({
  toolTimeoutSec: z.number().int().min(5).max(300).default(30),
  /** Optional cap on read-tool retry attempts. Omitted = infinite (current default behaviour). */
  maxRetryAttempts: z.number().int().min(1).max(1000).optional()
})
export type AgentConfig = z.infer<typeof agentConfigSchema>

export const appConfigSchema = z.object({
  connections: z.array(connectionRecordSchema).default([]),
  activeConnectionId: z.string().nullable().default(null),
  /** Stable LangGraph thread_id for the single chat conversation. Phase 2 will allow many. */
  activeThreadId: z.string().nullable().default(null),
  llm: llmConfigSchema.nullable().default(null),
  agent: agentConfigSchema.default({ toolTimeoutSec: 30 })
})
export type AppConfig = z.infer<typeof appConfigSchema>

export const defaultAppConfig: AppConfig = {
  connections: [],
  activeConnectionId: null,
  activeThreadId: null,
  llm: null,
  agent: { toolTimeoutSec: 30 }
}

/** Parse loosely-typed persisted data, falling back to defaults on corruption. */
export function parseAppConfig(raw: unknown): AppConfig {
  const result = appConfigSchema.safeParse(raw)
  return result.success ? result.data : defaultAppConfig
}

// ----------------------------------------------------------------------------
// Persistence ports — implemented in the main process (electron-store / safeStorage),
// faked in tests. Keeping them as interfaces is what keeps `core` framework-agnostic.
// ----------------------------------------------------------------------------

export interface ConfigStore {
  load(): AppConfig
  save(config: AppConfig): void
}

export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  has(key: string): boolean
}

/** Stable secret-key conventions so all callers agree on where secrets live. */
export const secretKeys = {
  connectionPassword: (connectionId: string) => `conn-password:${connectionId}`,
  llmApiKey: (provider: string) => `llm-apikey:${provider}`
} as const
