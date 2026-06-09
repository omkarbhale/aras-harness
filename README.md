# Aras Harness

An agentic developer harness for **Aras Innovator** — conceptually a coding agent (like
Claude Code), but for AML/OData. An LLM agent reasons about your intent and accomplishes
it by calling tools against a **live Aras instance** (run AML, introspect schema, read
method source), with a **human approval gate** before any write. A manual AML query pane
sits alongside the chat.

## Stack

- **Electron** (security-first: `contextIsolation`, `sandbox`, no `nodeIntegration`)
- **LangGraph.js** (`createReactAgent` + `interrupt()` for approvals + checkpointing)
- **TypeScript** (strict), **React**, **Vite** (via `electron-vite`)
- Multi-provider LLM: **Anthropic / OpenAI / Ollama** (configurable, your keys)

## Architecture

The domain logic lives in `src/core/` and is **framework-agnostic** — no Electron, no
React — so it is unit-tested in isolation and can be reused behind any UI or transport.

```
src/
  shared/   IPC contract (DTOs + AgentEvent union) — imported by both processes
  core/     domain logic (no Electron/React)
    aras/   ArasClient (OAuth + REST/OData), AML parser  — the only Aras-aware code
    llm/    createChatModel() factory over LangChain BaseChatModel
    agent/  AgentService (LangGraph), ToolRegistry, tools, write-approval gate
    config/ zod settings schema + SettingsService (secret-free DTOs)
  main/     Electron lifecycle, IPC handlers, electron-store/safeStorage adapters
  preload/  contextBridge typed `window.api`
  renderer/ React UI: features/{chat,query,connections,settings}
```

Dependency rule: `renderer → shared`, `main → core + shared`, `core → nothing app-specific`.

## Develop

```bash
npm install
npm run dev         # launch the app (electron-vite)
npm test            # core unit tests (no Aras/LLM needed)
npm run typecheck   # tsc for node + web projects
npm run build       # production bundle
```

## End-to-end usage

1. **Connections** tab → add your Aras instance (URL, database, user, password) → **Test**.
   Auth uses the modern OAuth flow (Aras 12 / 2024 / 29): discovery → password grant → bearer token.
2. **Settings** tab → pick an LLM provider/model and enter your API key (stored encrypted
   via the OS keychain).
3. **Agent** tab → ask e.g. *"List the 10 most recently created Parts"*. Watch the agent
   introspect the schema, run AML, and stream its answer. A write request (e.g. *"Add a
   Part TEST-001"*) pauses for your **Approve / Deny**.
4. **Query** tab → run raw AML against the active connection and view results in a grid.

## Security

Credentials and API keys live only in the main process, encrypted at rest with Electron
`safeStorage`. The renderer receives secret-free DTOs and a narrow, typed IPC surface.

## Roadmap (architecture leaves room for)

Monaco editor + AML IntelliSense · MCP tool loading (`@langchain/mcp-adapters` merges into
`ToolRegistry`) · method authoring/deploy · export/import & diff · conversation history.
