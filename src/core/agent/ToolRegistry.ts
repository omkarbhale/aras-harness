import type { StructuredToolInterface } from '@langchain/core/tools'

/**
 * Holds the agent's tools. Built-in Aras tools are registered at startup; this is also
 * the seam where MCP-provided tools (via @langchain/mcp-adapters) will be merged later,
 * without the agent code needing to change.
 */
export class ToolRegistry {
  private readonly tools: StructuredToolInterface[] = []

  register(tools: StructuredToolInterface[]): this {
    this.tools.push(...tools)
    return this
  }

  list(): StructuredToolInterface[] {
    return [...this.tools]
  }
}
