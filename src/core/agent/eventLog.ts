import type { AgentEvent } from '@shared/ipc'

/**
 * Persistence boundary for the agent's per-run event stream. The renderer already
 * builds its transcript from the same {@link AgentEvent} sequence (`useAgent.ts`),
 * so replaying a thread's events through the same reducer rebuilds the UI exactly.
 */
export interface AgentEventLog {
  append(threadId: string, runId: string, event: AgentEvent): void
  listByThread(threadId: string): AgentEvent[]
  deleteByThread(threadId: string): void
}

/** In-memory impl for unit tests. */
export class InMemoryAgentEventLog implements AgentEventLog {
  private readonly byThread = new Map<string, AgentEvent[]>()

  append(threadId: string, _runId: string, event: AgentEvent): void {
    const existing = this.byThread.get(threadId) ?? []
    existing.push(event)
    this.byThread.set(threadId, existing)
  }

  listByThread(threadId: string): AgentEvent[] {
    return [...(this.byThread.get(threadId) ?? [])]
  }

  deleteByThread(threadId: string): void {
    this.byThread.delete(threadId)
  }
}
