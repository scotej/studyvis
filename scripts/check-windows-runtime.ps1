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

function Test-PackagedAppRunStart {
    param([string]$DataRoot)

    if (-not (Test-Path -LiteralPath $DataRoot)) {
        return $false
    }
    foreach ($log in Get-ChildItem -LiteralPath $DataRoot -File -Filter 'studyvis.log' -Recurse -ErrorAction SilentlyContinue) {
        foreach ($line in Get-Content -LiteralPath $log.FullName -ErrorAction SilentlyContinue) {
            try {
                $record = ConvertFrom-Json -InputObject $line -ErrorAction Stop
                if ($record.win -eq 'main' -and $record.msg -eq 'run.start') {
                    return $true
                }
            } catch {
                # The renderer can append while the smoke test reads the file.
                # Ignore a partial final line and retry on the next poll.
            }
        }
    }
    return $false
}

function Invoke-PackagedApp {
    param(
        [string]$Binary,
        [string]$WorkingDirectory
    )

    $smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) "studyvis-app-smoke-$([guid]::NewGuid())"
    $smokeData = Join-Path $smokeRoot 'roaming'
    New-Item -ItemType Directory -Path $smokeData -Force | Out-Null

    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Binary
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $false
    $start.Environment['APPDATA'] = $smokeData
    $start.Environment['PATH'] = "$WorkingDirectory;$env:SystemRoot\System32;$env:SystemRoot"

    $appProcess = [System.Diagnostics.Process]::new()
    $appProcess.StartInfo = $start
    $started = $false
    try {
        if (-not $appProcess.Start()) {
            throw 'Failed to start the packaged StudyVis application'
        }
        $started = $true
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
        $rendererReady = $false
        $windowReady = $false
        while ([DateTimeOffset]::UtcNow -lt $deadline) {
            $appProcess.Refresh()
            if ($appProcess.HasExited) {
                throw "Packaged StudyVis exited before startup completed (exit $($appProcess.ExitCode))"
            }
            if (-not $rendererReady) {
                $rendererReady = Test-PackagedAppRunStart $smokeData
            }
            if ($appProcess.MainWindowHandle -ne [IntPtr]::Zero -and $appProcess.MainWindowTitle -eq 'StudyVis') {
                $windowReady = $true
            }
            if ($rendererReady -and $windowReady) {
                break
            }
            Start-Sleep -Milliseconds 500
        }
        if (-not $rendererReady) {
            throw 'Packaged StudyVis did not write its main renderer run.start record within 60 seconds'
        }
        if (-not $windowReady) {
            throw "Packaged StudyVis did not show its StudyVis main window within 60 seconds (title '$($appProcess.MainWindowTitle)')"
        }

        # Keep the app alive briefly after both signals so a startup crash just
        # after the first paint cannot pass the packaged-installer smoke test.
        Start-Sleep -Seconds 3
        $appProcess.Refresh()
        if ($appProcess.HasExited) {
            throw "Packaged StudyVis exited immediately after startup (exit $($appProcess.ExitCode))"
        }
        Write-Host 'Packaged StudyVis main window and renderer startup passed'
    }
    finally {
        if ($started -and -not $appProcess.HasExited) {
            $null = $appProcess.CloseMainWindow()
            if (-not $appProcess.WaitForExit(5000)) {
                $appProcess.Kill($true)
                $appProcess.WaitForExit()
            }
        }
        $appProcess.Dispose()
        Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
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

    if (-not $StagedPrebuild) {
        $appRoot = Split-Path -Parent $runtimeInfo.engine
        Invoke-PackagedApp (Join-Path $appRoot 'studyvis.exe') $appRoot
    }
    Write-Host 'Windows runtime: packaged PE closure and startup checks passed'
}
finally {
    foreach ($directory in @($stage, $prebuildStage)) {
        if ($directory -and (Test-Path -LiteralPath $directory)) {
            Remove-Item -LiteralPath $directory -Recurse -Force
        }
    }
}
