#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ConnectionManager } from './connection'
import { ArasTools, type ToolResult } from './tools'

const VERSION = '0.2.0'

/** Adapt our flat ToolResult into the MCP CallToolResult shape. */
function toMcp(result: ToolResult): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text', text: result.text }], isError: result.isError }
}

export function createServer(tools: ArasTools): McpServer {
  const server = new McpServer({ name: 'aras-mcp', version: VERSION })

  server.registerTool(
    'aras_connect',
    {
      title: 'Connect to Aras',
      description:
        'Authenticate against an Aras Innovator (v12+) instance and make it the active connection ' +
        'for this session. Pass a saved `profile` name, and/or inline `url`/`database`/`username`/`password`. ' +
        'Passwords may also come from ARAS_PASSWORD / ARAS_PASSWORD_<PROFILE> env vars. Call this first.',
      inputSchema: {
        profile: z.string().optional().describe('Saved profile name (see aras_list_profiles).'),
        url: z.string().optional().describe('Base instance URL, e.g. https://plm.corp.com/InnovatorServer'),
        database: z.string().optional().describe('Aras database name.'),
        username: z.string().optional().describe('Aras username.'),
        password: z.string().optional().describe('Password (omit to use an env var instead).')
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args) => toMcp(await tools.connect(args))
  )

  server.registerTool(
    'aras_list_profiles',
    {
      title: 'List connection profiles',
      description: 'List saved Aras connection profiles (names + url/database; never secrets).',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => toMcp(tools.listProfiles())
  )

  server.registerTool(
    'aras_status',
    {
      title: 'Connection status',
      description: 'Report whether there is an active Aras connection and its round-trip latency.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => toMcp(await tools.status())
  )

  server.registerTool(
    'aras_whoami',
    {
      title: 'Current Aras user',
      description:
        'Identify the user this session is authenticated as: returns the connected login, its Aras ' +
        'User `id`, display name, and email, plus the active connection name and database. The `id` is ' +
        'what `created_by_id` / `owned_by_id` / `managed_by_id` filters match on — call this once instead ' +
        'of looking up your own User item before "created by me" queries.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async () => toMcp(await tools.whoami()),
  )

  server.registerTool(
    'aras_run_query',
    {
      title: 'Run AML query (read-only)',
      description:
        'Run a read-only AML query (action="get") against the active instance. Rejects mutating AML — ' +
        'use aras_run_write for changes. Pass a complete document, e.g. ' +
        '<AML><Item type="Part" action="get" select="id,item_number" maxRecords="25"/></AML>. ' +
        'Results are capped at 50 items; for larger sets page with the AML attributes ' +
        '`page` + `pagesize` (1-based) — the response then includes a `page` block ' +
        '{ page, pageMax, itemMax } so you know the true total and how many pages remain.',
      inputSchema: {
        aml: z.string().describe('A complete read-only AML document wrapped in <AML>...</AML>.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ aml }) => toMcp(await tools.runQuery(aml))
  )

  server.registerTool(
    'aras_run_write',
    {
      title: 'Run AML write (mutating)',
      description:
        'Execute MUTATING AML (add/update/delete/promoteItem/lock/unlock/...) against the active ' +
        'instance. Runs once, never retried. Requires a recognized mutating action; use ' +
        'aras_run_query for reads. Note: custom server-method actions are not recognized as ' +
        'mutating — invoke those with care.',
      inputSchema: {
        aml: z.string().describe('A complete mutating AML document wrapped in <AML>...</AML>.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ aml }) => toMcp(await tools.runWrite(aml))
  )

  server.registerTool(
    'aras_run_odata',
    {
      title: 'Run OData query (read-only)',
      description:
        'Run a read-only OData GET against /server/odata, e.g. ' +
        '`Part?$top=10&$select=item_number,name&$filter=...`. ' +
        'Verbose @odata navigation annotations are stripped (the @aras.keyed_name / @aras.id ' +
        'labels are kept); oversized responses are truncated at a row boundary as valid JSON with ' +
        'a `@truncated` marker — page with $top/$skip and trim fields with $select.',
      inputSchema: {
        query: z.string().describe('OData path + query appended to /server/odata/')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query }) => toMcp(await tools.runOData(query))
  )

  server.registerTool(
    'aras_list_itemtypes',
    {
      title: 'List ItemTypes',
      description: 'List the names of all ItemTypes defined in the active instance.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async () => toMcp(await tools.listItemTypes())
  )

  server.registerTool(
    'aras_introspect_itemtype',
    {
      title: 'Introspect an ItemType',
      description:
        'Get an ItemType with its Property definitions (name, label, data_type) and the RelationshipTypes ' +
        'whose source is this ItemType. Use before writing AML to learn the schema and relationships.',
      inputSchema: {
        name: z.string().describe('Exact ItemType name, e.g. "Part".')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ name }) => toMcp(await tools.introspectItemType(name))
  )

  server.registerTool(
    'aras_get_method',
    {
      title: 'Get Method source',
      description: 'Fetch the source code (method_code) and type of a server/client Method by name.',
      inputSchema: {
        name: z.string().describe('Exact Method name.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ name }) => toMcp(await tools.getMethod(name))
  )

  server.registerTool(
    'aras_import',
    {
      title: 'Import a package manifest',
      description:
        'Import an Aras solution into the active instance from a manifest file (.mf), using the ' +
        'Aras package import/export utilities. Pass the absolute path to the .mf; package folders are ' +
        'resolved relative to it. Mutates the target instance (merge import). Returns the engine ' +
        'messages plus the import log. Windows-only (runs the .NET utilities via PowerShell).',
      inputSchema: {
        manifestPath: z.string().describe('Absolute path to the manifest (.mf) file to import.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ manifestPath }) => toMcp(await tools.importManifest(manifestPath))
  )

  server.registerTool(
    'aras_export',
    {
      title: 'Export items to a folder',
      description:
        'Export a list of items from the active instance into an EMPTY target folder, using the Aras ' +
        'package import/export utilities. Each item is a triplet { itemType, itemId, keyedName }. Items ' +
        'are grouped automatically by the package they belong to — one call can span many packages. ' +
        'The folder must already exist and be empty (a non-empty folder is rejected). Items that belong ' +
        'to no package are rejected with their names listed. Writes the exported XML plus a re-importable ' +
        '`imports.mf` enumerating every exported package, and returns the engine messages and export log. ' +
        'Windows-only (runs the .NET utilities via PowerShell).',
      inputSchema: {
        outDir: z.string().describe('Absolute path to an existing, EMPTY folder to export into.'),
        items: z
          .array(
            z.object({
              itemType: z.string().describe('ItemType name, e.g. "Part".'),
              itemId: z.string().describe('The item id (32-char) to export.'),
              keyedName: z.string().describe('Keyed name / label; used as the exported file name.')
            })
          )
          .min(1)
          .describe('Items to export, as { itemType, itemId, keyedName } triplets.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async ({ outDir, items }) => toMcp(await tools.exportItems(outDir, items))
  )

  return server
}

async function main(): Promise<void> {
  const conn = new ConnectionManager()
  const tools = new ArasTools(conn)
  const server = createServer(tools)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr is safe for logs on stdio transport (stdout carries the protocol).
  process.stderr.write(`aras-mcp ${VERSION} ready on stdio\n`)
}

main().catch((e) => {
  process.stderr.write(`aras-mcp failed to start: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
