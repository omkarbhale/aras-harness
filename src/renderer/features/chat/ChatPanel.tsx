import { useEffect, useRef, useState } from 'react'
import { ChatSidebar } from './ChatSidebar'
import { Markdown } from './Markdown'
import { useAgent, type ChatItem } from './useAgent'
import { useThreads } from './useThreads'

const ACTIVE_THREAD_KEY = 'aras-harness:active-thread-id'

export function ChatPanel(): JSX.Element {
  const { threads, create, rename, remove } = useThreads()
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(ACTIVE_THREAD_KEY))
  const { items, busy, send, respond, cancel } = useAgent(activeId)
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  // Auto-select first thread once the list arrives, when nothing is selected.
  useEffect(() => {
    if (activeId) {
      if (threads.length > 0 && !threads.some((t) => t.id === activeId)) {
        // Active thread was deleted elsewhere — fall back to the most recent.
        const next = threads[0]?.id ?? null
        setActiveId(next)
        if (next) localStorage.setItem(ACTIVE_THREAD_KEY, next)
        else localStorage.removeItem(ACTIVE_THREAD_KEY)
      }
      return
    }
    if (threads.length > 0) {
      const next = threads[0]!.id
      setActiveId(next)
      localStorage.setItem(ACTIVE_THREAD_KEY, next)
    }
  }, [threads, activeId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [items])

  const selectThread = (id: string): void => {
    setActiveId(id)
    localStorage.setItem(ACTIVE_THREAD_KEY, id)
  }

  const newThread = async (): Promise<void> => {
    const t = await create()
    selectThread(t.id)
  }

  const deleteThread = async (id: string): Promise<void> => {
    await remove(id)
    if (id === activeId) {
      setActiveId(null)
      localStorage.removeItem(ACTIVE_THREAD_KEY)
    }
  }

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || busy) return
    let target = activeId
    if (!target) {
      const t = await create()
      target = t.id
      selectThread(target)
    }
    send(text)
    setDraft('')
  }

  return (
    <div className="chat-with-sidebar">
      <ChatSidebar
        threads={threads}
        activeId={activeId}
        onSelect={selectThread}
        onNew={() => void newThread()}
        onRename={(id, name) => void rename(id, name)}
        onDelete={(id) => void deleteThread(id)}
      />
      <div className="chat">
        <div className="chat-log" ref={logRef}>
          {items.length === 0 && (
            <p className="muted">
              Ask the agent to query or modify your Aras instance — e.g. "List the 10 most
              recently created Parts" or "Add a Part with item_number TEST-001".
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
                void submit()
              }
            }}
          />
          <button onClick={() => void submit()} disabled={busy || draft.trim().length === 0}>
            Send
          </button>
        </div>
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
      return (
        <div className="bubble assistant markdown">
          {item.text ? <Markdown text={item.text} /> : '…'}
        </div>
      )
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
