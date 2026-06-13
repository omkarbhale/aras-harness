import Database, { type Database as Db } from 'better-sqlite3'

/**
 * Open the harness state DB and apply the (idempotent) schema. Used by both Electron
 * (state.sqlite under userData) and CLI builds. WAL mode keeps writers from blocking
 * the renderer's reads.
 */
export function openDb(filePath: string): Db {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

function applySchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      appliedAt INTEGER NOT NULL
    );

    -- LangGraph checkpointer tables (see SqliteCheckpointer).
    CREATE TABLE IF NOT EXISTS checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      checkpoint BLOB NOT NULL,
      metadata BLOB NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_thread
      ON checkpoints(thread_id, checkpoint_ns, checkpoint_id);

    CREATE TABLE IF NOT EXISTS checkpoint_writes (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      channel TEXT NOT NULL,
      value BLOB NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    );

    -- App-level: threads, runs, and the full agent event log per thread.
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      archivedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS runs (
      runId TEXT PRIMARY KEY,
      threadId TEXT NOT NULL,
      status TEXT NOT NULL,
      approvalId TEXT,
      approvalPayload TEXT,
      pid INTEGER,
      startedAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      cancelRequested INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(threadId);

    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      threadId TEXT NOT NULL,
      runId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_thread ON agent_events(threadId, seq);
  `)

  const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as
    | { version: number }
    | undefined
  if (!row) {
    db.prepare('INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)').run(1, Date.now())
  }
}
