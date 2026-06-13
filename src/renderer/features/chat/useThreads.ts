import { useCallback, useEffect, useState } from 'react'
import type { ThreadSummary } from '@shared/ipc'

/**
 * Thread list state for the sidebar. The list is refreshed on demand (after
 * create/rename/delete/send) and on every agent `done` event so the sidebar's
 * messageCount + preview reflect the latest persisted state.
 */
export function useThreads(): {
  threads: ThreadSummary[]
  refresh: () => Promise<void>
  create: (name?: string) => Promise<ThreadSummary>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
} {
  const [threads, setThreads] = useState<ThreadSummary[]>([])

  const refresh = useCallback(async () => {
    const list = await window.api.threads.list()
    setThreads(list)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Refresh the sidebar after every run completes so titles + counts catch up.
  useEffect(() => {
    return window.api.agent.onEvent((event) => {
      if (event.type === 'done' || event.type === 'error') void refresh()
    })
  }, [refresh])

  const create = useCallback(
    async (name?: string) => {
      const t = await window.api.threads.create(name ? { name } : {})
      await refresh()
      return t
    },
    [refresh]
  )

  const rename = useCallback(
    async (id: string, name: string) => {
      await window.api.threads.rename({ id, name })
      await refresh()
    },
    [refresh]
  )

  const remove = useCallback(
    async (id: string) => {
      await window.api.threads.remove(id)
      await refresh()
    },
    [refresh]
  )

  return { threads, refresh, create, rename, remove }
}
