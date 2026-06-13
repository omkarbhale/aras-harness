import type { Database as Db } from 'better-sqlite3'
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP
} from '@langchain/langgraph-checkpoint'
import type { CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint'
import { TASKS, type SendProtocol } from '@langchain/langgraph-checkpoint'
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint'

/**
 * Disk-backed LangGraph checkpointer. Behaviourally a port of the in-tree MemorySaver
 * (see `@langchain/langgraph-checkpoint/dist/memory.js`) onto a single shared sqlite
 * database. Lets agent state survive process exit so a CLI `resume` (or a UI restart)
 * can pick up a paused turn from its `interrupt()`.
 */
export class SqliteCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly db: Db, serde?: SerializerProtocol) {
    super(serde)
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) return undefined
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? ''
    const requestedId = getCheckpointId(config)

    let row: CheckpointRow | undefined
    if (requestedId) {
      row = this.db
        .prepare<[string, string, string]>(
          'SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata ' +
            'FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?'
        )
        .get(threadId, checkpointNs, requestedId) as CheckpointRow | undefined
    } else {
      row = this.db
        .prepare<[string, string]>(
          'SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata ' +
            'FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1'
        )
        .get(threadId, checkpointNs) as CheckpointRow | undefined
    }
    if (!row) return undefined

    const pendingSends = await this.getPendingSends(
      threadId,
      checkpointNs,
      row.parent_checkpoint_id ?? undefined
    )
    const deserializedCheckpoint: Checkpoint = {
      ...((await this.serde.loadsTyped('json', row.checkpoint)) as Checkpoint),
      pending_sends: pendingSends
    }
    const metadata = (await this.serde.loadsTyped('json', row.metadata)) as CheckpointMetadata
    const pendingWrites = await this.loadWrites(threadId, checkpointNs, row.checkpoint_id)

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.checkpoint_id
        }
      },
      checkpoint: deserializedCheckpoint,
      metadata,
      pendingWrites
    }
    if (row.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.parent_checkpoint_id
        }
      }
    }
    return tuple
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { before, limit, filter } = options ?? {}
    const threadIdFilter = config.configurable?.thread_id as string | undefined
    const nsFilter = config.configurable?.checkpoint_ns as string | undefined
    const idFilter = config.configurable?.checkpoint_id as string | undefined
    const beforeId = before?.configurable?.checkpoint_id as string | undefined

    const where: string[] = []
    const params: unknown[] = []
    if (threadIdFilter !== undefined) {
      where.push('thread_id = ?')
      params.push(threadIdFilter)
    }
    if (nsFilter !== undefined) {
      where.push('checkpoint_ns = ?')
      params.push(nsFilter)
    }
    if (idFilter !== undefined) {
      where.push('checkpoint_id = ?')
      params.push(idFilter)
    }
    if (beforeId !== undefined) {
      where.push('checkpoint_id < ?')
      params.push(beforeId)
    }
    const sql =
      'SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata ' +
      `FROM checkpoints${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY checkpoint_id DESC`
    const rows = this.db.prepare(sql).all(...params) as CheckpointRow[]

    let yielded = 0
    for (const row of rows) {
      const metadata = (await this.serde.loadsTyped('json', row.metadata)) as CheckpointMetadata
      if (filter && !Object.entries(filter).every(([k, v]) => (metadata as Record<string, unknown>)[k] === v)) {
        continue
      }
      if (limit !== undefined && yielded >= limit) break

      const pendingSends = await this.getPendingSends(
        row.thread_id,
        row.checkpoint_ns,
        row.parent_checkpoint_id ?? undefined
      )
      const checkpoint: Checkpoint = {
        ...((await this.serde.loadsTyped('json', row.checkpoint)) as Checkpoint),
        pending_sends: pendingSends
      }
      const pendingWrites = await this.loadWrites(row.thread_id, row.checkpoint_ns, row.checkpoint_id)

      const tuple: CheckpointTuple = {
        config: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id
          }
        },
        checkpoint,
        metadata,
        pendingWrites
      }
      if (row.parent_checkpoint_id) {
        tuple.parentConfig = {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.parent_checkpoint_id
          }
        }
      }
      yielded++
      yield tuple
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) {
      throw new Error(
        'Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field.'
      )
    }
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? ''
    const parent = (config.configurable?.checkpoint_id as string | undefined) ?? null

    const prepared = copyCheckpoint(checkpoint)
    // pending_sends are derived from writes — never persisted on the checkpoint row itself.
    ;(prepared as { pending_sends?: SendProtocol[] }).pending_sends = []
    const [, serializedCheckpoint] = this.serde.dumpsTyped(prepared)
    const [, serializedMetadata] = this.serde.dumpsTyped(metadata)

    this.db
      .prepare(
        'INSERT OR REPLACE INTO checkpoints ' +
          '(thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata) ' +
          'VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        threadId,
        checkpointNs,
        checkpoint.id,
        parent,
        Buffer.from(serializedCheckpoint),
        Buffer.from(serializedMetadata)
      )

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id
      }
    }
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? ''
    const checkpointId = config.configurable?.checkpoint_id as string | undefined
    if (!threadId) {
      throw new Error('Failed to put writes. RunnableConfig is missing "thread_id".')
    }
    if (!checkpointId) {
      throw new Error('Failed to put writes. RunnableConfig is missing "checkpoint_id".')
    }

    const insertIgnore = this.db.prepare(
      'INSERT OR IGNORE INTO checkpoint_writes ' +
        '(thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const insertReplace = this.db.prepare(
      'INSERT OR REPLACE INTO checkpoint_writes ' +
        '(thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    )

    const tx = this.db.transaction((entries: PendingWrite[]) => {
      entries.forEach(([channel, value], idx) => {
        const [, serialized] = this.serde.dumpsTyped(value)
        const effectiveIdx =
          (WRITES_IDX_MAP as Record<string, number>)[channel as string] ?? idx
        // Special writes (negative idx) overwrite; regular writes dedupe.
        const stmt = effectiveIdx >= 0 ? insertIgnore : insertReplace
        stmt.run(
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          effectiveIdx,
          channel as string,
          Buffer.from(serialized)
        )
      })
    })
    tx(writes)
  }

  private async getPendingSends(
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string | undefined
  ): Promise<SendProtocol[]> {
    if (!parentCheckpointId) return []
    const rows = this.db
      .prepare<[string, string, string, string]>(
        'SELECT value FROM checkpoint_writes ' +
          'WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND channel = ?'
      )
      .all(threadId, checkpointNs, parentCheckpointId, TASKS) as { value: Buffer }[]
    const sends: SendProtocol[] = []
    for (const r of rows) {
      sends.push((await this.serde.loadsTyped('json', r.value)) as SendProtocol)
    }
    return sends
  }

  private async loadWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<[string, string, unknown][]> {
    const rows = this.db
      .prepare<[string, string, string]>(
        'SELECT task_id, channel, value FROM checkpoint_writes ' +
          'WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY task_id, idx'
      )
      .all(threadId, checkpointNs, checkpointId) as {
      task_id: string
      channel: string
      value: Buffer
    }[]
    const out: [string, string, unknown][] = []
    for (const r of rows) {
      out.push([r.task_id, r.channel, await this.serde.loadsTyped('json', r.value)])
    }
    return out
  }
}

interface CheckpointRow {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_checkpoint_id: string | null
  checkpoint: Buffer
  metadata: Buffer
}
