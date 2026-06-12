import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type AgentEvent,
  type AgentSettings,
  type AgentSettingsInput,
  type Connection,
  type ConnectionInput,
  type HarnessApi,
  type LlmSettings,
  type LlmSettingsInput,
  type TestResult,
  type AmlResult
} from '@shared/ipc'

/** The typed bridge exposed on `window.api`. The renderer has no other Node/Electron access. */
const api: HarnessApi = {
  connections: {
    list: () => ipcRenderer.invoke(IpcChannels.connectionsList) as Promise<Connection[]>,
    save: (input: ConnectionInput) =>
      ipcRenderer.invoke(IpcChannels.connectionsSave, input) as Promise<Connection>,
    remove: (id: string) => ipcRenderer.invoke(IpcChannels.connectionsDelete, id) as Promise<void>,
    setActive: (id: string) =>
      ipcRenderer.invoke(IpcChannels.connectionsSetActive, id) as Promise<void>,
    getActive: () => ipcRenderer.invoke(IpcChannels.connectionsGetActive) as Promise<string | null>,
    test: (id: string) => ipcRenderer.invoke(IpcChannels.connectionsTest, id) as Promise<TestResult>
  },
  settings: {
    getLlm: () => ipcRenderer.invoke(IpcChannels.settingsGetLlm) as Promise<LlmSettings | null>,
    saveLlm: (input: LlmSettingsInput) =>
      ipcRenderer.invoke(IpcChannels.settingsSaveLlm, input) as Promise<LlmSettings>,
    getAgent: () => ipcRenderer.invoke(IpcChannels.settingsGetAgent) as Promise<AgentSettings>,
    saveAgent: (input: AgentSettingsInput) =>
      ipcRenderer.invoke(IpcChannels.settingsSaveAgent, input) as Promise<AgentSettings>
  },
  query: {
    runAml: (body: string) => ipcRenderer.invoke(IpcChannels.queryRunAml, body) as Promise<AmlResult>
  },
  agent: {
    send: (message: string) =>
      ipcRenderer.invoke(IpcChannels.agentSend, message) as Promise<{ runId: string }>,
    approve: (approvalId: string, approved: boolean) =>
      ipcRenderer.invoke(IpcChannels.agentApprove, { approvalId, approved }) as Promise<void>,
    cancel: (_runId: string) =>
      ipcRenderer.invoke(IpcChannels.agentCancel) as Promise<void>,
    onEvent: (cb: (event: AgentEvent) => void) => {
      const listener = (_e: unknown, event: AgentEvent): void => cb(event)
      ipcRenderer.on(IpcChannels.agentEvent, listener)
      return () => ipcRenderer.removeListener(IpcChannels.agentEvent, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
