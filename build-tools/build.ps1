#requires -Version 5.0
[CmdletBinding()]
param([switch]$Help)

$ErrorActionPreference = 'Stop'
$script:LastMenuActionStatus = 0
$Root = Split-Path -Parent $PSScriptRoot
$script:OnWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$script:PowerShellExe = if ($script:OnWindows -and -not (Get-Command 'pwsh' -ErrorAction SilentlyContinue)) { 'powershell' } else { 'pwsh' }
Set-Location $Root

if ($Help) {
    Write-Host 'Menú de desarrollo y compilación de LTerminal'
    Write-Host 'Uso: powershell -ExecutionPolicy Bypass -File build-tools/build.ps1'
    Write-Host 'Abre submenús para desarrollo/preview, compilación, pruebas y limpieza.'
    exit 0
}
if ($args.Count -gt 0) { throw "Argumento(s) no reconocido(s): $($args -join ', ')" }

function Pause-Menu {
    [void](Read-Host 'Pulsa Enter para volver al menú')
}

function Read-MenuChoice([string]$Prompt) {
    $value = Read-Host $Prompt
    if ($null -eq $value) { return '0' }
    return $value.Trim()
}

function Confirm-MenuAction([string]$Prompt) {
    while ($true) {
        $rawAnswer = Read-Host "$Prompt [s/N]"
        if ($null -eq $rawAnswer) { return $false }
        $answer = $rawAnswer.Trim().ToLowerInvariant()
        if ($answer -in @('s', 'si', 'sí', 'y', 'yes')) { return $true }
        if ([string]::IsNullOrWhiteSpace($answer) -or $answer -in @('n', 'no')) { return $false }
        Write-Host 'Responde sí o no.'
    }
}

function Invoke-MenuAction {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Command,
        [string[]]$Arguments = @(),
        [hashtable]$Environment = @{}
    )
    Write-Host "`n==> $Label"
    $oldLocation = Get-Location
    $oldPreference = $ErrorActionPreference
    $oldEnvironment = @{}
    try {
        Set-Location $Root
        foreach ($key in $Environment.Keys) {
            $oldEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
        }
        $ErrorActionPreference = 'Continue'
        & $Command @Arguments
        $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
        $script:LastMenuActionStatus = $exitCode
        if ($exitCode -eq 0) {
            Write-Host "`nCompletado."
        } else {
            Write-Host "`nLa acción terminó con código $exitCode. Revisa el mensaje anterior."
        }
    } catch {
        $script:LastMenuActionStatus = 1
        Write-Host "`nLa acción no pudo completarse: $($_.Exception.Message)"
    } finally {
        $ErrorActionPreference = $oldPreference
        foreach ($key in $oldEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $oldEnvironment[$key], 'Process')
        }
        Set-Location $oldLocation
    }
    Pause-Menu
}

function Invoke-LinuxBuild([bool]$Fast) {
    $arguments = @('linux/build.sh', '--no-run', '--non-interactive')
    if ($Fast) { $arguments += @('--fast', '--no-extended-tests', '--skip-checks') }
    if (-not (Confirm-MenuAction '¿Permitir instalar automáticamente dependencias del sistema si faltan?')) {
        $arguments += '--no-install'
    }
    Invoke-MenuAction 'Generando el AppImage Linux' 'bash' $arguments
}

function Invoke-LinuxBuildWithoutExtendedTests {
    $arguments = @('linux/build.sh', '--no-run', '--non-interactive', '--no-extended-tests')
    if (-not (Confirm-MenuAction '¿Permitir instalar automáticamente dependencias del sistema si faltan?')) {
        $arguments += '--no-install'
    }
    Invoke-MenuAction 'Generando el AppImage Linux sin pruebas ampliadas' 'bash' $arguments
}

function Invoke-WindowsCrossBuild([bool]$Fast) {
    $arguments = @('linux/build-windows.sh', '--non-interactive')
    if ($Fast) { $arguments += @('--fast', '--skip-checks') }
    if (-not (Confirm-MenuAction '¿Permitir instalar automáticamente MinGW/Wine si faltan?')) {
        $arguments += '--no-install'
    }
    Invoke-MenuAction 'Generando la aplicación portable Windows (GNU x64)' 'bash' $arguments
}

function Invoke-WindowsCrossBuildWithoutExtendedTests {
    $arguments = @('linux/build-windows.sh', '--non-interactive', '--no-extended-tests')
    if (-not (Confirm-MenuAction '¿Permitir instalar automáticamente MinGW/Wine si faltan?')) {
        $arguments += '--no-install'
    }
    Invoke-MenuAction 'Generando Windows sin pruebas ampliadas' 'bash' $arguments
}

function Invoke-WindowsWineTests {
    $arguments = @('linux/build-windows.sh', '--non-interactive', '--full-tests', '--wine-repeats', '3')
    if (-not (Confirm-MenuAction '¿Permitir instalar automáticamente MinGW/Wine si faltan?')) {
        $arguments += '--no-install'
    }
    Invoke-MenuAction 'Compilando Windows y ejecutando la suite Rust bajo Wine' 'bash' $arguments
}

function Invoke-LinuxAndWindowsBuild {
    $arguments = @('linux/build.sh', '--no-run', '--non-interactive', '--full-tests', '--cross-windows')
    if (-not (Confirm-MenuAction '¿Permitir instalar automáticamente dependencias Linux/MinGW/Wine si faltan?')) {
        $arguments += '--no-install'
    }
    Invoke-MenuAction 'Generando AppImage y validando Windows de forma cruzada con Wine' 'bash' $arguments
}

function Show-DevelopmentMenu {
    while ($true) {
        Write-Host "`nDesarrollo y preview"
        Write-Host '  1. Abrir servidor web de desarrollo (Vite + recarga)'
        Write-Host '  2. Previsualizar el último frontend compilado'
        Write-Host '  3. Ejecutar la app de escritorio en desarrollo'
        Write-Host '  4. Compilar solo el frontend'
        Write-Host '  5. Compilar solo el frontend (rápido)'
        Write-Host '  6. Generar el preview web funcional (sin Tauri)'
        Write-Host '  0. Volver'
        $choice = Read-MenuChoice 'Elige una opción'
        switch ($choice) {
            '1' { Invoke-MenuAction 'Iniciando Vite en http://localhost:1420' 'npm' @('run', 'dev', '--', '--host', '127.0.0.1') }
            '2' { Invoke-MenuAction 'Previsualizando dist/ en http://localhost:4173' 'npm' @('run', 'preview', '--', '--host', '127.0.0.1') }
            '3' { Invoke-MenuAction 'Iniciando la aplicación Tauri en desarrollo' 'npm' @('start') }
            '4' { Invoke-MenuAction 'Compilando únicamente el frontend' 'npm' @('run', 'build') }
            '5' { Invoke-MenuAction 'Compilando únicamente el frontend en modo rápido' 'npm' @('run', 'build:fast') }
            '6' { Invoke-MenuAction 'Generando el preview web funcional en dist-preview/' 'npm' @('run', 'build:preview') }
            '0' { return }
            default { Write-Host 'Opción no válida.' }
        }
    }
}

function Show-BackendMenu {
    Write-Host "`nBackend Rust"
    Write-Host '  1. Revisar el backend sin generar ejecutable'
    Write-Host '  2. Compilar ejecutable de desarrollo'
    Write-Host '  0. Volver'
    switch (Read-MenuChoice 'Elige una opción') {
        '1' { Invoke-MenuAction 'Revisando el backend Rust' 'cargo' @('check', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'winslim-terminal') }
        '2' { Invoke-MenuAction 'Compilando el backend Rust en modo desarrollo' 'cargo' @('build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'winslim-terminal') }
        '0' { }
        default { Write-Host 'Opción no válida.' }
    }
}

function Show-BuildMenu {
    while ($true) {
        Write-Host "`nCompilar"
        Write-Host '  1. Comprobar/compilar backend Rust (sin empaquetar)'
        if ($script:OnWindows) {
            Write-Host '  2. Generar release Windows completa (EXE, ZIP e instalador)'
            Write-Host '  3. Generar aplicación portable Windows (sin instalador)'
            Write-Host '  4. Generar aplicación portable Windows (rápida)'
            Write-Host '  5. Generar release Windows y validar también Linux en WSL'
            Write-Host '  6. Compilar frontend y backend juntos sin empaquetar'
            Write-Host '  7. Generar release Linux sin pruebas ampliadas'
            Write-Host '  8. Generar Windows sin pruebas ampliadas'
        } else {
            Write-Host '  2. Generar AppImage Linux (release completa)'
            Write-Host '  3. Generar AppImage Linux (iteración rápida)'
            Write-Host '  4. Generar aplicación portable Windows desde Linux'
            Write-Host '  5. Generar aplicación portable Windows (rápida)'
            Write-Host '  6. Compilar y probar Windows con la suite Rust bajo Wine'
            Write-Host '  7. Generar AppImage y validar también Windows bajo Wine'
            Write-Host '  8. Compilar frontend y backend juntos sin empaquetar'
            Write-Host '  9. Generar Linux y Windows sin pruebas ampliadas'
        }
        Write-Host '  0. Volver'
        $choice = Read-MenuChoice 'Elige una opción'
        if ($choice -eq '1') { Show-BackendMenu; continue }
        if ($choice -eq '6' -and $script:OnWindows) {
            $tauriConfig = if ($script:OnWindows) { 'src-tauri/tauri.windows.conf.json' } else { 'src-tauri/tauri.linux.conf.json' }
            Invoke-MenuAction 'Compilando frontend y aplicación de escritorio sin empaquetar' 'npm' @('run', 'tauri', '--', 'build', '--config', $tauriConfig, '--no-bundle')
            continue
        }
        if ($choice -eq '6' -and -not $script:OnWindows) { Invoke-WindowsWineTests; continue }
        if ($choice -eq '7' -and -not $script:OnWindows) { Invoke-LinuxAndWindowsBuild; continue }
        if ($choice -eq '7' -and $script:OnWindows) { Invoke-LinuxBuildWithoutExtendedTests; continue }
        if ($choice -eq '8' -and $script:OnWindows) { Invoke-WindowsCrossBuildWithoutExtendedTests; continue }
        if ($choice -eq '8' -and -not $script:OnWindows) {
            $tauriConfig = 'src-tauri/tauri.linux.conf.json'
            Invoke-MenuAction 'Compilando frontend y aplicación de escritorio Linux sin empaquetar' 'npm' @('run', 'tauri', '--', 'build', '--config', $tauriConfig, '--no-bundle')
            continue
        }
        if ($choice -eq '0') { return }

        if ($script:OnWindows) {
            switch ($choice) {
                '2' {
                    if (Confirm-MenuAction 'El builder puede descargar o instalar Node.js, Rust o herramientas de Visual Studio si faltan. ¿Continuar?') {
                        Invoke-MenuAction 'Generando la release Windows completa' $script:PowerShellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-FullTests')
                    }
                }
                '3' {
                    if (Confirm-MenuAction 'El builder puede descargar o instalar herramientas necesarias si faltan. ¿Continuar?') {
                        Invoke-MenuAction 'Generando la versión portable Windows' $script:PowerShellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-NoInstaller', '-FullTests')
                    }
                }
                '4' {
                    if (Confirm-MenuAction 'El builder puede descargar o instalar herramientas necesarias si faltan. ¿Continuar?') {
                        Invoke-MenuAction 'Generando la versión portable rápida Windows' $script:PowerShellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-NoInstaller', '-NoExtendedTests', '-SkipChecks', '-Fast')
                    }
                }
                '5' {
                    if (Confirm-MenuAction 'Esto compila Windows y Linux mediante WSL; el builder puede instalar herramientas si faltan. ¿Continuar?') {
                        Invoke-MenuAction 'Generando release Windows y validando Linux en WSL' $script:PowerShellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-FullTests', '-CrossLinux')
                    }
                }
                default { Write-Host 'Opción no válida.' }
            }
        } else {
            switch ($choice) {
                '2' { Invoke-LinuxBuild $false }
                '3' { Invoke-LinuxBuild $true }
                '4' { Invoke-WindowsCrossBuild $false }
                '5' { Invoke-WindowsCrossBuild $true }
                '6' { Invoke-WindowsWineTests }
                '7' { Invoke-LinuxAndWindowsBuild }
                '9' {
                    $arguments = @('linux/build.sh', '--no-run', '--non-interactive', '--no-extended-tests', '--cross-windows')
                    if (-not (Confirm-MenuAction '¿Permitir instalar automáticamente dependencias Linux/MinGW/Wine si faltan?')) {
                        $arguments += '--no-install'
                    }
                    Invoke-MenuAction 'Generando Linux y Windows sin pruebas ampliadas' 'bash' $arguments
                }
                default { Write-Host 'Opción no válida.' }
            }
        }
    }
}

function Show-TestsMenu {
    while ($true) {
        Write-Host "`nPruebas y smoke sin recompilar la aplicación"
        Write-Host '  1. Pruebas locales, contratos y lógica frontend'
        Write-Host '  2. Suite completa de validación del proyecto'
        Write-Host '  3. Pruebas unitarias Rust'
        if (-not $script:OnWindows) { Write-Host '  4. Smoke de un AppImage existente' }
        Write-Host '  5. Batería E2E sobre un ejecutable ya compilado'
        if (-not $script:OnWindows) { Write-Host '  6. Comprobar herramientas/shells disponibles en el host' }
        Write-Host '  0. Volver'
        $choice = Read-MenuChoice 'Elige una opción'
        switch ($choice) {
            '1' { Invoke-MenuAction 'Ejecutando validaciones locales' 'npm' @('run', 'check:local') }
            '2' { Invoke-MenuAction 'Ejecutando validaciones completas' 'npm' @('run', 'check') }
            '3' { Invoke-MenuAction 'Ejecutando pruebas Rust' 'cargo' @('test', '--manifest-path', 'src-tauri/Cargo.toml') }
            '4' {
                if ($script:OnWindows) { Write-Host 'Opción no disponible en Windows.' }
                else { Invoke-MenuAction 'Validando la aplicación ya empaquetada' 'bash' @('linux/validate-release.sh') }
            }
            '5' {
                $defaultBinary = if ($script:OnWindows) { Join-Path $Root 'src-tauri\target\release\winslim-terminal.exe' } else { Join-Path $Root 'src-tauri/target/release/winslim-terminal' }
                $binary = Read-Host "Ruta al ejecutable compilado [$defaultBinary]"
                if ([string]::IsNullOrWhiteSpace($binary)) { $binary = $defaultBinary }
                if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
                    Write-Host "No se encontró el ejecutable: $binary`nCompila la app primero o introduce otra ruta."
                    Pause-Menu
                } else {
                    $driver = Read-Host 'Ruta a WebKitWebDriver/EdgeDriver (Enter para autodetectar o usar la variable actual)'
                    $environment = @{ E2E_BINARY = (Resolve-Path -LiteralPath $binary).Path }
                    if (-not [string]::IsNullOrWhiteSpace($driver)) { $environment.TAURI_NATIVE_DRIVER = $driver.Trim() }
                    Invoke-MenuAction 'Ejecutando la batería E2E sin recompilar la app' 'npm' @('run', 'e2e') $environment
                }
            }
            '6' {
                if ($script:OnWindows) { Write-Host 'Opción no disponible en Windows.' }
                else { Invoke-MenuAction 'Probando las herramientas del host' 'bash' @('linux/exercise-host.sh') }
            }
            '0' { return }
            default { Write-Host 'Opción no válida.' }
        }
    }
}

function Show-CleanMenu {
    $cleaner = Join-Path $Root 'scripts/clean-repository.ps1'
    Invoke-MenuAction 'Revisando qué cachés y salidas temporales se podrían limpiar' $script:PowerShellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $cleaner)
    if ($script:LastMenuActionStatus -ne 0) {
        Write-Host 'La vista previa falló; se cancela la limpieza y no se ofrecerá aplicar borrados.'
        return
    }
    if (Confirm-MenuAction 'release/ se conserva. ¿Aplicar ahora la limpieza de cachés y salidas temporales conocidas?') {
        Invoke-MenuAction 'Eliminando cachés y salidas temporales conocidas' $script:PowerShellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $cleaner, '-Apply')
    }
}

while ($true) {
    Write-Host "`nLTerminal — desarrollo y compilación"
    Write-Host '  1. Desarrollo y preview'
    Write-Host '  2. Compilar'
    Write-Host '  3. Pruebas y smoke sin recompilar'
    Write-Host '  4. Limpiar cachés y builds temporales'
    Write-Host '  0. Salir'
    $choice = Read-MenuChoice 'Elige una opción'
    if ($choice -eq '0') { break }
    switch ($choice) {
        '1' { Show-DevelopmentMenu }
        '2' { Show-BuildMenu }
        '3' { Show-TestsMenu }
        '4' { Show-CleanMenu }
        default { Write-Host 'Opción no válida.' }
    }
}
