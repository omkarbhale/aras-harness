import { withRetry, isWriteAml, summarizeAml, type AmlItem, type AmlPageInfo, type AmlResult } from '../aras'
import type { ConnectionManager } from './connection'
import { loadProfiles, resolveCredentials, type ConnectInput, type ProfileConfig } from './profiles'

const MAX_ITEMS_IN_RESULT = 50
const ODATA_RESULT_CHARS = 8000

export interface ToolOptions {
  /** Per-call timeout (ms). Default 30 000. */
  toolTimeoutMs?: number
  /** Retry cap for read tools. Default 3 (host has its own timeout — don't hang it). */
  maxRetryAttempts?: number
  /** Profiles for connect/list. Defaults to loading the config file lazily. */
  loadProfiles?: () => Record<string, ProfileConfig>
  env?: NodeJS.ProcessEnv
}

/** Uniform tool result. `isError` maps to the MCP `isError` flag. */
export interface ToolResult {
  text: string
  isError?: boolean
}

function ok(text: string): ToolResult {
  return { text }
}
function err(text: string): ToolResult {
  return { text, isError: true }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id))
}

function summarizeItems(items: AmlItem[], pageInfo?: AmlPageInfo): string {
  const shown = items.slice(0, MAX_ITEMS_IN_RESULT)
  return JSON.stringify({
    count: items.length,
    truncated: items.length > MAX_ITEMS_IN_RESULT,
    // When the query is paged, tell the caller the true total + how to page further.
    ...(pageInfo ? { page: pageInfo } : {}),
    items: shown
  })
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * The Aras tool implementations, decoupled from the MCP wire layer so they can be
 * unit-tested directly against a {@link ConnectionManager} backed by a mock client.
 *
 * Read vs write are deliberately separate tools: `runWrite` carries the destructive
 * annotation in the MCP registration, so a host's permission prompt is precise, and
 * `runQuery` refuses mutating AML outright (defense in depth — the old LangGraph
 * approval interrupt is now the host's job).
 */
export class ArasTools {
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly env: NodeJS.ProcessEnv
  private readonly profilesLoader: () => Record<string, ProfileConfig>

  constructor(
    private readonly conn: ConnectionManager,
    opts: ToolOptions = {}
  ) {
    this.timeoutMs = opts.toolTimeoutMs ?? 30_000
    this.maxAttempts = opts.maxRetryAttempts ?? 3
    this.env = opts.env ?? process.env
    this.profilesLoader = opts.loadProfiles ?? (() => loadProfiles())
  }

  private retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, undefined, { maxAttempts: this.maxAttempts })
  }

  /** Read-only AML retried with backoff. */
  private async readAml(aml: string, label: string): Promise<AmlResult> {
    const client = this.conn.getClient()
    return withTimeout(this.retry(() => client.runAml(aml)), this.timeoutMs, label)
  }

  // --- connection ---------------------------------------------------------

  async connect(input: ConnectInput): Promise<ToolResult> {
    try {
      const creds = resolveCredentials(input, this.profilesLoader(), this.env)
      const { latencyMs } = await this.conn.connect(creds, creds.name)
      return ok(
        JSON.stringify({
          connected: true,
          to: creds.name ?? creds.instanceUrl,
          database: creds.database,
          username: creds.username,
          latencyMs
        })
      )
    } catch (e) {
      return err(`Connection failed: ${messageOf(e)}`)
    }
  }

  listProfiles(): ToolResult {
    const profiles = this.profilesLoader()
    const names = Object.keys(profiles)
    return ok(
      JSON.stringify({
        count: names.length,
        profiles: names.map((name) => ({ name, url: profiles[name].url, database: profiles[name].database }))
      })
    )
  }

  async status(): Promise<ToolResult> {
    if (!this.conn.isConnected()) {
      return ok(JSON.stringify({ connected: false }))
    }
    try {
      const { latencyMs } = await withTimeout(
        this.conn.getClient().testConnection(),
        this.timeoutMs,
        'aras_status'
      )
      return ok(JSON.stringify({ connected: true, active: this.conn.active, latencyMs }))
    } catch (e) {
      return err(`Connection is set but not responding: ${messageOf(e)}`)
    }
  }

  // --- queries ------------------------------------------------------------

  async runQuery(aml: string): Promise<ToolResult> {
    if (isWriteAml(aml)) {
      return err(
        `This AML contains a mutating action (${summarizeAml(aml)}). ` +
          'aras_run_query is read-only — use aras_run_write for changes.'
      )
    }
    try {
      const result = await this.readAml(aml, 'aras_run_query')
      return ok(summarizeItems(result.items, result.pageInfo))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  async runWrite(aml: string): Promise<ToolResult> {
    if (!isWriteAml(aml)) {
      return err('This AML has no mutating action — use aras_run_query for reads.')
    }
    try {
      // Run exactly once: never retry a write (a "failure" may have committed).
      const client = this.conn.getClient()
      const result = await withTimeout(client.runAml(aml), this.timeoutMs, 'aras_run_write')
      return ok(summarizeItems(result.items))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  async runOData(query: string): Promise<ToolResult> {
    try {
      const client = this.conn.getClient()
      const result = await withTimeout(
        this.retry(() => client.runODataQuery(query)),
        this.timeoutMs,
        'aras_run_odata'
      )
      return ok(JSON.stringify(result).slice(0, ODATA_RESULT_CHARS))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  // --- schema discovery ---------------------------------------------------

  async listItemTypes(): Promise<ToolResult> {
    try {
      const { items } = await this.readAml(
        '<AML><Item type="ItemType" action="get" select="name,label" orderBy="name" /></AML>',
        'aras_list_itemtypes'
      )
      const names = items.map((i) => i.properties.name).filter(Boolean)
      return ok(JSON.stringify({ count: names.length, itemTypes: names }))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  async introspectItemType(name: string): Promise<ToolResult> {
    try {
      const { items: typeItems } = await this.readAml(
        `<AML><Item type="ItemType" action="get" select="name,label"><name>${name}</name></Item></AML>`,
        'aras_introspect_itemtype'
      )
      if (typeItems.length === 0) return ok(`No ItemType named "${name}" was found.`)

      // Properties sourced by this ItemType (queried directly, not nested — the parser
      // collapses nested relationship Items to a placeholder).
      const { items: props } = await this.readAml(
        `<AML><Item type="Property" action="get" select="name,label,data_type,data_source">` +
          `<source_id><Item type="ItemType" action="get" select="id"><name>${name}</name></Item></source_id>` +
          `</Item></AML>`,
        'aras_introspect_itemtype'
      )

      // RelationshipTypes whose source is this ItemType — best effort (single attempt).
      let rels: AmlItem[] = []
      try {
        const client = this.conn.getClient()
        const relRes = await withTimeout(
          withRetry(
            () =>
              client.runAml(
                `<AML><Item type="RelationshipType" action="get" select="name,related_id">` +
                  `<source_id><Item type="ItemType" action="get" select="id"><name>${name}</name></Item></source_id>` +
                  `</Item></AML>`
              ),
            undefined,
            { maxAttempts: 1 }
          ),
          this.timeoutMs,
          'aras_introspect_itemtype'
        )
        rels = relRes.items
      } catch {
        rels = []
      }

      return ok(summarizeItems([...typeItems, ...props, ...rels]))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  async getMethod(name: string): Promise<ToolResult> {
    try {
      const { items } = await this.readAml(
        `<AML><Item type="Method" action="get" select="name,method_type,method_code"><name>${name}</name></Item></AML>`,
        'aras_get_method'
      )
      if (items.length === 0) return ok(`No Method named "${name}" was found.`)
      return ok(summarizeItems(items))
    } catch (e) {
      return err(messageOf(e))
    }
  }
}
