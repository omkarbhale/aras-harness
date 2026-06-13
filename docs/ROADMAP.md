# Roadmap (unapproved)

Future work the architecture leaves room for, grouped by what they buy. Nothing here is committed; each item is a paragraph and a sketch, not a spec. Pick what serves your goals.

## Reliability & safety

### Harden write detection
`amlIntrospection.isWriteAml` is a regex (`action="(add|update|delete|edit|create)"`). It can be defeated by case variations, comments, or CDATA. A proper XML parse + an allow-list of read actions (`get`, plus AML-method invocations that are demonstrably read-only) would close the bypass and let the harness say "I don't recognise this action — treating as a write" instead of silently letting it through. Cost: ~half a day, plus tests.

### Single-flight token refresh
`ArasClient` handles 401s by re-authenticating, but two concurrent requests racing to refresh aren't deduped. Wrap the refresh in a `Promise` cache keyed by `(instanceUrl, database, username)` so N concurrent expirations result in one OAuth round-trip. Trivial change; matters more under tool parallelism (below).

### SOAP fault decoding breadth
`amlParser` reads `faultcode` + `faultstring`. Aras sometimes emits `detail.message` (especially for permission errors). Extend the parser + add fixtures from real fault responses.

### `getState` shape unit test
The "system prompt once" logic in `AgentService.runUntilPause` branches on whether `agent.getState({configurable:{thread_id}})` returns an empty-ish state. The exact shape on empty threads (`{}` vs `undefined values`) is LangGraph-version-dependent. A unit test would catch a duplicate-or-missing system message on a future bump.

## Agent intelligence

### Stronger system prompt for writes
gpt-4o-mini (and other smaller models) tend to ask for confirmation in chat rather than call `run_aml` for writes. The current prompt politely *describes* the approval flow; making it directive ("**Do not** ask in chat. Call `run_aml`. The user will approve at the interrupt.") plus a worked example in the prompt would push smaller models to act. Pairs with a test fixture: run a known write request against a fake LLM that always asks for confirmation, then assert the prompt makes the model call the tool.

### Tool parallelism
`createReactAgent` supports concurrent tool calls; this harness currently runs serial. Setting `max_concurrency` and inspecting whether the streaming UI handles interleaved `tool_start`/`tool_end` events correctly would unlock real speedup on multi-table reads. Risk: the OData rate-limit story on Aras is fuzzy; needs a knob.

### Streaming long tool output
Some tools (a Method source dump, a big OData page) return kilobytes. The UI currently waits for the whole result then prints. Tools could emit incremental events (`tool_chunk`) and the reducer could append them. Useful for human UX; less important for an LLM caller.

### Subagent / planner-executor split
A cheap planner model picks tools and writes AML; an expensive executor model only weighs in on natural-language synthesis. The composition root already supports per-call model overrides; this is a `runUntilPause` config addition + a planning prompt.

### Context windowing
Long threads accumulate messages until the LLM hits its context limit. Today there's no pruning. A summary-and-trim pass on every Nth turn (or token-budget overrun) is a few hundred lines.

### Structured-output mode
When the user asks for a table or list, return JSON the UI renders natively. `withStructuredOutput` exists in LangChain; the agent could conditionally route to it based on a "format" intent classifier in the prompt.

## Tooling & ecosystem

### MCP tool loading
Plumb `@langchain/mcp-adapters` into `ToolRegistry`. Users add external tools (Jira, git, doc search) by configuring an MCP server URL in Settings — no recompile. The tool list becomes runtime-dynamic; tools.ts becomes one source of tools among many. This is the single biggest architectural multiplier here.

### Per-tool config
`tool_timeout` and `max_retry_attempts` are global. Some tools (`introspect_itemtype` against a slow instance) want longer timeouts; some (`run_aml` writes) want zero retries already. A per-tool override declared on the tool itself, with sensible defaults, is a 1-day change.

### Tool-level structured errors
Currently a tool's error is a string in the `tool_end` event. A structured `{ code, message, retryable }` shape would let the agent (and the UI) make smarter decisions. Pairs with the AML parser breadth work.

## Observability & evaluation

### OpenTelemetry tracing
A trace per agent run, with spans for each tool call + LLM hop. Drops into Honeycomb / Datadog / Jaeger. Adds a "Runs" debug panel in the desktop that shows the trace tree inline. Surfaces all the latency the user can't see today.

### Per-tool metrics
Persist a `tool_metrics` table: latency, retry count, success/error per call. Surface "your slowest tools this week" in Settings. Cheap to compute from `agent_events`; doesn't even need a new table if we accept the query cost.

### Eval harness
A directory of golden tasks — "List 5 Parts", "Add a Part TEST-001 then delete it", "Show me the Method source for X" — each with a deterministic grader that asserts the agent reached the expected end-state. Runs in CI on each prompt/LLM change. The CLI is *exactly* the shape this needs: each task is `aras agent send` + assertions on the NDJSON stream + exit code.

### Approval audit log
Every approve/deny becomes a row in an `approval_audit` table (timestamp, user, AML hash, decision). Compliance need for write tools in regulated environments.

## CLI & multi-surface

### Unified storage option
Make the CLI optionally point its `cliPaths()` and secret backend at the desktop's. Three pieces:
1. `aras config --use-electron-data` flag that resolves `app.getPath('userData')` (via a sibling util) and writes a `.cli-config.json` pointing the file/sqlite stores there.
2. A SafeStorage-over-CLI shim — calls the Electron app via IPC if running, otherwise falls back to keytar. Hard problem; not worth it unless storage unification matters.
3. Document the trade-off and offer storage migration scripts as a middle path.

### `aras agent send --auto-approve`
For trusted CI batch runs, a flag that pre-authorises all writes (or specific tool names). Off by default. Logs each auto-approval to the audit table above.

### `aras query <aml-file>`
Drop the "agent path only" decision — a raw-AML CLI command is cheap and useful for scripts that already know what they want. Saves an LLM round-trip.

### Daemonized agent (long-running mode)
Skip the per-shell-call process spin-up: `aras agent serve` runs a local socket; `aras agent send --socket ...` is a thin client. Same architecture, way less startup latency. Best for very chatty external-LLM callers.

### Connection / settings import from the desktop
`aras config import-from-electron` reads the electron-store config.json, prompts for the connection password + LLM key (because secrets can't be auto-imported across keystores), and writes the CLI-side equivalents. The single biggest QoL win for users who set things up in the desktop first.

## UI

### Search across threads
Full-text search over `agent_events.payload` (sqlite FTS5 virtual table). The event log is already the right granularity; just needs a search box and a query.

### Pin / archive threads
Sidebar gets a pin column; `threads.archivedAt` already exists and is queried out of the default list — just expose archive/unarchive actions.

### Export a thread
"Save as Markdown" button on each thread → dumps a clean transcript with tool args + results + approval decisions. Useful for incident reports, sharing, fine-tune dataset gathering.

### Diff view for write previews
When an approval is pending, show the *current* state of the items the AML would touch alongside the proposed change. Requires running a sibling read AML before pausing — the agent could do this itself with a smarter system prompt, but a UI-side diff renderer is the higher-leverage piece.

### Monaco AML editor
Replace the Query panel's textarea with Monaco + AML grammar + IntelliSense for ItemType / Property names (pulled from `list_itemtypes` / `introspect_itemtype`). Big undertaking; high return for power users.

## Testing & code-health

### AgentService.runUntilPause integration test
Spin up an in-memory LangGraph + a stub LLM + a stub tool that calls `interrupt()`. Assert: first call returns `paused`, second call (with `Command({resume:{approved:true}})`) finishes. This is the central invariant of the harness and currently has no automated coverage.

### Eval harness as a test backstop
Same idea as above but at the integration level: golden tasks running against a recorded LLM (cassette-style) hit predictable Aras endpoints (recorded too). Catches regressions in `tools.ts`, `amlParser`, the prompt, and the agent loop all at once.

### Replace `tsc -p` builds with project references
Two tsconfigs (`node` + `web`) currently typecheck-only. Project references would let `tsc -b` incrementally build both with shared `core` declarations — meaningful CI speedup once the codebase grows.

## Deployment

### Single-binary CLI
`bun build --compile` or `pkg` to ship a no-Node-required binary. Currently `npm install -g .` works fine for dev, but for distribution to ops folks who don't want to manage Node, a binary helps.

### Auto-update for the desktop app
`electron-updater` + a GitHub release feed. Standard but unimplemented.

### Code-signing
Required for non-flagged distribution on macOS and Windows. Not done.

## Strategic angles

### What this harness is good at
- One-off and exploratory work against an Aras instance, where the LLM does the schema discovery for you.
- Batch operations behind a script when paired with the CLI.
- Teaching: the system prompt + tools are short and readable; a developer can grok the entire agent loop in an afternoon.

### What it isn't (yet)
- A replacement for an Aras client library — `ArasClient` covers AML + OData and OAuth, but not the WSDL/SOAP surface, file vault uploads, or workflow signoff. Adding those is straightforward in the existing client.
- A real audit trail. Approvals fire and the decision lands in `runs.approvalPayload`, but there's no per-user attribution and no immutable log.
- A team tool. State is local sqlite per machine. Multi-user with shared history would need a server and a different storage backend.

### The bet to consider
The biggest single design choice still on the table is **MCP**. If you go there, this harness becomes a runtime container for arbitrary tools (not just Aras), the Aras tools become one bundled pack of many, and external LLM callers can subscribe to tool sets dynamically. That changes the product from "Aras agent" to "agent platform with first-class Aras support". Worth a serious think.
