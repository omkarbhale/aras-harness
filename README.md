# Aras Harness

Two front-ends, one backend. A LangGraph agent that reasons about your intent and accomplishes it against a **live Aras Innovator** instance through tools — AML execution, schema introspection, method-source lookup — with a **human approval gate** before any write.

- **Electron desktop app** — chat, transcript history, manual AML query pane.
- **`aras` CLI** — same backend, callable from PowerShell / bash by a human or by an external LLM. Stateless per shell call; conversation state persists to disk.

Both surfaces share the same domain logic (`src/core/`), the same sqlite-backed state, the same event-sourced transcript.

## Stack

- **Electron** (security-first: `contextIsolation`, `sandbox`, no `nodeIntegration`) for the desktop UI
- **LangGraph.js** — `createReactAgent`, `interrupt()` for approvals, sqlite checkpointer
- **TypeScript** strict, **React**, **Vite** (`electron-vite`)
- **Commander** + **tsup** for the CLI; **keytar** for OS keychain on CLI; Electron `safeStorage` for the renderer
- **better-sqlite3** for state persistence (threads, runs, agent events, LangGraph checkpoints)
- Multi-provider LLM: **Anthropic / OpenAI / Ollama**

## Quickstart — desktop

```bash
npm install
npm run dev         # launches Electron with HMR
```

Then in the app: **Connections** → add your Aras instance and Test → **Settings** → pick an LLM + API key → **Agent** → ask away. **Query** runs raw AML against the active connection.

## Quickstart — CLI

```bash
npm run build:cli                    # tsup → dist/cli/index.js (~80 KB CJS)
node dist/cli/index.js --help        # or `npm link` then plain `aras --help`

# One-time setup (separate store from the desktop app, see docs/ARCHITECTURE.md):
"my-aras-password" | aras connection add --name dev \
  --url "http://host/InnovatorServer" --db "InnovatorSolutions" --user admin --password-stdin
aras connection set-active dev
"sk-..." | aras settings llm set --provider openai --model gpt-4o-mini --api-key-stdin

# Drive the agent:
aras agent send "List 5 Part item_numbers."
```

Full CLI reference: [docs/CLI.md](docs/CLI.md).

## Documentation

- **[docs/CLI.md](docs/CLI.md)** — every command, every flag, every exit code, scripted-usage patterns
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — code layout, layering rules, how the two front-ends share core, the agent + approval flow in detail, persistence schema
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — what's intentionally not built yet and what the design leaves room for

## Develop

```bash
npm install
npm run dev         # Electron app with HMR
npm test            # core unit tests — no Aras, no LLM required
npm run typecheck   # tsc -p tsconfig.node.json && tsconfig.web.json
npm run build       # production Electron bundle
npm run build:cli   # CLI bundle (CJS, node20 target)
```

Native bindings: `better-sqlite3` is rebuilt automatically by `npm run dev` / `npm test` / `npm run cli` to match the right ABI (Electron's vs host Node's). If you bounce between surfaces, expect a one-second rebuild step.

## Security

- Connection passwords and LLM API keys never reach the renderer process and are never accepted on argv.
  - **Desktop:** encrypted at rest via Electron `safeStorage` (DPAPI on Windows, Keychain on macOS).
  - **CLI:** OS keychain via `keytar` (Windows Credential Manager / macOS Keychain / libsecret).
- All writes to Aras pause for explicit approval (UI modal in the desktop app; exit-code-10 in the CLI).
- Renderer ↔ main IPC is a narrow, typed contract (`src/shared/ipc.ts`).
