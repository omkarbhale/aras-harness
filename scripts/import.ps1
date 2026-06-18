<#
.SYNOPSIS
    Import an Aras solution manifest (.mf) into a live Aras Innovator (v12+) instance.

.DESCRIPTION
    Driven by the aras-mcp `aras_import` tool. Loads IOM.dll + Libs.dll (the
    Aras.Tools.SolutionUpgrade package import/export library), authenticates with the
    OAuth password grant, and runs ImportExportManager.ImportSolutions over every
    package listed in the manifest.

    All progress/status/error lines from the import engine are written to stdout
    (prefixed) so the calling tool can relay them to the agent; the engine's own log
    is written to -LogFile.

    Contract with the caller:
      - Prints "ARAS_IMPORT_OK" on success, "ARAS_IMPORT_FAIL: <reason>" on failure.
      - Exit code 0 on success, non-zero on failure.

    This is Windows PowerShell 5.1 / .NET Framework only: the Aras libraries are
    .NET Framework assemblies.
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

    Add-Type -Path $IomDll
    Add-Type -Path $LibsDll

    # --- OAuth password-grant connection (mirrors Aras IOMApp client) ---
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

    # --- Import context ---
    $manifestInfo = New-Object System.IO.FileInfo($ManifestFile)
    $context = New-Object Aras.Tools.SolutionUpgrade.SolutionUpgradeContext
    $context.Action           = [Aras.Tools.SolutionUpgrade.ImportExport]::Import
    $context.Verbose          = $true
    $context.Url              = $ArasUrl
    $context.DataBase         = $ArasDatabase
    $context.UserName         = $ArasUser
    $context.Password         = $ArasPassword
    $context.WorkingDirectory = $manifestInfo.DirectoryName
    $context.ManifestFile     = $manifestInfo.FullName
    $context.LogFilePath      = $LogFile
    $context.Timeout          = $Timeout

    $importContext = New-Object Aras.Tools.SolutionUpgrade.SUImportContext
    $importContext.bFast  = $FastMode
    $importContext.bMerge = $MergeMode
    $importContext.bVault = $true

    $cItemHelper = New-Object Aras.Tools.SolutionUpgrade.CItemHelper($serverConnection)
    $cItemHelper.Login()

    # Message factory: relay every engine message to stdout so the tool can surface it.
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

    $importExportManager = New-Object Aras.Tools.SolutionUpgrade.ImportExportManager($context, $messagesFactory, $cItemHelper)

    # Packages to import = every <package name="..."> in the manifest.
    [xml]$manifestXml = Get-Content $ManifestFile -Raw
    $packagesToImport = New-Object System.Collections.ArrayList
    foreach ($pkg in $manifestXml.imports.package) {
        [void]$packagesToImport.Add($pkg.name)
    }
    if ($packagesToImport.Count -eq 0) { Fail "Manifest lists no <package> entries: $ManifestFile" }
    Write-Output "INFO: importing packages: $($packagesToImport -join ', ')"

    $returnCode = $importExportManager.ImportSolutions($packagesToImport, $importContext)
    if ($returnCode -ne 0) { Fail "ImportSolutions returned $returnCode (see log: $LogFile)" }

    Write-Output "ARAS_IMPORT_OK"
    exit 0
}
catch {
    Fail "$($_.Exception.Message)"
}
