import { useMemo, useState } from 'react'
import type { AmlResult } from '@shared/ipc'

const SAMPLE = '<AML>\n  <Item type="ItemType" action="get" select="name,label" maxRecords="25" />\n</AML>'

export function QueryPanel(): JSX.Element {
  const [aml, setAml] = useState(SAMPLE)
  const [result, setResult] = useState<AmlResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    try {
      setResult(await window.api.query.runAml(aml))
    } catch (e) {
      setResult(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const columns = useMemo(() => {
    if (!result) return []
    const keys = new Set<string>()
    for (const item of result.items) for (const k of Object.keys(item.properties)) keys.add(k)
    return [...keys]
  }, [result])

  return (
    <div className="panel">
      <h2>AML Query</h2>
      <textarea rows={8} value={aml} onChange={(e) => setAml(e.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => void run()} disabled={running}>
          {running ? 'Running…' : 'Run AML'}
        </button>
        <span className="muted">Runs against the active connection.</span>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--red)' }}>{error}</div>}

      {result && (
        <>
          <p className="muted">{result.count} item(s)</p>
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>type</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.id}</td>
                  <td>{item.type}</td>
                  {columns.map((c) => (
                    <td key={c} title={item.properties[c]}>
                      {item.properties[c] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
