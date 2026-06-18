import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionManager } from './connection'
import { ArasTools } from './tools'

/**
 * Live integration test for the package import/export DRIVER (PowerShell + the .NET
 * SolutionUpgrade DLLs). Unlike the unit tests — which mock the script runner — this
 * actually spawns the bundled scripts against a real instance, so it catches failures
 * that only surface through the real engine. In particular it guards the regression
 * where invoking the engine from PowerShell threw "cast PSObject to Hashtable" and
 * exported NOTHING while still reporting success: here we assert real XML is written.
 *
 * SKIPPED unless live creds are present AND we're on Windows (the driver is Windows-only):
 *   ARAS_TEST_URL  ARAS_TEST_DB  ARAS_TEST_USER  ARAS_TEST_PASSWORD
 *
 * Export is read-only on the server (it only reads items and writes local files), so this
 * is safe to run against any instance. Run just this:
 *   ARAS_TEST_URL=... vitest run src/mcp/packaging.live.test.ts
 */

const env = process.env
const haveCreds = Boolean(
  env.ARAS_TEST_URL && env.ARAS_TEST_DB && env.ARAS_TEST_USER && env.ARAS_TEST_PASSWORD
)
const onWindows = process.platform === 'win32'
const d = haveCreds && onWindows ? describe : describe.skip

d('live package export driver', () => {
  let tools: ArasTools
  let outDir: string

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
    outDir = mkdtempSync(join(tmpdir(), 'aras-pkg-live-'))
  }, 60_000)

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true })
  })

  /**
   * Find a packaged ItemType to export. ItemType ids equal their config_id, so the
   * PackageElement.element_id is directly usable as the export item id — no version
   * resolution needed.
   */
  async function findPackagedItemType(): Promise<{ id: string; name: string }> {
    const r = await tools.runQuery(
      '<AML><Item type="PackageElement" action="get" select="element_id,name" maxRecords="1">' +
        '<element_type>ItemType</element_type></Item></AML>'
    )
    expect(r.isError).toBeFalsy()
    const item = JSON.parse(r.text).items?.[0]?.properties
    if (!item?.element_id) throw new Error('No packaged ItemType found to export on this instance')
    return { id: item.element_id, name: item.name ?? item.element_id }
  }

  it('exports a real packaged ItemType: writes XML + imports.mf (not a silent no-op)', async () => {
    const target = await findPackagedItemType()

    const r = await tools.exportItems(outDir, [
      { itemType: 'ItemType', itemId: target.id, keyedName: target.name }
    ])

    expect(r.isError).toBeFalsy()
    expect(r.text).toMatch(/Export succeeded/)

    // The actual regression guard: the engine must have produced files, not just a marker.
    expect(existsSync(join(outDir, 'imports.mf'))).toBe(true)
    const xmls: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.toLowerCase().endsWith('.xml')) xmls.push(p)
      }
    }
    walk(outDir)
    expect(xmls.length).toBeGreaterThan(0)
  }, 180_000)

  it('rejects a non-empty output folder', async () => {
    // outDir now contains the previous export — a second export must be refused.
    const r = await tools.exportItems(outDir, [
      { itemType: 'ItemType', itemId: 'x', keyedName: 'x' }
    ])
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/not empty|belong to no package/)
  })
})
