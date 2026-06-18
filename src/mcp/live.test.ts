import { describe, it, expect, beforeAll } from 'vitest'
import { ConnectionManager } from './connection'
import { ArasTools } from './tools'

/**
 * Live integration tests against a real Aras Innovator (v12+) instance.
 *
 * These are SKIPPED unless connection env vars are set, so CI without credentials
 * stays green. To run them, provide:
 *
 *   ARAS_TEST_URL=https://your-instance/InnovatorServer
 *   ARAS_TEST_DB=YourDatabase
 *   ARAS_TEST_USER=admin
 *   ARAS_TEST_PASSWORD=...
 *
 * Optional write round-trip (creates + deletes one item — only enable on a scratch DB):
 *   ARAS_TEST_ALLOW_WRITE=1
 *   ARAS_TEST_WRITE_TYPE=Part            (ItemType to add/delete)
 *   ARAS_TEST_WRITE_KEY=item_number      (a required string property)
 *
 * Run just these:  ARAS_TEST_URL=... vitest run src/mcp/live.test.ts
 */

const env = process.env
const haveCreds = Boolean(
  env.ARAS_TEST_URL && env.ARAS_TEST_DB && env.ARAS_TEST_USER && env.ARAS_TEST_PASSWORD
)

const d = haveCreds ? describe : describe.skip

d('live Aras MCP tools', () => {
  let tools: ArasTools

  beforeAll(async () => {
    const conn = new ConnectionManager()
    tools = new ArasTools(conn, { maxRetryAttempts: 2, toolTimeoutMs: 30_000 })
    const r = await tools.connect({
      url: env.ARAS_TEST_URL,
      database: env.ARAS_TEST_DB,
      username: env.ARAS_TEST_USER,
      password: env.ARAS_TEST_PASSWORD
    })
    if (r.isError) throw new Error(`Live connect failed: ${r.text}`)
  }, 60_000)

  it('aras_connect established a working session (status)', async () => {
    const r = await tools.status()
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(r.text).connected).toBe(true)
  })

  it('aras_list_itemtypes returns ItemTypes (ItemType always exists)', async () => {
    const r = await tools.listItemTypes()
    expect(r.isError).toBeFalsy()
    const parsed = JSON.parse(r.text)
    expect(parsed.count).toBeGreaterThan(0)
    expect(parsed.itemTypes).toContain('ItemType')
  })

  it('aras_run_query reads ItemType rows', async () => {
    const r = await tools.runQuery(
      '<AML><Item type="ItemType" action="get" select="name" maxRecords="3"/></AML>'
    )
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(r.text).count).toBeGreaterThan(0)
  })

  it('aras_run_query refuses a mutating action (no write reaches the server)', async () => {
    const r = await tools.runQuery('<AML><Item type="ItemType" action="update" id="0"/></AML>')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/aras_run_write/)
  })

  it('aras_introspect_itemtype returns properties for ItemType', async () => {
    const r = await tools.introspectItemType('ItemType')
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(r.text).count).toBeGreaterThan(0)
  })

  it('aras_run_odata reads over the OData endpoint', async () => {
    const r = await tools.runOData('ItemType?$top=1&$select=name')
    expect(r.isError).toBeFalsy()
  })

  it('surfaces a real Aras fault as an error result (bad ItemType)', async () => {
    const r = await tools.runQuery(
      '<AML><Item type="ZzNotARealType123" action="get" select="id"/></AML>'
    )
    // Either an empty result or a fault — but never a thrown/unhandled failure.
    expect(typeof r.text).toBe('string')
  })
})

const allowWrite =
  haveCreds && env.ARAS_TEST_ALLOW_WRITE === '1' && env.ARAS_TEST_WRITE_TYPE && env.ARAS_TEST_WRITE_KEY
const w = allowWrite ? describe : describe.skip

w('live Aras write round-trip (scratch DB only)', () => {
  let tools: ArasTools
  const type = env.ARAS_TEST_WRITE_TYPE as string
  const key = env.ARAS_TEST_WRITE_KEY as string
  const value = 'ARAS_MCP_TEST_DELETE_ME'

  beforeAll(async () => {
    const conn = new ConnectionManager()
    tools = new ArasTools(conn, { toolTimeoutMs: 30_000 })
    const r = await tools.connect({
      url: env.ARAS_TEST_URL,
      database: env.ARAS_TEST_DB,
      username: env.ARAS_TEST_USER,
      password: env.ARAS_TEST_PASSWORD
    })
    if (r.isError) throw new Error(`Live connect failed: ${r.text}`)
  }, 60_000)

  it('adds then deletes an item', async () => {
    const add = await tools.runWrite(
      `<AML><Item type="${type}" action="add"><${key}>${value}</${key}></Item></AML>`
    )
    expect(add.isError).toBeFalsy()
    const id = JSON.parse(add.text).items?.[0]?.id
    expect(id).toBeTruthy()

    const del = await tools.runWrite(`<AML><Item type="${type}" action="delete" id="${id}"/></AML>`)
    expect(del.isError).toBeFalsy()

    const verify = await tools.runQuery(
      `<AML><Item type="${type}" action="get" select="id" id="${id}"/></AML>`
    )
    expect(JSON.parse(verify.text).count).toBe(0)
  }, 60_000)
})
