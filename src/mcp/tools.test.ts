import { describe, it, expect } from 'vitest'
import type { ArasClient } from '../aras'
import type { AmlResult } from '../aras'
import { ConnectionManager } from './connection'
import { ArasTools } from './tools'
import type { ScriptRunner } from './packaging'

/** Minimal stand-in for ArasClient that records calls and returns canned results. */
class FakeClient {
  amlCalls: string[] = []
  odataCalls: string[] = []
  testCalls = 0
  /** Per-test override for what runAml returns (keyed loosely by content). */
  amlHandler: (aml: string) => Promise<AmlResult> = async () => result([])
  /** Per-test override for what runODataQuery returns. */
  odataHandler: (path: string) => Promise<unknown> = async () => ({ value: [{ item_number: 'P-1' }] })
  /** Mirrors ArasClient's identity getters used by aras_whoami. */
  username = 'u'
  database = 'D'

  async runAml(aml: string): Promise<AmlResult> {
    this.amlCalls.push(aml)
    return this.amlHandler(aml)
  }
  async runODataQuery(path: string): Promise<unknown> {
    this.odataCalls.push(path)
    return this.odataHandler(path)
  }
  async testConnection(): Promise<{ latencyMs: number }> {
    this.testCalls++
    return { latencyMs: 7 }
  }
}

function result(
  items: { id?: string; type?: string; properties?: Record<string, string> }[],
  pageInfo?: AmlResult['pageInfo']
): AmlResult {
  const full = items.map((i) => ({ id: i.id ?? '', type: i.type ?? '', properties: i.properties ?? {} }))
  return { raw: '<xml/>', items: full, count: full.length, ...(pageInfo ? { pageInfo } : {}) }
}

/** Build ArasTools wired to a FakeClient, already "connected". */
function setup(): { tools: ArasTools; fake: FakeClient; conn: ConnectionManager } {
  const fake = new FakeClient()
  const conn = new ConnectionManager(() => fake as unknown as ArasClient)
  const tools = new ArasTools(conn, { maxRetryAttempts: 1, loadProfiles: () => ({}), env: {} })
  return { tools, fake, conn }
}

async function connect(tools: ArasTools): Promise<void> {
  await tools.connect({ url: 'http://x/Server', database: 'D', username: 'u', password: 'p' })
}

describe('ArasTools.connect', () => {
  it('connects with inline credentials and reports latency', async () => {
    const { tools, fake } = setup()
    const r = await tools.connect({ url: 'http://x/Server', database: 'D', username: 'u', password: 'p' })
    expect(r.isError).toBeFalsy()
    expect(fake.testCalls).toBe(1)
    expect(JSON.parse(r.text)).toMatchObject({ connected: true, database: 'D', latencyMs: 7 })
  })

  it('returns an error result when credentials are incomplete', async () => {
    const { tools } = setup()
    const r = await tools.connect({ url: 'http://x/Server' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/missing: database, username, password/)
  })
})

describe('connection guard', () => {
  it('tools fail with a readable error before connecting', async () => {
    const { tools } = setup()
    const r = await tools.listItemTypes()
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/No active Aras connection/)
  })
})

describe('read/write split', () => {
  it('aras_run_query rejects mutating AML', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    const r = await tools.runQuery('<AML><Item type="Part" action="update" id="1"><name>x</name></Item></AML>')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/aras_run_write/)
    expect(fake.amlCalls).toHaveLength(0) // never sent to the server
  })

  it('aras_run_write rejects non-mutating AML', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    const r = await tools.runWrite('<AML><Item type="Part" action="get" select="id"/></AML>')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/aras_run_query/)
    expect(fake.amlCalls).toHaveLength(0)
  })

  it('aras_run_write runs the mutation exactly once (never retried)', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async () => result([{ id: 'NEW', type: 'Part', properties: { item_number: 'P-9' } }])
    const r = await tools.runWrite('<AML><Item type="Part" action="add"><item_number>P-9</item_number></Item></AML>')
    expect(r.isError).toBeFalsy()
    expect(fake.amlCalls).toHaveLength(1)
    expect(JSON.parse(r.text)).toMatchObject({ count: 1 })
  })
})

describe('queries', () => {
  it('aras_run_query summarizes returned items', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async () =>
      result([
        { id: 'a', type: 'Part', properties: { item_number: 'P-1' } },
        { id: 'b', type: 'Part', properties: { item_number: 'P-2' } }
      ])
    const r = await tools.runQuery('<AML><Item type="Part" action="get" select="item_number"/></AML>')
    const parsed = JSON.parse(r.text)
    expect(parsed.count).toBe(2)
    expect(parsed.items[0].properties.item_number).toBe('P-1')
  })

  it('aras_run_query surfaces page metadata when the query is paged', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async () =>
      result([{ id: 'a', type: 'Identity', properties: { name: 'A' } }], { page: 2, pageMax: 17, itemMax: 51 })
    const r = await tools.runQuery(
      '<AML><Item type="Identity" action="get" select="name" page="2" pagesize="3"/></AML>'
    )
    expect(JSON.parse(r.text).page).toEqual({ page: 2, pageMax: 17, itemMax: 51 })
  })

  it('aras_run_query omits page metadata for non-paged queries', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async () => result([{ id: 'a', type: 'Part', properties: {} }])
    const r = await tools.runQuery('<AML><Item type="Part" action="get" select="id"/></AML>')
    expect(JSON.parse(r.text).page).toBeUndefined()
  })

  it('aras_run_query surfaces client errors as an error result', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async () => {
      throw new Error('boom from server')
    }
    const r = await tools.runQuery('<AML><Item type="Part" action="get"/></AML>')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/boom from server/)
  })

  it('aras_run_odata returns the JSON payload', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    const r = await tools.runOData('Part?$top=1')
    expect(r.isError).toBeFalsy()
    expect(fake.odataCalls).toEqual(['Part?$top=1'])
    expect(r.text).toMatch(/P-1/)
  })

  it('aras_run_odata strips @odata navigation noise but keeps @aras labels', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.odataHandler = async () => ({
      '@odata.context': 'http://x/$metadata#Member',
      value: [
        {
          '@odata.id': "Member('1')",
          'related_id@odata.associationLink': 'Member(1)/related_id/$ref',
          'related_id@odata.navigationLink': 'Member(1)/related_id',
          'related_id@aras.keyed_name': 'Innovator Admin',
          'related_id@aras.id': 'DBA5'
        }
      ]
    })
    const r = await tools.runOData('Member')
    const parsed = JSON.parse(r.text) // must be valid JSON
    const row = parsed.value[0]
    expect(row['related_id@aras.keyed_name']).toBe('Innovator Admin')
    expect(row['related_id@aras.id']).toBe('DBA5')
    expect(Object.keys(row).some((k) => k.includes('odata.associationLink'))).toBe(false)
    expect(Object.keys(row).some((k) => k.includes('odata.navigationLink'))).toBe(false)
  })

  it('aras_run_odata truncates large value[] to valid JSON with a marker', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    const rows = Array.from({ length: 2000 }, (_, i) => ({ name: `identity-number-${i}-with-padding` }))
    fake.odataHandler = async () => ({ value: rows })
    const r = await tools.runOData('Identity')
    const parsed = JSON.parse(r.text) // valid JSON despite truncation
    expect(parsed['@truncated'].of).toBe(2000)
    expect(parsed['@truncated'].returned).toBeLessThan(2000)
    expect(parsed.value.length).toBe(parsed['@truncated'].returned)
    expect(r.text.length).toBeLessThanOrEqual(8000)
  })
})

describe('schema discovery', () => {
  it('aras_list_itemtypes returns the names', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async () =>
      result([{ properties: { name: 'Part' } }, { properties: { name: 'Document' } }])
    const r = await tools.listItemTypes()
    expect(JSON.parse(r.text)).toEqual({ count: 2, itemTypes: ['Part', 'Document'] })
  })

  it('aras_introspect_itemtype reports not-found cleanly', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async () => result([]) // ItemType lookup returns nothing
    const r = await tools.introspectItemType('Ghost')
    expect(r.isError).toBeFalsy()
    expect(r.text).toMatch(/No ItemType named "Ghost"/)
  })

  it('aras_introspect_itemtype returns type + properties when found', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async (aml) => {
      // Order matters: the Property/RelationshipType queries nest an <Item type="ItemType">
      // for source_id, so match the outer type first.
      if (aml.includes('type="Property"'))
        return result([{ type: 'Property', properties: { name: 'item_number', data_type: 'string' } }])
      if (aml.includes('type="RelationshipType"')) return result([])
      return result([{ type: 'ItemType', properties: { name: 'Part', label: 'Part' } }])
    }
    const r = await tools.introspectItemType('Part')
    const parsed = JSON.parse(r.text)
    const names = parsed.items.map((i: { properties: { name: string } }) => i.properties.name)
    expect(names).toContain('item_number')
  })

  it('aras_get_method reports not-found and returns source when present', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async () => result([])
    expect((await tools.getMethod('Nope')).text).toMatch(/No Method named "Nope"/)

    fake.amlHandler = async () =>
      result([{ type: 'Method', properties: { name: 'M', method_code: 'return 1;' } }])
    const r = await tools.getMethod('M')
    expect(r.text).toMatch(/return 1;/)
  })
})

describe('status', () => {
  it('reports disconnected before connect', async () => {
    const { tools } = setup()
    expect(JSON.parse((await tools.status()).text)).toEqual({ connected: false })
  })

  it('reports latency when connected', async () => {
    const { tools } = setup()
    await connect(tools)
    const parsed = JSON.parse((await tools.status()).text)
    expect(parsed).toMatchObject({ connected: true, latencyMs: 7 })
  })
})

describe('whoami', () => {
  it('reports disconnected before connect', async () => {
    const { tools } = setup()
    expect(JSON.parse((await tools.whoami()).text)).toEqual({ connected: false })
  })

  it('resolves the connected login to its User id and details', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async (aml) => {
      expect(aml).toContain('type="User"')
      expect(aml).toContain('<login_name>u</login_name>')
      return result([
        { id: 'USR1', type: 'User', properties: { id: 'USR1', login_name: 'u', keyed_name: 'Test User', email: 't@x' } }
      ])
    }
    const parsed = JSON.parse((await tools.whoami()).text)
    expect(parsed).toMatchObject({ connected: true, database: 'D', login_name: 'u', id: 'USR1', name: 'Test User', email: 't@x' })
  })

  it('notes when the login has no matching User item', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.amlHandler = async () => result([])
    const parsed = JSON.parse((await tools.whoami()).text)
    expect(parsed).toMatchObject({ connected: true, login_name: 'u' })
    expect(parsed.id).toBeUndefined()
    expect(parsed.note).toMatch(/no User item matched/)
  })

  it('escapes XML metacharacters in the login name', async () => {
    const { tools, fake } = setup()
    await connect(tools)
    fake.username = 'a&b<c'
    fake.amlHandler = async (aml) => {
      expect(aml).toContain('<login_name>a&amp;b&lt;c</login_name>')
      return result([])
    }
    await tools.whoami()
  })
})

describe('listProfiles', () => {
  it('lists configured profiles without secrets', async () => {
    const fake = new FakeClient()
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    const tools = new ArasTools(conn, {
      loadProfiles: () => ({ dev: { url: 'http://x', database: 'D', username: 'u' } }),
      env: {}
    })
    const parsed = JSON.parse(tools.listProfiles().text)
    expect(parsed.count).toBe(1)
    expect(parsed.profiles[0]).toEqual({ name: 'dev', url: 'http://x', database: 'D' })
  })
})

describe('importManifest / exportItems', () => {
  it('importManifest errors before spawning when not connected', async () => {
    const { tools } = setup()
    const r = await tools.importManifest('C:/x/imports.mf')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/No active Aras connection/)
  })

  it('exportItems errors before spawning when not connected', async () => {
    const { tools } = setup()
    const r = await tools.exportItems('C:/out', [{ itemType: 'Part', itemId: 'A', keyedName: 'P-1' }])
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/No active Aras connection/)
  })

  it('importManifest forwards the connected creds to the packaging runner', async () => {
    const fake = new FakeClient()
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    let seen: { url: string; pw?: string } | undefined
    const tools = new ArasTools(conn, {
      loadProfiles: () => ({}),
      env: {},
      packagingDeps: {
        runner: async (scriptPath, args, env) => {
          seen = { url: args[args.indexOf('-ArasUrl') + 1], pw: env.ARAS_PKG_PASSWORD }
          return { exitCode: 0, stdout: 'ARAS_IMPORT_OK', stderr: '' }
        },
        // Point at a manifest that exists so the pre-check passes.
        resources: undefined
      }
    })
    await tools.connect({ url: 'http://h/Server', database: 'D', username: 'admin', password: 'pw' })

    // Use this very test file as a stand-in "manifest path that exists".
    const here = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    const r = await tools.importManifest(here)
    expect(r.isError).toBeFalsy()
    expect(seen?.url).toBe('http://h/Server')
    expect(seen?.pw).toBe('pw')
  })
})

describe('exportItems package resolution', () => {
  // amlHandler that resolves Part "ABC" -> package "com.acme.parts"; anything else orphan.
  function packagedClient(): FakeClient {
    const fake = new FakeClient()
    fake.amlHandler = async (aml) => {
      if (aml.includes('type="PackageElement"')) {
        // Orphan path: only ABC's config has a package element.
        if (aml.includes('CFG-ABC')) return result([{ properties: { source_id: 'GROUP-1' } }])
        return result([])
      }
      if (aml.includes('type="PackageGroup"')) return result([{ properties: { source_id: 'DEF-1' } }])
      if (aml.includes('type="PackageDefinition"')) return result([{ properties: { name: 'com.acme.parts' } }])
      // Plain item get -> config_id.
      if (aml.includes('select="config_id"')) {
        const id = /id="([^"]+)"/.exec(aml)?.[1] ?? ''
        return result([{ properties: { config_id: `CFG-${id}` } }])
      }
      return result([])
    }
    return fake
  }

  function setupWithClient(fake: FakeClient, runner: ScriptRunner) {
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    const tools = new ArasTools(conn, { loadProfiles: () => ({}), env: {}, packagingDeps: { runner } })
    return { conn, tools }
  }

  it('groups items by resolved package and passes them to the runner', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'))
    try {
      let groupsJson: string | undefined
      const fake = packagedClient()
      const { tools } = setupWithClient(fake, async (_s, args) => {
        groupsJson = args[args.indexOf('-GroupsJson') + 1]
        return { exitCode: 0, stdout: 'ARAS_EXPORT_OK', stderr: '' }
      })
      await tools.connect({ url: 'http://h/Server', database: 'D', username: 'admin', password: 'pw' })
      const r = await tools.exportItems(out, [{ itemType: 'Part', itemId: 'ABC', keyedName: 'P-1' }])
      expect(r.isError).toBeFalsy()
      expect(JSON.parse(groupsJson!)).toEqual({
        'com.acme.parts': [{ itemType: 'Part', itemId: 'ABC', keyedName: 'P-1' }]
      })
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('rejects orphan items (in no package) before exporting', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'))
    try {
      let ran = false
      const fake = packagedClient()
      const { tools } = setupWithClient(fake, async () => {
        ran = true
        return { exitCode: 0, stdout: 'ARAS_EXPORT_OK', stderr: '' }
      })
      await tools.connect({ url: 'http://h/Server', database: 'D', username: 'admin', password: 'pw' })
      const r = await tools.exportItems(out, [{ itemType: 'Doc', itemId: 'ZZZ', keyedName: 'D-9' }])
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/belong to no package/)
      expect(r.text).toMatch(/Doc "D-9" \(ZZZ\)/)
      expect(ran).toBe(false) // never reached the export driver
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })
})

describe('searchMethods', () => {
  // amlHandler: step-1 candidate query (LIKE, no body) vs step-2 idlist (with body).
  function searchClient(bodies: Record<string, string>): FakeClient {
    const fake = new FakeClient()
    fake.amlHandler = async (aml) => {
      if (aml.includes('idlist=')) {
        const ids = /idlist="([^"]+)"/.exec(aml)![1].split(',')
        return result(ids.map((id) => ({ id, properties: { name: id, method_type: 'C#', method_code: bodies[id] } })))
      }
      if (aml.includes('condition="like"')) {
        // Candidate rows: never carry method_code (proves step-1 doesn't pull bodies).
        return result(Object.keys(bodies).map((id) => ({ id, properties: { name: id, method_type: 'C#' } })))
      }
      return result([])
    }
    return fake
  }

  it('returns matched snippets, not whole bodies, and never selects body in step 1', async () => {
    const fake = searchClient({ M1: 'a\nhas cost here\nb', M2: 'no match here' })
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    const tools = new ArasTools(conn, { maxRetryAttempts: 1, loadProfiles: () => ({}), env: {} })
    await connect(tools)

    const r = await tools.searchMethods({ pattern: 'cost' })
    expect(r.isError).toBeFalsy()
    const out = JSON.parse(r.text)
    expect(out.returnedCount).toBe(1)
    expect(out.methods[0].name).toBe('M1')
    expect(out.methods[0].snippets[0].lines).toContain('has cost here')
    // Step-1 candidate query must not request method_code.
    const step1 = fake.amlCalls.find((a) => a.includes('condition="like"'))!
    expect(step1).not.toContain('method_code" idlist')
    expect(step1).toContain('select="name,method_type"')
  })

  it('escapes LIKE wildcards in the pattern', async () => {
    const fake = searchClient({ M1: '100% done' })
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    const tools = new ArasTools(conn, { maxRetryAttempts: 1, loadProfiles: () => ({}), env: {} })
    await connect(tools)
    await tools.searchMethods({ pattern: '100%' })
    const step1 = fake.amlCalls.find((a) => a.includes('condition="like"'))!
    expect(step1).toContain('100[%]')
  })

  it('flags truncated when candidates exceed maxMethods', async () => {
    const bodies: Record<string, string> = {}
    for (let i = 0; i < 5; i++) bodies[`M${i}`] = 'cost'
    const fake = searchClient(bodies)
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    const tools = new ArasTools(conn, { maxRetryAttempts: 1, loadProfiles: () => ({}), env: {} })
    await connect(tools)
    const out = JSON.parse((await tools.searchMethods({ pattern: 'cost', maxMethods: 2 })).text)
    expect(out.truncated).toBe(true)
    expect(out.methods).toHaveLength(2)
  })

  it('regex refines the literal-matched set', async () => {
    const fake = searchClient({ M1: 'getCost()', M2: 'costCenter' })
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    const tools = new ArasTools(conn, { maxRetryAttempts: 1, loadProfiles: () => ({}), env: {} })
    await connect(tools)
    const out = JSON.parse((await tools.searchMethods({ pattern: 'cost', regex: 'getCost' })).text)
    expect(out.returnedCount).toBe(1)
    expect(out.methods[0].name).toBe('M1')
  })
})

describe('findMethodCallers', () => {
  function callersClient(): FakeClient {
    const fake = new FakeClient()
    fake.amlHandler = async (aml) => {
      // Resolve the target method to its id.
      if (aml.includes('select="id,name"')) {
        return result([{ id: 'TGT', properties: { name: 'Part_RecalcCost' } }])
      }
      // Method-to-method: step-1 candidates, step-2 bodies.
      if (aml.includes('idlist=')) {
        const ids = /idlist="([^"]+)"/.exec(aml)![1].split(',')
        const src: Record<string, string> = { CALLER: "x.apply('Part_RecalcCost')" }
        return result(ids.map((id) => ({ id, properties: { name: id, method_type: 'C#', method_code: src[id] } })))
      }
      if (aml.includes('condition="like"')) {
        return result([
          { id: 'TGT', properties: { name: 'Part_RecalcCost', method_type: 'C#' } }, // self, excluded
          { id: 'CALLER', properties: { name: 'Part_OnUpdate', method_type: 'C#' } }
        ])
      }
      if (aml.includes('type="Action"')) {
        return result([{ id: 'A1', properties: { name: 'Recalc', location: 'toolbar' } }])
      }
      if (aml.includes('type="ItemType Method"')) {
        return result([{ id: 'R1', properties: { name: 'onAfterUpdate', 'source_id@keyed_name': 'Part' } }])
      }
      return result([])
    }
    return fake
  }

  it('merges method, action, and itemType-event layers', async () => {
    const fake = callersClient()
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    const tools = new ArasTools(conn, { maxRetryAttempts: 1, loadProfiles: () => ({}), env: {} })
    await connect(tools)
    const out = JSON.parse((await tools.findMethodCallers({ name: 'Part_RecalcCost' })).text)
    expect(out.found).toBe(true)
    expect(out.callers.methods.map((m: { id: string }) => m.id)).toEqual(['CALLER']) // self excluded
    expect(out.callers.actions).toEqual([{ name: 'Recalc', location: 'toolbar' }])
    expect(out.callers.itemTypeMethods).toEqual([{ itemType: 'Part', event: 'onAfterUpdate' }])
    expect(out.warnings).toEqual([])
  })

  it('returns found:false for an unknown method', async () => {
    const fake = new FakeClient() // default handler returns []
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    const tools = new ArasTools(conn, { maxRetryAttempts: 1, loadProfiles: () => ({}), env: {} })
    await connect(tools)
    const out = JSON.parse((await tools.findMethodCallers({ name: 'Ghost' })).text)
    expect(out.found).toBe(false)
  })

  it('degrades a failing layer to empty + warning instead of failing the call', async () => {
    const fake = callersClient()
    const base = fake.amlHandler
    fake.amlHandler = async (aml) => {
      if (aml.includes('type="Action"')) throw new Error('boom')
      return base(aml)
    }
    const conn = new ConnectionManager(() => fake as unknown as ArasClient)
    const tools = new ArasTools(conn, { maxRetryAttempts: 1, loadProfiles: () => ({}), env: {} })
    await connect(tools)
    const r = await tools.findMethodCallers({ name: 'Part_RecalcCost' })
    expect(r.isError).toBeFalsy()
    const out = JSON.parse(r.text)
    expect(out.callers.actions).toEqual([])
    expect(out.warnings.join(' ')).toMatch(/actions.*failed/)
  })
})
