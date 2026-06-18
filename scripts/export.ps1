<#
.SYNOPSIS
    Export a set of Aras items from a live Aras Innovator (v12+) instance into a folder,
    grouped by the package each item belongs to, producing a re-importable manifest.

.DESCRIPTION
    Driven by the aras-mcp `aras_export` tool. Loads IOM.dll + Libs.dll, authenticates
    with the OAuth password grant, and runs ImportExportManager.ExportSolutions over the
    "selected items" table.

    The caller has already resolved which package each item belongs to (orphans — items
    in no package — are rejected by the tool before this script runs). -GroupsJson is a
    JSON object mapping packageName -> array of { itemType, itemId, keyedName }:

        { "com.acme.parts": [ { "itemType": "Part", "itemId": "...", "keyedName": "P-1" } ],
          "com.acme.cad":   [ ... ] }

    One export call therefore spans every package its items live in. After export an
    `imports.mf` is written at the root of -OutDir enumerating ALL of those packages, so
    the result can be fed straight back to `aras_import`.

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

    $groups = $GroupsJson | ConvertFrom-Json
    if ($null -eq $groups) { Fail "GroupsJson did not parse" }
    $packageNames = @($groups.PSObject.Properties.Name)
    if ($packageNames.Count -eq 0) { Fail "No packages/items requested for export" }

    Add-Type -Path $IomDll
    Add-Type -Path $LibsDll

    # --- OAuth password-grant connection ---
    $tokenEndpoint = $ArasUrl.TrimEnd('/') + "/OAuthServer/connect/token"
    $tokenOptions = New-Object Aras.IOM.OAuth.PasswordTokenProviderOptions
    $tokenOptions.ClientId      = "IOMApp"
    $tokenOptions.Scope         = "Innovator"
    $tokenOptions.Database      = $ArasDatabase
    $tokenOptions.UserName      = $ArasUser
    $tokenOptions.Password      = $ArasPassword
    $tokenOptions.TokenEndpoint = $tokenEndpoint

    $tokenProvider    = New-Object Aras.IOM.OAuth.PasswordTokenProvider($tokenOptions)
    $serverConnection = [Aras.IOM.IomFactory]::CreateHttpServerConnection($ArasUrl, $tokenProvider, [Aras.IOM.OAuth.ProtocolType]::Standard)

    $inn = New-Object Aras.IOM.Innovator($serverConnection)
    $test = $inn.applyAML("<AML></AML>")
    if ($test.isError()) { Fail "Aras connection/auth failed: $($test.getErrorDetail())" }
    Write-Output "INFO: connected to $ArasUrl (db=$ArasDatabase) as $ArasUser"

    # --- Build the SolutionUpgrade selected-items table ---
    #   table[packageName] = Hashtable( itemId -> ExportItem(keyedName, itemId, itemType) )
    $table = New-Object System.Collections.Hashtable
    $totalItems = 0
    foreach ($pkgName in $packageNames) {
        $pkgItems = New-Object System.Collections.Hashtable
        foreach ($it in @($groups.$pkgName)) {
            $itemType  = [string]$it.itemType
            $itemId    = [string]$it.itemId
            $keyedName = [string]$it.keyedName
            if ([string]::IsNullOrWhiteSpace($itemType) -or [string]::IsNullOrWhiteSpace($itemId)) {
                Fail "Each item needs a non-empty itemType and itemId (package '$pkgName')"
            }
            if ([string]::IsNullOrWhiteSpace($keyedName)) { $keyedName = $itemId }
            $pkgItems[$itemId] = New-Object Aras.Tools.SolutionUpgrade.ExportItem($keyedName, $itemId, $itemType)
            $totalItems++
        }
        $table[$pkgName] = $pkgItems
    }
    Write-Output "INFO: exporting $totalItems item(s) across $($packageNames.Count) package(s): $($packageNames -join ', ')"

    # The export URL the engine expects: normalize via the lib's helper if present,
    # otherwise fall back to the raw URL (proven to work for the import path).
    $serverPath = $ArasUrl
    try   { $serverPath = [Aras.Tools.SolutionUpgrade.InnovatorServer]::GetInnovatorServerPath($ArasUrl) }
    catch {
        try { $serverPath = [Aras.IOM.InnovatorServer]::GetInnovatorServerPath($ArasUrl) }
        catch { $serverPath = $ArasUrl }
    }

    # --- Export context ---
    $context = New-Object Aras.Tools.SolutionUpgrade.SolutionUpgradeContext
    $context.Action           = [Aras.Tools.SolutionUpgrade.ImportExport]::Export
    $context.WorkingDirectory = $OutDir
    $context.Url              = $serverPath
    $context.DataBase         = $ArasDatabase
    $context.UserName         = $ArasUser
    $context.Password         = $ArasPassword
    $context.LogFilePath      = $LogFile
    $context.Timeout          = $Timeout

    $exportContext = New-Object Aras.Tools.SolutionUpgrade.SUExportContext
    $exportContext.sLevel                 = "1"
    $exportContext.bExportReferencedItems = $ExportReferenced
    $exportContext.RefToUnknownPacks      = [Aras.Tools.SolutionUpgrade.ReferencesToUnknownPackages]::DoNotRemove

    # Message factory: relay engine messages to stdout.
    $msgFactoryCode = @"
using System;
using Aras.Tools.SolutionUpgrade;

public class ConsoleMessage : Message {
    private readonly string _prefix;
    public ConsoleMessage(string prefix) { _prefix = prefix; }
    public override bool? Execute() {
        if (!string.IsNullOrEmpty(Text))
            Console.WriteLine("  [{0}] {1}", _prefix, Text);
        return true;
    }
}

public class ConsoleMessagesFactory : IMessagesFactory {
    public Message GetErrorMessage()          { return new ConsoleMessage("ERROR"); }
    public Message GetErrorMessageQuestion()  { return new ConsoleMessage("ERROR?"); }
    public Message GetWarningMessage()        { return new ConsoleMessage("WARN"); }
    public Message GetStatusMessage()         { return new ConsoleMessage("INFO"); }
    public Message GetCurrentPackageMessage() { return new ConsoleMessage("PKG"); }
}
"@
    Add-Type -TypeDefinition $msgFactoryCode -ReferencedAssemblies @($LibsDll)
    $messagesFactory = New-Object ConsoleMessagesFactory

    $cItemHelper = New-Object Aras.Tools.SolutionUpgrade.CItemHelper($serverConnection)
    $cItemHelper.Login()

    $importExportManager = New-Object Aras.Tools.SolutionUpgrade.ImportExportManager($context, $messagesFactory, $cItemHelper)
    $importExportManager.ExportSolutions($exportContext, $table)

    # --- Write a re-importable manifest (imports.mf) enumerating EVERY package ---
    # com.aras* packages live at root; everything else under <leaf>\Import (matches the
    # folder layout ExportSolutions writes and the import convention).
    $mfPath = Join-Path $OutDir "imports.mf"
    $xml = New-Object System.Xml.XmlDocument
    $root = $xml.CreateElement("imports")
    [void]$xml.AppendChild($root)
    foreach ($pkgName in $packageNames) {
        $pkgEl = $xml.CreateElement("package")
        $pkgEl.SetAttribute("name", $pkgName)
        if ($pkgName.StartsWith("com.aras")) {
            $pkgEl.SetAttribute("path", ".\")
        } elseif ($pkgName.StartsWith("com.")) {
            $pkgEl.SetAttribute("path", ($pkgName.Split('.')[-1] + "\Import"))
        } else {
            $pkgEl.SetAttribute("path", ($pkgName + "\Import"))
        }
        [void]$root.AppendChild($pkgEl)
    }
    $xml.Save($mfPath)
    Write-Output "INFO: wrote manifest $mfPath ($($packageNames.Count) package(s))"

    Write-Output "ARAS_EXPORT_OK"
    exit 0
}
catch {
    Fail "$($_.Exception.Message)"
}
