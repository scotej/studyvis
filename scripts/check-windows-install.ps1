param(
    [Parameter(Mandatory = $true)]
    [string]$Installer
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Installer smoke only runs in a disposable GitHub-hosted Windows account; never a developer profile'
}

function Invoke-Nsis {
    param([string]$Binary, [string]$CommandLine)

    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Binary
    $start.Arguments = $CommandLine
    $start.UseShellExecute = $false
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "Could not start $Binary" }
        if (-not $process.WaitForExit(180000)) {
            $process.Kill($true)
            $process.WaitForExit()
            throw "NSIS exceeded three minutes: $Binary"
        }
        if ($process.ExitCode -ne 0) { throw "NSIS failed with exit $($process.ExitCode): $Binary" }
    } finally {
        $process.Dispose()
    }
}

$installerPath = (Resolve-Path -LiteralPath $Installer).Path
if (-not $installerPath.EndsWith('-setup.exe', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Expected the exact NSIS -setup.exe artifact'
}
$config = Get-Content -Raw -LiteralPath 'src-tauri/tauri.conf.json' | ConvertFrom-Json
if ($config.bundle.windows.nsis.installMode -ne 'currentUser') {
    throw 'Installer smoke requires the currentUser install contract'
}
$version = $config.version
$product = $config.productName
$identifier = $config.identifier
$manufacturer = $identifier.Split('.')[1]
if ('publisher' -in $config.bundle.PSObject.Properties.Name) { $manufacturer = $config.bundle.publisher }
$roaming = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not $roaming -or -not $local) { throw 'Windows known folders are unavailable' }
$installRoot = Join-Path $local $product
$dataRoots = @((Join-Path $roaming 'studyvis'), (Join-Path $roaming $identifier), (Join-Path $local $identifier))
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$machineUninstallKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$protocolKey = 'HKCU:\Software\Classes\studyvis'
$machineProtocolKey = 'HKLM:\Software\Classes\studyvis'
$manufacturerKey = "HKCU:\Software\$manufacturer\$product"
$guardPaths = @($installRoot, $uninstallKey, $machineUninstallKey, $protocolKey, $machineProtocolKey, $manufacturerKey) + $dataRoots
foreach ($path in $guardPaths) {
    if (Test-Path -LiteralPath $path) { throw "Refusing a nonfresh hosted profile: $path already exists" }
}
if (Get-Process -Name 'studyvis' -ErrorAction SilentlyContinue) { throw 'StudyVis is already running' }

$installed = $false
$uninstalled = $false
$retained = @{}
try {
    # Do not override /D: asserting the real default per-user destination is
    # part of this test. /NS suppresses shortcuts, not install/registry work.
    Invoke-Nsis $installerPath '/S /NS'
    $app = Join-Path $installRoot 'studyvis.exe'
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $app) -or -not (Test-Path -LiteralPath $uninstaller)) {
        throw 'Silent install did not create the application and uninstaller in LocalAppData'
    }
    $installed = $true
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    if ($registration.DisplayName -ne $product -or $registration.DisplayVersion -ne $version -or
        $registration.InstallLocation.Trim('"') -ne $installRoot -or
        $registration.UninstallString.Trim('"') -ne $uninstaller) {
        throw 'Per-user uninstall registration does not match the exact installed artifact/version'
    }
    if (Test-Path -LiteralPath $machineUninstallKey) { throw 'Per-user installer unexpectedly registered a machine-wide installation' }
    $protocol = Get-Item -LiteralPath $protocolKey
    if ('URL Protocol' -notin $protocol.GetValueNames()) { throw 'studyvis:// lacks its URL Protocol registration' }
    $command = (Get-Item -LiteralPath "$protocolKey\shell\open\command").GetValue('')
    if ($command -ne ('"{0}" "%1"' -f $app)) { throw 'studyvis:// does not point to the installed executable and quoted URL argument' }
    if (Test-Path -LiteralPath $machineProtocolKey) { throw 'Per-user installer unexpectedly registered a machine-wide URL handler' }

    & (Join-Path $PSScriptRoot 'check-windows-runtime.ps1') -ArtifactRoot $installRoot
    if ($LASTEXITCODE -ne 0) { throw 'Installed application runtime/startup check failed' }
    foreach ($directory in $dataRoots) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $sentinel = Join-Path $directory '.studyvis-ci-retention.txt'
        [IO.File]::WriteAllText($sentinel, "retain-$([guid]::NewGuid())")
        $retained[$sentinel] = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
    }

    # Exercise the installer's real updater mode as well as first install.
    # This is same-version reinstallation, not a claim of N-1 updater proof.
    Invoke-Nsis $installerPath '/S /UPDATE /NS'
    foreach ($sentinel in $retained.Keys) {
        if (-not (Test-Path -LiteralPath $sentinel) -or (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $retained[$sentinel]) {
            throw 'NSIS updater mode removed or changed user data'
        }
    }

    # NSIS requires final, unquoted _?= to disable the self-copy child; waiting
    # on the original uninstaller otherwise races the actual uninstall.
    # https://nsis.sourceforge.io/Docs/Chapter3.html#uninstallerusage
    Invoke-Nsis $uninstaller "/S _?=$installRoot"
    $uninstalled = $true
    if ((Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $protocolKey)) {
        throw 'Silent uninstall left the executable, uninstall entry, or owned URL handler behind'
    }
    foreach ($sentinel in $retained.Keys) {
        if (-not (Test-Path -LiteralPath $sentinel) -or (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $retained[$sentinel]) {
            throw 'Silent uninstall removed or changed user data without the delete-data checkbox'
        }
    }
    Write-Host "Exact NSIS install/startup/registration/update-mode/uninstall passed for $product $version; native and Tauri data retained"
} finally {
    if ($installed -and -not $uninstalled) {
        $uninstaller = Join-Path $installRoot 'uninstall.exe'
        if (Test-Path -LiteralPath $uninstaller) {
            try { Invoke-Nsis $uninstaller "/S _?=$installRoot" } catch { Write-Warning "Cleanup uninstall failed: $_" }
        }
    }
    # Everything below was absent at the freshness guard and belongs only to
    # this ephemeral hosted profile. NSIS _?= can leave its running EXE behind.
    foreach ($path in @($installRoot) + $dataRoots) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    foreach ($path in @($uninstallKey, $protocolKey, $manufacturerKey)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
}
