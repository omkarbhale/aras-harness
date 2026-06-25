import { writeFileSync } from 'fs'
import { withRetry, isWriteAml, summarizeAml, type AmlItem, type AmlPageInfo, type AmlResult } from '../aras'
import type { ConnectionManager } from './connection'
import { loadProfiles, resolveCredentials, type ConnectInput, type ProfileConfig } from './profiles'
import { runImport, runExport, type ExportTriplet, type PackageGroups, type PackagingDeps } from './packaging'
import {
  extractSnippets,
  likeEscape,
  literalMatcher,
  callSiteMatcher,
  CALLER_PROBES,
  xml,
  type Snippet
} from './methodSearch'

const MAX_ITEMS_IN_RESULT = 50
const ODATA_RESULT_CHARS = 8000
/** Methods bigger than this are listed but not snippet-scanned (keeps responses bounded). */
const MAX_METHOD_BODY_CHARS = 200_000

/** A Method with snippets matched by a search. */
interface MethodMatch {
  id: string
  name: string
  methodType?: string
  matchCount?: number
  snippets?: Snippet[]
  snippetsTruncated?: boolean
}

/** A candidate whose body was too large to scan. */
interface SkippedMethod {
  id: string
  name: string
  sizeChars: number
}

/**
 * Map the stored `method_type` to the conceptual server/client split. Aras stores the
 * concrete language (`C#`, `VB`, `SQL`, `JavaScript`); JavaScript is the client tier,
 * everything else runs server-side. `any` matches all.
 */
function methodTypeMatches(methodType: string | undefined, want: 'server' | 'client' | 'any'): boolean {
  if (want === 'any') return true
  const isClient = (methodType ?? '').toLowerCase().includes('javascript')
  return want === 'client' ? isClient : !isClient
}

export interface ToolOptions {
  /** Per-call timeout (ms). Default 30 000. */
  toolTimeoutMs?: number
  /** Retry cap for read tools. Default 3 (host has its own timeout — don't hang it). */
  maxRetryAttempts?: number
  /** Profiles for connect/list. Defaults to loading the config file lazily. */
  loadProfiles?: () => Record<string, ProfileConfig>
  env?: NodeJS.ProcessEnv
  /** Injected dependencies for the import/export PowerShell driver (tests mock the runner). */
  packagingDeps?: PackagingDeps
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
  private readonly packagingDeps: PackagingDeps

  constructor(
    private readonly conn: ConnectionManager,
    opts: ToolOptions = {}
  ) {
    this.timeoutMs = opts.toolTimeoutMs ?? 30_000
    this.maxAttempts = opts.maxRetryAttempts ?? 3
    this.env = opts.env ?? process.env
    this.profilesLoader = opts.loadProfiles ?? (() => loadProfiles())
    this.packagingDeps = opts.packagingDeps ?? {}
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
          latencyMs,
          guidance:
            'For schema discovery (itemtypes/properties/relationships), prefer spawning a ' +
            'subagent and have it return only the relevant slice — keeps this context lean. ' +
            'Load the `schema-discovery` skill via aras_skill for instructions to hand it.'
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

  async runQuery(aml: string, outFile?: string): Promise<ToolResult> {
    if (isWriteAml(aml)) {
      return err(
        `This AML contains a mutating action (${summarizeAml(aml)}). ` +
          'aras_run_query is read-only — use aras_run_write for changes.'
      )
    }
    try {
      const result = await this.readAml(aml, 'aras_run_query')
      if (outFile) {
        const payload = JSON.stringify(
          {
            count: result.items.length,
            ...(result.pageInfo ? { page: result.pageInfo } : {}),
            items: result.items
          },
          null,
          2
        )
        writeFileSync(outFile, payload, 'utf8')
        return ok(
          JSON.stringify({
            saved: outFile,
            count: result.items.length,
            ...(result.pageInfo ? { page: result.pageInfo } : {})
          })
        )
      }
      return ok(summarizeItems(result.items, result.pageInfo))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  async runWrite(aml: string, outFile?: string): Promise<ToolResult> {
    if (!isWriteAml(aml)) {
      return err('This AML has no mutating action — use aras_run_query for reads.')
    }
    try {
      // Run exactly once: never retry a write (a "failure" may have committed).
      const client = this.conn.getClient()
      const result = await withTimeout(client.runAml(aml), this.timeoutMs, 'aras_run_write')
      if (outFile) {
        writeFileSync(outFile, JSON.stringify({ count: result.items.length, items: result.items }, null, 2), 'utf8')
        return ok(JSON.stringify({ saved: outFile, count: result.items.length }))
      }
      return ok(summarizeItems(result.items))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  async promoteItem(input: {
    itemType: string
    itemId: string
    state: string
    outFile?: string
  }): Promise<ToolResult> {
    try {
      const client = this.conn.getClient()
      const aml =
        `<AML><Item type="${escapeXml(input.itemType)}" action="promoteItem" ` +
        `id="${escapeXml(input.itemId)}"><state>${escapeXml(input.state)}</state></Item></AML>`
      // Mutation: run exactly once, never retry (a "failure" may have committed).
      const result = await withTimeout(client.runAml(aml), this.timeoutMs, 'aras_promote_item')
      if (input.outFile) {
        writeFileSync(
          input.outFile,
          JSON.stringify({ count: result.items.length, items: result.items }, null, 2),
          'utf8'
        )
        return ok(JSON.stringify({ saved: input.outFile, count: result.items.length }))
      }
      return ok(summarizeItems(result.items))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  async runOData(query: string, outFile?: string): Promise<ToolResult> {
    try {
      const client = this.conn.getClient()
      const result = await withTimeout(
        this.retry(() => client.runODataQuery(query)),
        this.timeoutMs,
        'aras_run_odata'
      )
      if (outFile) {
        const clean = stripODataNoise(result)
        writeFileSync(outFile, JSON.stringify(clean, null, 2), 'utf8')
        const rowCount =
          clean && typeof clean === 'object' && Array.isArray((clean as { value?: unknown[] }).value)
            ? (clean as { value: unknown[] }).value.length
            : undefined
        return ok(JSON.stringify({ saved: outFile, ...(rowCount !== undefined ? { rowCount } : {}) }))
      }
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

  // --- method search & callers --------------------------------------------

  /**
   * Core search engine, shared by `searchMethods` and the method-to-method layer of
   * `findMethodCallers`. Narrows on the server with a literal LIKE over `method_code`
   * (selecting NO body), caps the candidate set, then fetches bodies only for the
   * survivors and extracts matched snippets host-side via `matcher`. Bodies never
   * leave this method — only snippets do.
   */
  private async runMethodSearch(opts: {
    literal: string
    matcher: (line: string) => boolean
    nameLike?: string
    methodType: 'server' | 'client' | 'any'
    contextLines: number
    maxMethods: number
    maxSnippetsPerMethod: number
    excludeId?: string
  }): Promise<{ matches: MethodMatch[]; candidateCount: number; truncated: boolean; skipped: SkippedMethod[] }> {
    const like = `%${likeEscape(opts.literal)}%`
    const nameCond = opts.nameLike
      ? `<name condition="like">${xml(`%${likeEscape(opts.nameLike)}%`)}</name>`
      : ''
    // Step 1: narrow on the server WITHOUT pulling bodies.
    const { items: candidates } = await this.readAml(
      `<AML><Item type="Method" action="get" select="name,method_type">` +
        `<method_code condition="like">${xml(like)}</method_code>${nameCond}</Item></AML>`,
      'aras_search_methods'
    )

    const filtered = candidates
      .filter((c) => c.id !== opts.excludeId)
      .filter((c) => methodTypeMatches(c.properties.method_type, opts.methodType))
    const truncated = filtered.length > opts.maxMethods
    const chosen = filtered.slice(0, opts.maxMethods)
    if (chosen.length === 0) {
      return { matches: [], candidateCount: filtered.length, truncated, skipped: [] }
    }

    // Step 2: fetch bodies only for the capped survivors.
    const idlist = chosen.map((c) => c.id).join(',')
    const { items: bodies } = await this.readAml(
      `<AML><Item type="Method" action="get" select="name,method_type,method_code" idlist="${xml(idlist)}"/></AML>`,
      'aras_search_methods'
    )

    const matches: MethodMatch[] = []
    const skipped: SkippedMethod[] = []
    for (const m of bodies) {
      const code = m.properties.method_code ?? ''
      if (code.length > MAX_METHOD_BODY_CHARS) {
        skipped.push({ id: m.id, name: m.properties.name, sizeChars: code.length })
        continue
      }
      const { snippets, matchCount, truncated: snippetsTruncated } = extractSnippets(code, opts.matcher, {
        contextLines: opts.contextLines,
        max: opts.maxSnippetsPerMethod
      })
      if (matchCount === 0) continue // server LIKE matched but the host matcher didn't
      matches.push({
        id: m.id,
        name: m.properties.name,
        methodType: m.properties.method_type,
        matchCount,
        snippets,
        snippetsTruncated
      })
    }
    return { matches, candidateCount: filtered.length, truncated, skipped }
  }

  async searchMethods(input: {
    pattern: string
    regex?: string
    nameLike?: string
    methodType?: 'server' | 'client' | 'any'
    contextLines?: number
    maxMethods?: number
    maxSnippetsPerMethod?: number
    outFile?: string
  }): Promise<ToolResult> {
    let refine: RegExp | undefined
    if (input.regex) {
      try {
        refine = new RegExp(input.regex, 'i')
      } catch (e) {
        return err(`Invalid regex: ${messageOf(e)}`)
      }
    }
    const litMatch = literalMatcher(input.pattern)
    const matcher = refine ? (line: string) => litMatch(line) && refine!.test(line) : litMatch
    try {
      const res = await this.runMethodSearch({
        literal: input.pattern,
        matcher,
        nameLike: input.nameLike,
        methodType: input.methodType ?? 'any',
        contextLines: input.contextLines ?? 1,
        maxMethods: input.maxMethods ?? 50,
        maxSnippetsPerMethod: input.maxSnippetsPerMethod ?? 5
      })
      const payload = {
        pattern: input.pattern,
        regex: input.regex ?? null,
        candidateCount: res.candidateCount,
        returnedCount: res.matches.length,
        truncated: res.truncated,
        ...(res.skipped.length ? { skipped: res.skipped } : {}),
        methods: res.matches
      }
      if (input.outFile) {
        writeFileSync(input.outFile, JSON.stringify(payload, null, 2), 'utf8')
        return ok(
          JSON.stringify({
            saved: input.outFile,
            candidateCount: res.candidateCount,
            returnedCount: res.matches.length,
            truncated: res.truncated
          })
        )
      }
      return ok(JSON.stringify(payload))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  /**
   * Find what references a Method — method-to-method call sites plus the metadata
   * bindings declared in {@link CALLER_PROBES}. Each layer is best-effort and
   * independent: a failing probe degrades to an empty layer with a `warnings` note
   * rather than failing the whole call (mirrors `introspectItemType`).
   */
  async findMethodCallers(input: { name: string; includeSource?: boolean }): Promise<ToolResult> {
    try {
      // Resolve the target Method to its id (probes filter on the id, not the name).
      const { items: found } = await this.readAml(
        `<AML><Item type="Method" action="get" select="id,name"><name>${xml(input.name)}</name></Item></AML>`,
        'aras_find_method_callers'
      )
      const method = found[0]
      if (!method) {
        return ok(JSON.stringify({ method: { name: input.name }, found: false }))
      }
      const resolved = { id: method.id, name: method.properties.name ?? input.name }
      const warnings: string[] = []

      // Layer 1: other Methods that call this one (source search, call-site filtered).
      let methodCallers: MethodMatch[] = []
      try {
        const res = await this.runMethodSearch({
          literal: resolved.name,
          matcher: callSiteMatcher(resolved.name),
          methodType: 'any',
          contextLines: 1,
          maxMethods: 100,
          maxSnippetsPerMethod: input.includeSource ? 3 : 0,
          excludeId: resolved.id
        })
        methodCallers = res.matches.map((m) =>
          input.includeSource
            ? { id: m.id, name: m.name, methodType: m.methodType, snippets: m.snippets }
            : { id: m.id, name: m.name, methodType: m.methodType }
        )
        if (res.truncated) warnings.push('method-to-method results truncated at 100 candidates')
      } catch (e) {
        warnings.push(`method-to-method layer failed: ${messageOf(e)}`)
      }

      // Layers 2..n: metadata bindings, driven by the CALLER_PROBES registry.
      const callers: Record<string, unknown> = { methods: methodCallers }
      for (const probe of CALLER_PROBES) {
        try {
          const { items } = await this.readAml(probe.buildAml(resolved), 'aras_find_method_callers')
          callers[probe.key] = probe.extract(items)
        } catch (e) {
          callers[probe.key] = []
          warnings.push(`${probe.key} (${probe.label}) failed: ${messageOf(e)}`)
        }
      }

      return ok(JSON.stringify({ method: resolved, found: true, callers, warnings }))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  // --- package import / export --------------------------------------------

  /**
   * Import an Aras solution manifest (.mf) into the connected instance via the
   * SolutionUpgrade utilities (out-of-process PowerShell + .NET DLLs). Returns the
   * engine's messages plus the import log so the agent can see exactly what happened.
   */
  async importManifest(manifestPath: string): Promise<ToolResult> {
    let creds
    try {
      creds = this.conn.getCredentials()
    } catch (e) {
      return err(messageOf(e))
    }
    try {
      const outcome = await runImport(creds, manifestPath, this.packagingDeps)
      return outcome.ok ? ok(outcome.text) : err(outcome.text)
    } catch (e) {
      return err(`Import driver failed: ${messageOf(e)}`)
    }
  }

  /**
   * Resolve which PackageDefinition each item belongs to, by walking
   * PackageElement(element_id=config_id) -> PackageGroup -> PackageDefinition — the
   * same chain the Aras package tools use. Items in no package are returned as orphans
   * (the engine can't export them without a package association).
   */
  private async resolveItemPackages(
    items: ExportTriplet[]
  ): Promise<{ groups: PackageGroups; orphans: ExportTriplet[] }> {
    const groups: PackageGroups = {}
    const orphans: ExportTriplet[] = []

    for (const item of items) {
      // 1. config_id (what PackageElement.element_id matches; == id for unversioned items).
      const { items: itemRows } = await this.readAml(
        `<AML><Item type="${escapeXml(item.itemType)}" action="get" id="${escapeXml(item.itemId)}" select="config_id"/></AML>`,
        'aras_export'
      )
      const configId = itemRows[0]?.properties.config_id ?? item.itemId

      // 2. PackageElement -> source_id (the PackageGroup id).
      const { items: peRows } = await this.readAml(
        `<AML><Item type="PackageElement" action="get" select="source_id"><element_id>${escapeXml(configId)}</element_id></Item></AML>`,
        'aras_export'
      )
      const groupId = peRows[0]?.properties.source_id
      if (peRows.length === 0 || !groupId) {
        orphans.push(item)
        continue
      }

      // 3. PackageGroup -> source_id (the PackageDefinition id).
      const { items: pgRows } = await this.readAml(
        `<AML><Item type="PackageGroup" action="get" id="${escapeXml(groupId)}" select="source_id"/></AML>`,
        'aras_export'
      )
      const defId = pgRows[0]?.properties.source_id
      if (!defId) {
        orphans.push(item)
        continue
      }

      // 4. PackageDefinition -> name.
      const { items: pdRows } = await this.readAml(
        `<AML><Item type="PackageDefinition" action="get" id="${escapeXml(defId)}" select="name"/></AML>`,
        'aras_export'
      )
      const packageName = pdRows[0]?.properties.name
      if (!packageName) {
        orphans.push(item)
        continue
      }

      ;(groups[packageName] ??= []).push(item)
    }

    return { groups, orphans }
  }

  /**
   * Export the given items (itemType / itemId / keyedName triplets) into `outDir`,
   * which must already exist and be empty. Items are grouped by the package each one
   * belongs to (one export can span many packages); items in no package are rejected.
   * Returns the engine's messages plus the export log; a generated `imports.mf`
   * enumerating every exported package lands in `outDir` for re-import.
   */
  async exportItems(outDir: string, items: ExportTriplet[]): Promise<ToolResult> {
    let creds
    try {
      creds = this.conn.getCredentials()
    } catch (e) {
      return err(messageOf(e))
    }
    if (items.length === 0) return err('Assertion failed: no items given to export.')

    let resolved
    try {
      resolved = await this.resolveItemPackages(items)
    } catch (e) {
      return err(`Could not resolve item packages: ${messageOf(e)}`)
    }
    if (resolved.orphans.length > 0) {
      const list = resolved.orphans.map((o) => `${o.itemType} "${o.keyedName}" (${o.itemId})`).join(', ')
      return err(
        `Export aborted: ${resolved.orphans.length} item(s) belong to no package and cannot be exported: ${list}. ` +
          'Add them to a PackageDefinition first, then retry.'
      )
    }

    try {
      const outcome = await runExport(creds, outDir, resolved.groups, this.packagingDeps)
      return outcome.ok ? ok(outcome.text) : err(outcome.text)
    } catch (e) {
      return err(`Export driver failed: ${messageOf(e)}`)
    }
  }
}
