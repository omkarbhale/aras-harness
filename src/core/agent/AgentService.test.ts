import { describe, it, expect } from 'vitest'
import { isAssistantToken } from './AgentService'

describe('isAssistantToken', () => {
  it('accepts an AI message from the agent node', () => {
    const chunk = { content: 'hello', _getType: () => 'ai' }
    expect(isAssistantToken(chunk, { langgraph_node: 'agent' })).toBe(true)
  })

  it('rejects a tool result streamed from the tools node', () => {
    const chunk = { content: '{"count":504}', _getType: () => 'tool' }
    expect(isAssistantToken(chunk, { langgraph_node: 'tools' })).toBe(false)
  })

  it('rejects a tool message even if node metadata is missing', () => {
    const chunk = { content: 'result', _getType: () => 'tool' }
    expect(isAssistantToken(chunk, undefined)).toBe(false)
  })

  it('rejects anything from the tools node even if the type is unknown', () => {
    const chunk = { content: 'result' }
    expect(isAssistantToken(chunk, { langgraph_node: 'tools' })).toBe(false)
  })

  it('accepts a plain chunk when neither signal is present (best effort)', () => {
    expect(isAssistantToken({ content: 'hi' }, undefined)).toBe(true)
  })

  it('rejects an absent chunk', () => {
    expect(isAssistantToken(undefined, { langgraph_node: 'agent' })).toBe(false)
  })
})
