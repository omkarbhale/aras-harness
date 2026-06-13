import type { Database as Db } from 'better-sqlite3'
import type { AgentEvent } from '@shared/ipc'
import type { AgentEventLog } from '@core/agent/eventLog'

/**
 * Persists the agent's event stream so a thread's transcript can be reconstructed
 * after a restart. Replays through the same reducer the renderer already uses
 * (`useAgent.handleEvent`), so no rendering code changes.
 */
export class SqliteEventLog implements AgentEventLog {
  private nextSeq = new Map<string, number>()

  constructor(private readonly db: Db) {}

  append(threadId: string, runId: string, event: AgentEvent): void {
    const seq = this.peekSeq(threadId)
    this.db
      .prepare(
        'INSERT INTO agent_events (threadId, runId, seq, type, payload, createdAt) ' +
          'VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(threadId, runId, seq, event.type, JSON.stringify(event), Date.now())
    this.nextSeq.set(threadId, seq + 1)
  }

  listByThread(threadId: string): AgentEvent[] {
    const rows = this.db
      .prepare<[string]>('SELECT payload FROM agent_events WHERE threadId = ? ORDER BY seq ASC')
      .all(threadId) as { payload: string }[]
    return rows.map((r) => JSON.parse(r.payload) as AgentEvent)
  }

  deleteByThread(threadId: string): void {
    this.db.prepare('DELETE FROM agent_events WHERE threadId = ?').run(threadId)
    this.nextSeq.delete(threadId)
  }

  private peekSeq(threadId: string): number {
    const cached = this.nextSeq.get(threadId)
    if (cached !== undefined) return cached
    const row = this.db
      .prepare<[string]>('SELECT MAX(seq) AS maxSeq FROM agent_events WHERE threadId = ?')
      .get(threadId) as { maxSeq: number | null } | undefined
    return (row?.maxSeq ?? -1) + 1
  }
}
