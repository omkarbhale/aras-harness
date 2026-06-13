import { useState } from 'react'
import type { ThreadSummary } from '@shared/ipc'

interface ChatSidebarProps {
  threads: ThreadSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

/** Past-conversation list with new / rename / delete. Click an item to open it. */
export function ChatSidebar(props: ChatSidebarProps): JSX.Element {
  const { threads, activeId, onSelect, onNew, onRename, onDelete } = props

  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar-header">
        <span className="chat-sidebar-title">Conversations</span>
        <button className="chat-sidebar-new" onClick={onNew} title="New conversation">
          + New
        </button>
      </div>
      <ul className="chat-sidebar-list">
        {threads.length === 0 && (
          <li className="muted chat-sidebar-empty">No conversations yet.</li>
        )}
        {threads.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === activeId}
            onSelect={() => onSelect(t.id)}
            onRename={(name) => onRename(t.id, name)}
            onDelete={() => onDelete(t.id)}
          />
        ))}
      </ul>
    </aside>
  )
}

function ThreadRow({
  thread,
  active,
  onSelect,
  onRename,
  onDelete
}: {
  thread: ThreadSummary
  active: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onDelete: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(thread.name)

  const submit = (): void => {
    const next = draft.trim()
    if (next && next !== thread.name) onRename(next)
    setEditing(false)
  }

  return (
    <li className={`chat-thread ${active ? 'active' : ''}`}>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') {
              setDraft(thread.name)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button className="chat-thread-button" onClick={onSelect} title={thread.preview ?? ''}>
          <div className="chat-thread-name">{thread.name}</div>
          {thread.preview && <div className="chat-thread-preview">{thread.preview}</div>}
        </button>
      )}
      <div className="chat-thread-actions">
        <button
          className="ghost"
          title="Rename"
          onClick={() => {
            setDraft(thread.name)
            setEditing(true)
          }}
        >
          ✎
        </button>
        <button
          className="ghost danger"
          title="Delete"
          onClick={() => {
            if (confirm(`Delete "${thread.name}"? This cannot be undone.`)) onDelete()
          }}
        >
          ✕
        </button>
      </div>
    </li>
  )
}
