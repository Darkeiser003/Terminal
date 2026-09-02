[CmdletBinding()]
param(
    # Sin esta opción el script solo enumera las rutas: la limpieza es siempre
    # intencionada y se puede revisar antes de borrar artefactos del proyecto,
    # temporales E2E, logs y cachés privadas.
    [switch]$Apply,
    [Alias('h')][switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RootPrefix = $ProjectRoot.TrimEnd([char]92) + [IO.Path]::DirectorySeparatorChar
$RootReadme = Join-Path $ProjectRoot 'README.md'
$ReleaseRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'release')).TrimEnd([char]92)
$TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char]92)
$AppDataRoot = [IO.Path]::GetFullPath([Environment]::GetFolderPath('ApplicationData')).TrimEnd([char]92)
$LocalAppDataRoot = [IO.Path]::GetFullPath([Environment]::GetFolderPath('LocalApplicationData')).TrimEnd([char]92)

if ($Help) {
    Write-Host 'Uso: powershell -ExecutionPolicy Bypass -File scripts\clean-repository.ps1 [-Apply]' -ForegroundColor Cyan
    Write-Host 'Sin -Apply solo muestra las rutas.'
    Write-Host 'Con -Apply elimina salidas, temporales E2E, logs y cachés privadas; release\ se conserva.'
    exit 0
}

function Assert-ProjectPath {
    param([string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "La ruta de limpieza queda fuera del repositorio: $fullPath"
    }
    return $fullPath
}

function Assert-ExternalPath {
    param([string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    foreach ($root in @($TempRoot, $AppDataRoot, $LocalAppDataRoot)) {
        $prefix = $root.TrimEnd([char]92) + [IO.Path]::DirectorySeparatorChar
        if ($fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            return $fullPath
        }
    }
    throw "La ruta externa de limpieza queda fuera de las carpetas permitidas: $fullPath"
}

# Solo salidas reproducibles, cachés e informes locales. No se usa git clean:
# así no se borran configuraciones personales ni archivos no versionados que no
# sean una salida conocida del proyecto.
$generatedDirectories = @(
    'node_modules', 'dist',
    '.cache', '.parcel-cache', '.turbo', '.svelte-kit',
    'coverage', '.nyc_output', 'test-results', 'playwright-report',
    'allure-results', 'AppDir', 'target', 'build', 'tmp', 'temp',
    'src-tauri/target', 'src-tauri/gen'
)

$directoryTargets = [Collections.Generic.List[string]]::new()
foreach ($relativePath in $generatedDirectories) {
    $candidate = Assert-ProjectPath (Join-Path $ProjectRoot $relativePath)
    if (Test-Path -LiteralPath $candidate) {
        $directoryTargets.Add((Resolve-Path -LiteralPath $candidate).Path)
    }
}

# Temporales de node_modules creados por la build Linux al apartar dependencias
# Windows. Se buscan solo en la raíz y nunca dentro de release/.
foreach ($candidate in Get-ChildItem -LiteralPath $ProjectRoot -Force -Directory -Filter '.node_modules.windows.*' -ErrorAction SilentlyContinue) {
    $directoryTargets.Add((Assert-ProjectPath $candidate.FullName))
}

$skippedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($directory in $directoryTargets) {
    [void]$skippedDirectories.Add($directory)
}
# release/ se conserva completo, incluida cualquier documentación empaquetada.
[void]$skippedDirectories.Add($ReleaseRoot)

# El usuario pidió conservar únicamente README.md. Se recorre manualmente para
# no entrar en .git ni en las salidas generadas que ya se eliminarán arriba.
$markdownTargets = [Collections.Generic.List[string]]::new()
function Find-NonReadmeMarkdown {
    param([string]$Directory)

    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
        $entryPath = Assert-ProjectPath $entry.FullName
        if ($entry.PSIsContainer) {
            if ($entry.Name -eq '.git' -or $skippedDirectories.Contains($entryPath)) {
                continue
            }
            Find-NonReadmeMarkdown $entryPath
            continue
        }
        if ($entry.Extension -ieq '.md' -and -not $entryPath.Equals($RootReadme, [StringComparison]::OrdinalIgnoreCase)) {
            $markdownTargets.Add($entryPath)
        }
    }
}
Find-NonReadmeMarkdown $ProjectRoot

# Rastros fuera del repositorio que pertenecen exclusivamente a builds, smoke
# y E2E. No se elimina la configuración de usuario: solo logs y cachés de la
# aplicación/driver que los scripts generan.
$externalTargets = [Collections.Generic.List[string]]::new()
function Add-ExternalPatternTargets {
    param([string]$Root, [string[]]$Patterns)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    foreach ($entry in Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue) {
        if ($Patterns | Where-Object { $entry.Name -like $_ }) {
            [void]$externalTargets.Add((Assert-ExternalPath $entry.FullName))
        }
    }
}

$tempPatterns = @(
    'winslim-terminal-e2e-*.json', 'winslim-terminal-e2e-captures-*',
    'winslim-terminal-webview2-e2e-*', 'winslim-terminal-smoke-*',
    'lterminal-smoke-*', 'lterminal-e2e-report.*', 'lterminal-wine-smoke*',
    'lterminal-appimage-*', 'lterminal-e2e-*',
    'node-v22.14.0-x64.msi', 'rustup-init.exe'
)
Add-ExternalPatternTargets $TempRoot $tempPatterns

# Sesiones temporales por PID creadas por la aplicación durante smoke/E2E. No
# se elimina una sesión cuyo proceso siga vivo para no romper una terminal en
# uso; las demás son restos recuperables de ejecuciones anteriores.
$activePids = @(
    Get-Process -Name 'winslim-terminal', 'lterminal' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id
)
foreach ($sessionRoot in @(
    (Join-Path $TempRoot 'winslim-terminal'),
    (Join-Path $TempRoot 'lterminal')
)) {
    if (-not (Test-Path -LiteralPath $sessionRoot -PathType Container)) { continue }
    foreach ($session in Get-ChildItem -LiteralPath $sessionRoot -Directory -Force -ErrorAction SilentlyContinue) {
        if ($session.Name -notmatch '^\d+$') { continue }
        if ($activePids -contains [int]$session.Name) {
            Write-Warn "Se conserva la sesión temporal activa: $($session.FullName)"
            continue
        }
        [void]$externalTargets.Add((Assert-ExternalPath $session.FullName))
    }
}

# El logger de smoke/E2E comparte el directorio de logs con la app instalada.
# Se borran los logs actuales y rotados, pero se conservan settings, scripts,
# plugins y demás datos de usuario.
foreach ($dataRoot in @(
    (Join-Path $AppDataRoot 'winslim-terminal'),
    (Join-Path $AppDataRoot 'WinSlim Terminal'),
    (Join-Path $AppDataRoot 'lterminal')
)) {
    $logsRoot = Join-Path $dataRoot 'logs'
    if (Test-Path -LiteralPath $logsRoot -PathType Container) {
        [void]$externalTargets.Add((Assert-ExternalPath $logsRoot))
    }
}

# Cachés privadas de LTerminal (AppImage y WebKitWebDriver). No se toca la
# caché global de Tauri ni ninguna carpeta de otros proyectos.
foreach ($cacheRoot in @(
    (Join-Path $LocalAppDataRoot 'lterminal'),
    (Join-Path $AppDataRoot 'lterminal')
)) {
    if (Test-Path -LiteralPath $cacheRoot -PathType Container) {
        foreach ($cacheName in @('cache', 'e2e', 'appimage')) {
            $cachePath = Join-Path $cacheRoot $cacheName
            if (Test-Path -LiteralPath $cachePath) {
                [void]$externalTargets.Add((Assert-ExternalPath $cachePath))
            }
        }
    }
}

$targets = @($directoryTargets) + @($markdownTargets) + @($externalTargets)
if ($targets.Count -eq 0) {
    Write-Host 'Repositorio ya limpio: no hay salidas generadas ni Markdown no-README.' -ForegroundColor Green
    exit 0
}

$mode = if ($Apply) { 'LIMPIEZA' } else { 'VISTA PREVIA' }
Write-Host "$mode - $($targets.Count) ruta(s) bajo $ProjectRoot" -ForegroundColor Cyan
foreach ($target in $targets) {
    $relative = if ($target.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $target.Substring($RootPrefix.Length)
    } else {
        $target
    }
    Write-Host "  $relative"
}

if (-not $Apply) {
    Write-Host 'No se ha borrado nada. Ejecuta: powershell -ExecutionPolicy Bypass -File scripts/clean-repository.ps1 -Apply' -ForegroundColor Yellow
    exit 0
}

$failedTargets = [Collections.Generic.List[string]]::new()
function Add-FailedTarget {
    param([string]$Target, [string]$Reason)

    if (-not $failedTargets.Contains($Target)) {
        $failedTargets.Add($Target)
        Write-Warning "No se pudo eliminar $Target : $Reason"
    }
}

function Remove-CleanupDirectory {
    param([string]$Target)

    try {
        $safeTarget = Assert-ProjectPath $Target
        $releasePrefix = $ReleaseRoot + [IO.Path]::DirectorySeparatorChar
        if ($safeTarget.Equals($ReleaseRoot, [StringComparison]::OrdinalIgnoreCase) -or
            $safeTarget.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "La ruta está protegida porque pertenece a release/: $safeTarget"
        }
        Remove-Item -LiteralPath $safeTarget -Recurse -Force
    } catch {
        # Una app que se está cerrando puede mantener una sola subcarpeta de
        # release. Se eliminan las entradas que sí estén libres y se informa
        # de la ruta concreta pendiente, en vez de abandonar toda la limpieza.
        Write-Warning "No se pudo eliminar $Target completo; se limpiarán sus entradas desbloqueadas."
        foreach ($child in Get-ChildItem -LiteralPath (Assert-ProjectPath $Target) -Force -ErrorAction SilentlyContinue) {
            try {
                Remove-Item -LiteralPath (Assert-ProjectPath $child.FullName) -Recurse -Force
            } catch {
                Add-FailedTarget $child.FullName $_.Exception.Message
            }
        }
        if (Test-Path -LiteralPath $Target) {
            $remaining = @(Get-ChildItem -LiteralPath $Target -Force -ErrorAction SilentlyContinue)
            if ($remaining.Count -eq 0) {
                try {
                    Remove-Item -LiteralPath (Assert-ProjectPath $Target) -Force
                } catch {
                    Add-FailedTarget $Target $_.Exception.Message
                }
            }
        }
    }
}

foreach ($target in $directoryTargets) {
    Remove-CleanupDirectory $target
}
foreach ($target in $markdownTargets) {
    try {
        Remove-Item -LiteralPath (Assert-ProjectPath $target) -Force
    } catch {
        Add-FailedTarget $target $_.Exception.Message
    }
}
foreach ($target in $externalTargets) {
    try {
        Remove-Item -LiteralPath (Assert-ExternalPath $target) -Recurse -Force
    } catch {
        Add-FailedTarget $target $_.Exception.Message
    }
}
if ($failedTargets.Count -gt 0) {
    throw "Limpieza incompleta: $($failedTargets.Count) ruta(s) sigue(n) bloqueada(s)."
}
Write-Host ('Limpieza terminada: {0} directorio(s), {1} Markdown y {2} rastro(s) externo(s) eliminados. release/ se conservó.' -f $directoryTargets.Count, $markdownTargets.Count, $externalTargets.Count) -ForegroundColor Green
