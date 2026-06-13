import type { Database as Db } from 'better-sqlite3'

export type RunStatus = 'running' | 'paused' | 'done' | 'error' | 'cancelled'

export interface RunRecord {
  runId: string
  threadId: string
  status: RunStatus
  approvalId: string | null
  approvalPayload: string | null
  pid: number | null
  startedAt: number
  updatedAt: number
  cancelRequested: number
}

/**
 * CRUD over the `runs` table. Owned primarily by the CLI (so a `resume` invocation
 * in a fresh process can locate the paused run's threadId + approval payload), but
 * exposed to the renderer too for future runs-list features.
 */
export class SqliteRunStore {
  constructor(private readonly db: Db) {}

  start(input: { runId: string; threadId: string; pid?: number }): RunRecord {
    const now = Date.now()
    this.db
      .prepare(
        'INSERT INTO runs (runId, threadId, status, approvalId, approvalPayload, pid, startedAt, updatedAt, cancelRequested) ' +
          "VALUES (?, ?, 'running', NULL, NULL, ?, ?, ?, 0)"
      )
      .run(input.runId, input.threadId, input.pid ?? null, now, now)
    return {
      runId: input.runId,
      threadId: input.threadId,
      status: 'running',
      approvalId: null,
      approvalPayload: null,
      pid: input.pid ?? null,
      startedAt: now,
      updatedAt: now,
      cancelRequested: 0
    }
  }

  markPaused(runId: string, approvalId: string, approvalPayload: unknown): void {
    this.db
      .prepare("UPDATE runs SET status = 'paused', approvalId = ?, approvalPayload = ?, updatedAt = ? WHERE runId = ?")
      .run(approvalId, JSON.stringify(approvalPayload), Date.now(), runId)
  }

  markStatus(runId: string, status: RunStatus): void {
    this.db.prepare('UPDATE runs SET status = ?, updatedAt = ? WHERE runId = ?').run(status, Date.now(), runId)
  }

  requestCancel(runId: string): void {
    this.db.prepare('UPDATE runs SET cancelRequested = 1, updatedAt = ? WHERE runId = ?').run(Date.now(), runId)
  }

  get(runId: string): RunRecord | undefined {
    return this.db
      .prepare<[string]>('SELECT * FROM runs WHERE runId = ?')
      .get(runId) as RunRecord | undefined
  }

  isCancelRequested(runId: string): boolean {
    const row = this.db
      .prepare<[string]>('SELECT cancelRequested FROM runs WHERE runId = ?')
      .get(runId) as { cancelRequested: number } | undefined
    return row?.cancelRequested === 1
  }

  deleteByThread(threadId: string): void {
    this.db.prepare('DELETE FROM runs WHERE threadId = ?').run(threadId)
  }
}
