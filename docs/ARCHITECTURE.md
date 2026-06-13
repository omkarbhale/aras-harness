# Architecture

Two front-ends — Electron desktop and `aras` CLI — sit on top of one framework-agnostic core. The same `AppServices` instance, the same `AgentService.runUntilPause` loop, the same sqlite state, the same `AgentEvent` stream.

## Layering rules

```
                  ┌─────────────────────┐         ┌─────────────────────┐
                  │   Electron Main     │         │       aras CLI      │
                  │  (registerIpc.ts)   │         │  (commands/agent)   │
                  └──────────┬──────────┘         └──────────┬──────────┘
                             │                               │
                             ▼                               ▼
                  ┌────────────────────────────────────────────────────┐
                  │            core/services/AppServices               │
                  │   (composition root; pure DI; no framework deps)   │
                  └──────────────────────┬─────────────────────────────┘
                                         │
              ┌──────────────┬───────────┼───────────┬──────────────┐
              ▼              ▼           ▼           ▼              ▼
          core/aras     core/agent   core/llm   core/config   core/persistence
          (ArasClient)  (LangGraph)  (factory)  (Settings)    (sqlite/*)
```

**Dependency rule:** core depends on nothing app-specific. Main and CLI both depend on core. Renderer depends only on `shared/` (the typed IPC contract). Shared has zero runtime deps — it's pure types and channel names.

This is enforced socially, not by tooling, but the import paths make violations conspicuous. The benefit: every core file is unit-testable in isolation under vitest (33 tests today), and a third front-end (web, headless cron, MCP server) would be a `buildXxxServices.ts` + a thin transport.

## Directory map

```
src/
├── shared/
│   └── ipc.ts                          types, IpcChannels, AgentEvent union, HarnessApi
│
├── core/                               framework-agnostic domain logic
│   ├── aras/
│   │   ├── ArasClient.ts               OAuth (Aras 12/2024/29) + AML + OData
│   │   ├── amlParser.ts                fast-xml-parser wrapper, SOAP fault decode
│   │   ├── http.ts                     bounded retry (jittered backoff), AbortSignal-aware
│   │   └── errors.ts                   ArasAuthError, ArasRequestError, ArasFaultError
│   ├── agent/
│   │   ├── AgentService.ts             runUntilPause; LangGraph adapter
│   │   ├── ToolRegistry.ts             tool collection w/ a fluent register API
│   │   ├── tools.ts                    run_aml, run_odata_query, list_itemtypes, ...
│   │   ├── amlIntrospection.ts         isWriteAml + summarizeAml (write-detection heuristic)
│   │   └── eventLog.ts                 AgentEventLog interface
│   ├── llm/
│   │   ├── LlmProviderFactory.ts       createChatModel: anthropic | openai | ollama
│   │   └── index.ts
│   ├── config/
│   │   ├── settings.ts                 zod schemas, ConfigStore + SecretStore interfaces
│   │   └── SettingsService.ts          DTO-safe API; secrets stay inside the service
│   ├── persistence/sqlite/
│   │   ├── openDb.ts                   single shared better-sqlite3 instance
│   │   ├── SqliteCheckpointer.ts       BaseCheckpointSaver implementation
│   │   ├── SqliteEventLog.ts           agent_events table — full event-source log
│   │   ├── SqliteThreadStore.ts        threads + listSummaries (window-fn query)
│   │   └── SqliteRunStore.ts           runs table — for CLI cross-process resume + cancel
│   └── services/
│       └── AppServices.ts              composition root (DI ctor; no Electron imports)
│
├── main/                               Electron-only adapters
│   ├── index.ts                        BrowserWindow + lifecycle
│   ├── services/
│   │   └── buildElectronServices.ts    wires safeStorage + electron-store + sqlite
│   ├── store/
│   │   ├── ElectronConfigStore.ts      ConfigStore impl over electron-store
│   │   └── SafeStorageSecretStore.ts   SecretStore impl over Electron safeStorage
│   └── ipc/
│       ├── registerIpc.ts              every ipcMain.handle()
│       └── InProcessApprovalBus.ts     in-process approval rendezvous (desktop only)
│
├── preload/
│   └── index.ts                        contextBridge → `window.api`
│
├── renderer/                           React UI
│   ├── App.tsx
│   ├── styles.css
│   └── features/
│       ├── chat/
│       │   ├── ChatPanel.tsx           main view, sidebar layout
│       │   ├── ChatSidebar.tsx         thread list with new/rename/delete
│       │   ├── useAgent.ts             reduceEvent + live subscription + history replay
│       │   └── useThreads.ts           thread list state + IPC roundtrip
│       ├── connections/
│       │   └── ConnectionsPanel.tsx
│       ├── query/
│       │   └── QueryPanel.tsx          raw AML against active connection
│       └── settings/
│           └── SettingsPanel.tsx
│
└── cli/                                external-LLM-callable shell
    ├── index.ts                        commander entry (#!/usr/bin/env node)
    ├── buildCliServices.ts             wires keytar + file config + sqlite
    ├── paths.ts                        per-OS data/config dirs (no env-paths dep)
    ├── stdin.ts                        --stdin helper (rejects TTY)
    ├── exit.ts                         ExitCode enum + error→code classifier
    ├── store/
    │   ├── FileConfigStore.ts          ConfigStore impl over JSON file
    │   └── KeytarSecretStore.ts        SecretStore impl over OS keychain
    ├── printer/
    │   ├── Printer.ts                  interface
    │   ├── TextPrinter.ts              human-readable; meta to stderr
    │   └── NdjsonPrinter.ts            one event per line on stdout
    └── commands/
        ├── connection.ts
        ├── settings.ts
        ├── thread.ts
        └── agent.ts                    send | resume | cancel
```

## Core

### `core/aras` — the only Aras-aware code

`ArasClient` wraps the modern OAuth flow (discovery → password grant → bearer token) and exposes `runAml` (writes + reads via `applyItem.aspx`) and `runODataQuery` (read-only). Errors are typed (`ArasAuthError` / `ArasRequestError` / `ArasFaultError`) so the CLI's exit classifier can route them to code 30 and the UI can show actionable remediation.

`http.ts` retries with **jittered exponential backoff** and is fully `AbortSignal`-aware. Default is infinite retry (the agent's tool layer caps it via `maxRetryAttempts` when configured); cancelling the run aborts in-flight requests cleanly.

### `core/agent` — the agent loop

`AgentService` is a thin adapter over LangGraph's `createReactAgent`. Its only public method during a turn is:

```ts
runUntilPause(args: {
  runId: string
  threadId: string
  input: HumanMessage | Command       // HumanMessage to start, Command({resume}) to continue
  emit: (event: AgentEvent) => void
}): Promise<{ status: 'done' } | { status: 'paused', approvalId, request }>
```

One call = one streamed segment. It returns `done` when the graph finishes, or `paused` when a tool calls `interrupt(approvalRequest)`. The system prompt is injected exactly once per thread, detected by probing `agent.getState({configurable:{thread_id}})` for an existing message history — so the prompt survives restarts but isn't duplicated.

**There is no `pendingApprovals` Map and no `provideApproval` method on `AgentService` anymore.** Callers loop on `runUntilPause` themselves:

- The **desktop** wraps the loop in `registerIpc.ts/driveAgentRun`. When `runUntilPause` returns `paused`, it awaits an in-process `InProcessApprovalBus.awaitDecision(approvalId)` Promise that `agent:approve` resolves.
- The **CLI** wraps the loop in `commands/agent.ts/driveCliRun`. When `runUntilPause` returns `paused`, it persists the approval state to the `runs` table and exits with code 10. A later `aras agent resume` invocation in a fresh process loads the row and calls `runUntilPause` again with `Command({resume:{approved}})`.

The LangGraph checkpointer (sqlite) holds the actual graph state — both surfaces just feed Commands in.

#### Tools

`createArasTools` returns five Zod-validated tools:

| Tool | Purpose |
|---|---|
| `run_aml` | Execute any AML; write detection via regex + `interrupt(approvalRequest)`; read retries with backoff |
| `run_odata_query` | Read-only OData GET against `/server/odata` |
| `list_itemtypes` | Enumerate all ItemType names |
| `introspect_itemtype` | Get an ItemType + its Property definitions (schema discovery) |
| `get_method_source` | Fetch a server/client Method's source code |

`isWriteAml` is a regex heuristic (`action="add|update|delete|edit|create"`) — see ROADMAP for the hardening it deserves.

### `core/persistence/sqlite` — one DB, four tables (+ LangGraph)

A single `better-sqlite3` database file holds:

| Table | Purpose |
|---|---|
| `threads` | Conversation metadata: id, name, createdAt, updatedAt, archivedAt |
| `runs` | Per-agent-turn lifecycle: runId, threadId, status, approvalId, approvalPayload (JSON), pid, cancelRequested |
| `agent_events` | Full event-source log; `seq` is monotonic per thread; every `AgentEvent` persists at source |
| `checkpoints*` | LangGraph's own tables managed by `@langchain/langgraph-checkpoint-sqlite` |

`SqliteThreadStore.listSummaries` joins messageCount + first-user-message preview via a window function in a single query — drives the sidebar without per-thread N+1s.

### `core/config` — secrets stay inside

`SettingsService` is the only place that touches `SecretStore`. Public methods return secret-free DTOs (`hasPassword`, `hasApiKey`); raw values never escape the service. The renderer never sees a password. The IPC handler that takes a new password from the user passes it straight from `ConnectionsPanel` to `SettingsService.saveConnection` and discards it.

`SecretStore` is **async** so a sync OS-keychain shim (like a `deasync` hack on keytar) is unnecessary. `SafeStorageSecretStore` returns sync values inside `async` methods to match.

### `core/services/AppServices`

The composition root. Constructed once per process by either `buildElectronServices` or `buildCliServices`. Owns the singletons (`SettingsService`, `SqliteThreadStore`, `SqliteRunStore`, `SqliteEventLog`, the checkpointer) and **lazily** builds an `AgentService` + the active `ArasClient` on first use. Invalidates them on config change.

## Main process (Electron)

`main/index.ts` builds a `BrowserWindow` with `contextIsolation: true`, `sandbox: true`, no `nodeIntegration`. `preload/index.ts` exposes a typed `window.api` via `contextBridge`.

`registerIpc.ts` is the entire IPC surface — one `ipcMain.handle` per channel, every handler a thin adapter over `AppServices`. The agent trio:

- `agent:send({threadId, message})` — generates a runId, kicks off `driveAgentRun` in the background, returns `{runId}` synchronously
- `agent:approve({approvalId, approved})` — resolves the in-process bus Promise
- `agent:cancel(runId)` — aborts the run's `AbortController` via an `activeRuns` Map

Events stream **to** the renderer via a push channel: `agent:event`, sent through `WebContents.send` for every emit.

## Renderer

The renderer is a small React app. Every panel is a feature folder; the chat feature is the bulk.

### `features/chat`

`ChatPanel` owns the active `threadId` (with `localStorage` memory of the last opened), renders `ChatSidebar` + the message list, wires up `useThreads` for thread CRUD and `useAgent(threadId)` for the active conversation.

`useAgent` is the event-stream → UI transcript adapter:

- `reduceEvent(prev, event, nextId)` is a **pure reducer** — given previous items and one event, returns new items
- Live `agent:event` subscription pipes events straight into the reducer
- On `threadId` change, calls `threads:loadEvents` and re-feeds the persisted stream through the same reducer — restored transcripts include tool args, approval pill state (`approved`/`denied`/`pending`), and errors, byte-identically to the original session

This shape means anything we add to the live stream — say, a `progress` event for long-running tools — automatically shows up in replay with zero extra wiring.

### Other panels

- **`features/connections`** — CRUD over connections, with a Test button that runs the OAuth round-trip and reports latency.
- **`features/settings`** — LLM provider + model + key, plus agent tuning (tool timeout, max retry attempts).
- **`features/query`** — raw AML against the active connection. The agent loop bypassed; useful for power users.

## CLI

`cli/index.ts` builds the same `AppServices` from `FileConfigStore` + `KeytarSecretStore` + sqlite, then dispatches commander to one of four command modules.

`driveCliRun` in `commands/agent.ts` is the structural twin of `driveAgentRun` in the desktop's `registerIpc.ts` — same `runUntilPause` + `emit(eventLog.append + printer)` pattern. The differences are intentional:

- **No `InProcessApprovalBus`.** A pause persists to disk and exits 10; a separate process resumes by reading sqlite and calling `runUntilPause(Command({resume}))`. This works because LangGraph's checkpoint state lives in the same sqlite file regardless of process.
- **Cancel is cross-process.** `aras agent cancel <runId>` writes `cancelRequested=1` and sends SIGINT to the recorded pid. The `send` process's SIGINT handler aborts, and a 500ms `cancelRequested` poll covers the cross-console SIGINT-delivery hole on Windows.

## Persistence shapes

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  archivedAt INTEGER
);

CREATE TABLE runs (
  runId TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  status TEXT NOT NULL,                 -- running | paused | done | error | cancelled
  approvalId TEXT,                      -- non-null when status='paused'
  approvalPayload TEXT,                 -- JSON of the ApprovalRequest payload
  pid INTEGER,                          -- for cross-process cancel
  startedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  cancelRequested INTEGER DEFAULT 0
);

CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  threadId TEXT NOT NULL,
  runId TEXT NOT NULL,
  seq INTEGER NOT NULL,                 -- monotonic per thread
  type TEXT NOT NULL,
  payload TEXT NOT NULL,                -- JSON-encoded AgentEvent
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_agent_events_thread ON agent_events(threadId, seq);

-- plus LangGraph's own tables (checkpoints, writes, ...) managed by SqliteSaver
```

## What each surface supports

| Capability | Desktop | CLI |
|---|---|---|
| Connection CRUD + Test | ✓ | ✓ |
| LLM + agent settings | ✓ | ✓ |
| Threads: list, new, rename, delete | ✓ | ✓ |
| Transcript replay on open | ✓ | `aras thread show <id>` |
| Send a message to the agent | ✓ | ✓ |
| Tool calls + streaming output | ✓ (streaming UI) | ✓ (NDJSON or text) |
| Write-approval gate | UI modal | exit-code 10 + `agent resume` |
| Cancel a run | Stop button | `aras agent cancel <runId>` |
| Raw AML query | ✓ (Query tab) | not exposed (use agent or build a script) |
| Side-by-side multiple threads | one active in the UI | each shell process owns one threadId at a time |

## Cross-surface storage caveat

The two front-ends do **not** currently share state by default:

| Resource | Desktop location | CLI location |
|---|---|---|
| Config | `%APPDATA%/aras-harness/config.json` (electron-store keyed under `app`) | `%APPDATA%/aras-harness/Config/config.json` (raw `AppConfig` shape) |
| Secrets | Electron `safeStorage` (DPAPI) in `%APPDATA%/aras-harness/secrets.json` | OS keychain via `keytar` |
| State (threads, events, runs, checkpoints) | `app.getPath('userData')/state.sqlite` | `%LOCALAPPDATA%/aras-harness/Data/state.sqlite` |

This is intentional for the initial release — secrets in particular cannot be shared between Electron's `safeStorage` and `keytar` without rewriting one of them — but a "unified storage" mode would be a real quality-of-life win for users who want to switch between surfaces freely. See ROADMAP.

## Testing

- **33 unit tests** under vitest cover `core/aras` (HTTP + OAuth + AML parsing), `core/agent/amlIntrospection`, `core/config/SettingsService`, `core/llm/LlmProviderFactory`, and `core/persistence/sqlite`.
- No tests for `AgentService.runUntilPause` end-to-end yet — it requires either a real LangGraph or a complex mock. Worth filling in (see ROADMAP).
- No tests for IPC handlers; the layer is thin enough that it's mostly covered transitively by `core` tests.
- Smoke testing for the CLI is manual and documented in [docs/CLI.md](CLI.md).
