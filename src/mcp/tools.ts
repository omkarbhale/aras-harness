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

/** Escape the five XML metacharacters for safe interpolation into an AML value. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// OData entity payloads carry navigation/association/context annotations on every
// property — typically several times the size of the useful data. Drop them, but keep
// the human label (@aras.keyed_name), the real id (@aras.id), and paging hints.
const ODATA_NOISE =
  /@odata\.(associationLink|navigationLink|context|type|editLink|id|mediaReadLink|mediaContentType|mediaEtag)/

function stripODataNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripODataNoise)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (ODATA_NOISE.test(k)) continue
      out[k] = stripODataNoise(v)
    }
    return out
  }
  return node
}

/**
 * Render an OData payload into a size-bounded string that is ALWAYS valid JSON.
 *
 * The old `JSON.stringify(result).slice(0, N)` cut mid-string and produced unparseable
 * output. This strips annotation noise first, then — if still over budget — drops whole
 * rows from `value[]` and records what was dropped, so callers can page deliberately
 * (OData `$top`/`$skip`/`$select`) instead of guessing at a broken tail.
 */
function summarizeOData(payload: unknown, maxChars: number): string {
  const clean = stripODataNoise(payload)
  let json = JSON.stringify(clean)
  if (json.length <= maxChars) return json

  if (clean && typeof clean === 'object' && Array.isArray((clean as { value?: unknown[] }).value)) {
    const obj = clean as Record<string, unknown>
    const rows = obj.value as unknown[]
    let kept = rows.length
    while (kept > 0) {
      json = JSON.stringify({
        ...obj,
        value: rows.slice(0, kept),
        '@truncated': { returned: kept, of: rows.length, hint: 'narrow with $select or page with $top/$skip' }
      })
      if (json.length <= maxChars) return json
      kept = kept > 10 ? Math.floor(kept / 2) : kept - 1
    }
    return JSON.stringify({
      '@truncated': { returned: 0, of: rows.length, hint: 'rows too large; reduce fields with $select' }
    })
  }

  return JSON.stringify({ '@truncated': true, hint: 'OData response exceeded size budget; narrow the query' })
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

  /**
   * Resolve the connected login to its User item. The `id` it returns is what
   * `created_by_id` / `owned_by_id` / `managed_by_id` filters compare against, so this
   * saves the agent a manual User lookup before every "items created by me" query.
   */
  async whoami(): Promise<ToolResult> {
    if (!this.conn.isConnected()) {
      return ok(JSON.stringify({ connected: false }))
    }
    try {
      const client = this.conn.getClient()
      const login = client.username
      const { items } = await this.readAml(
        `<AML><Item type="User" action="get" select="id,login_name,keyed_name,first_name,last_name,email">` +
          `<login_name>${escapeXml(login)}</login_name></Item></AML>`,
        'aras_whoami'
      )
      const base = { connected: true, connection: this.conn.active, database: client.database, login_name: login }
      const p = items[0]?.properties
      if (!p) {
        return ok(
          JSON.stringify({
            ...base,
            note: `Authenticated as "${login}", but no User item matched that login_name.`
          })
        )
      }
      return ok(
        JSON.stringify({
          ...base,
          id: p.id,
          name: p.keyed_name ?? p['id@keyed_name'],
          first_name: p.first_name,
          last_name: p.last_name,
          email: p.email
        })
      )
    } catch (e) {
      return err(messageOf(e))
    }
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
      return ok(summarizeOData(result, ODATA_RESULT_CHARS))
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

      // Properties sourced by this ItemType, queried directly as a flat list (simpler to
      // consume here than walking a nested response).
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
