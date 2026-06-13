# CLI Reference

The `aras` CLI exposes the same backend the desktop app uses. It is designed so a human or an **external LLM** can drive the agent loop from PowerShell or bash, one shell invocation at a time. Each call is stateless from the caller's perspective; the agent's conversation state, run state, and event stream persist to a sqlite file on disk.

## Why a CLI

- **Automation.** Drive batch operations, CI jobs, or one-off scripts against an Aras instance without launching a desktop app.
- **External LLM as caller.** A higher-level agent in another tool (or another model) can use `aras` as a callable subprocess: send a message, parse the NDJSON stream, branch on the exit code, decide whether to resume a pending approval.
- **Scriptable approvals.** Write-AML approvals are exposed as a process exit (code 10) with the pending decision printed to stdout, instead of as a UI modal. A separate `aras agent resume` invocation supplies the decision and the agent picks up exactly where it left off.

## Quickstart

```powershell
# Build the CLI bundle (CJS, ~80 KB, host-Node):
npm run build:cli
node dist/cli/index.js --help      # or `npm link` then plain `aras --help`

# First-time creds (CLI stores are separate from the desktop app — see ARCHITECTURE.md):
"pw" | aras connection add --name dev --url "http://host/InnovatorServer" --db "DB" --user "admin" --password-stdin
aras connection set-active dev
"sk-..." | aras settings llm set --provider openai --model gpt-4o-mini --api-key-stdin

# Drive the agent:
aras agent send "List the 5 most recently created Parts."
```

## Output

- **Default = human text.** Streamed tokens render as a continuous assistant paragraph on **stdout**; meta lines (tool starts, tool results, approval requests, errors) go to **stderr** so a pipe consumer can still capture just the content.
- **`--json` = NDJSON.** One `AgentEvent` per line on stdout — the exact same shape as the in-process event bus the desktop app uses. Schema: see `AgentEvent` in `src/shared/ipc.ts`.

## Exit codes

Stable, so an LLM caller can branch without parsing stdout:

| Code | Name | Meaning |
|---|---|---|
| 0 | `Ok` | Run finished cleanly |
| 1 | `Unexpected` | Anything not classified below |
| 10 | `PendingApproval` | Run paused on a write-AML interrupt. Inspect, then call `aras agent resume` |
| 20 | `Denied` | `aras agent resume --decision deny` completed; the agent reported the write was not executed |
| 30 | `Connection` | Aras auth / network / fault error (`ArasAuthError` / `ArasRequestError` / `ArasFaultError`) |
| 40 | `Llm` | LLM provider not configured, bad API key, or model init failure |

## Commands

### `aras connection <subcommand>`

CRUD over Aras connections. `<id-or-name>` accepts a UUID *or* a unique connection name; ambiguous names fall back to requiring the id.

```
aras connection list
aras connection add --name <n> --url <u> --db <d> --user <u> --password-stdin
aras connection remove <id-or-name>
aras connection set-active <id-or-name>
aras connection get-active                    # prints the active id (or nothing)
aras connection test <id-or-name>             # OAuth round-trip + latency
```

Passwords are accepted on **stdin only** (never on argv — they'd leak to shell history).

### `aras settings <group> <subcommand>`

```
aras settings llm get
aras settings llm set --provider <anthropic|openai|ollama> --model <m> [--base-url <u>] [--api-key-stdin]
aras settings agent get
aras settings agent set --tool-timeout <sec> [--max-retry-attempts <n>]
```

- `--api-key-stdin` reads the key from stdin; omit on re-save to keep the existing key.
- `--max-retry-attempts` caps read-tool retries; omit to keep the infinite-retry default.

### `aras thread <subcommand>`

Conversation threads — the same ones the desktop sidebar lists, sharing the same sqlite file when both surfaces point at the same data dir (they currently don't by default — see ARCHITECTURE.md).

```
aras thread new [--name <n>]                  # prints the new thread id
aras thread list [--json]
aras thread show <id> [--text]                # NDJSON event stream (default) or human transcript
aras thread rename <id> --name <new>
aras thread delete <id>                       # cascades event log + runs
```

### `aras agent <subcommand>`

The agent loop. This is the one part the CLI does *differently* from the desktop: approvals are not modals, they are exits.

```
aras agent send "<message>" [--thread <id>] [--json]
aras agent resume <runId> --decision allow|deny [--json]
aras agent cancel <runId>
```

#### `aras agent send`

1. Resolves the thread (creates a new one if `--thread` is omitted; auto-names it from the first 60 chars of the message).
2. Generates a new `runId`, prints it on **stderr**, registers the process pid in the `runs` table.
3. Streams the agent's events through the chosen printer.
4. On `done` → exit 0. On write-approval `interrupt()` → persist `runs.status='paused'` + `approvalId` + `approvalPayload`, emit a final `approval_request` event, exit **10**. On error → exit 30/40/1 per the classifier.

#### `aras agent resume <runId>`

1. Loads the paused run from sqlite.
2. Re-instantiates the agent (fresh process, same checkpointer, same threadId).
3. Calls `runUntilPause` with `new Command({ resume: { approved: <decision==='allow'> } })` — LangGraph picks up from the checkpoint, the `interrupt()` returns the decision the tool was awaiting, execution continues.
4. Same exit-code surface as `send`. A clean completion after `deny` exits **20** so the caller can distinguish "agent ran and reported no write" from "all good, write happened".

#### `aras agent cancel <runId>`

1. Writes `runs.cancelRequested=1`.
2. Sends `SIGINT` to the `runs.pid` of the owning process.

The owning process catches either: the SIGINT handler aborts the in-flight `AbortController`, *or* a 500 ms poll of `cancelRequested` does the same for cross-console cases (Windows often won't deliver SIGINT across consoles).

## Scripted approval flow

```powershell
$out = aras agent send "Add a Part TEST-001" --json 2>$null
if ($LASTEXITCODE -eq 10) {
  $approval = $out -split "`n" | Where-Object { $_ -match '"approval_request"' } | ConvertFrom-Json
  # ... your LLM / human inspects $approval.payload.aml ...
  $runId = ($out -split "`n" | Where-Object { $_ -match '"run_start"' } | ConvertFrom-Json).runId
  aras agent resume $runId --decision allow
}
```

## Storage locations

- **Config**: `%APPDATA%/aras-harness/Config/config.json` (Windows) / `~/.config/aras-harness/config.json` (Linux) / `~/Library/Preferences/aras-harness/config.json` (macOS)
- **Secrets**: OS keychain under service name `aras-harness`
- **State** (threads, runs, agent events, LangGraph checkpoints): `%LOCALAPPDATA%/aras-harness/Data/state.sqlite` / `~/.local/share/aras-harness/state.sqlite` / `~/Library/Application Support/aras-harness/state.sqlite`

These are **independent of the desktop app's locations** — see ARCHITECTURE.md for why and the (not-yet-built) path to unifying them.

## Known limits

- The CLI does not currently call out the desktop's `safeStorage`-encrypted secrets, so a connection set up in the desktop must be re-added on the CLI side.
- gpt-4o-mini (and other smaller models) tend to ask for confirmation in chat instead of calling `run_aml` for write operations. Once the tool is actually called, the approval flow works perfectly; force the call with an explicit "use run_aml directly" in your message, or use a stronger model.
