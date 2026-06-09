import { useCallback, useEffect, useState } from 'react'
import { ChatPanel } from './features/chat/ChatPanel'
import { QueryPanel } from './features/query/QueryPanel'
import { ConnectionsPanel } from './features/connections/ConnectionsPanel'
import { SettingsPanel } from './features/settings/SettingsPanel'

type Tab = 'chat' | 'query' | 'connections' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: '💬 Agent' },
  { id: 'query', label: '⚡ Query' },
  { id: 'connections', label: '🔌 Connections' },
  { id: 'settings', label: '⚙️ Settings' }
]

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('chat')
  const [activeConn, setActiveConn] = useState<string | null>(null)
  const [provider, setProvider] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    const [active, list, llm] = await Promise.all([
      window.api.connections.getActive(),
      window.api.connections.list(),
      window.api.settings.getLlm()
    ])
    setActiveConn(list.find((c) => c.id === active)?.name ?? null)
    setProvider(llm ? `${llm.provider}/${llm.model}` : null)
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  return (
    <div className="app">
      <nav className="sidebar">
        <h1>Aras Harness</h1>
        {TABS.map((t) => (
          <div
            key={t.id}
            className={`nav-item ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </div>
        ))}
        <div className="nav-status">
          <div>
            Connection: <strong>{activeConn ?? 'none'}</strong>
          </div>
          <div>
            Model: <strong>{provider ?? 'not set'}</strong>
          </div>
        </div>
      </nav>
      <main className="main">
        {tab === 'chat' && <ChatPanel />}
        {tab === 'query' && <QueryPanel />}
        {tab === 'connections' && <ConnectionsPanel onChanged={refreshStatus} />}
        {tab === 'settings' && <SettingsPanel onChanged={refreshStatus} />}
      </main>
    </div>
  )
}
