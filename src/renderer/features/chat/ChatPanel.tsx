import { useEffect, useRef, useState } from 'react'
import { ChatSidebar } from './ChatSidebar'
import { formatAml } from './formatAml'
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
              <span className="spinner" />
              <span className="muted">Working…</span>
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
      return (
        <div className="msg msg-user">
          <div className="msg-role">You</div>
          <div className="bubble user">{item.text}</div>
        </div>
      )
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <div className="msg-role">Agent</div>
          <div className="bubble assistant">
            {item.text || (item.live ? '' : '…')}
            {item.live && <span className="caret" />}
          </div>
        </div>
      )
    case 'tool':
      return <ToolCall item={item} />
    case 'approval':
      return <ApprovalCard item={item} onRespond={onRespond} />
    default:
      return null
  }
}

const TOOL_LABELS: Record<string, string> = {
  run_aml: 'Run AML',
  run_odata_query: 'OData Query',
  list_itemtypes: 'List ItemTypes',
  introspect_itemtype: 'Introspect ItemType',
  get_method_source: 'Get Method Source'
}

function humanizeTool(name: string): string {
  if (!name) return 'Tool'
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ')
}

function ToolCall({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }): JSX.Element {
  const running = item.result === undefined
  const input = describeToolInput(item.args)
  return (
    <div className={`tool-call${item.isError ? ' error' : ''}`}>
      <div className="tool-call-header">
        <span className="tool-call-icon">⚙</span>
        <span className="tool-call-kind">Tool</span>
        <span className="tool-call-name">{humanizeTool(item.name)}</span>
        {running ? (
          <span className="spinner" title="running…" />
        ) : (
          <span className={`pill ${item.isError ? 'red' : 'green'}`}>
            {item.isError ? 'error' : 'done'}
          </span>
        )}
      </div>
      {input && (
        <div className="tool-section">
          <div className="tool-section-label">{input.label}</div>
          <pre className="code">{input.code}</pre>
        </div>
      )}
      {item.result !== undefined && (
        <details className="tool-section" open>
          <summary className="tool-section-label">Result</summary>
          <pre className="code">{formatResult(item.result)}</pre>
        </details>
      )}
    </div>
  )
}

function ApprovalCard({
  item,
  onRespond
}: {
  item: Extract<ChatItem, { kind: 'approval' }>
  onRespond: (approvalId: string, approved: boolean) => void
}): JSX.Element {
  return (
    <div className={`approval${item.status === 'pending' ? '' : ' resolved'}`}>
      <div className="approval-header">
        <span className="approval-icon">⚠</span>
        <span className="approval-title">
          Approve write via <code>{item.tool}</code>
        </span>
        {item.status !== 'pending' && (
          <span className={`pill ${item.status === 'approved' ? 'green' : 'red'}`}>
            {item.status}
          </span>
        )}
      </div>
      <div className="approval-summary">{item.summary}</div>
      <pre className="code">{extractAml(item.payload)}</pre>
      {item.status === 'pending' && (
        <div className="approval-actions">
          <button onClick={() => onRespond(item.approvalId, true)}>Approve &amp; Run</button>
          <button className="danger" onClick={() => onRespond(item.approvalId, false)}>
            Deny
          </button>
        </div>
      )}
    </div>
  )
}

function safeFormatAml(aml: string): string {
  try {
    return formatAml(aml)
  } catch {
    return aml
  }
}

/** Pick the most useful field out of a tool's args and render it as code, not raw JSON. */
function describeToolInput(args: unknown): { label: string; code: string } | null {
  if (args === undefined || args === null) return null
  if (typeof args !== 'object') return { label: 'Input', code: String(args) }
  const a = args as Record<string, unknown>
  if (typeof a.aml === 'string') return { label: 'AML', code: safeFormatAml(a.aml) }
  if (typeof a.query === 'string') return { label: 'OData', code: a.query }
  const keys = Object.keys(a)
  if (keys.length === 0) return null
  if (keys.length === 1 && typeof a[keys[0]] === 'string') {
    return { label: keys[0], code: String(a[keys[0]]) }
  }
  return { label: 'Input', code: JSON.stringify(a, null, 2) }
}

function extractAml(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'aml' in payload) {
    return safeFormatAml(String((payload as { aml: unknown }).aml))
  }
  return JSON.stringify(payload, null, 2)
}

const MAX_RESULT_CHARS = 8000

/** Pretty-print a JSON tool result; leave anything else as-is. Capped for the DOM. */
function formatResult(result: string): string {
  let out = result
  const trimmed = result.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      out = JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      out = result
    }
  }
  return out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}\n… (truncated)` : out
}
