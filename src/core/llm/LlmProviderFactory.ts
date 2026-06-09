import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import type { LlmConfig } from '../config'

const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

/** Which providers require an API key (vs. local/self-hosted). */
export function providerRequiresApiKey(provider: LlmConfig['provider']): boolean {
  return provider === 'anthropic' || provider === 'openai'
}

/**
 * Builds a LangChain {@link BaseChatModel} for the configured provider. Because every
 * provider implements the same `BaseChatModel` interface, the rest of the agent code
 * is provider-agnostic — adding a provider means adding one `case` here.
 */
export function createChatModel(config: LlmConfig, apiKey?: string): BaseChatModel {
  if (providerRequiresApiKey(config.provider) && !apiKey) {
    throw new Error(`An API key is required for the ${config.provider} provider.`)
  }

  switch (config.provider) {
    case 'anthropic':
      return new ChatAnthropic({
        model: config.model,
        apiKey,
        streaming: true,
        maxRetries: 2
      })
    case 'openai':
      return new ChatOpenAI({
        model: config.model,
        apiKey,
        streaming: true,
        maxRetries: 2
      })
    case 'ollama':
      return new ChatOllama({
        model: config.model,
        baseUrl: config.baseUrl ?? DEFAULT_OLLAMA_URL
      })
    default: {
      const exhaustive: never = config.provider
      throw new Error(`Unsupported provider: ${String(exhaustive)}`)
    }
  }
}
