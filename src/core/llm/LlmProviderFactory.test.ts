import { describe, it, expect } from 'vitest'
import { createChatModel, providerRequiresApiKey } from './LlmProviderFactory'

describe('createChatModel', () => {
  it('builds an Anthropic model when given a key', () => {
    const model = createChatModel({ provider: 'anthropic', model: 'claude-opus-4-8' }, 'sk-ant')
    expect(model._llmType()).toBe('anthropic')
  })

  it('builds an OpenAI model when given a key', () => {
    const model = createChatModel({ provider: 'openai', model: 'gpt-4o' }, 'sk-oai')
    expect(model._llmType()).toBe('openai')
  })

  it('builds an Ollama model without a key', () => {
    const model = createChatModel({
      provider: 'ollama',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434'
    })
    expect(model._llmType()).toBe('ollama')
  })

  it('throws when a key-requiring provider has no key', () => {
    expect(() => createChatModel({ provider: 'anthropic', model: 'claude-opus-4-8' })).toThrow(
      /API key is required/i
    )
  })
})

describe('providerRequiresApiKey', () => {
  it('classifies providers correctly', () => {
    expect(providerRequiresApiKey('anthropic')).toBe(true)
    expect(providerRequiresApiKey('openai')).toBe(true)
    expect(providerRequiresApiKey('ollama')).toBe(false)
  })
})
