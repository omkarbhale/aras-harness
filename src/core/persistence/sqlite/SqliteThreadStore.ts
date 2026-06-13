import type { Database as Db } from 'better-sqlite3'

export interface ThreadRecord {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

export interface ThreadSummaryRow extends ThreadRecord {
  messageCount: number
  preview: string | null
}

/**
 * CRUD over the `threads` table. The thread id doubles as the LangGraph `thread_id`
 * passed into the checkpointer, so a thread row anchors all of its agent state.
 */
export class SqliteThreadStore {
  constructor(private readonly db: Db) {}

  list(includeArchived = false): ThreadRecord[] {
    const where = includeArchived ? '' : 'WHERE archivedAt IS NULL '
    return this.db
      .prepare(`SELECT id, name, createdAt, updatedAt, archivedAt FROM threads ${where}ORDER BY updatedAt DESC`)
      .all() as ThreadRecord[]
  }

  /**
   * Same as {@link list} but augmented with message count + first-user-message preview,
   * computed in a single query. Used by the sidebar.
   */
  listSummaries(): ThreadSummaryRow[] {
    return this.db
      .prepare(
        `SELECT t.id, t.name, t.createdAt, t.updatedAt, t.archivedAt,
                COALESCE(c.messageCount, 0) AS messageCount,
                p.preview AS preview
         FROM threads t
         LEFT JOIN (
           SELECT threadId, COUNT(*) AS messageCount FROM agent_events
           WHERE type = 'user_message'
           GROUP BY threadId
         ) c ON c.threadId = t.id
         LEFT JOIN (
           SELECT threadId, json_extract(payload, '$.content') AS preview FROM (
             SELECT threadId, payload,
                    ROW_NUMBER() OVER (PARTITION BY threadId ORDER BY seq) AS rn
             FROM agent_events WHERE type = 'user_message'
           ) WHERE rn = 1
         ) p ON p.threadId = t.id
         WHERE t.archivedAt IS NULL
         ORDER BY t.updatedAt DESC`
      )
      .all() as ThreadSummaryRow[]
  }

  get(id: string): ThreadRecord | undefined {
    return this.db
      .prepare<[string]>('SELECT id, name, createdAt, updatedAt, archivedAt FROM threads WHERE id = ?')
      .get(id) as ThreadRecord | undefined
  }

  create(input: { id: string; name: string }): ThreadRecord {
    const now = Date.now()
    this.db
      .prepare('INSERT INTO threads (id, name, createdAt, updatedAt, archivedAt) VALUES (?, ?, ?, ?, NULL)')
      .run(input.id, input.name, now, now)
    return { id: input.id, name: input.name, createdAt: now, updatedAt: now, archivedAt: null }
  }

  rename(id: string, name: string): void {
    this.db.prepare('UPDATE threads SET name = ?, updatedAt = ? WHERE id = ?').run(name, Date.now(), id)
  }

  touch(id: string): void {
    this.db.prepare('UPDATE threads SET updatedAt = ? WHERE id = ?').run(Date.now(), id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
  }
}
