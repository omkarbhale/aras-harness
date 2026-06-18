<#
.SYNOPSIS
    Export a set of Aras items from a live Aras Innovator (v12+) instance into a folder,
    grouped by the package each item belongs to, producing a re-importable manifest.

.DESCRIPTION
    Driven by the aras-mcp `aras_export` tool. Loads IOM.dll + Libs.dll and runs the
    SolutionUpgrade ImportExportManager.ExportSolutions over the "selected items" table.

    IMPORTANT — why the work happens in C#:
      When ExportSolutions is invoked directly from PowerShell, the engine throws
      "Unable to cast object of type 'System.Management.Automation.PSObject' to type
      'System.Collections.Hashtable'" (PowerShell's ETS wraps an object the engine
      re-casts internally) and silently exports nothing. Building the table and calling
      the engine entirely inside a compiled C# helper avoids this — PowerShell only ever
      hands the helper primitive strings/arrays. Do NOT "simplify" this back into pure PS.

    The caller has already resolved which package each item belongs to (orphans are
    rejected by the tool before this script runs). -GroupsJson is a JSON object mapping
    packageName -> array of { itemType, itemId, keyedName }. One export call spans every
    package its items live in; the SolutionUpgrade engine itself writes an `imports.mf`
    at the root of -OutDir enumerating those packages (with their dependencies), so the
    result feeds straight back into `aras_import`.

    Contract with the caller:
      - -OutDir MUST already exist and be empty (the tool enforces this before calling).
      - Prints "ARAS_EXPORT_OK" on success, "ARAS_EXPORT_FAIL: <reason>" on failure.
      - Exit code 0 on success, non-zero on failure.

    Windows PowerShell 5.1 / .NET Framework only.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $ArasUrl,
    [Parameter(Mandatory)][string] $ArasDatabase,
    [Parameter(Mandatory)][string] $ArasUser,
    # Password is read from the ARAS_PKG_PASSWORD env var by default (keeps it off the
    # process command line); -ArasPassword may override for manual runs.
    [string] $ArasPassword = $env:ARAS_PKG_PASSWORD,
    [Parameter(Mandatory)][string] $OutDir,
    [Parameter(Mandatory)][string] $LogFile,
    [Parameter(Mandatory)][string] $IomDll,
    [Parameter(Mandatory)][string] $LibsDll,
    # JSON object: { "<packageName>": [ { "itemType","itemId","keyedName" }, ... ], ... }
    [Parameter(Mandatory)][string] $GroupsJson,
    [bool]   $ExportReferenced = $true,
    [int]    $Timeout          = 1200000
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
    Write-Output "ARAS_EXPORT_FAIL: $msg"
    exit 1
}

try {
    if ([string]::IsNullOrEmpty($ArasPassword)) { Fail "No password supplied (set ARAS_PKG_PASSWORD or pass -ArasPassword)" }
    if (-not (Test-Path $OutDir))  { Fail "Output directory does not exist: $OutDir" }
    if (-not (Test-Path $IomDll))  { Fail "IOM.dll not found: $IomDll" }
    if (-not (Test-Path $LibsDll)) { Fail "Libs.dll not found: $LibsDll" }

    $iom  = (Resolve-Path $IomDll).Path
    $libs = (Resolve-Path $LibsDll).Path
    Add-Type -Path $iom
    Add-Type -Path $libs

    # Flatten the grouped JSON into parallel primitive string arrays in PowerShell, then
    # hand them to the compiled helper. (Only strings cross the boundary — see note above.)
    $groups = $GroupsJson | ConvertFrom-Json
    if ($null -eq $groups) { Fail "GroupsJson did not parse" }
    $pkgArr  = New-Object System.Collections.Generic.List[string]
    $typeArr = New-Object System.Collections.Generic.List[string]
    $idArr   = New-Object System.Collections.Generic.List[string]
    $nameArr = New-Object System.Collections.Generic.List[string]
    foreach ($pkgName in @($groups.PSObject.Properties.Name)) {
        foreach ($it in @($groups.$pkgName)) {
            $pkgArr.Add([string]$pkgName)
            $typeArr.Add([string]$it.itemType)
            $idArr.Add([string]$it.itemId)
            $kn = [string]$it.keyedName
            if ([string]::IsNullOrWhiteSpace($kn)) { $kn = [string]$it.itemId }
            $nameArr.Add($kn)
        }
    }
    if ($idArr.Count -eq 0) { Fail "No items requested for export" }

    # --- Compiled helper: build the table + run the engine entirely in C# ---
    $code = @"
using System;
using System.Collections;
using Aras.IOM;
using Aras.IOM.OAuth;
using Aras.Tools.SolutionUpgrade;

public class PkgMessage : Message {
    private readonly string _prefix;
    private readonly ExpResult _r;
    public PkgMessage(string prefix, ExpResult r) { _prefix = prefix; _r = r; }
    public override bool? Execute() {
        if (!string.IsNullOrEmpty(Text)) {
            Console.WriteLine("  [{0}] {1}", _prefix, Text);
            if (_prefix == "ERROR" || _prefix == "ERROR?") _r.Errors++;
        }
        return true;
    }
}

public class ExpResult { public int Errors = 0; }

public class PkgMessagesFactory : IMessagesFactory {
    private readonly ExpResult _r;
    public PkgMessagesFactory(ExpResult r) { _r = r; }
    public Message GetErrorMessage()          { return new PkgMessage("ERROR",  _r); }
    public Message GetErrorMessageQuestion()  { return new PkgMessage("ERROR?", _r); }
    public Message GetWarningMessage()        { return new PkgMessage("WARN",   _r); }
    public Message GetStatusMessage()         { return new PkgMessage("INFO",   _r); }
    public Message GetCurrentPackageMessage() { return new PkgMessage("PKG",    _r); }
}

public static class ArasExportRunner {
    // Returns the number of error messages the engine reported (0 == clean).
    public static int Run(
        string url, string db, string user, string pw,
        string outDir, string logFile, int timeout, bool exportReferenced,
        string[] pkgNames, string[] itemTypes, string[] itemIds, string[] keyedNames) {

        var opts = new PasswordTokenProviderOptions {
            ClientId = "IOMApp", Scope = "Innovator", Database = db,
            UserName = user, Password = pw,
            TokenEndpoint = url.TrimEnd('/') + "/OAuthServer/connect/token"
        };
        var sc = IomFactory.CreateHttpServerConnection(url, new PasswordTokenProvider(opts), Aras.IOM.OAuth.ProtocolType.Standard);
        var inn = new Innovator(sc);
        var test = inn.applyAML("<AML></AML>");
        if (test.isError()) throw new Exception("Aras connection/auth failed: " + test.getErrorDetail());
        Console.WriteLine("INFO: connected to " + url + " (db=" + db + ") as " + user);

        // table[packageName] = Hashtable( itemId -> ExportItem(keyedName, itemId, itemType) )
        var table = new Hashtable();
        for (int i = 0; i < itemIds.Length; i++) {
            var pkg = pkgNames[i];
            var inner = (Hashtable)table[pkg];
            if (inner == null) { inner = new Hashtable(); table[pkg] = inner; }
            inner[itemIds[i]] = new ExportItem(keyedNames[i], itemIds[i], itemTypes[i]);
        }

        string serverPath = url;
        try { serverPath = InnovatorServer.GetInnovatorServerPath(url); } catch { serverPath = url; }

        var ctx = new SolutionUpgradeContext {
            Action = ImportExport.Export, WorkingDirectory = outDir, Url = serverPath,
            DataBase = db, UserName = user, Password = pw, LogFilePath = logFile, Timeout = timeout
        };
        var ec = new SUExportContext {
            sLevel = "1", bExportReferencedItems = exportReferenced,
            RefToUnknownPacks = ReferencesToUnknownPackages.DoNotRemove
        };

        var r = new ExpResult();
        var mf = new PkgMessagesFactory(r);
        var ci = new CItemHelper(sc);
        ci.Login();
        var mgr = new ImportExportManager(ctx, mf, ci);
        mgr.ExportSolutions(ec, table);
        return r.Errors;
    }
}
"@
    Add-Type -TypeDefinition $code -ReferencedAssemblies @($iom, $libs)

    $errors = [ArasExportRunner]::Run(
        $ArasUrl, $ArasDatabase, $ArasUser, $ArasPassword,
        $OutDir, $LogFile, $Timeout, $ExportReferenced,
        $pkgArr.ToArray(), $typeArr.ToArray(), $idArr.ToArray(), $nameArr.ToArray())

    if ($errors -gt 0) { Fail "ExportSolutions reported $errors error(s) (see log: $LogFile)" }

    # Sanity: the engine should have written at least one .xml plus its imports.mf.
    $xmlCount = (Get-ChildItem -Path $OutDir -Recurse -Filter *.xml -File -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($xmlCount -eq 0) { Fail "Export produced no .xml files in $OutDir (engine reported no error, but nothing was written)" }

    Write-Output "INFO: exported $($idArr.Count) item(s); $xmlCount xml file(s) written"
    Write-Output "ARAS_EXPORT_OK"
    exit 0
}
catch {
    Fail "$($_.Exception.Message)"
}
