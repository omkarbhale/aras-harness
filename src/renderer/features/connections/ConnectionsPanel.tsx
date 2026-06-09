import { useEffect, useState } from 'react'
import type { Connection, ConnectionInput, TestResult } from '@shared/ipc'

const emptyForm: ConnectionInput = {
  name: '',
  instanceUrl: '',
  database: '',
  username: '',
  password: ''
}

export function ConnectionsPanel({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [connections, setConnections] = useState<Connection[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState<ConnectionInput>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [testing, setTesting] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setConnections(await window.api.connections.list())
    setActiveId(await window.api.connections.getActive())
    onChanged()
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (): Promise<void> => {
    await window.api.connections.save(editingId ? { ...form, id: editingId } : form)
    setForm(emptyForm)
    setEditingId(null)
    await refresh()
  }

  const edit = (c: Connection): void => {
    setEditingId(c.id)
    setForm({
      name: c.name,
      instanceUrl: c.instanceUrl,
      database: c.database,
      username: c.username,
      password: ''
    })
  }

  const test = async (id: string): Promise<void> => {
    setTesting(id)
    const result = await window.api.connections.test(id)
    setTestResults((prev) => ({ ...prev, [id]: result }))
    setTesting(null)
  }

  const set = (patch: Partial<ConnectionInput>): void => setForm((f) => ({ ...f, ...patch }))

  return (
    <div className="panel">
      <h2>Connections</h2>

      {connections.map((c) => (
        <div className="card" key={c.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{c.name}</strong>{' '}
              {c.id === activeId && <span className="pill green">active</span>}
              {!c.hasPassword && <span className="pill red">no password</span>}
              <div className="muted">
                {c.username}@{c.instanceUrl} · {c.database}
              </div>
              {testResults[c.id] && (
                <div className={testResults[c.id].ok ? 'pill green' : 'pill red'}>
                  {testResults[c.id].message}
                  {testResults[c.id].latencyMs != null && ` (${testResults[c.id].latencyMs}ms)`}
                </div>
              )}
            </div>
            <div className="row">
              <button
                className="secondary"
                disabled={testing === c.id}
                onClick={() => void test(c.id)}
              >
                {testing === c.id ? 'Testing…' : 'Test'}
              </button>
              <button
                className="secondary"
                disabled={c.id === activeId}
                onClick={() => void window.api.connections.setActive(c.id).then(refresh)}
              >
                Activate
              </button>
              <button className="secondary" onClick={() => edit(c)}>
                Edit
              </button>
              <button
                className="danger"
                onClick={() => void window.api.connections.remove(c.id).then(refresh)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ))}

      <div className="card">
        <h3>{editingId ? 'Edit connection' : 'New connection'}</h3>
        <label>Name</label>
        <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
        <label>Instance URL</label>
        <input
          placeholder="http://localhost/InnovatorServer"
          value={form.instanceUrl}
          onChange={(e) => set({ instanceUrl: e.target.value })}
        />
        <label>Database</label>
        <input value={form.database} onChange={(e) => set({ database: e.target.value })} />
        <label>Username</label>
        <input value={form.username} onChange={(e) => set({ username: e.target.value })} />
        <label>Password {editingId && <span className="muted">(leave blank to keep)</span>}</label>
        <input
          type="password"
          value={form.password ?? ''}
          onChange={(e) => set({ password: e.target.value })}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => void save()} disabled={!form.name || !form.instanceUrl}>
            {editingId ? 'Save changes' : 'Add connection'}
          </button>
          {editingId && (
            <button
              className="secondary"
              onClick={() => {
                setEditingId(null)
                setForm(emptyForm)
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
