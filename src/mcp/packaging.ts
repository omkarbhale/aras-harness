import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ArasCredentials } from '../aras'

/**
 * Out-of-process driver for the Aras package import/export utilities.
 *
 * The import/export functionality only exists as .NET Framework assemblies
 * (`IOM.dll` + `Libs.dll` / Aras.Tools.SolutionUpgrade). There is no HTTP/AML
 * equivalent, so we shell out to Windows PowerShell 5.1 running the bundled
 * `scripts/import.ps1` / `scripts/export.ps1`, which `Add-Type` the DLLs, re-auth
 * with the same OAuth password grant, and run the engine. This module resolves the
 * bundled resource paths, runs the script, and shapes the result for the agent.
 *
 * Windows-only by nature.
 */

export interface ScriptRun {
  exitCode: number
  stdout: string
  stderr: string
}

/** Injectable so tests can run without a real PowerShell / DLLs. */
export type ScriptRunner = (
  scriptPath: string,
  args: string[],
  env: Record<string, string>
) => Promise<ScriptRun>

/** A single item to export, identified the way the SolutionUpgrade engine wants it. */
export interface ExportTriplet {
  itemType: string
  itemId: string
  keyedName: string
}

/** Locations of the bundled scripts + native DLLs, relative to the package root. */
export interface PackagingResources {
  importScript: string
  exportScript: string
  iomDll: string
  libsDll: string
}

/**
 * Walk up from this module to the package root (the dir containing package.json).
 * Works both from `dist/server.js` (bundled) and `src/mcp/packaging.ts` (tsx/vitest).
 */
export function findPackageRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir
  // Stop at the filesystem root.
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Could not locate package root (no package.json) above ${startDir}`)
}

export function resolveResources(root = findPackageRoot()): PackagingResources {
  return {
    importScript: join(root, 'scripts', 'import.ps1'),
    exportScript: join(root, 'scripts', 'export.ps1'),
    iomDll: join(root, 'native', 'IOM.dll'),
    libsDll: join(root, 'native', 'Libs.dll')
  }
}

/** Default runner: Windows PowerShell 5.1 (.NET Framework — required for these DLLs). */
export const defaultScriptRunner: ScriptRunner = (scriptPath, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { env: { ...process.env, ...env }, windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })

function readLogTail(logFile: string, maxChars: number): string {
  try {
    const text = readFileSync(logFile, 'utf8')
    return text.length > maxChars ? `…(truncated)…\n${text.slice(-maxChars)}` : text
  } catch {
    return '(log file not found or unreadable)'
  }
}

export interface PackagingDeps {
  resources?: PackagingResources
  runner?: ScriptRunner
  /** Override the temp-dir factory in tests. Returns a fresh dir for log files. */
  makeTempDir?: () => string
  /** Cap on bytes of the engine log echoed back to the agent. */
  maxLogChars?: number
}

/** Shape returned to the tool layer; `text` is what the agent sees. */
export interface PackagingOutcome {
  ok: boolean
  text: string
}

const DEFAULT_MAX_LOG = 12_000

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aras-pkg-'))
}

/**
 * Import a manifest (.mf) into the connected instance.
 * `manifestPath` must point to an existing .mf file; the engine resolves package
 * folders relative to that file's directory.
 */
export async function runImport(
  creds: ArasCredentials,
  manifestPath: string,
  deps: PackagingDeps = {}
): Promise<PackagingOutcome> {
  const res = deps.resources ?? resolveResources()
  const runner = deps.runner ?? defaultScriptRunner
  const maxLog = deps.maxLogChars ?? DEFAULT_MAX_LOG

  if (!existsSync(manifestPath)) {
    return { ok: false, text: `Assertion failed: manifest file not found: ${manifestPath}` }
  }
  for (const [label, p] of [
    ['import script', res.importScript],
    ['IOM.dll', res.iomDll],
    ['Libs.dll', res.libsDll]
  ] as const) {
    if (!existsSync(p)) return { ok: false, text: `Bundled ${label} missing at ${p}. Reinstall the package.` }
  }

  const logDir = (deps.makeTempDir ?? tempDir)()
  const logFile = join(logDir, 'import.log')
  try {
    const run = await runner(
      res.importScript,
      [
        '-ArasUrl', creds.instanceUrl,
        '-ArasDatabase', creds.database,
        '-ArasUser', creds.username,
        '-ManifestFile', manifestPath,
        '-LogFile', logFile,
        '-IomDll', res.iomDll,
        '-LibsDll', res.libsDll
      ],
      { ARAS_PKG_PASSWORD: creds.password }
    )
    const ok = run.exitCode === 0 && /ARAS_IMPORT_OK/.test(run.stdout)
    const log = readLogTail(logFile, maxLog)
    return {
      ok,
      text: formatResult({ ok, kind: 'Import', run, log, extra: { manifest: manifestPath } })
    }
  } finally {
    try {
      if (!deps.makeTempDir) rmSync(logDir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Items to export, grouped by the package each one belongs to. */
export type PackageGroups = Record<string, ExportTriplet[]>

/**
 * Export the given items into `outDir`, grouped by package. `outDir` must already exist
 * and be empty — a non-empty (or missing) folder is a clear assertion error. One call
 * spans every package in `groups`; the generated `imports.mf` enumerates all of them.
 */
export async function runExport(
  creds: ArasCredentials,
  outDir: string,
  groups: PackageGroups,
  deps: PackagingDeps = {}
): Promise<PackagingOutcome> {
  const res = deps.resources ?? resolveResources()
  const runner = deps.runner ?? defaultScriptRunner
  const maxLog = deps.maxLogChars ?? DEFAULT_MAX_LOG

  const packageNames = Object.keys(groups)
  const totalItems = packageNames.reduce((n, p) => n + groups[p].length, 0)
  if (totalItems === 0) {
    return { ok: false, text: 'Assertion failed: no items given to export.' }
  }
  if (!existsSync(outDir)) {
    return { ok: false, text: `Assertion failed: output folder does not exist: ${outDir}. Create it (empty) first.` }
  }
  let entries: string[]
  try {
    entries = readdirSync(outDir)
  } catch (e) {
    return { ok: false, text: `Assertion failed: cannot read output folder ${outDir}: ${(e as Error).message}` }
  }
  if (entries.length > 0) {
    return {
      ok: false,
      text:
        `Assertion failed: output folder is not empty (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}): ${outDir}. ` +
        'Export requires an empty target folder so it cannot clobber existing files.'
    }
  }
  for (const [label, p] of [
    ['export script', res.exportScript],
    ['IOM.dll', res.iomDll],
    ['Libs.dll', res.libsDll]
  ] as const) {
    if (!existsSync(p)) return { ok: false, text: `Bundled ${label} missing at ${p}. Reinstall the package.` }
  }

  const logDir = (deps.makeTempDir ?? tempDir)()
  const logFile = join(logDir, 'export.log')
  try {
    const run = await runner(
      res.exportScript,
      [
        '-ArasUrl', creds.instanceUrl,
        '-ArasDatabase', creds.database,
        '-ArasUser', creds.username,
        '-OutDir', outDir,
        '-LogFile', logFile,
        '-IomDll', res.iomDll,
        '-LibsDll', res.libsDll,
        '-GroupsJson', JSON.stringify(groups)
      ],
      { ARAS_PKG_PASSWORD: creds.password }
    )
    const ok = run.exitCode === 0 && /ARAS_EXPORT_OK/.test(run.stdout)
    const log = readLogTail(logFile, maxLog)
    return {
      ok,
      text: formatResult({
        ok,
        kind: 'Export',
        run,
        log,
        extra: { outDir, items: totalItems, packages: packageNames.join(', ') }
      })
    }
  } finally {
    try {
      if (!deps.makeTempDir) rmSync(logDir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
}

function formatResult(opts: {
  ok: boolean
  kind: 'Import' | 'Export'
  run: ScriptRun
  log: string
  extra: Record<string, string | number>
}): string {
  const { ok, kind, run, log, extra } = opts
  const header = ok ? `${kind} succeeded.` : `${kind} FAILED (exit ${run.exitCode}).`
  const meta = Object.entries(extra)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const stderr = run.stderr.trim() ? `\n--- stderr ---\n${run.stderr.trim()}` : ''
  return (
    `${header}\n${meta}\n` +
    `\n--- messages ---\n${run.stdout.trim() || '(no output)'}` +
    stderr +
    `\n\n--- ${kind.toLowerCase()} log ---\n${log}`
  )
}
