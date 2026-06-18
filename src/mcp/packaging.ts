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

/**
 * Find the directory that actually holds the bundled resources (`scripts/` + `native/`).
 * In a distributed build the build step copies these next to `server.js`, so `dist/` is
 * self-contained — walk up from the module dir and take the first ancestor that has
 * `scripts/export.ps1`. That's `dist/` for a shipped build and the package root in dev
 * (tsx/vitest run from `src/`). Falls back to the package root if nothing is bundled, so
 * the failure surfaces as a missing-resource error rather than a wrong directory.
 */
export function findResourceRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'scripts', 'export.ps1'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return findPackageRoot(startDir)
}

export function resolveResources(root = findResourceRoot()): PackagingResources {
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
  /** Host platform; defaults to process.platform. Overridable so tests are deterministic. */
  platform?: NodeJS.Platform
}

/**
 * Import/export drive the Aras .NET Framework package utilities through Windows
 * PowerShell — there is no equivalent on other platforms. Return a clear, agent-facing
 * refusal rather than letting `spawn('powershell.exe')` fail with a cryptic ENOENT.
 */
function windowsOnlyGuard(op: string, platform: NodeJS.Platform): PackagingOutcome | null {
  if (platform === 'win32') return null
  return {
    ok: false,
    text:
      `${op} is Windows-only: it runs the Aras .NET Framework package import/export ` +
      `utilities via Windows PowerShell, which is not available on this platform (${platform}). ` +
      'Run the MCP server on Windows to use this tool.'
  }
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
  const guard = windowsOnlyGuard('aras_import', deps.platform ?? process.platform)
  if (guard) return guard

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
    const ran = run.exitCode === 0 && /ARAS_IMPORT_OK/.test(run.stdout)
    const engineErrors = engineErrorCount(run.stdout)
    const ok = ran && engineErrors === 0
    const log = readLogTail(logFile, maxLog)
    return {
      ok,
      text: formatResult({ ok, ran, engineErrors, kind: 'Import', run, log, extra: { manifest: manifestPath } })
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
  const guard = windowsOnlyGuard('aras_export', deps.platform ?? process.platform)
  if (guard) return guard

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
    const ran = run.exitCode === 0 && /ARAS_EXPORT_OK/.test(run.stdout)
    const engineErrors = engineErrorCount(run.stdout)
    const ok = ran && engineErrors === 0
    const log = readLogTail(logFile, maxLog)
    return {
      ok,
      text: formatResult({
        ok,
        ran,
        engineErrors,
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

/**
 * Pull out the engine's error lines so the agent can judge a *partial* run (some items
 * processed, some not — the DLL's own behaviour, which we don't override). Catches both
 * the dedicated error channel (`[ERROR]`/`[ERROR?]`) and the engine's quirk of routing
 * failures through the warning channel with an `****ErrorMessage****` banner.
 */
function extractEngineErrors(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\[ERROR\??\]/.test(l) || /ErrorMessage/i.test(l))
}

/**
 * Authoritative engine error count: the scripts print `ARAS_ENGINE_ERRORS:<n>` (counted
 * in the C# message factory). Fall back to scraping error lines if that marker is absent.
 */
function engineErrorCount(stdout: string): number {
  const m = /ARAS_ENGINE_ERRORS:\s*(\d+)/.exec(stdout)
  return m ? Number(m[1]) : extractEngineErrors(stdout).length
}

function formatResult(opts: {
  ok: boolean
  ran: boolean
  engineErrors: number
  kind: 'Import' | 'Export'
  run: ScriptRun
  log: string
  extra: Record<string, string | number>
}): string {
  const { ok, ran, engineErrors, kind, run, log, extra } = opts

  // A run that reached completion but logged engine errors is a PARTIAL result — we treat
  // it as a failure (isError) so the host gates it, while still handing the agent the error
  // lines + full log so it can see exactly what didn't apply.
  const header = ok
    ? `${kind} succeeded.`
    : ran
      ? `${kind} FAILED: the engine reported ${engineErrors} error message(s) — the run is PARTIAL (some items may not have applied).`
      : `${kind} FAILED (exit ${run.exitCode}).`

  const meta = Object.entries(extra)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  const errs = extractEngineErrors(run.stdout)
  const errBlock = errs.length ? `\n\n--- engine errors (${errs.length}) ---\n${errs.join('\n')}` : ''

  const stderr = run.stderr.trim() ? `\n--- stderr ---\n${run.stderr.trim()}` : ''
  return (
    `${header}\n${meta}` +
    errBlock +
    `\n\n--- messages ---\n${run.stdout.trim() || '(no output)'}` +
    stderr +
    `\n\n--- ${kind.toLowerCase()} log ---\n${log}`
  )
}
