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
  type TestResult
} from '@shared/ipc'
import type { AppServices } from '../services/AppServices'
import { InProcessApprovalBus } from './InProcessApprovalBus'

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
  ipcMain.handle(IpcChannels.connectionsList, (): Connection[] => services.settings.listConnections())

  ipcMain.handle(IpcChannels.connectionsSave, (_e, input: ConnectionInput): Connection => {
    const dto = services.settings.saveConnection(input)
    services.invalidateConnection()
    return dto
  })

  ipcMain.handle(IpcChannels.connectionsDelete, (_e, id: string): void => {
    services.settings.deleteConnection(id)
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
      const { latencyMs } = await services.buildClientFor(id).testConnection()
      return { ok: true, message: 'Connected successfully.', latencyMs }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  // -- LLM settings -------------------------------------------------------
  ipcMain.handle(IpcChannels.settingsGetLlm, (): LlmSettings | null =>
    services.settings.getLlmSettings()
  )

  ipcMain.handle(IpcChannels.settingsSaveLlm, (_e, input: LlmSettingsInput): LlmSettings => {
    const dto = services.settings.saveLlmSettings(input)
    services.invalidateAgent()
    return dto
  })

  ipcMain.handle(IpcChannels.settingsGetAgent, (): AgentSettings =>
    services.settings.getAgentSettings()
  )

  ipcMain.handle(IpcChannels.settingsSaveAgent, (_e, input: AgentSettingsInput): AgentSettings => {
    const dto = services.settings.saveAgentSettings(input)
    services.invalidateAgent()
    return dto
  })

  // -- Manual query -------------------------------------------------------
  ipcMain.handle(IpcChannels.queryRunAml, (_e, body: string) =>
    services.getActiveClient().runAml(body)
  )

  // -- Agent --------------------------------------------------------------
  ipcMain.handle(IpcChannels.agentSend, (_e, message: string): { runId: string } => {
    const runId = randomUUID()
    const threadId = services.resolveActiveThreadId()
    const ac = new AbortController()
    activeRuns.set(runId, ac)

    void driveAgentRun({ runId, threadId, message, services, sendEvent, approvals, ac })
      .finally(() => {
        if (activeRuns.get(runId) === ac) activeRuns.delete(runId)
      })

    return { runId }
  })

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

  emit({ type: 'run_start', runId })
  try {
    const agent = services.getOrCreateAgent()
    // Abort propagation: cancelling the run also wakes any pending approval await.
    let next: HumanMessage | Command = new HumanMessage(message)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await agent.runUntilPause({ runId, threadId, input: next, emit })
      if (result.status === 'done') break
      const decision = await approvals.awaitDecision(result.approvalId, ac.signal)
      next = new Command({ resume: decision })
    }
    emit({ type: 'done', runId })
  } catch (error) {
    if (ac.signal.aborted) {
      emit({ type: 'done', runId })
    } else {
      emit({ type: 'error', runId, message: errorMessage(error) })
      emit({ type: 'done', runId })
    }
  }
}
