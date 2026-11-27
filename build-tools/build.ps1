#requires -Version 5.0
[CmdletBinding()]
param([switch]$Help)

$ErrorActionPreference = 'Stop'
$script:LastMenuActionStatus = 0
$Root = Split-Path -Parent $PSScriptRoot
$script:OnWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$script:AppName = if ($script:OnWindows) { 'WTerminal' } else { 'L' + 'Terminal' }
$script:PowerShellExe = if ($script:OnWindows -and -not (Get-Command 'pwsh' -ErrorAction SilentlyContinue)) { 'powershell' } else { 'pwsh' }
Set-Location $Root

if ($Help) {
    Write-Host "Menú de desarrollo y compilación de $script:AppName"
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

# windows/build.ps1 se lanza con -NonInteractive y no puede preguntar, así que
# la carpeta de claves se pide aquí y se le pasa con -KeysDir. Enter acepta la
# última usada (o Escritorio\Claves SSH); «-» genera la release sin firmar.
function Read-KeysDirArguments {
    $memory = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'WTerminalBuild\keys-dir.txt' }
    $default = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claves SSH'
    if ($memory -and (Test-Path -LiteralPath $memory -PathType Leaf)) {
        $last = (Get-Content -LiteralPath $memory -Raw).Trim()
        if ($last -and (Test-Path -LiteralPath $last -PathType Container)) { $default = $last }
    }
    while ($true) {
        $answer = Read-Host "Carpeta de las claves de firma [$default] (- para no firmar)"
        if ($null -eq $answer) { return @() }
        $answer = $answer.Trim().Trim('"')
        if ($answer -eq '-') { return @() }
        $chosen = if ([string]::IsNullOrWhiteSpace($answer)) { $default } else { $answer }
        if (Test-Path -LiteralPath $chosen -PathType Container) { return @('-KeysDir', $chosen) }
        Write-Host "No existe la carpeta: $chosen"
    }
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

# 22-11 (Romen: «usa y mejora mis scripts, con builds por pasos y opciones»):
# lo que antes se hacía con envoltorios fuera del repositorio.

# La versión de depuración sin pruebas: la más rápida para probar a mano.
function Invoke-DebugBuild {
    Invoke-MenuAction 'Compilando la versión de depuración sin pruebas' 'node' @('scripts/dev-test.mjs', '--build', 'debug', '--no-sign')
    $exe = if ($script:OnWindows) { 'src-tauri\target\debug\wterminal.exe' } else { 'src-tauri/target/debug/' + 'l' + 'terminal' }
    if ($script:LastMenuActionStatus -eq 0) { Write-Host "Ejecutable: $(Join-Path $Root $exe)" }
}

# Larga por etapas (windows/build-stages.ps1): reanudable con la misma etiqueta.
function Invoke-StagedBuild {
    $label = Read-Host 'Etiqueta de esta build (por ejemplo 84)'
    if ([string]::IsNullOrWhiteSpace($label)) { Write-Host 'Sin etiqueta no se lanza.'; return }
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build-stages.ps1', '-Label', $label.Trim())
    if (Confirm-MenuAction '¿Pasar antes la comprobación completa (check:local y cargo test)? Si falla, no compila') { $arguments += '-CheckFirst' }
    if (Confirm-MenuAction '¿Saltar WSL en las pruebas (equipo sin hipervisor)?') { $arguments += '-SkipWsl' }
    if (Confirm-MenuAction '¿Reanudarla sola si el equipo se reinicia a mitad?') { $arguments += @('-ResumeAfterReboot', '-InstallResumeAtLogon') }
    $suites = Read-Host 'Suites tras compilar [focused,video,downloads,dependency-audit,installer]'
    if (-not [string]::IsNullOrWhiteSpace($suites)) { $arguments += @('-Suites', $suites.Trim()) }
    $arguments += Read-KeysDirArguments
    Invoke-MenuAction "Build larga por etapas $label" $script:PowerShellExe $arguments
}

# Pruebas dirigidas con la compilación rápida (scripts/dev-test.mjs).
function Invoke-TargetedTests {
    Invoke-MenuAction 'Escenarios disponibles' 'node' @('scripts/dev-test.mjs', '--list')
    $only = Read-Host 'Escenarios separados por comas'
    if ([string]::IsNullOrWhiteSpace($only)) { Write-Host 'Sin escenarios no se lanza.'; return }
    $repeat = Read-Host 'Cuántas veces cada uno [1]'
    if ([string]::IsNullOrWhiteSpace($repeat)) { $repeat = '1' }
    $build = Read-Host 'Compilación: fast, debug o none (la última, sin compilar) [fast]'
    if ([string]::IsNullOrWhiteSpace($build)) { $build = 'fast' }
    $arguments = @('scripts/dev-test.mjs', '--only', $only.Trim(), '--repeat', $repeat.Trim(), '--build', $build.Trim())
    if ($script:OnWindows -and (Confirm-MenuAction '¿Saltar WSL en las pruebas?')) { $arguments += @('--env', 'E2E_SKIP_WSL=1') }
    Invoke-MenuAction 'Ejecutando las pruebas dirigidas' 'node' $arguments
}

# Las que alguna vez fallaron, cinco veces cada una (suite «intermitentes»).
function Invoke-IntermittentTests {
    $arguments = @('scripts/dev-test.mjs', '--suite', 'intermitentes')
    if ($script:OnWindows -and (Confirm-MenuAction '¿Saltar WSL en las pruebas?')) { $arguments += @('--env', 'E2E_SKIP_WSL=1') }
    Invoke-MenuAction 'Repitiendo las pruebas que alguna vez fallaron' 'node' $arguments
}

# Instalación real del catálogo (suite «real-install»): cambia el equipo.
function Invoke-RealInstall {
    if (-not (Confirm-MenuAction 'Instala DE VERDAD lo que falta del catálogo y actualiza lo pendiente (horas; cambia el equipo). ¿Continuar?')) { return }
    $arguments = @('scripts/dev-test.mjs', '--only', 'real-install')
    $ids = Read-Host 'Solo estas acciones (ids separados por comas; Enter = todo lo que falte)'
    if (-not [string]::IsNullOrWhiteSpace($ids)) { $arguments += @('--env', "E2E_REAL_INSTALL_IDS=$($ids.Trim())") }
    if (Confirm-MenuAction '¿Solo listar lo que instalaría, sin instalar nada?') { $arguments += @('--env', 'E2E_REAL_INSTALL_DRY=1') }
    if ($script:OnWindows) { $arguments += @('--env', 'E2E_SKIP_WSL=1') }
    Invoke-MenuAction 'Instalación real del catálogo' 'node' $arguments
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
        Write-Host '  7. Ejecutar cualquier script npm/pnpm del proyecto'
        Write-Host '  8. Suites E2E estandarizadas sobre un ejecutable ya compilado'
        Write-Host '  0. Volver'
        $choice = Read-MenuChoice 'Elige una opción'
        switch ($choice) {
            '1' { Invoke-MenuAction 'Iniciando Vite en http://localhost:1420' 'node' @('scripts/package-scripts.mjs', 'run', 'dev', '--', '--host', '127.0.0.1') }
            '2' { Invoke-MenuAction 'Previsualizando dist/ en http://localhost:4173' 'node' @('scripts/package-scripts.mjs', 'run', 'preview', '--', '--host', '127.0.0.1') }
            '3' { Invoke-MenuAction 'Iniciando la aplicación Tauri en desarrollo' 'node' @('scripts/package-scripts.mjs', 'run', 'start') }
            '4' { Invoke-MenuAction 'Compilando únicamente el frontend' 'node' @('scripts/package-scripts.mjs', 'run', 'build') }
            '5' { Invoke-MenuAction 'Compilando únicamente el frontend en modo rápido' 'node' @('scripts/package-scripts.mjs', 'run', 'build:fast') }
            '6' { Invoke-MenuAction 'Generando el preview web funcional en dist-preview/' 'node' @('scripts/package-scripts.mjs', 'run', 'build:preview') }
            '7' { Invoke-MenuAction 'Abriendo el selector dinámico de scripts' 'node' @('scripts/package-scripts.mjs', 'menu') }
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
        Write-Host '  9. Abrir el asistente interactivo completo del builder Windows'
            Write-Host ' 10. Generar release Windows con validación completa (vídeo, descargas, auditoría e instalador)'
            Write-Host ' 11. Versión de depuración sin pruebas (la más rápida, para probarla a mano)'
            Write-Host ' 12. Build larga por etapas y reanudable (comprobación, compilar y suites)'
        } else {
            Write-Host '  2. Generar AppImage Linux (release completa)'
            Write-Host '  3. Generar AppImage Linux (iteración rápida)'
            Write-Host '  4. Generar aplicación portable Windows desde Linux'
            Write-Host '  5. Generar aplicación portable Windows (rápida)'
            Write-Host '  6. Compilar y probar Windows con la suite Rust bajo Wine'
            Write-Host '  7. Generar AppImage y validar también Windows bajo Wine'
            Write-Host '  8. Compilar frontend y backend juntos sin empaquetar'
            Write-Host '  9. Generar Linux y Windows sin pruebas ampliadas'
            Write-Host ' 10. Abrir el asistente interactivo completo del builder Linux'
            Write-Host ' 11. Versión de depuración sin pruebas (la más rápida, para probarla a mano)'
        }
        Write-Host '  0. Volver'
        $choice = Read-MenuChoice 'Elige una opción'
        if ($choice -eq '1') { Show-BackendMenu; continue }
        if ($choice -eq '6' -and $script:OnWindows) {
            $tauriConfig = if ($script:OnWindows) { 'src-tauri/tauri.windows.conf.json' } else { 'src-tauri/tauri.linux.conf.json' }
            Invoke-MenuAction 'Compilando frontend y aplicación de escritorio sin empaquetar' 'node' @('scripts/package-scripts.mjs', 'run', 'tauri', '--', 'build', '--config', $tauriConfig, '--no-bundle')
            continue
        }
        if ($choice -eq '6' -and -not $script:OnWindows) { Invoke-WindowsWineTests; continue }
        if ($choice -eq '7' -and -not $script:OnWindows) { Invoke-LinuxAndWindowsBuild; continue }
        if ($choice -eq '7' -and $script:OnWindows) { Invoke-LinuxBuildWithoutExtendedTests; continue }
        if ($choice -eq '8' -and $script:OnWindows) { Invoke-WindowsCrossBuildWithoutExtendedTests; continue }
        if ($choice -eq '9' -and $script:OnWindows) {
            Invoke-MenuAction 'Asistente interactivo del builder Windows' $script:PowerShellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1')
            continue
        }
        if ($choice -eq '10' -and $script:OnWindows) {
            if (Confirm-MenuAction 'Incluye la batería completa, vídeo, descargas reales, la auditoría del catálogo y una instalación real del NSIS (pide UAC y lo desinstala al terminar). ¿Continuar?') {
                Invoke-MenuAction 'Generando la release Windows con validación completa' $script:PowerShellExe (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-ReleaseValidation') + (Read-KeysDirArguments))
            }
            continue
        }
        if ($choice -eq '11') { Invoke-DebugBuild; continue }
        if ($choice -eq '12' -and $script:OnWindows) { Invoke-StagedBuild; continue }
        if ($choice -eq '10' -and -not $script:OnWindows) {
            Invoke-MenuAction 'Asistente interactivo del builder Linux' 'bash' @('linux/build.sh')
            continue
        }
        if ($choice -eq '8' -and -not $script:OnWindows) {
            $tauriConfig = 'src-tauri/tauri.linux.conf.json'
            Invoke-MenuAction 'Compilando frontend y aplicación de escritorio Linux sin empaquetar' 'node' @('scripts/package-scripts.mjs', 'run', 'tauri', '--', 'build', '--config', $tauriConfig, '--no-bundle')
            continue
        }
        if ($choice -eq '0') { return }

        if ($script:OnWindows) {
            switch ($choice) {
                '2' {
                    if (Confirm-MenuAction 'El builder puede descargar o instalar Node.js, Rust o herramientas de Visual Studio si faltan. ¿Continuar?') {
                        Invoke-MenuAction 'Generando la release Windows completa' $script:PowerShellExe (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-FullTests') + (Read-KeysDirArguments))
                    }
                }
                '3' {
                    if (Confirm-MenuAction 'El builder puede descargar o instalar herramientas necesarias si faltan. ¿Continuar?') {
                        Invoke-MenuAction 'Generando la versión portable Windows' $script:PowerShellExe (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-NoInstaller', '-FullTests') + (Read-KeysDirArguments))
                    }
                }
                '4' {
                    if (Confirm-MenuAction 'El builder puede descargar o instalar herramientas necesarias si faltan. ¿Continuar?') {
                        Invoke-MenuAction 'Generando la versión portable rápida Windows' $script:PowerShellExe (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-NoInstaller', '-NoExtendedTests', '-SkipChecks', '-Fast') + (Read-KeysDirArguments))
                    }
                }
                '5' {
                    if (Confirm-MenuAction 'Esto compila Windows y Linux mediante WSL; el builder puede instalar herramientas si faltan. ¿Continuar?') {
                        Invoke-MenuAction 'Generando release Windows y validando Linux en WSL' $script:PowerShellExe (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-FullTests', '-CrossLinux') + (Read-KeysDirArguments))
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
        Write-Host '  7. Ejecutar cualquier script npm/pnpm del proyecto'
        Write-Host '  8. Suites E2E estandarizadas sobre un ejecutable ya compilado'
        Write-Host '  9. Pruebas dirigidas con la compilación rápida (las que elijas, N veces)'
        Write-Host ' 10. Repetir las que alguna vez fallaron (5 veces cada una)'
        Write-Host ' 11. Instalación real del catálogo (cambia el equipo)'
        Write-Host '  0. Volver'
        $choice = Read-MenuChoice 'Elige una opción'
        switch ($choice) {
            '9' { Invoke-TargetedTests }
            '10' { Invoke-IntermittentTests }
            '11' { Invoke-RealInstall }
            '1' { Invoke-MenuAction 'Ejecutando validaciones locales' 'node' @('scripts/package-scripts.mjs', 'run', 'check:local') }
            '2' { Invoke-MenuAction 'Ejecutando validaciones completas' 'node' @('scripts/package-scripts.mjs', 'run', 'check') }
            '3' { Invoke-MenuAction 'Ejecutando pruebas Rust' 'cargo' @('test', '--manifest-path', 'src-tauri/Cargo.toml') }
            '4' {
                if ($script:OnWindows) { Write-Host 'Opción no disponible en Windows.' }
                else { Invoke-MenuAction 'Validando la aplicación ya empaquetada' 'bash' @('linux/validate-release.sh') }
            }
            '5' {
                $defaultBinary = if ($script:OnWindows) { Join-Path $Root 'src-tauri\target\release\wterminal.exe' } else { Join-Path $Root ('src-tauri/target/release/l' + 'terminal') }
                $binary = Read-Host "Ruta al ejecutable compilado [$defaultBinary]"
                if ([string]::IsNullOrWhiteSpace($binary)) { $binary = $defaultBinary }
                if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
                    Write-Host "No se encontró el ejecutable: $binary`nCompila la app primero o introduce otra ruta."
                    Pause-Menu
                } else {
                    $driver = Read-Host 'Ruta a WebKitWebDriver/EdgeDriver (Enter para autodetectar o usar la variable actual)'
                    $environment = @{ E2E_BINARY = (Resolve-Path -LiteralPath $binary).Path }
                    if (-not [string]::IsNullOrWhiteSpace($driver)) { $environment.TAURI_NATIVE_DRIVER = $driver.Trim() }
                    Invoke-MenuAction 'Ejecutando la batería E2E sin recompilar la app' 'node' @('scripts/package-scripts.mjs', 'run', 'e2e') $environment
                }
            }
            '6' {
                if ($script:OnWindows) { Write-Host 'Opción no disponible en Windows.' }
                else { Invoke-MenuAction 'Probando las herramientas del host' 'bash' @('linux/exercise-host.sh') }
            }
            '7' { Invoke-MenuAction 'Abriendo el selector dinámico de scripts' 'node' @('scripts/package-scripts.mjs', 'menu') }
            '8' {
                $defaultBinary = if ($script:OnWindows) { Join-Path $Root 'src-tauri\target\release\wterminal.exe' } else { Join-Path $Root ('src-tauri/target/release/l' + 'terminal') }
                $binary = Read-Host "Ruta al ejecutable compilado [$defaultBinary]"
                if ([string]::IsNullOrWhiteSpace($binary)) { $binary = $defaultBinary }
                if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
                    Write-Host "No se encontró el ejecutable: $binary"
                    Pause-Menu
                } else {
                    Invoke-MenuAction 'Suites disponibles' 'node' @('scripts/run-e2e-suite.mjs', '--list')
                    $suites = Read-Host 'Suites separadas por comas [focused]'
                    if ([string]::IsNullOrWhiteSpace($suites)) { $suites = 'focused' }
                    Invoke-MenuAction 'Ejecutando las suites E2E estandarizadas' 'node' @('scripts/run-e2e-suite.mjs', '--binary', (Resolve-Path -LiteralPath $binary).Path, '--suite', $suites.Trim())
                }
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


# ===================================================================
# Menú por pasos (22-11, Romen: «modularizar: builds de este sistema, del
# otro, test y firma; al compilar, elegir el tipo de build, las pruebas,
# si se firma y con qué claves, y si se quiere una copia y dónde»).
# ===================================================================

function Read-Default([string]$Prompt, [string]$Default) {
    $answer = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim().Trim('"')
}

function Read-Option([string]$Title, [string[]]$Options, [int]$Default = 1) {
    Write-Host "`n$Title"
    for ($index = 0; $index -lt $Options.Count; $index++) { Write-Host ("  {0}. {1}" -f ($index + 1), $Options[$index]) }
    while ($true) {
        $answer = Read-Host "Elige [$Default]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
        $number = 0
        if ([int]::TryParse($answer.Trim(), [ref]$number) -and $number -ge 1 -and $number -le $Options.Count) { return $number }
        Write-Host 'Opción no válida.'
    }
}

function Get-BuildMemory([string]$Name, [string]$Default) {
    $file = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "WTerminalBuild\$Name.txt" } else { '' }
    if ($file -and (Test-Path -LiteralPath $file -PathType Leaf)) {
        $value = (Get-Content -LiteralPath $file -Raw).Trim()
        if ($value) { return $value }
    }
    return $Default
}

function Set-BuildMemory([string]$Name, [string]$Value) {
    if (-not $env:LOCALAPPDATA) { return }
    $dir = Join-Path $env:LOCALAPPDATA 'WTerminalBuild'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Set-Content -LiteralPath (Join-Path $dir "$Name.txt") -Value $Value -Encoding utf8
}

function Get-AppVersion {
    return ((Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw) | ConvertFrom-Json).version
}

# Paso «pruebas» de las builds de dev-test (depuración y rápida).
function Read-DevTestTests {
    $choice = Read-Option 'Pruebas después de compilar' @(
        'Ninguna (solo compilar)',
        'Algunas: las que elijas, N veces',
        'Suites enteras (focused, intermitentes, nuevas…)'
    ) 1
    switch ($choice) {
        2 {
            node scripts/dev-test.mjs --list | Out-Host
            $only = Read-Host 'Escenarios separados por comas'
            $repeat = Read-Default 'Cuántas veces cada uno' '1'
            if ([string]::IsNullOrWhiteSpace($only)) { return @() }
            return @('--only', $only.Trim(), '--repeat', $repeat)
        }
        3 {
            node scripts/run-e2e-suite.mjs --list | Select-String -Pattern '^\S' | ForEach-Object { Write-Host $_.Line }
            return @('--suite', (Read-Default 'Suites separadas por comas' 'focused'))
        }
        default { return @() }
    }
}

# Paso «firma»: devuelve la carpeta de claves o '' para no firmar.
function Read-SigningChoice {
    if (-not (Confirm-MenuAction '¿Firmar la build (SHA256SUMS con Ed25519 y SSH)?')) { return '' }
    $arguments = Read-KeysDirArguments
    if ($arguments.Count -ge 2) { return $arguments[1] }
    return ''
}

# Paso «copia adicional»: devuelve la carpeta destino o ''.
function Read-CopyChoice([string]$Label) {
    if (-not (Confirm-MenuAction '¿Guardar además una copia de la build en otra carpeta?')) { return '' }
    $base = Read-Default 'Carpeta donde guardar las copias' (Get-BuildMemory 'copy-dir' (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Builds WTerminal'))
    Set-BuildMemory 'copy-dir' $base
    $name = Read-Default 'Nombre de la subcarpeta de esta copia' $Label
    return (Join-Path $base $name)
}

function Copy-BuildOutput([string[]]$Sources, [string]$Destination) {
    if (-not $Destination) { return }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($source in $Sources) {
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $Destination -Recurse -Force }
    }
    Write-Host "Copia guardada en $Destination"
}

function Read-SkipWslArguments([string]$Style) {
    if (-not $script:OnWindows) { return @() }
    if (-not (Confirm-MenuAction '¿Saltar WSL en las pruebas (equipo sin hipervisor o sin distros)?')) { return @() }
    if ($Style -eq 'dev-test') { return @('--env', 'E2E_SKIP_WSL=1') }
    $env:E2E_SKIP_WSL = '1'
    return @()
}

# Compilar para este sistema, paso a paso.
function Show-NativeBuildWizard {
    $version = Get-AppVersion
    $types = if ($script:OnWindows) {
        @('Depuración: la más rápida, sin empaquetar (para probar a mano)',
          'Rápida: optimizada sin LTO, sin empaquetar',
          'Portable: un solo .exe y la carpeta, sin instalador',
          'Completa: portable, ZIP e instalador',
          'Completa por etapas y reanudable (larga validada)',
          'Completa + copia «Latest» (portable e instalador con Latest en el nombre)')
    } else {
        @('Depuración: la más rápida, sin empaquetar (para probar a mano)',
          'Rápida: optimizada sin LTO, sin empaquetar',
          'AppImage rápida (iteración)',
          'AppImage completa (release)')
    }
    $type = Read-Option 'Paso 1 · Tipo de build' $types 1
    $label = Read-Default 'Etiqueta de esta build (para el registro y la copia)' (Get-Date -Format 'yyyyMMdd-HHmm')

    # Depuración y rápida: scripts/dev-test.mjs (compila, prueba lo pedido y firma).
    if ($type -le 2) {
        $buildProfile = if ($type -eq 1) { 'debug' } else { 'fast' }
        $arguments = @('scripts/dev-test.mjs', '--build', $buildProfile) + (Read-DevTestTests)
        if ($arguments -contains '--only' -or $arguments -contains '--suite') { $arguments += Read-SkipWslArguments 'dev-test' }
        $keys = Read-SigningChoice
        $arguments += if ($keys) { @('--keys-dir', $keys) } else { @('--no-sign') }
        $copy = Read-CopyChoice $label
        Write-Host "`nResumen: build $buildProfile, etiqueta $label, $(if ($keys) { "firmada con $keys" } else { 'sin firmar' })$(if ($copy) { ", copia en $copy" })."
        if (-not (Confirm-MenuAction '¿Empezar?')) { return }
        Invoke-MenuAction "Build $buildProfile $label" 'node' $arguments
        $exe = if ($script:OnWindows) { "src-tauri\target\$buildProfile\wterminal.exe" } else { "src-tauri/target/$buildProfile/" + 'l' + 'terminal' }
        $folder = Split-Path (Join-Path $Root $exe) -Parent
        if ($script:LastMenuActionStatus -eq 0) {
            Write-Host "Ejecutable: $(Join-Path $Root $exe)"
            Copy-BuildOutput @((Join-Path $Root $exe), (Join-Path $folder 'conpty.dll'), (Join-Path $folder 'OpenConsole.exe')) $copy
        }
        return
    }

    if (-not $script:OnWindows) {
        Invoke-LinuxBuild ($type -eq 3)
        return
    }

    # Completa por etapas (windows/build-stages.ps1).
    if ($type -eq 5) {
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build-stages.ps1', '-Label', $label)
        $suites = Read-Default 'Paso 2 · Suites tras compilar' 'focused,video,downloads,dependency-audit,installer'
        $arguments += @('-Suites', $suites)
        if (Confirm-MenuAction '¿Comprobación completa antes (check:local y cargo test)? Si falla, no compila') { $arguments += '-CheckFirst' }
        if (Confirm-MenuAction '¿Saltar WSL en las pruebas?') { $arguments += '-SkipWsl' }
        if (Confirm-MenuAction '¿Reanudarla sola si el equipo se reinicia a mitad?') { $arguments += @('-ResumeAfterReboot', '-InstallResumeAtLogon') }
        $keys = Read-SigningChoice
        if ($keys) { $arguments += @('-KeysDir', $keys) } else { $arguments += '-NoSign' }
        $copy = Read-CopyChoice $label
        if (-not (Confirm-MenuAction "¿Empezar la build por etapas $label?")) { return }
        Invoke-MenuAction "Build por etapas $label" $script:PowerShellExe $arguments
        if ($script:LastMenuActionStatus -eq 0) { Copy-BuildOutput @(Get-ChildItem -LiteralPath (Join-Path $Root 'release') | ForEach-Object FullName) $copy }
        return
    }

    # Portable, completa y completa + Latest: windows/build.ps1.
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive')
    if ($type -eq 3) { $arguments += '-NoInstaller' }
    if ($type -eq 6) { $arguments += '-Latest' }
    $tests = Read-Option 'Paso 2 · Pruebas' @(
        'Ninguna (sin comprobaciones ni pruebas ampliadas; lo más rápido)',
        'Básicas (comprobaciones y pruebas del builder)',
        'Completas (todas las pruebas y el recorrido E2E de la carpeta y el portable)',
        'Completas + suites de release (vídeo, descargas, auditoría e instalador; horas)',
        'Reducida de release (lo mismo sin repetir; más corta)',
        'Elegir: compilar sin pruebas y luego pasar las suites o escenarios que digas'
    ) 3
    $after = @()
    switch ($tests) {
        1 { $arguments += @('-NoExtendedTests', '-SkipChecks') }
        3 { $arguments += '-FullTests' }
        4 { $arguments += '-ReleaseValidation' }
        5 { $arguments += '-QuickValidation' }
        6 {
            $arguments += @('-NoExtendedTests', '-SkipChecks')
            node scripts/run-e2e-suite.mjs --list | Select-String -Pattern '^\S' | ForEach-Object { Write-Host $_.Line }
            $after = @('--suite', (Read-Default 'Suites separadas por comas' 'focused'))
        }
    }
    [void](Read-SkipWslArguments 'build')
    $keys = Read-SigningChoice
    if ($keys) { $arguments += @('-KeysDir', $keys) }
    $copy = Read-CopyChoice $label
    Write-Host "`nResumen: build $($types[$type - 1]), pruebas: opción $tests, $(if ($keys) { "firmada con $keys" } else { 'sin firmar' })$(if ($copy) { ", copia en $copy" })."
    if (-not (Confirm-MenuAction '¿Empezar?')) { return }
    Invoke-MenuAction "Build $label" $script:PowerShellExe $arguments
    if ($after.Count -gt 0 -and $script:LastMenuActionStatus -eq 0) {
        $binary = Join-Path $Root "src-tauri\target\dist\WTerminal-$version\wterminal.exe"
        Invoke-MenuAction 'Pasando las suites elegidas' 'node' (@('scripts/run-e2e-suite.mjs', '--binary', $binary) + $after + @('--out', (Join-Path $Root "artifacts\release-validation\WTerminal-$version-build-$label")))
    }
    if ($script:LastMenuActionStatus -eq 0) { Copy-BuildOutput @(Get-ChildItem -LiteralPath (Join-Path $Root 'release') | ForEach-Object FullName) $copy }
}

# Compilar para el otro sistema.
function Show-CrossBuildMenu {
    if ($script:OnWindows) {
        $choice = Read-Option 'Builds de Linux desde Windows' @(
            'AppImage Linux sin pruebas ampliadas (en WSL)',
            'Release Windows y además validar Linux en WSL'
        ) 1
        if ($choice -eq 1) { Invoke-LinuxBuildWithoutExtendedTests }
        else {
            $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1', '-NoRun', '-NonInteractive', '-FullTests', '-CrossLinux') + (Read-KeysDirArguments)
            Invoke-MenuAction 'Generando release Windows y validando Linux en WSL' $script:PowerShellExe $arguments
        }
    } else {
        $choice = Read-Option 'Builds de Windows desde Linux' @(
            'Portable Windows (GNU x64)',
            'Portable Windows rápida',
            'Windows sin pruebas ampliadas',
            'Compilar Windows y pasar la suite Rust bajo Wine',
            'AppImage y además validar Windows bajo Wine'
        ) 1
        switch ($choice) {
            1 { Invoke-WindowsCrossBuild $false }
            2 { Invoke-WindowsCrossBuild $true }
            3 { Invoke-WindowsCrossBuildWithoutExtendedTests }
            4 { Invoke-WindowsWineTests }
            5 { Invoke-LinuxAndWindowsBuild }
        }
    }
}

# Pruebas sobre una build ya compilada, sin recompilar.
function Show-TestBuildMenu {
    $version = Get-AppVersion
    $exe = if ($script:OnWindows) { 'wterminal.exe' } else { 'l' + 'terminal' }
    $candidates = @(
        @{ Name = 'Depuración'; Path = Join-Path $Root "src-tauri\target\debug\$exe" },
        @{ Name = 'Rápida (fast)'; Path = Join-Path $Root "src-tauri\target\fast\$exe" },
        @{ Name = 'Release desempaquetada'; Path = Join-Path $Root "src-tauri\target\dist\WTerminal-$version\$exe" },
        @{ Name = 'Release (target\release)'; Path = Join-Path $Root "src-tauri\target\release\$exe" }
    ) | Where-Object { Test-Path -LiteralPath $_.Path }
    $options = @($candidates | ForEach-Object { "{0} ({1:dd/MM HH:mm})" -f $_.Name, (Get-Item -LiteralPath $_.Path).LastWriteTime }) + @('Otra ruta…')
    $choice = Read-Option 'Paso 1 · Qué build probar' $options 1
    $binary = if ($choice -le $candidates.Count) { $candidates[$choice - 1].Path } else { Read-Host 'Ruta al ejecutable' }
    if (-not $binary -or -not (Test-Path -LiteralPath $binary -PathType Leaf)) { Write-Host "No existe: $binary"; Pause-Menu; return }
    $what = Read-Option 'Paso 2 · Qué pruebas' @(
        'Regresiones enfocadas (focused)',
        'Recorrido completo (full)',
        'Las que alguna vez fallaron, 5 veces (intermitentes)',
        'Pruebas nuevas en rodaje (nuevas)',
        'Escenarios concretos, N veces',
        'Todas las de release menos el instalador (focused, video, downloads, dependency-audit)',
        'Instalador: instala, prueba lo instalado y desinstala',
        'Instalación real del catálogo (cambia el equipo)'
    ) 1
    $skipWsl = Read-SkipWslArguments 'dev-test'
    switch ($what) {
        5 {
            node scripts/dev-test.mjs --list | Out-Host
            $only = Read-Host 'Escenarios separados por comas'
            if ([string]::IsNullOrWhiteSpace($only)) { return }
            $repeat = Read-Default 'Cuántas veces cada uno' '1'
            Invoke-MenuAction 'Escenarios concretos' 'node' (@('scripts/dev-test.mjs', '--binary', $binary, '--only', $only.Trim(), '--repeat', $repeat) + $skipWsl)
        }
        7 {
            $installer = Read-Default 'Instalador' (Join-Path $Root "release\WTerminal-$version-x64-setup.exe")
            Invoke-MenuAction 'Probando el instalador' 'node' @('scripts/run-e2e-suite.mjs', '--binary', $binary, '--suite', 'installer', '--installer', $installer)
        }
        8 {
            if (-not (Confirm-MenuAction 'Instala DE VERDAD lo que falta del catálogo (horas; cambia el equipo). ¿Continuar?')) { return }
            $arguments = @('scripts/dev-test.mjs', '--binary', $binary, '--only', 'real-install') + $skipWsl
            $ids = Read-Host 'Solo estas acciones (ids separados por comas; Enter = todo lo que falte)'
            if (-not [string]::IsNullOrWhiteSpace($ids)) { $arguments += @('--env', "E2E_REAL_INSTALL_IDS=$($ids.Trim())") }
            if (Confirm-MenuAction '¿Solo listar lo que instalaría?') { $arguments += @('--env', 'E2E_REAL_INSTALL_DRY=1') }
            Invoke-MenuAction 'Instalación real del catálogo' 'node' $arguments
        }
        default {
            $suite = @('focused', 'full', 'intermitentes', 'nuevas', '', 'focused,video,downloads,dependency-audit')[$what - 1]
            if ($skipWsl.Count -gt 0) { $env:E2E_SKIP_WSL = '1' }
            Invoke-MenuAction "Suites $suite sobre $binary" 'node' @('scripts/run-e2e-suite.mjs', '--binary', $binary, '--suite', $suite)
        }
    }
}

# Firmar una build ya compilada.
function Show-SignMenu {
    $choice = Read-Option 'Qué firmar' @(
        'La release de release\ (todos sus paquetes)',
        'Otra carpeta (sus .exe, .zip, AppImage…)',
        'Archivos concretos'
    ) 1
    $arguments = @('scripts/sign-build.mjs')
    switch ($choice) {
        1 { $arguments += @('--dir', (Join-Path $Root 'release')) }
        2 { $arguments += @('--dir', (Read-Host 'Carpeta').Trim('"')) }
        3 {
            $files = Read-Host 'Archivos separados por comas'
            $out = Read-Default 'Dónde dejar SHA256SUMS y las firmas' (Split-Path ($files -split ',')[0].Trim('"') -Parent)
            $arguments += @('--files', $files, '--out', $out)
        }
    }
    $keys = Read-KeysDirArguments
    if ($keys.Count -lt 2) { Write-Host 'Sin claves no se firma.'; Pause-Menu; return }
    Invoke-MenuAction 'Firmando la build' 'node' ($arguments + @('--keys-dir', $keys[1]))
}

# ¿La release de release\ corresponde al código actual? Si hay archivos de la
# app más nuevos que su manifiesto, se avisa al abrir el menú: así no se prueba
# ni se publica un binario anterior a los últimos cambios sin darse cuenta.
function Show-ReleaseFreshness {
    $manifest = Join-Path $Root 'release\SHA256SUMS.txt'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
        Write-Host 'Aún no hay una release en release\: «2. Compilar» la genera.' -ForegroundColor DarkGray
        return
    }
    $builtAt = (Get-Item -LiteralPath $manifest).LastWriteTime
    $sources = @('src', 'src-tauri\src', 'src-tauri\windows', 'src-tauri\locales', 'src-tauri\crates') |
        ForEach-Object { Join-Path $Root $_ } | Where-Object { Test-Path -LiteralPath $_ }
    $files = @(Get-ChildItem -LiteralPath $sources -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '[\\/](target|node_modules)[\\/]' })
    $files += @('package.json', 'index.html', 'vite.config.ts', 'src-tauri\Cargo.toml', 'src-tauri\tauri.conf.json',
        'src-tauri\tauri.windows.conf.json', 'src-tauri\tauri.windows.installer.conf.json', 'src-tauri\default_settings.toml') |
        ForEach-Object { Join-Path $Root $_ } | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-Item -LiteralPath $_ }
    $newer = @($files | Where-Object { $_.LastWriteTime -gt $builtAt } | Sort-Object LastWriteTime -Descending)
    if ($newer.Count -gt 0) {
        $latest = $newer[0].FullName.Substring($Root.Length).TrimStart('\', '/')
        Write-Host ("AVISO: la release de release\ ({0:dd/MM HH:mm}) es anterior a tus cambios: {1} archivo(s) más nuevos, el último {2}. Recompila antes de probarla o publicarla." -f $builtAt, $newer.Count, $latest) -ForegroundColor Yellow
    } else {
        Write-Host ("La release de release\ ({0:dd/MM HH:mm}) está al día con el código." -f $builtAt) -ForegroundColor DarkGray
    }
}

Show-ReleaseFreshness

while ($true) {
    Write-Host "`n$script:AppName — desarrollo y compilación"
    Write-Host "  1. Compilar para $(if ($script:OnWindows) { 'Windows' } else { 'Linux' }) (paso a paso: tipo, pruebas, firma y copia)"
    Write-Host "  2. Compilar para $(if ($script:OnWindows) { 'Linux' } else { 'Windows' })"
    Write-Host '  3. Probar una build ya compilada (sin recompilar)'
    Write-Host '  4. Firmar una build ya compilada'
    Write-Host '  5. Pruebas del código (comprobaciones, Rust, lógica) y otras'
    Write-Host '  6. Desarrollo y preview'
    Write-Host '  7. Limpiar cachés y builds temporales'
    Write-Host '  8. Todas las opciones de compilar de antes'
    Write-Host '  0. Salir'
    $choice = Read-MenuChoice 'Elige una opción'
    if ($choice -eq '0') { break }
    switch ($choice) {
        '1' { Show-NativeBuildWizard; Pause-Menu }
        '2' { Show-CrossBuildMenu }
        '3' { Show-TestBuildMenu }
        '4' { Show-SignMenu }
        '5' { Show-TestsMenu }
        '6' { Show-DevelopmentMenu }
        '7' { Show-CleanMenu }
        '8' { Show-BuildMenu }
        default { Write-Host 'Opción no válida.' }
    }
}
