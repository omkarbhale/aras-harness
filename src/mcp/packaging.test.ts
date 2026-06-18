import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArasCredentials } from '../aras'
import {
  runImport,
  runExport,
  resolveResources,
  findPackageRoot,
  type ScriptRunner,
  type PackagingResources
} from './packaging'

const CREDS: ArasCredentials = {
  instanceUrl: 'http://localhost/Server',
  database: 'D',
  username: 'admin',
  password: 'secret'
}

/** Real resources resolve to bundled files that exist; reuse for happy-path tests. */
const RES: PackagingResources = resolveResources()

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aras-pkg-test-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** A runner that records its invocation and emits the success marker + a log file. */
function fakeRunner(opts: { ok: boolean; stderr?: string } = { ok: true }): {
  runner: ScriptRunner
  calls: { scriptPath: string; args: string[]; env: Record<string, string> }[]
} {
  const calls: { scriptPath: string; args: string[]; env: Record<string, string> }[] = []
  const runner: ScriptRunner = async (scriptPath, args, env) => {
    calls.push({ scriptPath, args, env })
    const logIdx = args.indexOf('-LogFile')
    if (logIdx >= 0) writeFileSync(args[logIdx + 1], 'engine log line 1\nengine log line 2\n')
    const marker = scriptPath.includes('import') ? 'ARAS_IMPORT_OK' : 'ARAS_EXPORT_OK'
    return {
      exitCode: opts.ok ? 0 : 1,
      stdout: opts.ok ? `INFO: connected\n${marker}\n` : 'ARAS_IMPORT_FAIL: boom\n',
      stderr: opts.stderr ?? ''
    }
  }
  return { runner, calls }
}

describe('findPackageRoot / resolveResources', () => {
  it('finds the package root and resolves bundled resources that exist', () => {
    const root = findPackageRoot()
    expect(root).toBeTruthy()
    // The bundled scripts + DLLs were committed; they must be present.
    for (const p of [RES.importScript, RES.exportScript, RES.iomDll, RES.libsDll]) {
      expect(p.length).toBeGreaterThan(0)
    }
  })
})

describe('runImport', () => {
  it('asserts the manifest exists', async () => {
    const { runner } = fakeRunner()
    const r = await runImport(CREDS, join(tmp, 'missing.mf'), { runner })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/manifest file not found/)
  })

  it('passes creds via args + password via env, and reports success with the log', async () => {
    const manifest = join(tmp, 'imports.mf')
    writeFileSync(manifest, '<imports><package name="X" path="X\\Import"/></imports>')
    const { runner, calls } = fakeRunner({ ok: true })
    const r = await runImport(CREDS, manifest, { runner, makeTempDir: () => tmp })

    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/Import succeeded/)
    expect(r.text).toMatch(/engine log line 2/) // log echoed back
    const call = calls[0]
    expect(call.args).toContain('-ManifestFile')
    expect(call.args).toContain(manifest)
    expect(call.args).toContain('admin')
    expect(call.args).not.toContain('secret') // password never on the arg list
    expect(call.env.ARAS_PKG_PASSWORD).toBe('secret')
  })

  it('reports failure when the engine does not emit the OK marker', async () => {
    const manifest = join(tmp, 'imports.mf')
    writeFileSync(manifest, '<imports/>')
    const { runner } = fakeRunner({ ok: false })
    const r = await runImport(CREDS, manifest, { runner, makeTempDir: () => tmp })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/Import FAILED/)
  })
})

describe('runExport', () => {
  const items = [{ itemType: 'Part', itemId: 'ABC', keyedName: 'P-100' }]
  const groups = { 'com.acme.parts': items }

  it('asserts a missing folder', async () => {
    const { runner } = fakeRunner()
    const r = await runExport(CREDS, join(tmp, 'nope'), groups, { runner })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/output folder does not exist/)
  })

  it('asserts a non-empty folder', async () => {
    const out = join(tmp, 'out')
    mkdirSync(out)
    writeFileSync(join(out, 'stray.txt'), 'x')
    const { runner } = fakeRunner()
    const r = await runExport(CREDS, out, groups, { runner })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/not empty/)
  })

  it('rejects an empty group set', async () => {
    const out = join(tmp, 'out')
    mkdirSync(out)
    const { runner } = fakeRunner()
    const r = await runExport(CREDS, out, {}, { runner })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/no items/i)
  })

  it('runs against an empty folder and serializes the package groups as JSON', async () => {
    const out = join(tmp, 'out')
    mkdirSync(out)
    const logDir = join(tmp, 'logs')
    mkdirSync(logDir)
    const { runner, calls } = fakeRunner({ ok: true })
    const r = await runExport(CREDS, out, groups, { runner, makeTempDir: () => logDir })

    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/Export succeeded/)
    const call = calls[0]
    const jsonIdx = call.args.indexOf('-GroupsJson')
    expect(JSON.parse(call.args[jsonIdx + 1])).toEqual(groups)
    expect(call.env.ARAS_PKG_PASSWORD).toBe('secret')
  })
})
