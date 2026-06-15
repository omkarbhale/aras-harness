import { tool } from '@langchain/core/tools'
import { interrupt } from '@langchain/langgraph'
import { z } from 'zod'
import type { ArasClient } from '../aras'
import { withRetry } from '../aras/http'
import { isWriteAml, summarizeAml } from './amlIntrospection'

/** Decision passed back into the graph when resuming an approval interrupt. */
export interface ApprovalDecision {
  approved: boolean
}

/** Payload surfaced to the UI when a tool pauses for approval. */
export interface ApprovalRequest {
  kind: 'approval'
  approvalId: string
  tool: string
  summary: string
  payload: unknown
}

export interface AgentToolDeps {
  /** Returns the client for the active connection, or throws a readable error. */
  getClient: () => Promise<ArasClient> | ArasClient
  /** Returns the AbortSignal for the current run, if any. */
  getSignal?: () => AbortSignal | undefined
  /** Tool execution timeout in milliseconds (default 30 000). */
  toolTimeoutMs?: number
  /** Optional cap on read-tool retry attempts. Omitted = infinite (default). */
  maxRetryAttempts?: number
  /** Id generator (injectable for tests). */
  genId?: () => string
}

const MAX_ITEMS_IN_RESULT = 50

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(`${toolName} timed out after ${ms / 1000}s`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id))
}

function summarizeResult(items: { id: string; type: string; properties: Record<string, string> }[]): string {
  const truncated = items.slice(0, MAX_ITEMS_IN_RESULT)
  return JSON.stringify({
    count: items.length,
    truncated: items.length > MAX_ITEMS_IN_RESULT,
    items: truncated
  })
}

/**
 * Builds the Aras tool set the agent can call. Read tools run directly; `run_aml`
 * routes any *mutating* AML through a LangGraph `interrupt()` so the user must approve
 * it first — the same primitive a coding agent uses for permission prompts.
 */
export function createArasTools(deps: AgentToolDeps) {
  const genId = deps.genId ?? (() => globalThis.crypto.randomUUID())
  const timeoutMs = deps.toolTimeoutMs ?? 30_000
  const sig = () => deps.getSignal?.()
  const client = (): Promise<ArasClient> => Promise.resolve(deps.getClient())
  const retry = <T>(fn: () => Promise<T>): Promise<T> =>
    withRetry(
      fn,
      sig(),
      deps.maxRetryAttempts !== undefined ? { maxAttempts: deps.maxRetryAttempts } : {}
    )

  const runAml = tool(
    async ({ aml }: { aml: string }) => {
      if (isWriteAml(aml)) {
        const request: ApprovalRequest = {
          kind: 'approval',
          approvalId: genId(),
          tool: 'run_aml',
          summary: summarizeAml(aml),
          payload: { aml }
        }
        // Pauses the graph; resumes with the ApprovalDecision passed via Command({ resume }).
        const decision = interrupt(request) as ApprovalDecision
        if (!decision?.approved) {
          return 'The user did NOT approve this write. The AML was not executed.'
        }
        // Approved write — run once, no retry (avoid duplicate mutations).
        const result = await withTimeout((await client()).runAml(aml, sig()), timeoutMs, 'run_aml')
        return summarizeResult(result.items)
      }
      // Read query — retry with backoff until success or cancellation (cap optional).
      const result = await withTimeout(
        retry(async () => (await client()).runAml(aml, sig())),
        timeoutMs,
        'run_aml'
      )
      return summarizeResult(result.items)
    },
    {
      name: 'run_aml',
      description:
        'Execute an AML query against the live Aras instance. Use for reads (action="get") ' +
        'and writes (add/update/delete). Writes require user approval before they run. ' +
        'Pass a complete AML document, e.g. <AML><Item type="Part" action="get" select="id,item_number" maxRecords="25"/></AML>.',
      schema: z.object({
        aml: z.string().describe('A complete AML document wrapped in <AML>...</AML>.')
      })
    }
  )

  const runOData = tool(
    async ({ query }: { query: string }) => {
      const result = await withTimeout(
        retry(async () => (await client()).runODataQuery(query, sig())),
        timeoutMs,
        'run_odata_query'
      )
      return JSON.stringify(result).slice(0, 8000)
    },
    {
      name: 'run_odata_query',
      description:
        'Run a read-only OData GET against /server/odata. Provide the path + query, e.g. ' +
        '`Part?$top=10&$select=item_number,name&$filter=...`.',
      schema: z.object({
        query: z.string().describe('OData path and query appended to /server/odata/')
      })
    }
  )

  const listItemTypes = tool(
    async () => {
      const result = await withTimeout(
        retry(async () =>
          (await client()).runAml(
            '<AML><Item type="ItemType" action="get" select="name,label" orderBy="name" /></AML>',
            sig()
          )
        ),
        timeoutMs,
        'list_itemtypes'
      )
      const names = result.items.map((i) => i.properties.name).filter(Boolean)
      return JSON.stringify({ count: names.length, itemTypes: names })
    },
    {
      name: 'list_itemtypes',
      description: 'List the names of all ItemTypes defined in the connected Aras instance.',
      schema: z.object({})
    }
  )

  const introspectItemType = tool(
    async ({ name }: { name: string }) => {
      const propsAml =
        `<AML><Item type="ItemType" action="get" select="name,label">` +
        `<name>${name}</name>` +
        `<Relationships><Item type="Property" action="get" select="name,label,data_type,data_source" /></Relationships>` +
        `</Item></AML>`
      const props = await withTimeout(
        retry(async () => (await client()).runAml(propsAml, sig())),
        timeoutMs,
        'introspect_itemtype'
      )

      // RelationshipTypes whose source is this ItemType — i.e. the relationships available on it.
      // Best-effort enrichment: a single attempt so a transient blip or unexpected schema can't
      // stall (or fail) the core property introspection above.
      const relsAml =
        `<AML><Item type="RelationshipType" action="get" select="name,related_id">` +
        `<source_id><Item type="ItemType" action="get" select="id"><name>${name}</name></Item></source_id>` +
        `</Item></AML>`
      let rels: typeof props.items = []
      try {
        const relResult = await withTimeout(
          withRetry(async () => (await client()).runAml(relsAml, sig()), sig(), { maxAttempts: 1 }),
          timeoutMs,
          'introspect_itemtype'
        )
        rels = relResult.items
      } catch {
        rels = []
      }

      return summarizeResult([...props.items, ...rels])
    },
    {
      name: 'introspect_itemtype',
      description:
        'Get an ItemType with its Property definitions (name, label, data_type) AND the ' +
        'RelationshipTypes whose source is this ItemType (relationship name + related ItemType). ' +
        'Use this to discover both the schema and the available relationships before writing AML.',
      schema: z.object({ name: z.string().describe('Exact ItemType name, e.g. "Part".') })
    }
  )

  const getMethodSource = tool(
    async ({ name }: { name: string }) => {
      const aml =
        `<AML><Item type="Method" action="get" select="name,method_type,method_code">` +
        `<name>${name}</name></Item></AML>`
      const result = await withTimeout(
        retry(async () => (await client()).runAml(aml, sig())),
        timeoutMs,
        'get_method_source'
      )
      if (result.count === 0) return `No Method named "${name}" was found.`
      return summarizeResult(result.items)
    },
    {
      name: 'get_method_source',
      description: 'Fetch the source code (method_code) and type of a server/client Method by name.',
      schema: z.object({ name: z.string().describe('Exact Method name.') })
    }
  )

  return [runAml, runOData, listItemTypes, introspectItemType, getMethodSource]
}

export type AgentTool = ReturnType<typeof createArasTools>[number]
