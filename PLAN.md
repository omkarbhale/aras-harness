# Aras MCP Server — Migration Plan

## Goal

Convert this repo from a standalone Electron/LangGraph agentic harness into an
**MCP server + skills** for Aras Innovator (v12+). The Aras domain logic (OAuth,
AML, OData, parsing, retry, write-gating) is the value and is portable; the agent
loop, Electron UI, CLI, LLM provider, and persistence are commodity harness work
that existing hosts (Claude Code, OpenCode, Cursor) already provide.

Same MCP server serves every host: internal dev tooling, end-user clients built
on OpenCode's client/server, or a custom client on the Claude Agent SDK.

## Keep (port — the gold)

| Source | Destination | Change |
|---|---|---|
| `src/core/aras/ArasClient.ts` | `src/aras/ArasClient.ts` | multi-instance via MCP `connect`; else as-is |
| `src/core/aras/http.ts` | `src/aras/http.ts` | as-is |
| `src/core/aras/amlParser.ts` | `src/aras/amlParser.ts` | import types locally, not `@shared/ipc` |
| `src/core/aras/errors.ts` | `src/aras/errors.ts` | as-is |
| `src/core/aras/types.ts` | `src/aras/types.ts` | **new** — `AmlItem`/`AmlResult` lifted out of `@shared/ipc` |
| `src/core/agent/amlIntrospection.ts` | `src/aras/amlIntrospection.ts` | as-is (`isWriteAml`/`summarizeAml`) |
| tests for the above | alongside | keep |

## Delete (harness cruft)

- `src/main/**`, `src/preload/**`, `src/renderer/**` — Electron + React
- `src/core/agent/**` (except amlIntrospection) — LangGraph loop, ToolRegistry, AgentService, eventLog
- `src/core/llm/**` — provider factory (host owns the model)
- `src/core/persistence/**` — sqlite checkpointer/threads/runs (host owns sessions)
- `src/core/config/**`, `src/core/services/**` — app wiring for the old harness
- `src/cli/**` — own CLI
- `src/shared/ipc.ts` — IPC contract (Electron-only)
- `electron.vite.config.ts`, `out/**`, `cli-ps-set.ps1`
- docs for old CLI/architecture (rewrite README)

## New structure

```
src/
  aras/                 the portable domain core (moved, ~untouched)
    ArasClient.ts  http.ts  amlParser.ts  errors.ts  types.ts  amlIntrospection.ts
  mcp/
    profiles.ts         connection profiles: JSON config + env-var secrets
    connection.ts       ConnectionManager — holds active ArasClient in memory
    tools.ts            tool registration (connect + 6 Aras tools)
    server.ts           McpServer + stdio transport (entrypoint)
skills/
  writing-aml/SKILL.md
  aras-schema/SKILL.md
  aml-write-safety/SKILL.md
  odata-queries/SKILL.md
```

## Tool surface (MCP)

| Tool | Kind | Notes |
|---|---|---|
| `aras_connect` | — | `{profile}` or inline `{url,database,username,password}`; establishes + caches client |
| `aras_list_profiles` | read | names from config |
| `aras_status` | read | active connection + latency (`testConnection`) |
| `aras_run_query` | read | AML `action="get"` / read-only; retried |
| `aras_run_write` | **destructive** | mutating AML; `destructiveHint:true`; rejects non-write AML; no retry |
| `aras_run_odata` | read | OData GET |
| `aras_list_itemtypes` | read | |
| `aras_introspect_itemtype` | read | props + relationships |
| `aras_get_method` | read | method source |

**Approval model change:** the old LangGraph `interrupt()` write-gate is gone — the
MCP *host* gates tool calls via its own permission prompt. We expose intent through
annotations and by splitting read vs write into separate tools (`aras_run_query`
read-only, `aras_run_write` destructive), so host permissions are precise.
`isWriteAml` is reused to *reject* mutating AML sent to the read tool (defense in
depth) and to summarize writes.

## Auth / "login to any Aras"

- v12+ OAuth only (drop legacy header path).
- `ConnectionManager` holds one active `ArasClient` per server process (stdio = one
  process per client). `aras_connect` once; all tools reuse it; auto token refresh
  on expiry/401 already handled in `ArasClient`.
- Profiles: `~/.aras-mcp/profiles.json` (non-secret: url/db/user). Secrets via
  `ARAS_PASSWORD` / `ARAS_PASSWORD_<PROFILE>` env vars, or passed inline to
  `aras_connect`. No native keychain dep in v1 (keeps `npx` install clean).

## Deps

- **Drop:** `@langchain/*`, `electron*`, `react*`, `react-markdown`, `remark-gfm`,
  `better-sqlite3`, `commander`, `electron-store`, `keytar`, vite/electron-vite, tsup.
- **Keep:** `fast-xml-parser`, `zod`.
- **Add:** `@modelcontextprotocol/sdk`.
- Build: plain `tsc`. Entry `dist/mcp/server.js`, bin `aras-mcp`.

## Tests

- **Unit** (always run, mocked `HttpClient`): tool dispatch, read/write split,
  `isWriteAml` rejection on read tool, profile resolution, connection manager.
  Existing `ArasClient`/`http`/`amlParser` tests retained.
- **Live integration** (gated on `ARAS_TEST_URL`/`_DB`/`_USER`/`_PASSWORD`): real
  `aras_connect` + each read tool against a live v12+ instance. `describe.skipIf`
  when env absent so CI without creds stays green. Writes: a guarded create→delete
  round-trip, only if `ARAS_TEST_ALLOW_WRITE=1`.

## Out of scope (later)

import/export packages, codetree access, keychain secret store, HTTP/SSE transport,
multi-connection concurrency.
