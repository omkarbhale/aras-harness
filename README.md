# aras-mcp

An [MCP](https://modelcontextprotocol.io) server for **Aras Innovator (v12+)**. It gives
any MCP-capable coding agent (Claude Code, OpenCode, Cursor, or a custom client built on
the Claude Agent SDK) the tools to authenticate to an Aras instance and query/introspect/
mutate it over AML and OData — plus a set of skills teaching the agent how to use them well.

The agent loop, UI, and session storage are the host's job. This repo is just the Aras
domain layer (OAuth, AML, OData, parsing, retry, write-gating) exposed as MCP tools.

## Tools

| Tool | Kind | Purpose |
|---|---|---|
| `aras_connect` | — | Authenticate (OAuth password grant) and set the active connection |
| `aras_list_profiles` | read | List saved connection profiles |
| `aras_status` | read | Active connection + round-trip latency |
| `aras_whoami` | read | Connected user's `id`/name/email + connection + database |
| `aras_run_query` | read | Run read-only AML (`action="get"`); rejects mutations |
| `aras_run_write` | **destructive** | Run mutating AML (add/update/delete/promote/…); never retried |
| `aras_run_odata` | read | Run an OData GET against `/server/odata` |
| `aras_list_itemtypes` | read | All ItemType names |
| `aras_introspect_itemtype` | read | Properties + RelationshipTypes of an ItemType |
| `aras_get_method` | read | Source of a Method by name |
| `aras_import` | **destructive** | Import a solution manifest (`.mf`) into the active instance |
| `aras_export` | write (local) | Export items (itemType/itemId/keyedName triplets) into an empty folder |

Reads and writes are deliberately separate tools so the host's permission prompt is
precise: `aras_run_write` carries the MCP `destructiveHint` and is what the host gates.

### Package import / export (Windows-only)

`aras_import` and `aras_export` wrap the Aras package import/export utilities, which
ship only as .NET Framework assemblies (`IOM.dll` + `Libs.dll` / `Aras.Tools.SolutionUpgrade`).
There is no AML/OData equivalent, so these two tools shell out to **Windows PowerShell 5.1**
running the bundled `scripts/import.ps1` / `scripts/export.ps1`; the DLLs are vendored under
`native/`. They re-authenticate with the same OAuth password grant as the active connection
(the password is handed to the child via the `ARAS_PKG_PASSWORD` env var, never the command
line). Each tool returns the engine's progress/error messages **and** the contents of the
engine log file.

- `aras_import` takes the absolute path to a manifest `.mf`; package folders resolve relative
  to it. It merge-imports into the live instance (destructive).
- `aras_export` takes an **empty, existing** target folder and a list of
  `{ itemType, itemId, keyedName }` triplets. It resolves the package each item belongs to
  (`PackageElement → PackageGroup → PackageDefinition`) and groups them, so one call can span
  many packages. Items in **no** package are rejected (listed by name) — add them to a package
  first. A non-empty or missing folder is rejected with a clear assertion error. It writes the
  exported XML plus a re-importable `imports.mf` enumerating every exported package.

## Skills

Markdown guidance the agent can load on demand (`skills/`):

- **writing-aml** — AML document structure, actions, filtering, relationships
- **aras-schema** — the ItemType/Property/RelationshipType/Method metamodel + discovery flow
- **aml-write-safety** — safe mutation practice (scope precisely, verify, no blind retry)
- **odata-queries** — OData v4 query options and when to prefer it over AML

## Install / build

```bash
npm install
npm run build      # tsup -> dist/server.js  (ESM, node20)
npm test           # unit tests (live tests auto-skip without creds)
npm run dev        # run from source via tsx
```

## Connecting to an Aras instance

Three ways to supply credentials, in precedence order per field:

1. **Inline** to `aras_connect`: `{ url, database, username, password }`.
2. **A saved profile** — `~/.aras-mcp/profiles.json` (override path with `ARAS_MCP_CONFIG`):
   ```json
   {
     "profiles": {
       "dev":  { "url": "http://localhost/12sp9",     "database": "12sp9",  "username": "admin", "password": "innovator" },
       "prod": { "url": "https://plm.corp.com/Server", "database": "ProdDB", "username": "svc" }
     }
   }
   ```
   Then `aras_connect({ profile: "dev" })`. A profile's `password` may be stored inline
   (plaintext — convenient on a trusted dev box) **or** omitted and supplied via
   `ARAS_PASSWORD_DEV` / `ARAS_PASSWORD` env vars. Per field, inline `aras_connect` args
   override the profile, which overrides env.

   > Inline passwords are plaintext on disk — keep `profiles.json` out of version control
   > (and prefer env vars for shared/prod instances).
3. **Default env profile**: `ARAS_URL`, `ARAS_DATABASE`, `ARAS_USERNAME`, `ARAS_PASSWORD`,
   used when `aras_connect` is called with no profile and no inline fields.

Auth is Aras's OAuth2 password grant (v12+): the server discovers the token endpoint,
exchanges credentials for a bearer token, caches it, and refreshes on expiry/401.

## Registering with a host

Claude Code (`.mcp.json` or user config):

```json
{
  "mcpServers": {
    "aras": {
      "command": "node",
      "args": ["/abs/path/to/aras-mcp/dist/server.js"],
      "env": { "ARAS_PASSWORD_DEV": "..." }
    }
  }
}
```

After building you can also run the `aras-mcp` bin directly.

## Running live tests

```bash
ARAS_TEST_URL=https://your-instance/InnovatorServer \
ARAS_TEST_DB=YourDatabase \
ARAS_TEST_USER=admin \
ARAS_TEST_PASSWORD=... \
npx vitest run src/mcp/live.test.ts
```

An optional add→delete round-trip runs only with `ARAS_TEST_ALLOW_WRITE=1`,
`ARAS_TEST_WRITE_TYPE`, and `ARAS_TEST_WRITE_KEY` set (use a scratch DB).

## Layout

```
src/aras/   portable Aras domain core (OAuth client, AML parser, retry, write-gate)
src/mcp/    MCP server: profiles, connection manager, tools, packaging driver, stdio entrypoint
scripts/    import.ps1 / export.ps1 — PowerShell drivers for the .NET import/export utilities
native/     vendored Aras .NET Framework DLLs (IOM.dll, Libs.dll) the scripts load
skills/     agent-facing usage guidance
```

See [PLAN.md](PLAN.md) for the design and the migration from the old harness.
Roadmap: codetree access, OS-keychain secrets, HTTP/SSE transport.
