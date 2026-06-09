import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import {
  IpcChannels,
  type AgentEvent,
  type Connection,
  type ConnectionInput,
  type LlmSettings,
  type LlmSettingsInput,
  type TestResult
} from '@shared/ipc'
import type { AppServices } from '../services/AppServices'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Registers all IPC handlers. Handlers are thin adapters: validate-ish input, call into
 * core services, return DTOs. The only stateful concern here is forwarding the agent's
 * event stream to the renderer via `sendEvent`.
 */
export function registerIpc(services: AppServices, sendEvent: (event: AgentEvent) => void): void {
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

  // -- Manual query -------------------------------------------------------
  ipcMain.handle(IpcChannels.queryRunAml, (_e, body: string) =>
    services.getActiveClient().runAml(body)
  )

  // -- Agent --------------------------------------------------------------
  ipcMain.handle(IpcChannels.agentSend, (_e, message: string): { runId: string } => {
    const runId = randomUUID()
    // Fire-and-forget: results stream back over the agentEvent channel.
    void (async () => {
      try {
        const agent = services.getOrCreateAgent()
        await agent.run(runId, message, sendEvent)
      } catch (error) {
        sendEvent({ type: 'error', runId, message: errorMessage(error) })
        sendEvent({ type: 'done', runId })
      }
    })()
    return { runId }
  })

  ipcMain.handle(
    IpcChannels.agentApprove,
    (_e, input: { approvalId: string; approved: boolean }): void => {
      services.peekAgent()?.provideApproval(input.approvalId, input.approved)
    }
  )
}
