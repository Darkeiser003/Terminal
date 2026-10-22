#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$Binary,
    [string]$Node
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Abre PowerShell con Ejecutar como administrador y vuelve a lanzar windows/e2e-elevated.ps1.'
}

if (-not $Binary) {
    # La comprobación elevada debe ejecutarse contra la release publicada; la
    # carpeta dev puede conservar un binario antiguo y dar una falsa sensación
    # de cobertura sobre el ejecutable que se entrega al usuario.
    $Binary = Join-Path $root 'src-tauri\target\dist\WTerminal-1.0.0\wterminal.exe'
}
$Binary = (Resolve-Path -LiteralPath $Binary -ErrorAction Stop).Path
$nodePath = $null
if ($Node) {
    $nodePath = (Resolve-Path -LiteralPath $Node -ErrorAction Stop).Path
} else {
    $nodeCommand = Get-Command node.exe, node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand) { $nodePath = $nodeCommand.Source }
    if (-not $nodePath) {
        $nodeCandidates = @(
            $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' }),
            $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }),
            $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'AppData\Local\Programs\nodejs\node.exe' })
        ) | Where-Object { $_ }
        $nodePath = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
}
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw 'No se encontró node.exe. Pasa su ruta absoluta con -Node al ejecutar esta E2E elevada.'
}
$nodePath = (Resolve-Path -LiteralPath $nodePath -ErrorAction Stop).Path
$runRoot = Join-Path $env:TEMP "wterminal-elevated-e2e-$([guid]::NewGuid().ToString('N'))"
$null = New-Item -ItemType Directory -Path $runRoot -Force
$reportPath = Join-Path $runRoot 'report.json'
$logPath = Join-Path $runRoot 'main.log'
$failurePath = Join-Path $runRoot 'elevated-runner-error.log'
$layersKey = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
$previousCompatibility = (Get-ItemProperty -LiteralPath $layersKey -Name $Binary -ErrorAction SilentlyContinue).$Binary

$environmentNames = @(
    'APPDATA',
    'E2E_BINARY',
    'LTERMINAL_E2E_APP_DATA_DIR',
    'LTERMINAL_E2E_TESTING',
    'LTERMINAL_E2E_DISABLE_PATH_AUTO',
    'E2E_WINDOWS_ADMIN_ONLY',
    'LTERMINAL_LOG_FILE',
    'LTERMINAL_SMOKE_REPORT',
    'E2E_REQUIRE_ELEVATED',
    'E2E_CAPTURE_VIDEO',
    'E2E_CAPTURE_SCREENSHOTS',
    'E2E_VIDEO_FPS',
    'TAURI_DRIVER'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$exitCode = 0
Push-Location $root
try {
    # Un perfil limpio y este runner elevado comprueban que el token efectivo
    # es administrativo, que NSudo se abre directo y que WTerminal no cambia
    # AppCompat ni se relanza (las pruebas nunca piden el UAC).
    $env:APPDATA = $runRoot
    $env:LTERMINAL_E2E_APP_DATA_DIR = $runRoot
    $env:E2E_BINARY = $Binary
    $env:LTERMINAL_E2E_DISABLE_PATH_AUTO = '1'
    # Mantenerlo enfocado evita que una matriz de PTY larga deje al sistema bajo
    # una carga innecesaria durante la comprobación de los permisos.
    $env:E2E_WINDOWS_ADMIN_ONLY = '1'
    $env:E2E_REQUIRE_ELEVATED = '1'
    $env:E2E_CAPTURE_VIDEO = '1'
    $env:E2E_CAPTURE_SCREENSHOTS = '1'
    $env:E2E_VIDEO_FPS = '8'
    $env:LTERMINAL_LOG_FILE = $logPath
    $env:LTERMINAL_SMOKE_REPORT = $reportPath
    # UAC puede reconstruir el PATH y omitir el perfil de Cargo del usuario.
    # Fijar la ruta absoluta hace que la prueba elevada sea reproducible.
    $tauriDriverCandidates = @(
        $(if ($env:CARGO_HOME) { Join-Path $env:CARGO_HOME 'bin\tauri-driver.exe' }),
        $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.cargo\bin\tauri-driver.exe' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    $tauriDriverPath = $tauriDriverCandidates | Select-Object -First 1
    if ($tauriDriverPath) {
        $env:TAURI_DRIVER = (Resolve-Path -LiteralPath $tauriDriverPath).Path
    }

    & $nodePath tests/e2e/smoke.mjs
    if ($LASTEXITCODE -ne 0) {
        throw "La E2E elevada falló con el código $LASTEXITCODE. Informe: $reportPath"
    }

    & $nodePath scripts/verify-e2e-report.mjs $reportPath
    if ($LASTEXITCODE -ne 0) {
        throw "El informe de la E2E elevada no pasó su validador: $reportPath"
    }

    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if ($report.focusedScenario -ne 'windows-admin-permissions') {
        throw "La E2E elevada no ejecutó el escenario enfocado de administración: $($report.focusedScenario)"
    }
    $permissions = @($report.events) | Where-Object { $_.type -eq 'windows-admin-permissions' } | Select-Object -First 1
    if (-not $permissions -or $permissions.elevated -ne $true -or $permissions.launcher -ne 'direct' -or $permissions.restartVisible -ne $false -or $permissions.runAsAdminFlag -ne $false) {
        throw 'La E2E elevada no confirmó que, siendo administrador, NSudo se abre directo, no se ofrece reiniciar y no hay marca RUNASADMIN.'
    }
    $elevation = @($report.events) | Where-Object { $_.type -eq 'elevation-status' } | Select-Object -First 1
    if (-not $elevation -or $elevation.required -ne $true -or $elevation.elevated -ne $true -or $elevation.passed -ne $true) {
        throw 'La E2E elevada no confirmó un token administrativo efectivo.'
    }

    $compatibility = (Get-ItemProperty -LiteralPath $layersKey -Name $Binary -ErrorAction SilentlyContinue).$Binary
    if ($compatibility -ne $previousCompatibility) {
        throw 'La E2E elevada alteró inesperadamente el valor AppCompat del ejecutable.'
    }

    Write-Host 'E2E con token administrativo efectivo y permisos de administrador: OK' -ForegroundColor Green
    Write-Host "Informe: $reportPath"
    Write-Host "Log: $logPath"
    Write-Host 'Escenario enfocado: permisos de administrador'
} catch {
    [IO.File]::WriteAllText($failurePath, ($_ | Out-String).Trim())
    Write-Error $_
    $exitCode = 1
} finally {
    Pop-Location
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}

exit $exitCode
