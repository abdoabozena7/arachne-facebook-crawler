param([switch]$Check)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskProject = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskRuntime = Join-Path $taskProject '.runtime'
Set-Location -LiteralPath $taskProject
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null

function Test-TaskNode([string]$NodePath) {
    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) { return $false }
    try { $taskVersion = & $NodePath -p 'process.versions.node'; return $LASTEXITCODE -eq 0 -and [int]($taskVersion.Split('.')[0]) -ge 22 } catch { return $false }
}
function Get-TaskHealth([string]$BaseURL) {
    try { return Invoke-RestMethod -Uri ($BaseURL + '/api/health') -TimeoutSec 2 } catch { return $null }
}
function Get-TaskHash([string]$FilePath) {
    $taskHashEngine = [Security.Cryptography.SHA256]::Create()
    $taskFileStream = [IO.File]::OpenRead($FilePath)
    try { return [BitConverter]::ToString($taskHashEngine.ComputeHash($taskFileStream)).Replace('-','') }
    finally { $taskFileStream.Dispose(); $taskHashEngine.Dispose() }
}
try {
    Write-Host 'Preparing Arachne...'
    $taskNode = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not (Test-TaskNode $taskNode)) {
        $taskArch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { 'arm64' } 'AMD64' { 'x64' } default { 'x86' } }
        $taskPortable = Get-ChildItem -LiteralPath $taskRuntime -Directory -Filter ('node-v22.*-win-' + $taskArch) | Sort-Object Name -Descending | Select-Object -First 1
        if ($taskPortable) { $taskNode = Join-Path $taskPortable.FullName 'node.exe' }
        if (-not (Test-TaskNode $taskNode)) {
            Write-Host 'Downloading the local Node.js runtime (first launch only)...'
            $taskReleases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
            $taskRelease = $taskReleases | Where-Object { $_.version -match '^v22\.\d+\.\d+$' -and $_.files -contains ('win-' + $taskArch + '-zip') } | Select-Object -First 1
            if (-not $taskRelease) { throw 'No supported official Node.js runtime found for this Windows architecture.' }
            $taskArchiveName = 'node-' + $taskRelease.version + '-win-' + $taskArch + '.zip'
            $taskDownloadBase = 'https://nodejs.org/dist/' + $taskRelease.version + '/'
            $taskArchive = Join-Path $taskRuntime $taskArchiveName
            $taskChecksums = (Invoke-WebRequest -UseBasicParsing -Uri ($taskDownloadBase + 'SHASUMS256.txt') -TimeoutSec 60).Content
            $taskHashMatch = [regex]::Match($taskChecksums, '(?m)^([a-f0-9]{64})\s+' + [regex]::Escape($taskArchiveName) + '\s*$')
            if (-not $taskHashMatch.Success) { throw 'Official runtime checksum was not found.' }
            Invoke-WebRequest -UseBasicParsing -Uri ($taskDownloadBase + $taskArchiveName) -OutFile $taskArchive -TimeoutSec 300
            if ((Get-TaskHash $taskArchive).ToLowerInvariant() -ne $taskHashMatch.Groups[1].Value) { throw 'Runtime checksum verification failed.' }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $taskZip = [IO.Compression.ZipFile]::OpenRead($taskArchive)
            try {
                foreach ($taskEntry in $taskZip.Entries) {
                    $taskTarget = [IO.Path]::GetFullPath((Join-Path $taskRuntime $taskEntry.FullName))
                    if (-not $taskTarget.StartsWith($taskRuntime + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path is outside the local runtime directory.' }
                    if (-not $taskEntry.Name) { [IO.Directory]::CreateDirectory($taskTarget) | Out-Null }
                    else { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskTarget)) | Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($taskEntry, $taskTarget, $true) }
                }
            } finally { $taskZip.Dispose() }
            $taskNode = Join-Path $taskRuntime ('node-' + $taskRelease.version + '-win-' + $taskArch + '\node.exe')
            if (-not (Test-TaskNode $taskNode)) { throw 'The local Node.js runtime could not start.' }
        }
    }
    $taskNodeDir = Split-Path -Parent $taskNode
    $env:PATH = $taskNodeDir + ';' + $env:PATH
    $taskNpm = Join-Path $taskNodeDir 'npm.cmd'
    & $taskNode (Join-Path $PSScriptRoot 'check-runtime.cjs') dependencies
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Installing project dependencies (first launch or changed dependencies)...'
        & $taskNpm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the internet connection and run again.' }
    }
    & $taskNode (Join-Path $PSScriptRoot 'check-runtime.cjs') browser
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Installing Chromium (first launch only)...'
        & $taskNode (Join-Path $taskProject 'node_modules\playwright\cli.js') install chromium
        if ($LASTEXITCODE -ne 0) { throw 'Chromium installation failed. Check the internet connection and run again.' }
    }
    $taskFiles = @(Get-ChildItem -LiteralPath (Join-Path $taskProject 'src'),(Join-Path $taskProject 'public') -File -Recurse)
    $taskFiles += Get-Item -LiteralPath (Join-Path $taskProject 'scripts\build.mjs'),(Join-Path $taskProject 'tsconfig.json'),(Join-Path $taskProject 'package-lock.json')
    $taskBuildText = ($taskFiles | Sort-Object FullName | ForEach-Object { $_.FullName + ':' + (Get-TaskHash $_.FullName) }) -join "`n"
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    try { $taskBuildHash = [BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskBuildText))).Replace('-','') } finally { $taskHasher.Dispose() }
    $taskStamp = Join-Path $taskRuntime 'build.sha256'
    $taskPreviousHash = if (Test-Path -LiteralPath $taskStamp) { (Get-Content -Raw -LiteralPath $taskStamp).Trim() } else { '' }
    $taskPrepared = $false
    if ($taskPreviousHash -ne $taskBuildHash -or -not (Test-Path -LiteralPath (Join-Path $taskProject 'dist\server.js'))) {
        Write-Host 'Preparing the application...'
        & $taskNpm run build
        if ($LASTEXITCODE -ne 0) { throw 'Application preparation failed; see the error above.' }
        [IO.File]::WriteAllText($taskStamp, $taskBuildHash)
        $taskPrepared = $true
    }
    if ($Check) { Write-Host 'Ready: runtime, dependencies, Chromium and application verified.'; exit 0 }
    $taskPort = 4318
    if (Test-Path -LiteralPath (Join-Path $taskProject 'config.json')) {
        $taskConfig = Get-Content -Raw -LiteralPath (Join-Path $taskProject 'config.json') | ConvertFrom-Json
        if ($null -ne $taskConfig.port) { $taskPort = [int]$taskConfig.port }
    }
    $taskBaseURL = 'http://127.0.0.1:' + $taskPort
    $taskHealth = Get-TaskHealth $taskBaseURL
    $taskDistHash = (Get-TaskHash (Join-Path $taskProject 'dist\server.js')).ToLowerInvariant()
    if ($taskHealth) {
        if ($taskHealth.application -ne 'arachne' -or $taskHealth.project_root -ne $taskProject) { throw 'The configured port belongs to another application.' }
        if ($taskHealth.build_id -ne $taskDistHash) {
            $taskState = Invoke-RestMethod -Uri ($taskBaseURL + '/api/state') -TimeoutSec 3
            if ($taskState.state -in @('starting','running','paused','waiting_login','stopping')) {
                Invoke-RestMethod -Method Post -Uri ($taskBaseURL + '/api/open-panel') -ContentType 'application/json' -Body '{}' | Out-Null
                Write-Host 'Current collection remains running. Updated code will load on the next launch after it finishes.'; exit 0
            }
            Invoke-RestMethod -Method Post -Uri ($taskBaseURL + '/api/shutdown') -ContentType 'application/json' -Body '{}' | Out-Null
            for ($taskAttempt=0; $taskAttempt -lt 30 -and (Get-TaskHealth $taskBaseURL); $taskAttempt++) { Start-Sleep -Milliseconds 200 }
            if (Get-TaskHealth $taskBaseURL) { throw 'The previous app did not finish shutting down.' }
        } else {
            $taskPanelRequest = if ($taskPrepared) { '{"refresh":true}' } else { '{}' }
            Invoke-RestMethod -Method Post -Uri ($taskBaseURL + '/api/open-panel') -ContentType 'application/json' -Body $taskPanelRequest | Out-Null
            Write-Host 'Arachne is already running; its panel is open.'; exit 0
        }
    }
    $taskAppProcess = Start-Process -FilePath $taskNode -ArgumentList @('dist/server.js', ('--port=' + $taskPort)) -WorkingDirectory $taskProject -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRuntime 'server.log') -RedirectStandardError (Join-Path $taskRuntime 'server-error.log') -PassThru
    [IO.File]::WriteAllText((Join-Path $taskRuntime 'server.pid'), [string]$taskAppProcess.Id)
    for ($taskAttempt=0; $taskAttempt -lt 60; $taskAttempt++) {
        $taskHealth = Get-TaskHealth $taskBaseURL
        if ($taskHealth -and $taskHealth.application -eq 'arachne' -and $taskHealth.project_root -eq $taskProject) {
            Invoke-RestMethod -Method Post -Uri ($taskBaseURL + '/api/open-panel') -ContentType 'application/json' -Body '{}' | Out-Null
            Write-Host 'Arachne is ready. Paste the post link and press Start.'; exit 0
        }
        $taskAppProcess.Refresh()
        if ($taskAppProcess.HasExited) { throw ('Application stopped: ' + (Get-Content -Raw -LiteralPath (Join-Path $taskRuntime 'server-error.log'))) }
        Start-Sleep -Milliseconds 250
    }
    throw 'The application did not become ready. See .runtime/server-error.log.'
} catch {
    Write-Host ('Could not start Arachne: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
