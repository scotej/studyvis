param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactRoot,
    [switch]$StagedPrebuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) {
    throw 'Windows runtime startup verification requires Windows PowerShell 7'
}

function Invoke-PackagedEngine {
    param(
        [string]$Binary,
        [string]$WorkingDirectory,
        [string]$Argument
    )

    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Binary
    $start.WorkingDirectory = $WorkingDirectory
    $start.ArgumentList.Add($Argument)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment.Clear()
    $start.Environment['SystemRoot'] = $env:SystemRoot
    $start.Environment['WINDIR'] = $env:SystemRoot
    $start.Environment['TEMP'] = $WorkingDirectory
    $start.Environment['TMP'] = $WorkingDirectory
    $start.Environment['PATH'] = "$WorkingDirectory;$env:SystemRoot\System32;$env:SystemRoot"

    $engineProcess = [System.Diagnostics.Process]::new()
    $engineProcess.StartInfo = $start
    try {
        if (-not $engineProcess.Start()) {
            throw "Failed to start packaged llama-server $Argument"
        }
        $stdout = $engineProcess.StandardOutput.ReadToEndAsync()
        $stderr = $engineProcess.StandardError.ReadToEndAsync()
        if (-not $engineProcess.WaitForExit(30000)) {
            $engineProcess.Kill($true)
            $engineProcess.WaitForExit()
            throw "Packaged llama-server $Argument exceeded 30 seconds"
        }
        $output = $stdout.GetAwaiter().GetResult() + "`n" + $stderr.GetAwaiter().GetResult()
        Write-Host $output
        if ($engineProcess.ExitCode -ne 0) {
            throw "Packaged llama-server $Argument failed (exit $($engineProcess.ExitCode))"
        }
        if ($Argument -eq '--version' -and $output -notmatch 'version:\s+\d+') {
            throw 'Packaged llama-server did not report an engine version'
        }
        if ($Argument -eq '--list-devices') {
            if ($output -notmatch 'Available devices:') {
                throw 'Packaged llama-server did not report device enumeration'
            }
            if ($output -notmatch 'loaded CPU backend') {
                throw 'Packaged llama-server did not load its CPU fallback backend'
            }
        }
    }
    finally {
        $engineProcess.Dispose()
    }
}

$stage = $null
$prebuildStage = $null
try {
    $validationArguments = @('run', '--silent', 'check-windows-runtime', '--')
    if ($StagedPrebuild) {
        $prebuildRoot = (Resolve-Path -LiteralPath $ArtifactRoot).Path
        $prebuildStage = Join-Path ([System.IO.Path]::GetTempPath()) "studyvis-prebuild-$([guid]::NewGuid())"
        $prebuildBinaries = Join-Path $prebuildStage 'binaries'
        New-Item -ItemType Directory -Path $prebuildBinaries -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $prebuildRoot 'llama-server-x86_64-pc-windows-msvc.exe') -Destination (Join-Path $prebuildStage 'llama-server.exe')
        $prebuildRuntime = Join-Path $prebuildRoot 'llama-runtime-x86_64-pc-windows-msvc'
        Copy-Item -LiteralPath $prebuildRuntime -Destination $prebuildBinaries -Recurse
        $prebuildRootRuntime = Join-Path $prebuildRoot 'windows-vc-runtime-x86_64-pc-windows-msvc'
        foreach ($name in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
            Copy-Item -LiteralPath (Join-Path $prebuildRootRuntime $name) -Destination $prebuildStage
        }
        $validationArguments += @($prebuildStage, '--engine-only')
    }
    else {
        $validationArguments += $ArtifactRoot
    }
    $validatorOutput = & npm @validationArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged Windows dependency validation failed (exit $LASTEXITCODE)"
    }
    $runtimeInfo = ($validatorOutput -join "`n") | ConvertFrom-Json

    # Check the shipped layout with the same cwd/library-path policy as the app.
    Invoke-PackagedEngine $runtimeInfo.engine $runtimeInfo.runtime '--version'
    Invoke-PackagedEngine $runtimeInfo.engine $runtimeInfo.runtime '--list-devices'

    # Colocation gives shipped VC DLLs precedence over hosted System32 copies.
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) "studyvis-runtime-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path $stage | Out-Null
    Copy-Item -LiteralPath $runtimeInfo.engine -Destination $stage
    foreach ($directory in @($runtimeInfo.runtime, (Split-Path $runtimeInfo.engine))) {
        Get-ChildItem -LiteralPath $directory -File -Filter '*.dll' | Copy-Item -Destination $stage
    }
    $stagedEngine = Join-Path $stage 'llama-server.exe'
    Invoke-PackagedEngine $stagedEngine $stage '--version'
    Invoke-PackagedEngine $stagedEngine $stage '--list-devices'
    Write-Host 'Windows runtime: packaged PE closure and engine startup passed'
}
finally {
    foreach ($directory in @($stage, $prebuildStage)) {
        if ($directory -and (Test-Path -LiteralPath $directory)) {
            Remove-Item -LiteralPath $directory -Recurse -Force
        }
    }
}
