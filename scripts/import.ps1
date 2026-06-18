<#
.SYNOPSIS
    Import an Aras solution manifest (.mf) into a live Aras Innovator (v12+) instance.

.DESCRIPTION
    Driven by the aras-mcp `aras_import` tool. Loads IOM.dll + Libs.dll and runs
    ImportExportManager.ImportSolutions over every package listed in the manifest.

    The engine calls happen inside a compiled C# helper (PowerShell hands it only
    primitive strings). This mirrors the export driver and avoids the PowerShell-host
    "cast PSObject to Hashtable" failure mode the SolutionUpgrade engine exhibits when
    driven directly from PowerShell. Do NOT inline this back into pure PowerShell.

    Import is a MERGE import (bMerge=true) and THOROUGH (bFast=false) with vault data
    (bVault=true) - the safe defaults; -FastMode / -MergeMode can override for manual runs.

    Contract with the caller:
      - Prints "ARAS_IMPORT_OK" on success, "ARAS_IMPORT_FAIL: <reason>" on failure.
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
    [Parameter(Mandatory)][string] $ManifestFile,
    [Parameter(Mandatory)][string] $LogFile,
    [Parameter(Mandatory)][string] $IomDll,
    [Parameter(Mandatory)][string] $LibsDll,
    [bool] $FastMode  = $false,
    [bool] $MergeMode = $true,
    [int]  $Timeout   = 1200000
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
    Write-Output "ARAS_IMPORT_FAIL: $msg"
    exit 1
}

try {
    if ([string]::IsNullOrEmpty($ArasPassword)) { Fail "No password supplied (set ARAS_PKG_PASSWORD or pass -ArasPassword)" }
    if (-not (Test-Path $ManifestFile)) { Fail "Manifest file not found: $ManifestFile" }
    if (-not (Test-Path $IomDll))       { Fail "IOM.dll not found: $IomDll" }
    if (-not (Test-Path $LibsDll))      { Fail "Libs.dll not found: $LibsDll" }

    $iom  = (Resolve-Path $IomDll).Path
    $libs = (Resolve-Path $LibsDll).Path
    $manifest = (Resolve-Path $ManifestFile).Path
    Add-Type -Path $iom
    Add-Type -Path $libs

    $code = @"
using System;
using System.Collections;
using System.IO;
using System.Xml;
using Aras.IOM;
using Aras.IOM.OAuth;
using Aras.Tools.SolutionUpgrade;

public class ImpMessage : Message {
    private readonly string _prefix;
    private readonly ImpResult _r;
    public ImpMessage(string prefix, ImpResult r) { _prefix = prefix; _r = r; }
    public override bool? Execute() {
        if (!string.IsNullOrEmpty(Text)) {
            Console.WriteLine("  [{0}] {1}", _prefix, Text);
            // The engine sometimes routes failures through the warning channel with the
            // "****ErrorMessage****" banner - count both so the tally is reliable.
            if (_prefix == "ERROR" || _prefix == "ERROR?" || Text.IndexOf("ErrorMessage", StringComparison.OrdinalIgnoreCase) >= 0)
                _r.Errors++;
        }
        return true;
    }
}

public class ImpResult { public int Errors = 0; }

public class ImpMessagesFactory : IMessagesFactory {
    private readonly ImpResult _r;
    public ImpMessagesFactory(ImpResult r) { _r = r; }
    public Message GetErrorMessage()          { return new ImpMessage("ERROR",  _r); }
    public Message GetErrorMessageQuestion()  { return new ImpMessage("ERROR?", _r); }
    public Message GetWarningMessage()        { return new ImpMessage("WARN",   _r); }
    public Message GetStatusMessage()         { return new ImpMessage("INFO",   _r); }
    public Message GetCurrentPackageMessage() { return new ImpMessage("PKG",    _r); }
}

public static class ArasImportRunner {
    // Returns error-message count; throws on a non-zero engine return code.
    public static int Run(
        string url, string db, string user, string pw,
        string manifestFile, string logFile, int timeout, bool fast, bool merge) {

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

        var manifestInfo = new FileInfo(manifestFile);
        var ctx = new SolutionUpgradeContext {
            Action = ImportExport.Import, Verbose = true, Url = url,
            DataBase = db, UserName = user, Password = pw,
            WorkingDirectory = manifestInfo.DirectoryName, ManifestFile = manifestInfo.FullName,
            LogFilePath = logFile, Timeout = timeout
        };
        var importContext = new SUImportContext { bFast = fast, bMerge = merge, bVault = true };

        var packages = new ArrayList();
        var doc = new XmlDocument();
        doc.Load(manifestFile);
        var root = doc.DocumentElement; // <imports>
        foreach (XmlNode node in root.ChildNodes) {
            if (node.NodeType != XmlNodeType.Element) continue;
            if (!string.Equals(node.Name, "package", StringComparison.OrdinalIgnoreCase)) continue;
            var nameAttr = node.Attributes["name"];
            if (nameAttr != null && !string.IsNullOrEmpty(nameAttr.Value)) packages.Add(nameAttr.Value);
        }
        if (packages.Count == 0) throw new Exception("Manifest lists no <package> entries: " + manifestFile);
        Console.WriteLine("INFO: importing packages: " + string.Join(", ", (string[])packages.ToArray(typeof(string))));

        var r = new ImpResult();
        var mf = new ImpMessagesFactory(r);
        var ci = new CItemHelper(sc);
        ci.Login();
        var mgr = new ImportExportManager(ctx, mf, ci);
        int returnCode = mgr.ImportSolutions(packages, importContext);
        if (returnCode != 0) throw new Exception("ImportSolutions returned " + returnCode + " (see log: " + logFile + ")");
        return r.Errors;
    }
}
"@
    Add-Type -TypeDefinition $code -ReferencedAssemblies @($iom, $libs, 'System.Xml.dll')

    $errors = [ArasImportRunner]::Run(
        $ArasUrl, $ArasDatabase, $ArasUser, $ArasPassword,
        $manifest, $LogFile, $Timeout, $FastMode, $MergeMode)

    # A non-zero engine return code already hard-fails inside the helper. Remaining per-item
    # errors may be partial; surface the count and let the caller judge from the log.
    Write-Output "ARAS_ENGINE_ERRORS: $errors"
    Write-Output "ARAS_IMPORT_OK"
    exit 0
}
catch {
    Fail "$($_.Exception.Message)"
}
