import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent } from '@shared/ipc'

export type ChatItem =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string; live: boolean }
  | { id: number; kind: 'tool'; toolCallId: string; name: string; args: unknown; result?: string; isError?: boolean }
  | {
      id: number
      kind: 'approval'
      approvalId: string
      tool: string
      summary: string
      payload: unknown
      status: 'pending' | 'approved' | 'denied'
    }

/**
 * Pure reducer over the agent event stream. Used both for the live subscription
 * and for replaying a thread's persisted events when the sidebar selection changes.
 * Each event yields a new `ChatItem[]` — no side effects.
 */
function reduceEvent(prev: ChatItem[], event: AgentEvent, nextId: () => number): ChatItem[] {
  const items = [...prev]
  switch (event.type) {
    case 'user_message': {
      // Close any live assistant bubble — the user just sent a new message.
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.live) {
        items[items.length - 1] = { ...last, live: false }
      }
      items.push({ id: nextId(), kind: 'user', text: event.content })
      return items
    }
    case 'token': {
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.live) {
        items[items.length - 1] = { ...last, text: last.text + event.delta }
      } else {
        items.push({ id: nextId(), kind: 'assistant', text: event.delta, live: true })
      }
      return items
    }
    case 'assistant_message': {
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.live && last.text.length === 0) {
        items[items.length - 1] = { ...last, text: event.content }
      }
      return items
    }
    case 'tool_start': {
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.live) {
        items[items.length - 1] = { ...last, live: false }
      }
      items.push({
        id: nextId(),
        kind: 'tool',
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args
      })
      return items
    }
    case 'tool_end': {
      const idx = items.findIndex(
        (it) => it.kind === 'tool' && it.toolCallId === event.toolCallId && it.result === undefined
      )
      if (idx >= 0) {
        const tool = items[idx] as Extract<ChatItem, { kind: 'tool' }>
        items[idx] = { ...tool, result: event.result, isError: event.isError }
      }
      return items
    }
    case 'approval_request': {
      items.push({
        id: nextId(),
        kind: 'approval',
        approvalId: event.approvalId,
        tool: event.tool,
        summary: event.summary,
        payload: event.payload,
        status: 'pending'
      })
      return items
    }
    case 'error': {
      items.push({ id: nextId(), kind: 'assistant', text: `⚠️ ${event.message}`, live: false })
      return items.map((it) => (it.kind === 'assistant' && it.live ? { ...it, live: false } : it))
    }
    case 'done': {
      return items.map((it) => (it.kind === 'assistant' && it.live ? { ...it, live: false } : it))
    }
    case 'run_start':
    default:
      return items
  }
}

/**
 * Bridges the streamed AgentEvent feed into a renderable chat transcript and exposes
 * `send` / `respond`. Accepts a threadId; on change, replays the thread's persisted
 * events through the same reducer the live feed uses, so transcript restoration is
 * pixel-identical to the original session.
 */
export function useAgent(threadId: string | null) {
  const [items, setItems] = useState<ChatItem[]>([])
  const [busy, setBusy] = useState(false)
  const nextId = useRef(0)
  const currentRunId = useRef<string | null>(null)
  const id = useCallback(() => nextId.current++, [])

  // Live event subscription. Only events for the currently selected thread should
  // mutate state — events from other threads (e.g. a run still completing on a
  // backgrounded thread) are ignored here; they'll be in the event log when the
  // user returns to that thread.
  const handleEvent = useCallback((event: AgentEvent) => {
    if ((event as { runId?: string }).runId !== undefined) {
      // Only update if this event belongs to the active run, OR no active run yet
      // and we're between turns on the same thread (rare).
      // The simpler invariant: currentRunId tracks the locally-initiated run; we
      // accept any event with that runId. Foreign runIds (other threads / windows)
      // are dropped.
      if (currentRunId.current && event.runId !== currentRunId.current) return
    }
    setItems((prev) => reduceEvent(prev, event, id))
    if (event.type === 'done' || event.type === 'error') {
      setBusy(false)
    }
  }, [id])

  useEffect(() => window.api.agent.onEvent(handleEvent), [handleEvent])

  // Replay history on threadId change.
  useEffect(() => {
    let cancelled = false
    if (!threadId) {
      setItems([])
      setBusy(false)
      nextId.current = 0
      currentRunId.current = null
      return
    }
    void window.api.threads.loadEvents(threadId).then((events) => {
      if (cancelled) return
      nextId.current = 0
      currentRunId.current = null
      let acc: ChatItem[] = []
      for (const ev of events) {
        acc = reduceEvent(acc, ev, id)
      }
      setItems(acc)
      setBusy(false)
    })
    return () => {
      cancelled = true
    }
  }, [threadId, id])

  const send = useCallback(
    (message: string) => {
      if (!threadId) return
      setBusy(true)
      void window.api.agent.send({ threadId, message }).then(({ runId }) => {
        currentRunId.current = runId
      })
    },
    [threadId]
  )

  const cancel = useCallback(() => {
    const runId = currentRunId.current
    if (runId) void window.api.agent.cancel(runId)
  }, [])

  const respond = useCallback((approvalId: string, approved: boolean) => {
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'approval' && it.approvalId === approvalId
          ? { ...it, status: approved ? 'approved' : 'denied' }
          : it
      )
    )
    void window.api.agent.approve(approvalId, approved)
  }, [])

  return useMemo(
    () => ({ items, busy, send, respond, cancel }),
    [items, busy, send, respond, cancel]
  )
}
