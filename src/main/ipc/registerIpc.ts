import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { HumanMessage } from '@langchain/core/messages'
import { Command } from '@langchain/langgraph'
import {
  IpcChannels,
  type AgentEvent,
  type AgentSettings,
  type AgentSettingsInput,
  type Connection,
  type ConnectionInput,
  type LlmSettings,
  type LlmSettingsInput,
  type TestResult,
  type ThreadSummary
} from '@shared/ipc'
import type { AppServices } from '@core/services'
import { InProcessApprovalBus } from './InProcessApprovalBus'

const DEFAULT_THREAD_NAME = 'New chat'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Registers all IPC handlers. Handlers are thin adapters: validate-ish input, call into
 * core services, return DTOs. The agent's send/approve/cancel handlers form the only
 * stateful trio: send drives a `runUntilPause` loop that pauses on approval, the bus
 * resolves an in-process Promise when approve arrives, and cancel aborts the loop.
 */
export function registerIpc(services: AppServices, sendEvent: (event: AgentEvent) => void): void {
  const approvals = new InProcessApprovalBus()
  // Tracks the currently running turn so `agent:cancel` can route to the right AC.
  const activeRuns = new Map<string, AbortController>()

  // -- Connections --------------------------------------------------------
  ipcMain.handle(
    IpcChannels.connectionsList,
    (): Promise<Connection[]> => services.settings.listConnections()
  )

  ipcMain.handle(
    IpcChannels.connectionsSave,
    async (_e, input: ConnectionInput): Promise<Connection> => {
      const dto = await services.settings.saveConnection(input)
      services.invalidateConnection()
      return dto
    }
  )

  ipcMain.handle(IpcChannels.connectionsDelete, async (_e, id: string): Promise<void> => {
    await services.settings.deleteConnection(id)
    services.invalidateConnection()
  })

  ipcMain.handle(IpcChannels.connectionsSetActive, (_e, id: string): void => {
    services.settings.setActiveConnection(id)
    services.invalidateConnection()
  })

  ipcMain.handle(IpcChannels.connectionsGetActive, (): string | null =>
    services.settings.getActiveConnectionId()
  )

  ipcMain.handle(IpcChannels.connectionsTest, async (_e, id: string): Promise<TestResult> => {
    try {
      const client = await services.buildClientFor(id)
      const { latencyMs } = await client.testConnection()
      return { ok: true, message: 'Connected successfully.', latencyMs }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  // -- LLM settings -------------------------------------------------------
  ipcMain.handle(
    IpcChannels.settingsGetLlm,
    (): Promise<LlmSettings | null> => services.settings.getLlmSettings()
  )

  ipcMain.handle(
    IpcChannels.settingsSaveLlm,
    async (_e, input: LlmSettingsInput): Promise<LlmSettings> => {
      const dto = await services.settings.saveLlmSettings(input)
      services.invalidateAgent()
      return dto
    }
  )

  ipcMain.handle(IpcChannels.settingsGetAgent, (): AgentSettings =>
    services.settings.getAgentSettings()
  )

  ipcMain.handle(IpcChannels.settingsSaveAgent, (_e, input: AgentSettingsInput): AgentSettings => {
    const dto = services.settings.saveAgentSettings(input)
    services.invalidateAgent()
    return dto
  })

  // -- Manual query -------------------------------------------------------
  ipcMain.handle(IpcChannels.queryRunAml, async (_e, body: string) => {
    const client = await services.getActiveClient()
    return client.runAml(body)
  })

  // -- Threads ------------------------------------------------------------
  ipcMain.handle(IpcChannels.threadsList, (): ThreadSummary[] =>
    services.threadStore.listSummaries().map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: row.messageCount,
      preview: row.preview
    }))
  )

  ipcMain.handle(
    IpcChannels.threadsCreate,
    (_e, input: { name?: string } = {}): ThreadSummary => {
      const id = randomUUID()
      const record = services.threadStore.create({ id, name: input.name?.trim() || DEFAULT_THREAD_NAME })
      return {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: 0,
        preview: null
      }
    }
  )

  ipcMain.handle(
    IpcChannels.threadsRename,
    (_e, input: { id: string; name: string }): void => {
      const next = input.name.trim()
      if (!next) return
      services.threadStore.rename(input.id, next)
    }
  )

  ipcMain.handle(IpcChannels.threadsDelete, (_e, id: string): void => {
    services.deleteThread(id)
  })

  ipcMain.handle(IpcChannels.threadsLoadEvents, (_e, id: string): AgentEvent[] =>
    services.eventLog.listByThread(id)
  )

  // -- Agent --------------------------------------------------------------
  ipcMain.handle(
    IpcChannels.agentSend,
    (_e, input: { threadId: string; message: string }): { runId: string } => {
      const runId = randomUUID()
      const { threadId, message } = input
      // Ensure the thread row exists (caller may have created it via threadsCreate, but
      // legacy paths or a deleted-then-re-sent thread should self-heal).
      if (!services.threadStore.get(threadId)) {
        services.threadStore.create({ id: threadId, name: DEFAULT_THREAD_NAME })
      }
      const ac = new AbortController()
      activeRuns.set(runId, ac)

      void driveAgentRun({ runId, threadId, message, services, sendEvent, approvals, ac })
        .finally(() => {
          if (activeRuns.get(runId) === ac) activeRuns.delete(runId)
        })

      return { runId }
    }
  )

  ipcMain.handle(
    IpcChannels.agentApprove,
    (_e, input: { approvalId: string; approved: boolean }): void => {
      approvals.provide(input.approvalId, { approved: input.approved })
    }
  )

  ipcMain.handle(IpcChannels.agentCancel, (_e, runId?: string): void => {
    if (runId) {
      const ac = activeRuns.get(runId)
      if (ac) ac.abort()
    } else {
      // Fallback for legacy callers that didn't pass a runId — abort all.
      for (const ac of activeRuns.values()) ac.abort()
    }
    services.cancelCurrentRun()
  })
}

interface DriveRunInput {
  runId: string
  threadId: string
  message: string
  services: AppServices
  sendEvent: (e: AgentEvent) => void
  approvals: InProcessApprovalBus
  ac: AbortController
}

/**
 * Drives one user message to completion: spins through `runUntilPause` + approval
 * waits, persisting every emitted event to the eventLog as it goes. Errors and
 * abort are surfaced as terminal `error` + `done` events.
 */
async function driveAgentRun(input: DriveRunInput): Promise<void> {
  const { runId, threadId, message, services, sendEvent, approvals, ac } = input
  const emit = (event: AgentEvent): void => {
    services.eventLog.append(threadId, runId, event)
    sendEvent(event)
  }

  // Auto-name a freshly created thread from its first user message before any events fire,
  // so the UI's sidebar shows a meaningful title instead of "New chat" the moment it lands.
  const thread = services.threadStore.get(threadId)
  if (thread && thread.name === DEFAULT_THREAD_NAME) {
    const title = message.trim().split(/\s+/).join(' ').slice(0, 60)
    if (title) services.threadStore.rename(threadId, title)
  }

  emit({ type: 'run_start', runId })
  emit({ type: 'user_message', runId, content: message })
  try {
    const agent = await services.getOrCreateAgent()
    let next: HumanMessage | Command = new HumanMessage(message)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await agent.runUntilPause({ runId, threadId, input: next, emit })
      if (result.status === 'done') break
      const decision = await approvals.awaitDecision(result.approvalId, ac.signal)
      next = new Command({ resume: decision })
    }
    services.threadStore.touch(threadId)
    emit({ type: 'done', runId })
  } catch (error) {
    services.threadStore.touch(threadId)
    if (ac.signal.aborted) {
      emit({ type: 'done', runId })
    } else {
      emit({ type: 'error', runId, message: errorMessage(error) })
      emit({ type: 'done', runId })
    }
  }
}
