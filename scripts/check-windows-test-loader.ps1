param(
    [Parameter(Mandatory = $true)]
    [string]$TargetDirectory,
    [Parameter(Mandatory = $true)]
    [string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Test-loader verification requires Windows' }
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$evidence = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
$report = [ordered]@{ checkedAt = (Get-Date).ToUniversalTime().ToString('o'); binary = $null; sha256 = $null; manifestV6 = $false; error = $null }

try {
    $binary = Get-ChildItem -LiteralPath $TargetDirectory -Filter 'journal_dispatch-*.exe' |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $binary) { throw 'No compiled journal_dispatch integration-test binary was found' }
    $report.binary = $binary.FullName
    $report.sha256 = (Get-FileHash -LiteralPath $binary.FullName -Algorithm SHA256).Hash
    Copy-Item -LiteralPath $binary.FullName -Destination $evidence
    $pdb = [IO.Path]::ChangeExtension($binary.FullName, '.pdb')
    if (Test-Path -LiteralPath $pdb) { Copy-Item -LiteralPath $pdb -Destination $evidence }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Visual Studio C++ tools were not found' }
    $dumpbin = Get-ChildItem -Path "$installation/VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe" |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $dumpbin) { throw 'dumpbin.exe was not found' }
    foreach ($operation in @('DEPENDENTS', 'IMPORTS')) {
        & $dumpbin.FullName "/$operation" $binary.FullName 2>&1 |
            Out-File -LiteralPath (Join-Path $evidence "$operation.txt") -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw "dumpbin /$operation failed" }
    }
    $systemControls = Join-Path $env:SystemRoot 'System32/comctl32.dll'
    & $dumpbin.FullName /EXPORTS $systemControls 2>&1 |
        Out-File -LiteralPath (Join-Path $evidence 'system-comctl32-exports.txt') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'dumpbin /EXPORTS comctl32.dll failed' }

    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin/*/x64/mt.exe'
    $mt = Get-ChildItem -Path $sdk | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $mt) { throw 'Windows SDK mt.exe was not found' }
    $manifestPath = Join-Path $evidence 'journal_dispatch.manifest'
    & $mt.FullName -nologo "-inputresource:$($binary.FullName);#1" "-out:$manifestPath" 2>&1 |
        Out-File -LiteralPath (Join-Path $evidence 'manifest-extraction.txt') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'The integration-test executable has no extractable application manifest' }
    [xml]$manifest = Get-Content -Raw -LiteralPath $manifestPath
    $dependencies = $manifest.SelectNodes("//*[local-name()='assemblyIdentity' and @name='Microsoft.Windows.Common-Controls' and @version='6.0.0.0']")
    if ($dependencies.Count -ne 1) { throw 'The integration test must activate Common Controls v6, like the application' }
    $report.manifestV6 = $true
    Write-Host "Verified Common Controls v6 manifest in $($binary.Name), SHA256 $($report.sha256)"
    Write-Host (Get-Content -Raw -LiteralPath $manifestPath)
}
catch {
    $report.error = $_.Exception.Message
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $evidence 'failure.txt') -Encoding utf8
}
finally {
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddMinutes(-30) } -ErrorAction SilentlyContinue |
            Where-Object { $_.ProviderName -in @('Application Error', 'Windows Error Reporting', 'SideBySide') -or $_.Message -like '*journal_dispatch*' } |
            Select-Object TimeCreated, Id, ProviderName, LevelDisplayName, Message)
        ConvertTo-Json -InputObject $events -Depth 5 |
            Set-Content -LiteralPath (Join-Path $evidence 'application-events.json') -Encoding utf8
    }
    catch {
        $_ | Out-String | Set-Content -LiteralPath (Join-Path $evidence 'application-events-error.txt') -Encoding utf8
    }
    try {
        $werRoot = Join-Path $env:ProgramData 'Microsoft/Windows/WER'
        $wer = @(Get-ChildItem -LiteralPath $werRoot -Filter 'Report.wer' -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 30)
        $index = 0
        foreach ($entry in $wer) {
            if (Select-String -LiteralPath $entry.FullName -Pattern 'journal_dispatch' -Quiet -ErrorAction SilentlyContinue) {
                Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $evidence "journal-dispatch-$index.wer")
                $index++
            }
        }
    }
    catch {
        $_ | Out-String | Set-Content -LiteralPath (Join-Path $evidence 'wer-error.txt') -Encoding utf8
    }
    $report | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $evidence 'loader-report.json') -Encoding utf8
}
if ($report.error) { throw $report.error }
