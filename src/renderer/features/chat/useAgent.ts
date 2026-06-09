import { useCallback, useEffect, useRef, useState } from 'react'
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
 * Bridges the streamed AgentEvent feed into a renderable chat transcript and exposes
 * `send` / `respond`. All event handling lives here so the view stays declarative.
 */
export function useAgent() {
  const [items, setItems] = useState<ChatItem[]>([])
  const [busy, setBusy] = useState(false)
  const nextId = useRef(0)
  const id = () => nextId.current++

  const handleEvent = useCallback((event: AgentEvent) => {
    setItems((prev) => {
      const items = [...prev]
      switch (event.type) {
        case 'token': {
          const last = items[items.length - 1]
          if (last && last.kind === 'assistant' && last.live) {
            items[items.length - 1] = { ...last, text: last.text + event.delta }
          } else {
            items.push({ id: id(), kind: 'assistant', text: event.delta, live: true })
          }
          break
        }
        case 'assistant_message': {
          const last = items[items.length - 1]
          if (last && last.kind === 'assistant' && last.live && last.text.length === 0) {
            items[items.length - 1] = { ...last, text: event.content }
          }
          break
        }
        case 'tool_start': {
          // Close any live assistant bubble so later tokens open a fresh one.
          const last = items[items.length - 1]
          if (last && last.kind === 'assistant' && last.live) {
            items[items.length - 1] = { ...last, live: false }
          }
          items.push({
            id: id(),
            kind: 'tool',
            toolCallId: event.toolCallId,
            name: event.name,
            args: event.args
          })
          break
        }
        case 'tool_end': {
          const idx = items.findIndex(
            (it) => it.kind === 'tool' && it.toolCallId === event.toolCallId && it.result === undefined
          )
          if (idx >= 0) {
            const tool = items[idx] as Extract<ChatItem, { kind: 'tool' }>
            items[idx] = { ...tool, result: event.result, isError: event.isError }
          }
          break
        }
        case 'approval_request': {
          items.push({
            id: id(),
            kind: 'approval',
            approvalId: event.approvalId,
            tool: event.tool,
            summary: event.summary,
            payload: event.payload,
            status: 'pending'
          })
          break
        }
        case 'error': {
          items.push({ id: id(), kind: 'assistant', text: `⚠️ ${event.message}`, live: false })
          // An errored run is terminal too — clear "working" and close any live bubble.
          setBusy(false)
          return items.map((it) =>
            it.kind === 'assistant' && it.live ? { ...it, live: false } : it
          )
        }
        case 'done': {
          setBusy(false)
          return items.map((it) =>
            it.kind === 'assistant' && it.live ? { ...it, live: false } : it
          )
        }
        case 'run_start':
        default:
          break
      }
      return items
    })
  }, [])

  useEffect(() => window.api.agent.onEvent(handleEvent), [handleEvent])

  const send = useCallback((message: string) => {
    setItems((prev) => [...prev, { id: nextId.current++, kind: 'user', text: message }])
    setBusy(true)
    void window.api.agent.send(message)
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

  return { items, busy, send, respond }
}
