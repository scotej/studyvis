[CmdletBinding()]
param(
    [string] $RuntimeDirectory = (Join-Path $PSScriptRoot '../src-tauri/binaries/llama-runtime-x86_64-pc-windows-msvc'),
    [string] $RootRuntimeDirectory = (Join-Path $PSScriptRoot '../src-tauri/binaries/windows-vc-runtime-x86_64-pc-windows-msvc')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    throw 'Stage the Windows runtime on Windows with Visual Studio 2022 installed.'
}
if (-not (Test-Path -LiteralPath $RuntimeDirectory -PathType Container)) {
    throw 'Fetch the Windows llama-server prebuild before staging its Visual C++ runtime.'
}
New-Item -ItemType Directory -Path $RootRuntimeDirectory -Force | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw 'The Visual Studio installer discovery tool is missing.'
}
$installations = @(& $vswhere -latest -version '[17.0,18.0)' -products Microsoft.VisualStudio.Product.Enterprise Microsoft.VisualStudio.Product.Professional -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json -utf8 | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $installations.Count -ne 1) {
    throw 'A licensed Visual Studio 2022 Enterprise or Professional C++ installation is required.'
}
$installation = $installations[0]
$redistRoot = Join-Path $installation.installationPath 'VC/Redist/MSVC'
$versions = @(Get-ChildItem -LiteralPath $redistRoot -Directory | Where-Object {
    $parsed = $null
    [version]::TryParse($_.Name, [ref] $parsed)
} | Sort-Object { [version] $_.Name } -Descending)
if ($versions.Count -eq 0) {
    throw "No versioned Visual C++ redistributable directory exists under $redistRoot."
}
$redistVersion = $versions[0].Name
$relativeDirectory = "VC/Redist/MSVC/$redistVersion/x64/Microsoft.VC143.CRT"
$sourceDirectory = Join-Path $installation.installationPath $relativeDirectory
$required = @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')
$files = @()

foreach ($name in $required) {
    $source = Join-Path $sourceDirectory $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "The official x64 CRT redistributable is incomplete: $source."
    }
    $bytes = [System.IO.File]::ReadAllBytes($source)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
        throw "$source is not a PE binary."
    }
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    if ($peOffset -lt 64 -or $peOffset -gt $bytes.Length - 24 -or
        [BitConverter]::ToUInt32($bytes, $peOffset) -ne 0x00004550 -or
        [BitConverter]::ToUInt16($bytes, $peOffset + 4) -ne 0x8664) {
        throw "$source is not an AMD64 PE binary."
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $source
    $signerName = if ($null -ne $signature.SignerCertificate) {
        $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    } else {
        '<none>'
    }
    $signerSubject = if ($null -ne $signature.SignerCertificate) {
        $signature.SignerCertificate.Subject
    } else {
        '<none>'
    }
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signerName -ne 'Microsoft Corporation') {
        throw "$source does not have a valid Microsoft Corporation Authenticode signature: status=$($signature.Status); message=$($signature.StatusMessage); signer=$signerName; subject=$signerSubject."
    }
    $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($source)
    if ($info.FileMajorPart -ne 14) {
        throw "$source is not a Visual C++ v14 runtime."
    }
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    # NSIS deduplicates resource sources, so root and nested targets need
    # distinct physical source files even though their contents are identical.
    foreach ($directory in @($RuntimeDirectory, $RootRuntimeDirectory)) {
        $destination = Join-Path $directory $name
        Copy-Item -LiteralPath $source -Destination $destination -Force
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) {
            throw "Staged runtime hash mismatch: $destination."
        }
    }
    $files += [ordered] @{
        name = $name
        version = "$($info.FileMajorPart).$($info.FileMinorPart).$($info.FileBuildPart).$($info.FilePrivatePart)"
        sha256 = $hash
        size = $bytes.Length
        machine = 'AMD64'
        signerSubject = $signature.SignerCertificate.Subject
        signerThumbprint = $signature.SignerCertificate.Thumbprint
    }
}

$licenseName = 'VC-RUNTIME-LICENSE.docx'
$licenseSource = Join-Path $PSScriptRoot 'licenses/MICROSOFT-VISUAL-STUDIO-2022-LICENSE.docx'
$licenseSha256 = '9c0cd52b20db9d081854c75bd1b50c75514b8f8cb09c8cad15e89d90b97b5bf3'
if ((Get-FileHash -LiteralPath $licenseSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $licenseSha256) {
    throw 'The pinned Microsoft license document has changed.'
}
Copy-Item -LiteralPath $licenseSource -Destination (Join-Path $RuntimeDirectory $licenseName) -Force

$licenseUrl = 'https://visualstudio.microsoft.com/license-terms/vs2022-ga-proenterprise/'
$licenseSourceUrl = 'https://visualstudio.microsoft.com/wp-content/uploads/2021/11/Visual-Studio-2022-Enterprise-Professional-License-EN.docx'
$redistributionUrl = 'https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution'
$manifest = [ordered] @{
    schemaVersion = 1
    component = 'Microsoft Visual C++ Runtime'
    architecture = 'x64'
    source = [ordered] @{
        kind = 'visual-studio-redist'
        productId = $installation.productId
        installationVersion = $installation.installationVersion
        redistVersion = $redistVersion
        relativeDirectory = $relativeDirectory
        redistributionUrl = $redistributionUrl
        licenseUrl = $licenseUrl
    }
    license = [ordered] @{
        name = $licenseName
        sourceUrl = $licenseSourceUrl
        sha256 = $licenseSha256
    }
    files = $files
}
$encoding = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $RuntimeDirectory 'VC-RUNTIME-MANIFEST.json'), (($manifest | ConvertTo-Json -Depth 6) + "`n"), $encoding)
$notice = @"
MICROSOFT VISUAL C++ RUNTIME
Copyright Microsoft Corporation. All rights reserved.

StudyVis includes unmodified x64 release DLLs from the licensed Visual Studio
2022 $($installation.productId) installation's $relativeDirectory directory.
These proprietary files are separate from StudyVis's Cargo/npm/llama notices.
The accompanying $licenseName contains the Microsoft license terms.
VC-RUNTIME-MANIFEST.json records each file's version, SHA-256, and Microsoft
Authenticode signer, and the license document's source and SHA-256.

License terms: $licenseUrl
Distributable files: $redistributionUrl
"@
[System.IO.File]::WriteAllText((Join-Path $RuntimeDirectory 'VC-RUNTIME-NOTICE.txt'), ($notice + "`n"), $encoding)
Write-Host "Staged $($required.Count) Microsoft x64 runtime DLLs from Visual Studio $($installation.installationVersion), redist $redistVersion."
