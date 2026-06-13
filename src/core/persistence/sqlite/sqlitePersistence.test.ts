import { describe, it, expect } from 'vitest'
import { openDb } from './openDb'
import { SqliteThreadStore } from './SqliteThreadStore'
import { SqliteRunStore } from './SqliteRunStore'
import { SqliteEventLog } from './SqliteEventLog'
import { SqliteCheckpointer } from './SqliteCheckpointer'

function freshDb() {
  return openDb(':memory:')
}

describe('SqliteThreadStore', () => {
  it('creates, lists, renames, deletes', () => {
    const store = new SqliteThreadStore(freshDb())
    const t = store.create({ id: 't1', name: 'Hello' })
    expect(t.id).toBe('t1')
    expect(store.list()).toHaveLength(1)
    store.rename('t1', 'World')
    expect(store.get('t1')?.name).toBe('World')
    store.delete('t1')
    expect(store.list()).toHaveLength(0)
  })
})

describe('SqliteRunStore', () => {
  it('tracks status transitions and cancel-request flag', () => {
    const store = new SqliteRunStore(freshDb())
    store.start({ runId: 'r1', threadId: 't1', pid: 1234 })
    store.markPaused('r1', 'a1', { aml: '<AML/>' })
    let row = store.get('r1')
    expect(row?.status).toBe('paused')
    expect(row?.approvalId).toBe('a1')
    expect(JSON.parse(row!.approvalPayload!)).toEqual({ aml: '<AML/>' })
    store.requestCancel('r1')
    expect(store.isCancelRequested('r1')).toBe(true)
    store.markStatus('r1', 'cancelled')
    row = store.get('r1')
    expect(row?.status).toBe('cancelled')
  })
})

describe('SqliteEventLog', () => {
  it('round-trips events ordered by seq', () => {
    const log = new SqliteEventLog(freshDb())
    log.append('t1', 'r1', { type: 'run_start', runId: 'r1' })
    log.append('t1', 'r1', { type: 'token', runId: 'r1', delta: 'hello' })
    log.append('t1', 'r1', { type: 'done', runId: 'r1' })
    const events = log.listByThread('t1')
    expect(events).toHaveLength(3)
    expect(events[0]?.type).toBe('run_start')
    expect(events[2]?.type).toBe('done')
  })

  it('deletes by thread', () => {
    const log = new SqliteEventLog(freshDb())
    log.append('t1', 'r1', { type: 'done', runId: 'r1' })
    log.deleteByThread('t1')
    expect(log.listByThread('t1')).toHaveLength(0)
  })
})

describe('SqliteCheckpointer', () => {
  it('round-trips a checkpoint via put/getTuple', async () => {
    const cp = new SqliteCheckpointer(freshDb())
    const config = { configurable: { thread_id: 'thr-1', checkpoint_ns: '' } }
    const checkpoint = {
      v: 1,
      id: '01HZX',
      ts: '2024-01-01T00:00:00.000Z',
      channel_values: { messages: ['hi'] },
      channel_versions: { messages: 1 },
      versions_seen: {},
      pending_sends: []
    }
    await cp.put(config, checkpoint, { source: 'input', step: 0, writes: {}, parents: {} } as never)
    const tuple = await cp.getTuple(config)
    expect(tuple?.checkpoint.id).toBe('01HZX')
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ['hi'] })
  })
})
