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

function Get-NormalizedDirectoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $pathRoot.Length) {
        $fullPath = $fullPath.TrimEnd([char[]]@([char]92, [char]47))
    }
    return $fullPath
}

$ProjectRoot = Get-NormalizedDirectoryPath (Split-Path -Parent $PSScriptRoot)
$RootPrefix = $ProjectRoot + [IO.Path]::DirectorySeparatorChar
$ReleaseRoots = @(
    (Get-NormalizedDirectoryPath (Join-Path $ProjectRoot 'release'))
)
$TempRoot = Get-NormalizedDirectoryPath ([IO.Path]::GetTempPath())
$appDataPath = [Environment]::GetFolderPath('ApplicationData')
if ([string]::IsNullOrWhiteSpace($appDataPath)) {
    $appDataPath = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME '.config' }
}
$localAppDataPath = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppDataPath)) {
    $localAppDataPath = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME '.local/share' }
}
$AppDataRoot = Get-NormalizedDirectoryPath $appDataPath
$LocalAppDataRoot = Get-NormalizedDirectoryPath $localAppDataPath

if ($Help) {
    Write-Host 'Uso: powershell -ExecutionPolicy Bypass -File scripts\clean-repository.ps1 [-Apply]' -ForegroundColor Cyan
    Write-Host 'Sin -Apply solo muestra las rutas.'
    Write-Host 'Con -Apply elimina salidas y temporales de build/smoke/E2E con nombres propios, además de logs y cachés privadas; release\ y releases\ se conservan.'
    exit 0
}

function Assert-ProjectPath {
    param([string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "La ruta de limpieza queda fuera del repositorio: $fullPath"
    }
    $current = [IO.Path]::GetDirectoryName($fullPath)
    while ($current -and $current.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        if ((Test-Path -LiteralPath $current) -and (Test-ReparsePoint $current)) {
            throw "La ruta de limpieza atraviesa un enlace o punto de reanálisis: $current"
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    return $fullPath
}

function Test-ReparsePoint {
    param([string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-ExternalPath {
    param([string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    foreach ($root in @($TempRoot, $AppDataRoot, $LocalAppDataRoot)) {
        $prefix = (Get-NormalizedDirectoryPath $root) + [IO.Path]::DirectorySeparatorChar
        if ($fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            $current = [IO.Path]::GetDirectoryName($fullPath)
            while ($current -and $current.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                if ((Test-Path -LiteralPath $current) -and (Test-ReparsePoint $current)) {
                    throw "La ruta externa atraviesa un enlace o punto de reanálisis: $current"
                }
                $current = [IO.Path]::GetDirectoryName($current)
            }
            return $fullPath
        }
    }
    throw "La ruta externa de limpieza queda fuera de las carpetas permitidas: $fullPath"
}

function Test-ExternalPathHasReparseParent {
    param([string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    foreach ($root in @($TempRoot, $AppDataRoot, $LocalAppDataRoot)) {
        $prefix = (Get-NormalizedDirectoryPath $root) + [IO.Path]::DirectorySeparatorChar
        if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $current = [IO.Path]::GetDirectoryName($fullPath)
        while ($current -and $current.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            if ((Test-Path -LiteralPath $current) -and (Test-ReparsePoint $current)) { return $true }
            $current = [IO.Path]::GetDirectoryName($current)
        }
        return $false
    }
    return $false
}

# Solo salidas reproducibles, cachés e informes locales. No se usa git clean:
# así no se borran configuraciones personales ni archivos no versionados que no
# sean una salida conocida del proyecto.
$generatedDirectories = @(
    'node_modules', 'dist', 'artifacts',
    '.cache', '.parcel-cache', '.turbo', '.svelte-kit', '.scala-build',
    'coverage', '.nyc_output', 'test-results', 'playwright-report',
    'allure-results', 'AppDir', 'target', 'build', 'tmp', 'temp',
    'src-tauri/target', 'src-tauri/gen'
)

$directoryTargets = [Collections.Generic.List[string]]::new()
foreach ($relativePath in $generatedDirectories) {
    $candidate = Assert-ProjectPath (Join-Path $ProjectRoot $relativePath)
    if (Test-Path -LiteralPath $candidate) {
        if (Test-ReparsePoint $candidate) {
            Write-Warning "Se conserva la salida porque es un enlace o punto de reanálisis: $candidate"
            continue
        }
        $directoryTargets.Add($candidate)
    }
}

# Temporales de node_modules creados por la build Linux al apartar dependencias
# Windows. Se buscan solo en la raíz y nunca dentro de release/.
foreach ($candidate in Get-ChildItem -LiteralPath $ProjectRoot -Force -Directory -Filter '.node_modules.windows.*' -ErrorAction SilentlyContinue) {
    $safeCandidate = Assert-ProjectPath $candidate.FullName
    if (Test-ReparsePoint $safeCandidate) {
        Write-Warning "Se conserva el staging porque es un enlace o punto de reanálisis: $safeCandidate"
        continue
    }
    $directoryTargets.Add($safeCandidate)
}

$skippedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($directory in $directoryTargets) {
    [void]$skippedDirectories.Add($directory)
}
# Ambas carpetas de distribución se conservan completas, incluida cualquier
# documentación o artefacto empaquetado.
foreach ($releaseRoot in $ReleaseRoots) {
    [void]$skippedDirectories.Add($releaseRoot)
}

# Solo se eliminan informes Markdown con nombres de salida conocidos. La
# documentación del proyecto puede vivir en cualquier subdirectorio sin que el
# limpiador la confunda con un artefacto.
$markdownTargets = [Collections.Generic.List[string]]::new()
function Find-NonReadmeMarkdown {
    param([string]$Directory)

    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
        $entryPath = Assert-ProjectPath $entry.FullName
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            continue
        }
        if ($entry.PSIsContainer) {
            if ($entry.Name -eq '.git' -or $skippedDirectories.Contains($entryPath)) {
                continue
            }
            Find-NonReadmeMarkdown $entryPath
            continue
        }
        if ($entry.Extension -ieq '.md' -and $entry.Name -match '^(AUDIT-|audit-|build-).+\.md$|-(audit|report)\.md$') {
            $markdownTargets.Add($entryPath)
        }
    }
}
Find-NonReadmeMarkdown $ProjectRoot

# Rastros fuera del repositorio con nombres propios de builds, smoke y E2E. No
# se elimina la configuración de usuario: solo logs y cachés de la aplicación.
$externalTargets = [Collections.Generic.List[string]]::new()
function Add-ExternalTarget {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (Test-ReparsePoint $Path) {
        Write-Warning "Se conserva la ruta externa porque es un enlace o punto de reanálisis: $Path"
        return
    }
    if (Test-ExternalPathHasReparseParent $Path) {
        Write-Warning "Se conserva la ruta externa porque atraviesa un enlace o punto de reanálisis: $Path"
        return
    }
    [void]$externalTargets.Add((Assert-ExternalPath $Path))
}

function Add-ExternalPatternTargets {
    param([string]$Root, [string[]]$Patterns)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    foreach ($entry in Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue) {
        if ($Patterns | Where-Object { $entry.Name -like $_ }) {
            Add-ExternalTarget $entry.FullName
        }
    }
}

$script:AppImageProcessPathsLoaded = $false
$script:AppImageProcessPathsVerifiable = $false
$script:AppImageProcessPaths = @()
function Test-LiveProcessInDirectory {
    param([string]$Path)

    if (-not $script:AppImageProcessPathsLoaded) {
        $script:AppImageProcessPathsLoaded = $true
        $procRoot = '/proc'
        $readlink = Get-Command 'readlink' -ErrorAction SilentlyContinue
        if ((Test-Path -LiteralPath $procRoot -PathType Container) -and $readlink) {
            $processPaths = [Collections.Generic.List[string]]::new()
            foreach ($process in Get-ChildItem -LiteralPath $procRoot -Directory -ErrorAction SilentlyContinue) {
                if ($process.Name -notmatch '^\d+$') { continue }
                foreach ($entryName in @('exe', 'cwd')) {
                    $entryPath = Join-Path $process.FullName $entryName
                    try {
                        $processPath = (& $readlink.Source -- $entryPath 2>$null | Select-Object -First 1)
                    } catch {
                        continue
                    }
                    if ($processPath) { $processPaths.Add([string]$processPath) }
                }
            }
            $script:AppImageProcessPaths = @($processPaths.ToArray())
            $script:AppImageProcessPathsVerifiable = $true
        }
    }
    if (-not $script:AppImageProcessPathsVerifiable) { return $true }

    $normalizedPath = Get-NormalizedDirectoryPath $Path
    $prefix = $normalizedPath + [IO.Path]::DirectorySeparatorChar
    foreach ($processPath in $script:AppImageProcessPaths) {
        if ($processPath.Equals($normalizedPath, [StringComparison]::Ordinal) -or $processPath.StartsWith($prefix, [StringComparison]::Ordinal)) {
            return $true
        }
    }
    return $false
}

$tempPatterns = @(
    'winslim-terminal-e2e-*.json', 'winslim-terminal-e2e-captures-*',
    'winslim-terminal-webview2-e2e-*', 'winslim-terminal-smoke-*', 'winslim-terminal-version-*',
    'lterminal-smoke-*', 'lterminal-adb-audit.*', 'lterminal-release-audit-captures.*',
    'lterminal-e2e-report.*', 'lterminal-version-backup.*',
    'lterminal-npm-audit.*', 'lterminal-fake-adb-*', 'lterminal-cleaner-test-*',
    'lterminal-build-menu-test-*', 'lterminal-release-signature-*', 'lterminal-windows-cross-release-*',
    'winslim-release-hash-*', 'lterminal-node-download.*',
    'lterminal-rustup-installer.*', 'lterminal-build-smoke.*', 'lterminal-build-smoke-app.*',
    'lterminal-release-validation.*', 'lterminal-wine-*',
    'lterminal-appimage-*', 'lterminal-e2e-*', 'winslim-terminal-build-*'
)
Add-ExternalPatternTargets $TempRoot $tempPatterns

# AppImage usa un nombre temporal genérico con hash. Solo se limpia cuando la
# extracción contiene los dos marcadores propios de LTerminal y no hay ningún
# proceso usando su ejecutable o directorio de trabajo.
foreach ($candidate in Get-ChildItem -LiteralPath $TempRoot -Force -Directory -Filter 'appimage_extracted_*' -ErrorAction SilentlyContinue) {
    if (Test-ReparsePoint $candidate.FullName) { continue }
    $binary = Join-Path $candidate.FullName 'usr/bin/lterminal'
    $desktop = Join-Path $candidate.FullName 'usr/share/applications/LTerminal.desktop'
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf) -or -not (Test-Path -LiteralPath $desktop -PathType Leaf)) { continue }
    if (Test-LiveProcessInDirectory $candidate.FullName) {
        Write-Host "  Se conserva AppImage de LTerminal activo o no verificable: $($candidate.FullName)"
        continue
    }
    Add-ExternalTarget $candidate.FullName
}

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
            Write-Warning "Se conserva la sesión temporal activa: $($session.FullName)"
            continue
        }
        Add-ExternalTarget $session.FullName
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
        Add-ExternalTarget $logsRoot
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
                Add-ExternalTarget $cachePath
            }
        }
    }
}

$targets = @($directoryTargets) + @($markdownTargets) + @($externalTargets)
if ($targets.Count -eq 0) {
    Write-Host 'Repositorio ya limpio: no hay salidas generadas ni informes Markdown.' -ForegroundColor Green
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
        foreach ($releaseRoot in $ReleaseRoots) {
            $releasePrefix = $releaseRoot + [IO.Path]::DirectorySeparatorChar
            if ($safeTarget.Equals($releaseRoot, [StringComparison]::OrdinalIgnoreCase) -or
                $safeTarget.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "La ruta está protegida porque pertenece a release/: $safeTarget"
            }
        }
        Remove-DirectoryTreeSafely $safeTarget
    } catch {
        # Una app que se está cerrando puede mantener una sola subcarpeta de
        # release. Se eliminan las entradas que sí estén libres y se informa
        # de la ruta concreta pendiente, en vez de abandonar toda la limpieza.
        Write-Warning "No se pudo eliminar $Target completo; se limpiarán sus entradas desbloqueadas."
        foreach ($child in Get-ChildItem -LiteralPath (Assert-ProjectPath $Target) -Force -ErrorAction SilentlyContinue) {
            try {
                Remove-DirectoryTreeSafely (Assert-ProjectPath $child.FullName)
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

function Remove-DirectoryTreeSafely {
    param([string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        # Elimina el enlace/junction como entrada, sin recorrer su destino.
        Remove-Item -LiteralPath $Path -Force
        return
    }
    if ($item.PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
            Remove-DirectoryTreeSafely $child.FullName
        }
    }
    Remove-Item -LiteralPath $Path -Force
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
        Remove-DirectoryTreeSafely (Assert-ExternalPath $target)
    } catch {
        Add-FailedTarget $target $_.Exception.Message
    }
}
if ($failedTargets.Count -gt 0) {
    throw "Limpieza incompleta: $($failedTargets.Count) ruta(s) sigue(n) bloqueada(s)."
}
Write-Host ('Limpieza terminada: {0} directorio(s), {1} Markdown y {2} rastro(s) externo(s) eliminados. release/ se conservó.' -f $directoryTargets.Count, $markdownTargets.Count, $externalTargets.Count) -ForegroundColor Green
