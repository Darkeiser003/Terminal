[CmdletBinding()]
param(
    # Sin esta opción el script solo enumera las rutas: la limpieza es siempre
    # intencionada y se puede revisar antes de borrar artefactos del proyecto,
    # temporales E2E, logs y cachés privadas.
    [switch]$Apply,
    # Solo restos: logs sueltos de la raíz, dist, releases anteriores apartadas,
    # evidencias de artifacts/ con más de -KeepDays días, temporales de pruebas,
    # sesiones muertas y entradas muertas del PATH de usuario. Conserva
    # node_modules, target y los logs de la app para que el siguiente build siga
    # siendo rápido.
    [switch]$Light,
    [ValidateRange(0, 3650)][int]$KeepDays = 3,
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
    Write-Host 'Uso: powershell -ExecutionPolicy Bypass -File scripts\clean-repository.ps1 [-Light [-KeepDays N]] [-Apply]' -ForegroundColor Cyan
    Write-Host 'Sin -Apply solo muestra las rutas.'
    Write-Host 'Con -Light solo quita restos (logs sueltos, dist, releases anteriores, evidencias de artifacts/ con más de -KeepDays días, temporales y entradas muertas del PATH) y conserva node_modules y target.'
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
$fullGeneratedDirectories = @(
    'node_modules', '.pnpm-store', 'dist', 'dist-preview', 'artifacts',
    '.cache', '.parcel-cache', '.turbo', '.svelte-kit', '.scala-build',
    'coverage', '.nyc_output', 'test-results', 'playwright-report',
    'allure-results', 'AppDir', 'target', 'build', 'tmp', 'temp',
    'src-tauri/target', 'src-tauri/gen',
    'src-tauri/crates/github-target/target', 'fuzz/target'
)
# El modo ligero deja las dependencias y las cachés de compilación: solo salidas
# que no hacen falta para el siguiente build y las releases anteriores que la
# build completa aparta en src-tauri/target/dist/release-anterior.
$generatedDirectories = if ($Light) {
    @('dist', 'dist-preview', 'src-tauri/target/dist/release-anterior')
} else {
    $fullGeneratedDirectories
}

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

# Archivos sueltos: logs que algunas builds dejan en la raíz y, en modo ligero,
# las evidencias de artifacts/ más antiguas que -KeepDays.
$fileTargets = [Collections.Generic.List[string]]::new()
foreach ($log in Get-ChildItem -LiteralPath $ProjectRoot -Force -File -Filter '*.log' -ErrorAction SilentlyContinue) {
    if (Test-ReparsePoint $log.FullName) { continue }
    $fileTargets.Add((Assert-ProjectPath $log.FullName))
}
if ($Light) {
    $artifactsRoot = Join-Path $ProjectRoot 'artifacts'
    if ((Test-Path -LiteralPath $artifactsRoot -PathType Container) -and -not (Test-ReparsePoint $artifactsRoot)) {
        $cutoff = (Get-Date).AddDays(-$KeepDays)
        foreach ($entry in Get-ChildItem -LiteralPath $artifactsRoot -Force -ErrorAction SilentlyContinue) {
            if ($entry.LastWriteTime -ge $cutoff) { continue }
            $fileTargets.Add((Assert-ProjectPath $entry.FullName))
        }
    }
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
        if ($entry.Extension -ieq '.md' -and ($entry.Name -eq 'AUDITORIA-WINDOWS-2026-09-23.md' -or $entry.Name -match '^(AUDIT-|audit-|build-).+\.md$|-(audit|report)\.md$')) {
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
    'lterminal-appimage-*', 'lterminal-e2e-*', 'winslim-terminal-build-*',
    # Nombres actuales de los E2E y pruebas de WTerminal (perfiles aislados,
    # gh/gsudo simulados, imagen del banner, E2E elevado) y las reproducciones
    # del PATH de WTools.
    'wterminal-e2e-*', 'wterminal-elevated-e2e-*', 'wterminal-banner-image-*', 'wtools-path-repro*'
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
    Get-Process -Name 'wterminal', 'winslim-terminal', 'lterminal' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id
)
foreach ($sessionRoot in @(
    (Join-Path $TempRoot 'wterminal'),
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
# El modo ligero conserva los logs de la app: pueden hacer falta para
# diagnosticar lo último que pasó.
$dataRoots = if ($Light) { @() } else { @(
    (Join-Path $AppDataRoot 'wterminal'),
    (Join-Path $AppDataRoot 'winslim-terminal'),
    (Join-Path $AppDataRoot 'WinSlim Terminal'),
    (Join-Path $AppDataRoot 'lterminal')
) }
foreach ($dataRoot in $dataRoots) {
    $logsRoot = Join-Path $dataRoot 'logs'
    if (Test-Path -LiteralPath $logsRoot -PathType Container) {
        Add-ExternalTarget $logsRoot
    }
}

# Cachés privadas de LTerminal (AppImage y WebKitWebDriver). No se toca la
# caché global de Tauri ni ninguna carpeta de otros proyectos.
$cacheRoots = if ($Light) { @() } else { @(
    (Join-Path $LocalAppDataRoot 'lterminal'),
    (Join-Path $AppDataRoot 'lterminal')
) }
foreach ($cacheRoot in $cacheRoots) {
    if (Test-Path -LiteralPath $cacheRoot -PathType Container) {
        foreach ($cacheName in @('cache', 'e2e', 'appimage')) {
            $cachePath = Join-Path $cacheRoot $cacheName
            if (Test-Path -LiteralPath $cachePath) {
                Add-ExternalTarget $cachePath
            }
        }
    }
}

# Entradas del PATH de usuario que apuntan a carpetas que ya no existen dentro
# de %TEMP% o de release\ de este repositorio: restos de pruebas y de builds
# anteriores. Las demás entradas, aunque no existan, son del usuario y no se
# tocan. Se leen sin expandir para conservar las %VARIABLES% al reescribir.
$pathTargets = [Collections.Generic.List[string]]::new()
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    $rawUserPath = if ($environmentKey) {
        [string]$environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } else { '' }
    if ($environmentKey) { $environmentKey.Close() }
    $releasePrefix = (Join-Path $ProjectRoot 'release') + [IO.Path]::DirectorySeparatorChar
    $tempPrefix = $TempRoot + [IO.Path]::DirectorySeparatorChar
    foreach ($entry in ($rawUserPath -split ';')) {
        if ([string]::IsNullOrWhiteSpace($entry)) { continue }
        try {
            $expanded = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($entry.Trim()))
        } catch {
            continue
        }
        $ours = $expanded.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            $expanded.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)
        if ($ours -and -not (Test-Path -LiteralPath $expanded)) { $pathTargets.Add($entry) }
    }
}

$targets = @($directoryTargets) + @($fileTargets) + @($markdownTargets) + @($externalTargets)
if ($targets.Count -eq 0 -and $pathTargets.Count -eq 0) {
    Write-Host 'Repositorio ya limpio: no hay salidas generadas ni informes Markdown.' -ForegroundColor Green
    exit 0
}

$mode = if ($Apply) { 'LIMPIEZA' } else { 'VISTA PREVIA' }
if ($Light) { $mode = "$mode LIGERA (conserva node_modules y target; artifacts/ de más de $KeepDays días)" }
Write-Host "$mode - $($targets.Count) ruta(s) bajo $ProjectRoot" -ForegroundColor Cyan
foreach ($target in $targets) {
    $relative = if ($target.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $target.Substring($RootPrefix.Length)
    } else {
        $target
    }
    Write-Host "  $relative"
}
foreach ($entry in $pathTargets) {
    Write-Host "  PATH de usuario (no existe): $entry"
}

if (-not $Apply) {
    # La orden sugerida repite el modo de la vista previa: en modo ligero,
    # sugerir solo -Apply llevaba a la limpieza completa (node_modules y target).
    $applyHint = if ($Light) { "-Light -KeepDays $KeepDays -Apply" } else { '-Apply' }
    Write-Host "No se ha borrado nada. Ejecuta: powershell -ExecutionPolicy Bypass -File scripts/clean-repository.ps1 $applyHint" -ForegroundColor Yellow
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
foreach ($target in $fileTargets) {
    try {
        Remove-DirectoryTreeSafely (Assert-ProjectPath $target)
    } catch {
        Add-FailedTarget $target $_.Exception.Message
    }
}
foreach ($target in $markdownTargets) {
    try {
        Remove-Item -LiteralPath (Assert-ProjectPath $target) -Force
    } catch {
        Add-FailedTarget $target $_.Exception.Message
    }
}
if ($pathTargets.Count -gt 0) {
    try {
        $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        $kind = $environmentKey.GetValueKind('Path')
        $rawUserPath = [string]$environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kept = @($rawUserPath -split ';' | Where-Object { $_ -and ($pathTargets -notcontains $_) })
        $environmentKey.SetValue('Path', ($kept -join ';'), $kind)
        $environmentKey.Close()
        # Avisa a Windows del cambio (WM_SETTINGCHANGE) sin dejar ninguna variable nueva.
        [Environment]::SetEnvironmentVariable('WTERMINAL_CLEANUP_NOTIFY', '1', 'User')
        [Environment]::SetEnvironmentVariable('WTERMINAL_CLEANUP_NOTIFY', $null, 'User')
    } catch {
        Add-FailedTarget 'PATH de usuario' $_.Exception.Message
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
Write-Host ('Limpieza terminada: {0} directorio(s), {1} archivo(s) sueltos, {2} Markdown, {3} rastro(s) externo(s) y {4} entrada(s) muertas del PATH eliminados. release/ se conservó.' -f $directoryTargets.Count, $fileTargets.Count, $markdownTargets.Count, $externalTargets.Count, $pathTargets.Count) -ForegroundColor Green
