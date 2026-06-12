import { useEffect, useRef, useState } from 'react'
import { useAgent, type ChatItem } from './useAgent'

export function ChatPanel(): JSX.Element {
  const { items, busy, send, respond, cancel } = useAgent()
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [items])

  const submit = (): void => {
    const text = draft.trim()
    if (!text || busy) return
    send(text)
    setDraft('')
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef}>
        {items.length === 0 && (
          <p className="muted">
            Ask the agent to query or modify your Aras instance — e.g. “List the 10 most recently
            created Parts” or “Add a Part with item_number TEST-001”.
          </p>
        )}
        {items.map((item) => (
          <ChatEntry key={item.id} item={item} onRespond={respond} />
        ))}
        {busy && (
          <div className="working-row">
            <span className="muted">● working…</span>
            <button className="stop-btn" onClick={cancel}>■ Stop</button>
          </div>
        )}
      </div>
      <div className="chat-input">
        <textarea
          rows={2}
          value={draft}
          placeholder="Message the Aras agent…  (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button onClick={submit} disabled={busy || draft.trim().length === 0}>
          Send
        </button>
      </div>
    </div>
  )
}

function ChatEntry({
  item,
  onRespond
}: {
  item: ChatItem
  onRespond: (approvalId: string, approved: boolean) => void
}): JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return <div className="bubble user">{item.text}</div>
    case 'assistant':
      return <div className="bubble assistant">{item.text || '…'}</div>
    case 'tool':
      return (
        <div className="tool">
          <div>
            🔧 <code>{item.name}</code>
            {item.isError && <span className="pill red" style={{ marginLeft: 6 }}>error</span>}
          </div>
          <pre>{JSON.stringify(item.args, null, 2)}</pre>
          {item.result !== undefined && <pre>{truncate(item.result, 1200)}</pre>}
        </div>
      )
    case 'approval':
      return (
        <div className="approval">
          <div>
            ⚠️ The agent wants to run a <strong>write</strong> via <code>{item.tool}</code>:{' '}
            {item.summary}
          </div>
          <pre style={{ maxHeight: 160, overflow: 'auto' }}>{describePayload(item.payload)}</pre>
          {item.status === 'pending' ? (
            <div className="row">
              <button onClick={() => onRespond(item.approvalId, true)}>Approve</button>
              <button className="danger" onClick={() => onRespond(item.approvalId, false)}>
                Deny
              </button>
            </div>
          ) : (
            <span className={`pill ${item.status === 'approved' ? 'green' : 'red'}`}>
              {item.status}
            </span>
          )}
        </div>
      )
    default:
      return null
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function describePayload(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'aml' in payload) {
    return String((payload as { aml: unknown }).aml)
  }
  return JSON.stringify(payload, null, 2)
}
