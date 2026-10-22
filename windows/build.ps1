#requires -Version 5.0
<#
    Build de WTerminal (Tauri 2 + Rust) para Windows.

    Produce por defecto la carpeta desempaquetada con el .exe y un instalador
    NSIS con WebView2 offline incluido; la descripción mantenida está en README.md.

    Requisitos: Node.js >= 22.12 y el toolchain de Rust (rustup/cargo). La
    carpeta desempaquetada incluye el bootstrapper si se prepara; el instalador
    offline lo instala en el equipo destino.
#>

param(
    [Alias('h')][switch]$Help,
    [switch]$Clean,
    [switch]$NoRun,
    [switch]$Installer,
    [switch]$NoInstaller,
    [switch]$SingleFile,
    [switch]$NoSingleFile,
    [switch]$SkipChecks,
    [switch]$AllowOfflineChecks,
    [string]$Version,
    [switch]$InstallE2eDriver,
    [switch]$NonInteractive,
    [switch]$FullTests,
    [switch]$StrictTests,
    [switch]$NoExtendedTests,
    [switch]$Fast,
    [switch]$CrossLinux,
    [switch]$ReleaseValidation,
    [switch]$VideoTest,
    [switch]$DownloadTests,
    [switch]$DependencyAudit,
    [switch]$InstallerTest,
    [switch]$NoFocusedTests
)

$ErrorActionPreference = 'Stop'

# PowerShell permite que los argumentos no vinculados terminen silenciosamente
# en `$args` cuando un script no declara parámetros posicionales. Rechazarlos
# aquí evita que una errata (por ejemplo, `-NotARealOption`) parezca aceptada y
# arranque una build con valores distintos de los que pidió el usuario.
# PowerShell vincula los parámetros con la forma `-Version 1.2.3`. Cualquier
# token restante se rechaza para que una errata no arranque una build distinta.
if ($args.Count -gt 0) {
    throw "Argumento(s) no reconocido(s): $($args -join ', ')"
}
$versionWasExplicit = $PSBoundParameters.ContainsKey('Version')
if ($versionWasExplicit -and [string]::IsNullOrWhiteSpace($Version)) {
    throw 'La versión no puede estar vacía.'
}

if ($NoExtendedTests.IsPresent -and ($FullTests.IsPresent -or $StrictTests.IsPresent)) {
    throw '-NoExtendedTests no se puede combinar con -FullTests ni -StrictTests.'
}
# -ReleaseValidation es el nivel que permite dar una release por buena: la
# batería completa más todas las suites estandarizadas (tests/e2e/suites.mjs).
if ($ReleaseValidation.IsPresent) {
    $FullTests = [switch]::new($true)
    $VideoTest = [switch]::new($true)
    $DownloadTests = [switch]::new($true)
    $DependencyAudit = [switch]::new($true)
    $InstallerTest = [switch]::new($true)
}
$extraSuiteRequested = $VideoTest.IsPresent -or $DownloadTests.IsPresent -or $DependencyAudit.IsPresent -or $InstallerTest.IsPresent
if ($NoExtendedTests.IsPresent -and ($extraSuiteRequested -or $ReleaseValidation.IsPresent)) {
    throw '-NoExtendedTests no se puede combinar con -ReleaseValidation, -VideoTest, -DownloadTests, -DependencyAudit ni -InstallerTest.'
}
if ($InstallerTest.IsPresent -and $NoInstaller.IsPresent) {
    throw '-InstallerTest necesita el instalador: no se puede combinar con -NoInstaller.'
}

# Resolver las rutas del proyecto al principio permite recoger todos los
# parámetros interactivos (incluida la versión) antes de tocar dependencias o
# comenzar una compilación.
$WindowsDir  = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $WindowsDir
$TauriDir    = Join-Path $ProjectRoot 'src-tauri'
$ReleaseDir  = Join-Path $TauriDir 'target\release'
$VendorDir   = Join-Path $TauriDir 'vendor\conpty'

Set-Location $ProjectRoot

$script:VersionManifestBackupDir = $null
$script:UsingPnpmNpmShim = $false
$script:BuildTempDir = Join-Path ([IO.Path]::GetTempPath()) "wterminal-build-$PID-$([guid]::NewGuid().ToString('N'))"
$script:VersionManifestPaths = @(
    (Join-Path $ProjectRoot 'package.json'),
    (Join-Path $ProjectRoot 'package-lock.json'),
    (Join-Path $TauriDir 'Cargo.toml'),
    (Join-Path $TauriDir 'Cargo.lock')
)

function Backup-VersionManifests {
    if ($script:VersionManifestBackupDir) { return }
    $script:VersionManifestBackupDir = Join-Path ([IO.Path]::GetTempPath()) "wterminal-version-$PID"
    New-Item -ItemType Directory -Force -Path $script:VersionManifestBackupDir | Out-Null
    try {
        foreach ($path in $script:VersionManifestPaths) {
            if (-not (Test-Path $path -PathType Leaf)) {
                throw "No existe el manifiesto de versión $path."
            }
            Copy-Item -LiteralPath $path -Destination (Join-Path $script:VersionManifestBackupDir ([IO.Path]::GetFileName($path))) -Force
        }
    } catch {
        Remove-Item -LiteralPath $script:VersionManifestBackupDir -Recurse -Force -ErrorAction SilentlyContinue
        $script:VersionManifestBackupDir = $null
        throw
    }
}

function Restore-VersionManifests {
    if (-not $script:VersionManifestBackupDir) { return }
    if (-not (Test-Path -LiteralPath $script:VersionManifestBackupDir -PathType Container)) {
        throw "No está disponible la copia de seguridad de los manifiestos: $script:VersionManifestBackupDir."
    }
    $restoreFailures = [Collections.Generic.List[string]]::new()
    foreach ($path in $script:VersionManifestPaths) {
        $backup = Join-Path $script:VersionManifestBackupDir ([IO.Path]::GetFileName($path))
        if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
            $restoreFailures.Add("$path (falta la copia de seguridad $backup)")
            continue
        }
        try {
            Copy-Item -LiteralPath $backup -Destination $path -Force -ErrorAction Stop
            $expectedHash = (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash
            $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
            if ($expectedHash -ne $actualHash) {
                throw 'el contenido restaurado no coincide con la copia'
            }
        } catch {
            $restoreFailures.Add("$path ($($_.Exception.Message))")
        }
    }
    if ($restoreFailures.Count -gt 0) {
        throw "No se pudieron verificar los manifiestos restaurados: $($restoreFailures -join '; '). Copia disponible en $script:VersionManifestBackupDir."
    }
    Remove-Item -LiteralPath $script:VersionManifestBackupDir -Recurse -Force -ErrorAction Stop
    $script:VersionManifestBackupDir = $null
}

if ($Installer.IsPresent -and $NoInstaller.IsPresent) {
    throw '-Installer y -NoInstaller no se pueden combinar.'
}
if ($SingleFile.IsPresent -and $NoSingleFile.IsPresent) {
    throw '-SingleFile y -NoSingleFile no se pueden combinar.'
}
# Una ejecución sin opciones debe generar una release publicable. El instalador
# se puede desactivar explícitamente para iteraciones rápidas o portables.
if (-not $NoInstaller.IsPresent) {
    $Installer = [switch]::new($true)
}
# La release completa publica también un portable de un solo archivo. Las
# builds rápidas no lo generan salvo que se solicite explícitamente para no
# convertir una iteración de desarrollo en un artefacto de distribución.
if (-not $NoSingleFile.IsPresent -and ($SingleFile.IsPresent -or -not $Fast.IsPresent)) {
    $SingleFile = [switch]::new($true)
}

if ($Help) {
    Write-Host 'Uso: powershell -ExecutionPolicy Bypass -File windows\build.ps1 [opciones]'
    Write-Host '  -Clean                Limpia dependencias y target antes de compilar.'
    Write-Host '  -Fast                 Iteracion rapida (sin LTO, incremental).'
    Write-Host '  -NoRun                No lanza la aplicacion al terminar.'
    Write-Host '  -SkipChecks           Omite comprobaciones locales.'
    Write-Host '  -NoExtendedTests      Omite sondas opcionales y E2E; conserva smoke minimo.'
    Write-Host '  -FullTests            Fuerza la bateria ampliada y E2E.'
    Write-Host '  -StrictTests          Hace fallar la build si faltan sondas opcionales.'
    Write-Host '  -AllowOfflineChecks   Convierte comprobaciones externas en avisos.'
    Write-Host '  -CrossLinux            Ejecuta tambien la build Linux dentro de WSL.'
    Write-Host '  -Installer             Activa el instalador NSIS offline (ya es predeterminado).'
    Write-Host '  -NoInstaller           Desactiva el instalador NSIS predeterminado.'
    Write-Host '  -SingleFile            Genera también el portable de un solo .exe (sin extraer nada).'
    Write-Host '  -NoSingleFile          Omite el portable de un solo .exe.'
    Write-Host '  -NoFocusedTests        Omite la suite de regresiones enfocadas que acompaña a la batería ampliada.'
    Write-Host '  -VideoTest             Añade el recorrido E2E completo grabando vídeo.'
    Write-Host '  -DownloadTests         Añade descargas reales (pip, npm, Deno, Bun, Go) a la carpeta de cachés (necesita red).'
    Write-Host '  -DependencyAudit       Añade la auditoría completa del catálogo de dependencias (larga).'
    Write-Host '  -InstallerTest         Instala el NSIS (un UAC), ejecuta el E2E sobre lo instalado y desinstala.'
    Write-Host '  -ReleaseValidation     -FullTests + vídeo + descargas + auditoría + instalador: el nivel para dar una release por buena.'
    Write-Host '  -InstallE2eDriver     Compatibilidad: el E2E ya prepara tauri-driver automáticamente.'
    Write-Host '  -Version X.Y.Z        Sobrescribe la version del paquete.'
    Write-Host '  -NonInteractive        No espera entrada del usuario.'
    Write-Host '  Sin opciones           Release completa: EXE + portable de un solo archivo + NSIS, checks estrictos, smoke, bateria ampliada y E2E.'
    Write-Host '                        En modo interactivo, la versión se pide al principio junto al resto de opciones.'
    Write-Host '                        Un fallo de E2E se informa al final sin impedir publicar la release.'
    exit 0
}

# Los escenarios de restauración de versión no necesitan descargar Node/Rust,
# sondear WinGet ni inicializar Visual Studio. Mantener este recorrido de prueba
# junto al backup real hace que el test sea rápido y fiable en CI y en hosts
# mínimos, y evita cambios temporales mientras busca requisitos externos.
$runVersionRecoveryTest = $env:LTERMINAL_TEST_FAIL_AFTER_VERSION -eq '1' -or
    -not [string]::IsNullOrWhiteSpace($env:LTERMINAL_TEST_REMOVE_VERSION_BACKUP) -or
    $env:LTERMINAL_TEST_EXIT_AFTER_VERSION -eq '1'
if ($runVersionRecoveryTest) {
    $testPackage = Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
    if (-not [string]::IsNullOrWhiteSpace($Version) -and $Version -ne $testPackage.version) {
        Backup-VersionManifests
        & node 'scripts/set-package-version.mjs' $Version
        if ($LASTEXITCODE -ne 0) { throw 'La prueba no pudo aplicar la versión de ensayo.' }
    }
    if ($env:LTERMINAL_TEST_REMOVE_VERSION_BACKUP) {
        if ($env:LTERMINAL_TEST_REMOVE_VERSION_BACKUP -notin @('package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock')) {
            throw 'El manifiesto solicitado para la prueba no está permitido.'
        }
        $testBackup = Join-Path $script:VersionManifestBackupDir $env:LTERMINAL_TEST_REMOVE_VERSION_BACKUP
        Remove-Item -LiteralPath $testBackup -Force -ErrorAction Stop
        Restore-VersionManifests
    }
    if ($env:LTERMINAL_TEST_EXIT_AFTER_VERSION -eq '1') {
        Restore-VersionManifests
        exit 0
    }
    if ($env:LTERMINAL_TEST_FAIL_AFTER_VERSION -eq '1') {
        Restore-VersionManifests
        throw 'Fallo de prueba solicitado después de aplicar la versión.'
    }
}

try {
$script:BuildStartedAt = [DateTime]::UtcNow
$script:StepStartedAt = $script:BuildStartedAt
# Las validaciones posteriores (sondas opcionales, E2E y WSL cruzado) no deben
# impedir que se publique el artefacto que ya compiló correctamente. Se
# acumulan para mostrarlas juntas al final y se conserva un código de salida
# distinto de cero para CI/diagnóstico.
$script:PostBuildIssues = @()
function Add-PostBuildIssue {
    param([Parameter(Mandatory = $true)][string]$Message)
    $script:PostBuildIssues += $Message
    Write-Warn $Message
}

# Lo que la build deja para revisar después: qué pruebas corrieron y dónde
# quedaron informes, capturas, vídeos y logs. `Write-BuildSummary` lo enseña
# todo junto al final; sin esto había que buscar en %TEMP% con nombres
# aleatorios y el log principal se borraba con el temporal de la build.
$script:BuildTests = @()
$script:BuildArtifactsDir = $null
function Add-BuildTest {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Result,
        [string]$Detail = ''
    )
    $script:BuildTests += [pscustomobject]@{ Name = $Name; Result = $Result; Detail = $Detail }
}
function Get-BuildArtifactsDir {
    if (-not $script:BuildArtifactsDir) {
        $suffix = if ($Fast) { '-dev' } else { '' }
        $script:BuildArtifactsDir = Join-Path $ProjectRoot ("artifacts\builds\WTerminal-$version$suffix-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Force -Path $script:BuildArtifactsDir | Out-Null
    }
    return $script:BuildArtifactsDir
}
function Format-BuildSize ([long]$Bytes) {
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    return ('{0:N0} KB' -f [Math]::Ceiling($Bytes / 1KB))
}
function Write-BuildSummary {
    $releaseFiles = @()
    if ($releaseOut -and (Test-Path -LiteralPath $releaseOut -PathType Container)) {
        $releaseFiles = @(Get-ChildItem -LiteralPath $releaseOut -File -Force | Sort-Object Name)
    }
    $artifactsDir = $script:BuildArtifactsDir
    if ($artifactsDir -and $logPath -and (Test-Path -LiteralPath $logPath -PathType Leaf)) {
        Copy-Item -LiteralPath $logPath -Destination (Join-Path $artifactsDir 'wterminal-main.log') -Force -ErrorAction SilentlyContinue
    }
    $evidence = @()
    $evidenceRoots = @($artifactsDir, $script:SuiteOutDir) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
    foreach ($root in $evidenceRoots) {
        $evidence += @(Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue)
    }
    $videos = @($evidence | Where-Object { $_.Extension -in '.mp4', '.webm' } | Sort-Object FullName)
    $screenshots = @($evidence | Where-Object { $_.Extension -in '.png', '.jpg', '.jpeg' })
    $reports = @($evidence | Where-Object { $_.Name -like '*report*.json' -or $_.Name -in 'summary.md', 'summary.json' } | Sort-Object FullName)
    $logs = @($evidence | Where-Object { $_.Extension -eq '.log' } | Sort-Object FullName)

    Write-Host ''
    Write-Host '==> Resumen de la build' -ForegroundColor Cyan
    Write-Host "  Versión: $version$(if ($Fast) { ' (rápida, -dev)' })"
    Write-Host "  Carpeta desempaquetada: $distDir"
    Write-Host "  Archivos de release ($releaseOut):"
    if ($releaseFiles.Count -eq 0) { Write-Host '    (ninguno)' -ForegroundColor Yellow }
    foreach ($file in $releaseFiles) {
        Write-Host ('    {0,-48} {1,10}' -f $file.Name, (Format-BuildSize $file.Length))
    }
    Write-Host '  Pruebas:'
    if ($script:BuildTests.Count -eq 0) { Write-Host '    (no se ejecutó ninguna)' -ForegroundColor Yellow }
    foreach ($test in $script:BuildTests) {
        $color = switch -Regex ($test.Result) { '^OK' { 'Green' } '^(FALLO|ERROR)' { 'Red' } default { 'Yellow' } }
        $detail = if ($test.Detail) { " — $($test.Detail)" } else { '' }
        Write-Host ('    [{0}] {1}{2}' -f $test.Result, $test.Name, $detail) -ForegroundColor $color
    }
    if ($evidenceRoots.Count -gt 0) {
        Write-Host '  Evidencias:'
        foreach ($root in $evidenceRoots) { Write-Host "    Carpeta: $root" }
        Write-Host "    Informes E2E ($($reports.Count)):"
        foreach ($item in $reports) { Write-Host "      $($item.FullName)" }
        Write-Host "    Vídeos ($($videos.Count)):"
        foreach ($item in $videos) { Write-Host ('      {0} ({1})' -f $item.FullName, (Format-BuildSize $item.Length)) }
        $captureFolders = @($screenshots | ForEach-Object { $_.DirectoryName } | Sort-Object -Unique)
        Write-Host "    Capturas: $($screenshots.Count) en $($captureFolders.Count) carpetas"
        foreach ($folder in $captureFolders) { Write-Host "      $folder" }
        Write-Host "    Logs ($($logs.Count)):"
        foreach ($item in $logs) { Write-Host "      $($item.FullName)" }
    }
    $totalSeconds = ([DateTime]::UtcNow - $script:BuildStartedAt).TotalSeconds
    Write-Host ("  Tiempo total: {0:N1} s" -f $totalSeconds) -ForegroundColor DarkGray
}

# Windows PowerShell 5.1 necesita el BOM del propio archivo para leer bien sus
# literales UTF-8 y, además, una codificación de consola explícita para no
# convertir en «ó/á» la salida UTF-8 de Node, Cargo y las herramientas.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try {
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
} catch {
    # Un host sin consola puede rechazar InputEncoding; no afecta a la build.
}

function Write-Step ($Message) {
    if ($null -ne $script:StepStartedAt) {
        $elapsed = ([DateTime]::UtcNow - $script:StepStartedAt).TotalSeconds
        if ($elapsed -ge 0.1) {
            Write-Host ("    Tiempo del paso anterior: {0:N1} s" -f $elapsed) -ForegroundColor DarkGray
        }
    }
    $script:StepStartedAt = [DateTime]::UtcNow
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}
function Write-Ok   ($Message) { Write-Host "    OK: $Message" -ForegroundColor Green }
function Write-Warn ($Message) { Write-Host "    AVISO: $Message" -ForegroundColor Yellow }
function Write-Err  ($Message) { Write-Host "    ERROR: $Message" -ForegroundColor Red }

function Get-Sha256Hash {
    param([Parameter(Mandatory = $true)][string]$Path)

    # `Get-FileHash` vive en Microsoft.PowerShell.Utility y algunos hosts
    # mínimos no cargan ese módulo aunque sí puedan ejecutar el resto de la
    # build. La implementación .NET está disponible desde PowerShell 5 y
    # evita que una release ya compilada falle solo al generar SHA256SUMS.
    $stream = [IO.File]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Read-BuildChoice {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [Parameter(Mandatory = $true)][bool]$Default
    )
    $hint = if ($Default) { 'S/n' } else { 's/N' }
    while ($true) {
        $answer = Read-Host "$Prompt [$hint]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
        switch ($answer.Trim().ToLowerInvariant()) {
            { $_ -in @('s', 'si', 'sí', 'y', 'yes') } { return $true }
            { $_ -in @('n', 'no') } { return $false }
            default { Write-Warn 'Responde s/sí o n/no; Enter conserva el valor predeterminado.' }
        }
    }
}

# Una ejecución interactiva ofrece una configuración cómoda antes de tocar
# dependencias o empezar a compilar. La versión se solicita siempre en este
# punto cuando falta, incluso si se han pasado otros flags; -NonInteractive,
# CI o una entrada redirigida desactivan cualquier diálogo.
$hasExplicitBuildOptions = @($PSBoundParameters.Keys | Where-Object { $_ -ne 'Help' }).Count -gt 0
$isCiEnvironment = $env:CI -match '^(1|true|yes)$'
$interactiveBuild = -not $NonInteractive.IsPresent -and
    -not $hasExplicitBuildOptions -and
    -not $isCiEnvironment -and
    [Environment]::UserInteractive -and
    -not [Console]::IsInputRedirected
$canPromptVersion = -not $NonInteractive.IsPresent -and
    -not $isCiEnvironment -and
    [Environment]::UserInteractive -and
    -not [Console]::IsInputRedirected
$packageJsonForPrompt = Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
$currentVersionForPrompt = [string]$packageJsonForPrompt.version
$printedBuildConfigHeader = $false
if ([string]::IsNullOrWhiteSpace($Version)) {
    if ($canPromptVersion) {
        if ($interactiveBuild) {
            Write-Host ''
            Write-Host 'Configuración de build (Enter conserva el valor actual):' -ForegroundColor Cyan
            $printedBuildConfigHeader = $true
        }
        $enteredVersion = Read-Host "Versión de release [$currentVersionForPrompt]"
        $Version = if ([string]::IsNullOrWhiteSpace($enteredVersion)) { $currentVersionForPrompt } else { $enteredVersion.Trim() }
    } else {
        $Version = $currentVersionForPrompt
    }
}
if ($interactiveBuild) {
    if (-not $printedBuildConfigHeader) {
        Write-Host ''
        Write-Host 'Configuración de build (Enter conserva el valor actual):' -ForegroundColor Cyan
    }
    Write-Host "  Versión seleccionada: $Version" -ForegroundColor DarkGray
    $Clean = Read-BuildChoice 'Limpiar dependencias y target antes de compilar' $Clean
    $Fast = Read-BuildChoice 'Usar perfil rápido de desarrollo' $Fast
    $Installer = [switch]::new((Read-BuildChoice 'Generar también instalador NSIS offline' $Installer.IsPresent))
    $SkipChecks = Read-BuildChoice 'Saltar comprobaciones locales' $SkipChecks
    $AllowOfflineChecks = Read-BuildChoice 'Convertir comprobaciones externas en avisos' $AllowOfflineChecks
    if (-not $FullTests.IsPresent -and -not $StrictTests.IsPresent) {
        $runExtendedTests = Read-BuildChoice 'Ejecutar pruebas ampliadas y E2E' (-not $NoExtendedTests.IsPresent)
        $NoExtendedTests = [switch](-not $runExtendedTests)
        if ($runExtendedTests) {
            $StrictTests = [switch](Read-BuildChoice 'Fallarlas si faltan herramientas opcionales (modo estricto)' $false)
        }
    }
    if (-not $NoExtendedTests.IsPresent) {
        if (Read-BuildChoice 'Validación completa de release: vídeo, descargas reales, auditoría del catálogo e instalador (pide UAC)' $ReleaseValidation.IsPresent) {
            $ReleaseValidation = [switch]::new($true)
            $FullTests = [switch]::new($true)
            $VideoTest = [switch]::new($true)
            $DownloadTests = [switch]::new($true)
            $DependencyAudit = [switch]::new($true)
            $InstallerTest = [switch]::new($true)
            if (-not $Installer.IsPresent) {
                $Installer = [switch]::new($true)
                Write-Host '  La validación completa prueba el instalador: se generará también.' -ForegroundColor DarkGray
            }
        }
    }
    $CrossLinux = Read-BuildChoice 'Ejecutar también la build Linux mediante WSL' $CrossLinux
    $NoRun = [switch](-not (Read-BuildChoice 'Lanzar la aplicación al terminar' (-not $NoRun)))
    Write-Host '  Opciones seleccionadas. La build comenzará ahora.' -ForegroundColor DarkGray
}

$semverPattern = '^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
if ($Version -notmatch $semverPattern) {
    throw "La versión indicada no es SemVer válida: $Version"
}

# Ejecuta un comando nativo y devuelve SOLO su codigo de salida.
#
# Windows PowerShell 5.1 convierte en error TERMINANTE cada linea que un comando
# nativo escribe en stderr cuando ErrorActionPreference vale 'Stop'. npm y cargo
# usan stderr para sus avisos y su progreso, asi que un "npm warn deprecated" o
# el propio "Compiling ..." de cargo abortaban el script a medias. La solucion
# de siempre con comandos nativos: bajar la preferencia mientras corren y
# decidir por $LASTEXITCODE, que es lo unico que indica de verdad si ha fallado.
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$CaptureOutput
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Get-Command también puede resolver alias de ejecución de WindowsApps
        # cuyo paquete real ya no existe. Invocarlos produce una excepción
        # ResourceUnavailable antes de asignar LASTEXITCODE. Se convierte en
        # el 9009 convencional de «comando no encontrado» para que la batería
        # lo clasifique como ausente y continúe hasta el E2E.
        # No inicializar $LASTEXITCODE dentro de esta función: PowerShell crea
        # una variable local que oculta el valor real actualizado por el EXE y
        # convertiría cualquier fallo nativo (incluido WSL/E2E) en código 0.
        try {
            $script:LastNativeOutput = ''
            if ($CaptureOutput) {
                # PowerShell 5.1 convierte cada línea de stderr de un proceso
                # nativo en NativeCommandError. Eso es especialmente visible
                # con `java -version`, que escribe deliberadamente toda su
                # versión en stderr aunque termine con código 0. Redirigir a
                # un archivo evita que el texto de diagnóstico se trate como
                # una excepción; el resultado sigue validándose por el código
                # de salida, que es la señal fiable de éxito.
                $stderrPath = [IO.Path]::GetTempFileName()
                $isJavaProbe = [IO.Path]::GetFileNameWithoutExtension($Command) -ieq 'java'
                if ($isJavaProbe) {
                    $stdoutPath = [IO.Path]::GetTempFileName()
                    try {
                        # ProcessStartInfo evita el NativeCommandError falso y
                        # no toca el diccionario de entorno (Start-Process
                        # falla con hosts que exponen PATH/path con distinta caja).
                        $processInfo = New-Object System.Diagnostics.ProcessStartInfo
                        $processInfo.FileName = $Command
                        $processInfo.Arguments = ($Arguments -join ' ')
                        $processInfo.UseShellExecute = $false
                        $processInfo.CreateNoWindow = $true
                        $processInfo.RedirectStandardOutput = $true
                        $processInfo.RedirectStandardError = $true
                        $process = New-Object System.Diagnostics.Process
                        $process.StartInfo = $processInfo
                        [void]$process.Start()
                        $stdoutText = $process.StandardOutput.ReadToEnd()
                        $stderrOutput = $process.StandardError.ReadToEnd()
                        $process.WaitForExit()
                        $exitCode = [int]$process.ExitCode
                        $process.Dispose()
                        [IO.File]::WriteAllText($stdoutPath, $stdoutText)
                        [IO.File]::WriteAllText($stderrPath, $stderrOutput)
                        $script:LastNativeOutput = ($stdoutText, [string]$stderrOutput) -join "`n"
                        if (-not [string]::IsNullOrWhiteSpace($stdoutText)) { $stdoutText.TrimEnd() | Out-Host }
                        if (-not [string]::IsNullOrWhiteSpace($stderrOutput)) { $stderrOutput.TrimEnd() | Out-Host }
                        return $exitCode
                    } finally {
                        Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
                    }
                }
                try {
                    $nativeOutput = @(& $Command @Arguments 2> $stderrPath)
                    $exitCode = [int]$LASTEXITCODE
                    $stderrOutput = if (Test-Path -LiteralPath $stderrPath) {
                        Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
                    } else {
                        ''
                    }
                    $stdoutText = ($nativeOutput | ForEach-Object { [string]$_ }) -join "`n"
                    $script:LastNativeOutput = ($stdoutText, [string]$stderrOutput) -join "`n"
                    if (-not [string]::IsNullOrWhiteSpace($stdoutText)) { $stdoutText | Out-Host }
                    if (-not [string]::IsNullOrWhiteSpace($stderrOutput)) { $stderrOutput.TrimEnd() | Out-Host }
                    return $exitCode
                } finally {
                    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
                }
            }
            # Algunos comandos (Tauri incluido) escriben información normal en
            # stderr. Windows PowerShell 5.1 convierte ese flujo en
            # NativeCommandError incluso al redirigirlo a una tubería. Guardar
            # stderr en un temporal y mostrarlo después evita el falso error;
            # el código de salida sigue siendo la única señal de fallo.
            $stderrPath = [IO.Path]::GetTempFileName()
            try {
                $nativeOutput = @(& $Command @Arguments 2> $stderrPath)
                $exitCode = [int]$LASTEXITCODE
                if ($nativeOutput.Count -gt 0) { $nativeOutput | Out-Host }
                if (Test-Path -LiteralPath $stderrPath) {
                    $stderrOutput = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
                    if (-not [string]::IsNullOrWhiteSpace($stderrOutput)) { $stderrOutput.TrimEnd() | Out-Host }
                }
                return $exitCode
            } finally {
                Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
            }
        } catch {
            Write-Host ("    No se pudo iniciar {0}: {1}" -f $Command, $_.Exception.Message) -ForegroundColor DarkGray
            return 9009
        }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Assert-E2eReport {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )
    if (-not (Test-Path $Path -PathType Leaf)) {
        throw "El E2E terminó sin generar informe: $Path"
    }
    try {
        $report = Get-Content $Path -Raw -ErrorAction Stop | ConvertFrom-Json
    } catch {
        throw "El informe E2E no es JSON válido: $Path ($_)"
    }
    if ($report.status -ne 'passed') {
        $detail = if ($report.error) { [string]$report.error } else { 'sin detalle de error' }
        throw "El E2E no terminó correctamente: estado '$($report.status)' ($detail). Informe: $Path"
    }
    if ($report.logValidated -ne $true) {
        throw "El E2E no validó el log de la ejecución actual. Informe: $Path"
    }
    $phases = @($report.phases)
    $events = @($report.events)
    if ($phases.Count -lt 11 -or $events.Count -lt 11) {
        throw "El E2E terminó sin una batería observable: fases=$($phases.Count), eventos=$($events.Count). Informe: $Path"
    }
}

function Show-SmokeDiagnostics {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Token
    )
    Write-Err "El smoke no confirmó el arranque completo. Log de esta ejecución: $Path"
    if (-not (Test-Path $Path -PathType Leaf)) {
        Write-Err 'No se creó main.log: el proceso pudo fallar antes de inicializar Rust/WebView2, o APPDATA no es escribible.'
        return
    }
    $text = (Get-Content $Path -Tail 300 -ErrorAction SilentlyContinue) -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($Token)) {
        $tokenLine = $text -split "`r?`n" |
            Where-Object { $_ -match [regex]::Escape($Token) } |
            Select-Object -First 1
        $sessionMatch = if ($tokenLine) {
            [regex]::Match($tokenLine, '^\[[^\]]+\] \[([^\]]+)\] ')
        }
        if ($sessionMatch -and $sessionMatch.Success) {
            $session = [regex]::Escape($sessionMatch.Groups[1].Value)
            $text = ($text -split "`r?`n" |
                Where-Object { $_ -match "\[$session\]" }) -join "`n"
        }
    }
    $markers = @(
        @{ Name = 'ARRANQUE'; Pattern = 'ARRANQUE' },
        @{ Name = 'Ventana inicial'; Pattern = 'Ventana inicial preparada' },
        @{ Name = 'PTY preparado'; Pattern = 'Preparando pty' },
        @{ Name = 'PTY creado'; Pattern = 'pty spawneado' },
        @{ Name = 'Error de PTY'; Pattern = 'No se pudo spawnear el pty|Falló la creación del PTY|El PTY sigue sin responder al límite de arranque' },
        @{ Name = 'Frontend'; Pattern = 'Frontend y terminal preparados' }
    )
    foreach ($marker in $markers) {
        $state = if ($text -match $marker.Pattern) { 'sí' } else { 'no' }
        Write-Host "      $($marker.Name): $state" -ForegroundColor DarkGray
    }
    if ($text -match '0xC0000142|STATUS_DLL_INIT_FAILED|DLL_INIT_FAILED') {
        Write-Err 'El log contiene STATUS_DLL_INIT_FAILED (0xC0000142): el fallo está en la inicialización de una DLL/proceso hijo, no en la batería WebDriver.'
        Write-Err 'Comprueba especialmente conpty.dll/OpenConsole.exe, WebView2Loader.dll y el cmd.exe del sistema.'
    } elseif ($text -match 'No se pudo spawnear el pty|Falló la creación del PTY|El PTY sigue sin responder al límite de arranque') {
        Write-Err 'La ventana sí llegó a iniciar, pero la primera shell no consiguió crear un PTY; por eso el E2E no se lanza.'
    } elseif ($text -notmatch 'Ventana inicial preparada') {
        Write-Err 'No se confirmó la ventana inicial; el fallo está antes del frontend (normalmente WebView2 o el ejecutable).'
    } else {
        Write-Err 'La ventana está viva, pero no confirmó frontend + PTY dentro del tiempo permitido.'
    }
    Write-Host '      Últimas líneas del log:' -ForegroundColor DarkGray
    Get-Content $Path -Tail 80 -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "        $_" -ForegroundColor DarkGray
    }
}

function Test-SmokeReady {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Token
    )
    if (-not (Test-Path $Path -PathType Leaf)) {
        return $false
    }
    $text = (Get-Content $Path -Tail 300 -ErrorAction SilentlyContinue) -join "`n"
    $tokenLine = $text -split "`r?`n" |
        Where-Object { $_ -match [regex]::Escape($Token) } |
        Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($tokenLine)) {
        return $false
    }
    $sessionMatch = [regex]::Match($tokenLine, '^\[[^\]]+\] \[([^\]]+)\] ')
    if (-not $sessionMatch.Success) {
        return $false
    }
    $session = [regex]::Escape($sessionMatch.Groups[1].Value)
    $current = ($text -split "`r?`n" |
        Where-Object { $_ -match "\[$session\]" }) -join "`n"
    # Solo el hito de éxito de ESTA sesión prueba frontend + xterm + PTY real.
    # Una espera transitoria por ConPTY no se registra como error.
    return $current -match 'Frontend y terminal preparados'
}

function Test-Command ($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-ProbeExecutable {
    param([Parameter(Mandatory = $true)][hashtable]$Probe)

    # Algunas aplicaciones Windows no añaden su ejecutable al PATH aunque
    # estén instaladas. La batería usa las mismas rutas conocidas que la
    # interfaz para evitar falsos avisos de herramienta ausente.
    if (Test-Command $Probe.Exe) {
        $command = Get-Command $Probe.Exe -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($command) { return [string]$command.Source }
        return [string]$Probe.Exe
    }
    $patterns = switch ($Probe.Name) {
        'MariaDB' { @('C:\Program Files\MariaDB*\bin\mariadb.exe', 'C:\Program Files (x86)\MariaDB*\bin\mariadb.exe') }
        'MySQL' { @('C:\Program Files\MySQL\MySQL Server*\bin\mysql.exe', 'C:\Program Files (x86)\MySQL\MySQL Server*\bin\mysql.exe') }
        'PostgreSQL' { @('C:\Program Files\PostgreSQL\*\bin\psql.exe', 'C:\Program Files (x86)\PostgreSQL\*\bin\psql.exe') }
        'Julia' { @((Join-Path $env:LOCALAPPDATA 'Programs\Julia-*\bin\julia.exe'), 'C:\Julia*\bin\julia.exe', 'C:\Program Files\Julia*\bin\julia.exe') }
        'R' { @('C:\Program Files\R\R-*\bin\x64\R.exe', 'C:\Program Files\R\R-*\bin\R.exe', 'C:\Program Files (x86)\R\R-*\bin\R.exe') }
        'OpenVPN' { @('C:\Program Files\OpenVPN\bin\openvpn.exe', 'C:\Program Files (x86)\OpenVPN\bin\openvpn.exe') }
        'QEMU' { @('C:\Program Files\qemu\qemu-system-x86_64.exe', 'C:\Program Files\QEMU\qemu-system-x86_64.exe') }
        'VirtualBox' { @('C:\Program Files\Oracle\VirtualBox\VBoxManage.exe', 'C:\Program Files (x86)\Oracle\VirtualBox\VBoxManage.exe') }
        'NSudo' { @('C:\WSCore\Components\Hooks\NSudo\NSudoLC.exe') }
        default { @() }
    }
    foreach ($pattern in $patterns) {
        $candidate = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($candidate) { return [string]$candidate.FullName }
    }
    return $null
}

function Initialize-NpmCompatibilityShim {
    # El ejecutor del proyecto usa `npm` tanto aquí como en beforeBuildCommand
    # de Tauri. En equipos de desarrollo con pnpm pero sin npm, ofrecer la
    # compatibilidad mínima que necesita este repo evita fallar antes de
    # compilar. Si npm está instalado no se cambia la ruta normal de release.
    if (Test-Command 'npm') { return }
    $pnpm = Get-Command 'pnpm.cmd' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $pnpm) {
        $pnpm = Get-Command 'pnpm' -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if (-not $pnpm -or -not (Test-Path -LiteralPath $pnpm.Source -PathType Leaf)) { return }

    New-Item -ItemType Directory -Force -Path $script:BuildTempDir | Out-Null
    $shimPath = Join-Path $script:BuildTempDir 'npm.cmd'
    $pnpmPath = $pnpm.Source.Replace('%', '%%')
    $shim = @(
        '@echo off',
        'setlocal',
        'set PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false',
        'if /I "%~1"=="ci" goto install',
        'if /I "%~1"=="install" goto install',
        ('call "{0}" --config.verifyDepsBeforeRun=false %*' -f $pnpmPath),
        'exit /b %ERRORLEVEL%',
        ':install',
        'set CI=true',
        ('call "{0}" --config.verifyDepsBeforeRun=false install --lockfile=false' -f $pnpmPath),
        'exit /b %ERRORLEVEL%'
    )
    [IO.File]::WriteAllLines($shimPath, $shim, [Text.Encoding]::ASCII)
    $env:Path = "$script:BuildTempDir;$env:Path"
    $script:UsingPnpmNpmShim = $true
    Write-Warn 'npm no está instalado; se usará pnpm para los comandos de build del proyecto.'
}

Initialize-NpmCompatibilityShim

function Get-WebView2RuntimeVersion {
    # Microsoft documenta estas claves como la fuente canónica para detectar
    # Evergreen WebView2. No se consulta Edge: una aplicación WebView2 no
    # necesita que el navegador completo esté instalado.
    $clientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $registryKeys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientId",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientId",
        "HKCU:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientId",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientId"
    )
    foreach ($key in $registryKeys) {
        try {
            $version = [string](Get-ItemProperty -LiteralPath $key -Name 'pv' -ErrorAction Stop).pv
            if ($version -match '^\d+\.\d+\.\d+\.\d+$' -and $version -ne '0.0.0.0') {
                return $version
            }
        } catch {
            # La instalación puede ser por usuario, por máquina, x86 o x64.
        }
    }
    return $null
}

function Get-MsEdgeDriverVersion {
    param([Parameter(Mandatory = $true)][string]$Path)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        try {
            $output = @(& $Path '--version' 2>&1)
            $code = [int]$LASTEXITCODE
        } catch {
            return $null
        }
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { return $null }
    $match = [regex]::Match(($output | Out-String), '\b(\d+\.\d+\.\d+\.\d+)\b')
    if ($match.Success) { return $match.Groups[1].Value }
    return $null
}

function Get-VersionBuild {
    param([string]$Version)
    if ([string]::IsNullOrWhiteSpace($Version)) { return $null }
    $parts = $Version.Split('.')
    if ($parts.Count -lt 3) { return $null }
    return "$($parts[0]).$($parts[1]).$($parts[2])"
}

function Test-MsEdgeDriverCompatibility {
    param(
        [string]$DriverVersion,
        [string]$RuntimeVersion
    )
    $driverBuild = Get-VersionBuild $DriverVersion
    $runtimeBuild = Get-VersionBuild $RuntimeVersion
    return -not [string]::IsNullOrWhiteSpace($driverBuild) -and $driverBuild -eq $runtimeBuild
}

function Ensure-MsEdgeDriver {
    $runtimeVersion = Get-WebView2RuntimeVersion
    $explicitDriver = [string]$env:TAURI_NATIVE_DRIVER

    if (-not [string]::IsNullOrWhiteSpace($explicitDriver)) {
        if (-not (Test-Path -LiteralPath $explicitDriver -PathType Leaf)) {
            throw "TAURI_NATIVE_DRIVER no apunta a un archivo: $explicitDriver"
        }
        $resolvedDriver = (Resolve-Path -LiteralPath $explicitDriver).Path
        $driverVersion = Get-MsEdgeDriverVersion $resolvedDriver
        if ([string]::IsNullOrWhiteSpace($driverVersion)) {
            throw "El driver indicado en TAURI_NATIVE_DRIVER no responde a --version: $resolvedDriver"
        }
        if (-not [string]::IsNullOrWhiteSpace($runtimeVersion) -and
            -not (Test-MsEdgeDriverCompatibility $driverVersion $runtimeVersion)) {
            throw "TAURI_NATIVE_DRIVER es $driverVersion, pero WebView2 Runtime es $runtimeVersion. Sus tres primeros componentes deben coincidir para E2E."
        }
        Write-Ok "Edge WebDriver explícito ${driverVersion}: $resolvedDriver"
        return $resolvedDriver
    }

    $pathDriver = Get-Command 'msedgedriver.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $pathDriver -and (Test-Path -LiteralPath $pathDriver.Source -PathType Leaf)) {
        $pathVersion = Get-MsEdgeDriverVersion $pathDriver.Source
        if ([string]::IsNullOrWhiteSpace($runtimeVersion) -or
            (Test-MsEdgeDriverCompatibility $pathVersion $runtimeVersion)) {
            Write-Ok "Edge WebDriver $pathVersion disponible en PATH"
            return $pathDriver.Source
        }
        Write-Warn "msedgedriver.exe de PATH es $pathVersion, pero WebView2 Runtime es $runtimeVersion; se preparará el compatible."
    }

    if ([string]::IsNullOrWhiteSpace($runtimeVersion)) {
        throw 'E2E necesita WebView2 Runtime y un Edge WebDriver compatible. No se encontró el runtime registrado; instala WebView2 o define TAURI_NATIVE_DRIVER.'
    }

    $architecture = if ($env:PROCESSOR_ARCHITEW6432) {
        [string]$env:PROCESSOR_ARCHITEW6432
    } else {
        [string]$env:PROCESSOR_ARCHITECTURE
    }
    $driverPlatform = switch ($architecture.ToUpperInvariant()) {
        'AMD64' { 'win64' }
        'ARM64' { 'arm64' }
        'X86' { 'win32' }
        default { throw "Arquitectura Windows no compatible con Edge WebDriver: $architecture" }
    }
    $runtimeBuild = Get-VersionBuild $runtimeVersion
    $driverDir = Join-Path $TauriDir "target\e2e-driver\$runtimeBuild"
    $driverPath = Join-Path $driverDir 'msedgedriver.exe'
    if (Test-Path -LiteralPath $driverPath -PathType Leaf) {
        $cachedVersion = Get-MsEdgeDriverVersion $driverPath
        if (Test-MsEdgeDriverCompatibility $cachedVersion $runtimeVersion) {
            Write-Ok "Edge WebDriver $cachedVersion recuperado de la caché de build"
            return $driverPath
        }
        Remove-Item -LiteralPath $driverPath -Force
    }

    New-Item -ItemType Directory -Force -Path $driverDir | Out-Null
    $archivePath = Join-Path $driverDir 'edgedriver.zip'
    $releasePath = Join-Path $driverDir 'LATEST_RELEASE'
    $runtimeMajor = $runtimeBuild.Split('.')[0]
    $releaseUrl = "https://msedgedriver.microsoft.com/LATEST_RELEASE_${runtimeMajor}_WINDOWS"
    Write-Warn "Falta Edge WebDriver compatible con WebView2 $runtimeVersion; se descargará sin instalar Microsoft Edge."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $releaseUrl -OutFile $releasePath -UseBasicParsing
        $driverVersion = (Get-Content -LiteralPath $releasePath -Raw).Trim().Trim([char]0xFEFF)
        if (-not (Test-MsEdgeDriverCompatibility $driverVersion $runtimeVersion)) {
            throw "Microsoft devolvió Edge WebDriver $driverVersion para WebView2 $runtimeVersion."
        }
        $driverUrl = "https://msedgedriver.microsoft.com/$driverVersion/edgedriver_$driverPlatform.zip"
        Invoke-WebRequest -Uri $driverUrl -OutFile $archivePath -UseBasicParsing
        Expand-Archive -LiteralPath $archivePath -DestinationPath $driverDir -Force
    } catch {
        throw "No se pudo preparar Edge WebDriver para WebView2 $runtimeVersion. Conecta el equipo a Internet o define TAURI_NATIVE_DRIVER. $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $releasePath -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $driverPath -PathType Leaf)) {
        throw "El paquete de Edge WebDriver no contenía msedgedriver.exe: $driverUrl"
    }
    $downloadedVersion = Get-MsEdgeDriverVersion $driverPath
    if (-not (Test-MsEdgeDriverCompatibility $downloadedVersion $runtimeVersion)) {
        throw "Se descargó Edge WebDriver $downloadedVersion, pero WebView2 Runtime es $runtimeVersion."
    }
    Write-Ok "Edge WebDriver $downloadedVersion preparado para WebView2 sin instalar Microsoft Edge"
    return $driverPath
}

function Get-WslDistros {
    if (-not (Test-Command 'wsl.exe')) { return @() }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& wsl.exe --list --quiet 2>$null)
    } finally {
        $ErrorActionPreference = $previous
    }
    return @($lines |
        # Windows PowerShell 5.1 recibe `wsl --list` como UTF-16 cuando la
        # consola está configurada así y deja un NUL entre cada carácter. Si
        # no se eliminan, `--distribution` recibe «U`0b`0u…» y WSL informa
        # engañosamente que la distribución no existe.
        ForEach-Object { (([string]$_).Split([char]0) -join '').Trim() } |
        Where-Object { $_ -and $_ -notmatch '^(Windows Subsystem|NAME|DISTRIBUTION)' } |
        ForEach-Object { $_ -replace '^\*\s*', '' })
}

function Ensure-Wsl {
    if (-not (Test-Command 'wsl.exe')) {
        if (-not (Test-Command 'winget')) {
            throw 'No se encontró WSL ni winget. Instala WSL desde https://learn.microsoft.com/windows/wsl/install.'
        }
        Write-Step 'Instalando WSL mediante winget'
        $wslCode = Invoke-Native 'winget' @(
            'install', '--id', 'Microsoft.WSL', '--exact', '--source', 'winget',
            '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'
        )
        Refresh-EnvironmentPath
        if ($wslCode -ne 0 -or -not (Test-Command 'wsl.exe')) {
            throw 'No se pudo instalar WSL automáticamente con winget.'
        }
    }

    $distros = @(Get-WslDistros)
    if ($distros.Count -eq 0) {
        Write-Step 'Instalando una distribución Ubuntu para las pruebas Linux'
        $installCode = Invoke-Native 'wsl.exe' @('--install', '--distribution', 'Ubuntu', '--no-launch')
        if ($installCode -ne 0) {
            throw 'WSL está disponible, pero no se pudo instalar Ubuntu automáticamente.'
        }
        Start-Sleep -Seconds 2
        $distros = @(Get-WslDistros)
    }
    if ($distros.Count -eq 0) {
        throw 'Ubuntu para WSL quedó pendiente de instalación. Reinicia Windows y reintenta con -CrossLinux.'
    }
    return [string]$distros[0]
}

function Invoke-CrossLinuxTests {
    $distro = Ensure-Wsl
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $wslRoot = ((& wsl.exe '--distribution' $distro '--' 'wslpath' '-a' $ProjectRoot 2>$null) -join '').Trim()
        $pathCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($pathCode -ne 0 -or [string]::IsNullOrWhiteSpace($wslRoot)) {
        # Windows PowerShell 5.1 puede separar en varios argumentos una ruta
        # con espacios al invocar un binario nativo (wslpath). El proyecto
        # está en una unidad Windows y WSL monta esas unidades en /mnt/<letra>
        # por contrato; usar esa conversión determinista evita que una
        # limitación del parser de argumentos impida toda la build.
        $windowsPath = [string]$ProjectRoot
        if ($windowsPath -match '^(?<drive>[A-Za-z]):[\\/](?<rest>.*)$') {
            $wslRoot = "/mnt/$($Matches.drive.ToLowerInvariant())/$($Matches.rest -replace '\\','/')"
            $wslRoot = $wslRoot.TrimEnd('/')
            Write-Warn "wslpath no aceptó la ruta con espacios; usando conversión estándar $wslRoot"
        } else {
            throw "WSL no pudo convertir la ruta del proyecto Windows: $ProjectRoot"
        }
    }

    # WSLg expone DISPLAY/WAYLAND_DISPLAY; build.sh instala WebKitGTK, Node,
    # Rust, WebKitWebDriver y tauri-driver dentro de la distribución. El E2E
    # ejecuta la aplicación Linux real y --no-run evita dejarla abierta al
    # terminar las pruebas.
    $escapedRoot = $wslRoot.Replace("'", "'\''")
    $linuxFlags = ' --full-tests --install-e2e-driver --no-run --non-interactive'
    if ($Fast) { $linuxFlags += ' --fast' }
    if ($NoExtendedTests) { $linuxFlags += ' --no-extended-tests' }
    if ($SkipChecks) { $linuxFlags += ' --skip-checks' }
    if ($AllowOfflineChecks) { $linuxFlags += ' --allow-offline-checks' }
    $linuxCommand = "cd '$escapedRoot' && bash linux/build.sh$linuxFlags"
    Write-Step "Compilando y probando Linux dentro de WSL ($distro)"
    $code = Invoke-Native 'wsl.exe' @('--distribution', $distro, '--', 'bash', '-lc', $linuxCommand)
    if ($code -ne 0) {
        Add-PostBuildIssue "Las pruebas Linux en WSL fallaron (código $code). Comprueba WSLg y la distribución Ubuntu."
        return
    }
    Write-Ok 'AppImage Linux compilado y probado desde Windows mediante WSL'
}

# Tauri debe seguir usando --release para conservar sus rutas de salida y el
# empaquetado existente. Cargo permite cambiar los ajustes del perfil release
# por variables de entorno: -Fast acelera iteraciones sin duplicar la
# configuración Tauri ni dejar una carpeta target distinta que el empaquetador
# no sepa localizar.
function Set-CargoBuildProfile {
    if ($Fast) {
        $env:CARGO_PROFILE_RELEASE_OPT_LEVEL = '1'
        $env:CARGO_PROFILE_RELEASE_LTO = 'false'
        $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '256'
        $env:CARGO_PROFILE_RELEASE_STRIP = 'none'
        $env:CARGO_PROFILE_RELEASE_DEBUG = '1'
        $env:CARGO_PROFILE_RELEASE_INCREMENTAL = 'true'
        $env:CARGO_PROFILE_RELEASE_PANIC = 'unwind'
        Write-Ok 'Perfil de desarrollo rápido: incremental, sin LTO y con símbolos de depuración'
    } else {
        $env:CARGO_PROFILE_RELEASE_OPT_LEVEL = 's'
        $env:CARGO_PROFILE_RELEASE_LTO = 'true'
        $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '1'
        $env:CARGO_PROFILE_RELEASE_STRIP = 'true'
        $env:CARGO_PROFILE_RELEASE_DEBUG = '0'
        $env:CARGO_PROFILE_RELEASE_INCREMENTAL = 'false'
        $env:CARGO_PROFILE_RELEASE_PANIC = 'abort'
        Write-Ok 'Perfil release comprimido: LTO completo, símbolos eliminados y optimización máxima'
    }
}

Set-CargoBuildProfile

# Las comprobaciones locales siguen siendo obligatorias. Este modo solo relaja
# las comprobaciones que dependen de red (enlaces, fuentes externas y WinGet), para que
# una caída temporal de DNS no se confunda con un fallo de compilación. Se deja
# en el entorno durante todo el proceso porque prebuild vuelve a ejecutar check.
if ($AllowOfflineChecks) {
    $env:LTERMINAL_LINK_CHECK = 'warn'
    $env:LTERMINAL_INSTALL_SOURCE_CHECK = 'warn'
    $env:LTERMINAL_WINGET_CHECK = 'warn'
    Write-Warn 'Comprobaciones externas en modo aviso: se mantienen svelte-check, clippy y las pruebas Rust.'
}

# ---------------------------------------------------------------------------
# 1. Requisitos
# ---------------------------------------------------------------------------
Write-Step 'Comprobando requisitos'

function Get-NodeVersion {
    if (-not (Test-Command 'node')) { return $null }
    try {
        $verStr = & node -p 'process.versions.node' 2>$null
        if ($verStr) { return [version]$verStr }
    } catch {}
    return $null
}

function Refresh-EnvironmentPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $existingPath = $env:Path

    $commonDirs = @(
        "${env:ProgramFiles}\nodejs",
        "${env:ProgramFiles(x86)}\nodejs",
        "$env:LocalAppData\Programs\node",
        "$env:USERPROFILE\.cargo\bin"
    )
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $pathEntries = [Collections.Generic.List[string]]::new()
    foreach ($entry in @($machinePath -split ';') + @($userPath -split ';') + @($existingPath -split ';') + $commonDirs) {
        $candidate = [string]$entry
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $candidate = $candidate.Trim().Trim('"')
            if ($seen.Add($candidate)) { $pathEntries.Add($candidate) }
        }
    }
    $env:Path = $pathEntries -join ';'
}

# Incluir los directorios habituales de Node y Rust sin eliminar las rutas que
# el host ya inyectó (por ejemplo, un runtime portátil de Node o pnpm).
Refresh-EnvironmentPath

$minNodeVersion = [version]'22.12.0'
$nodeFallbackVersion = '22.22.2'
$currentNodeVersion = Get-NodeVersion

if (-not $currentNodeVersion -or $currentNodeVersion -lt $minNodeVersion) {
    if (-not $currentNodeVersion) {
        Write-Warn 'No se encontro Node.js en el sistema.'
    } else {
        Write-Warn "Node.js $currentNodeVersion es inferior a la version requerida ($minNodeVersion)."
    }

    $installed = $false

    if (Test-Command 'winget') {
        Write-Step 'Instalando/actualizando Node.js (LTS) mediante winget...'
        $wingetCode = Invoke-Native 'winget' @(
            'install',
            '--id', 'OpenJS.NodeJS.LTS',
            '--exact',
            '--source', 'winget',
            '--accept-source-agreements',
            '--accept-package-agreements',
            '--disable-interactivity'
        )
        if ($wingetCode -ne 0) {
            $wingetCode = Invoke-Native 'winget' @(
                'upgrade',
                '--id', 'OpenJS.NodeJS.LTS',
                '--exact',
                '--source', 'winget',
                '--accept-source-agreements',
                '--accept-package-agreements',
                '--disable-interactivity'
            )
        }
        Refresh-EnvironmentPath
        $currentNodeVersion = Get-NodeVersion
        if ($currentNodeVersion -and $currentNodeVersion -ge $minNodeVersion) {
            Write-Ok "Node.js instalado correctamente mediante winget ($currentNodeVersion)"
            $installed = $true
        }
    }

    if (-not $installed) {
        Write-Step "Instalando Node.js (v$nodeFallbackVersion LTS) mediante descarga directa (MSI)..."
        try {
            $msiName = "node-v$nodeFallbackVersion-x64.msi"
            $msiUrl = "https://nodejs.org/dist/v$nodeFallbackVersion/$msiName"
            New-Item -ItemType Directory -Force -Path $script:BuildTempDir | Out-Null
            $msiPath = Join-Path $script:BuildTempDir $msiName
            Write-Host "    Descargando $msiUrl ..." -ForegroundColor Yellow
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing

            Write-Host '    Ejecutando instalador MSI de Node.js...' -ForegroundColor Yellow
            $msiCode = Invoke-Native 'msiexec.exe' @('/i', $msiPath, '/qn', '/norestart')
            Remove-Item $msiPath -Force -ErrorAction SilentlyContinue

            Refresh-EnvironmentPath
            $currentNodeVersion = Get-NodeVersion
            if ($currentNodeVersion -and $currentNodeVersion -ge $minNodeVersion) {
                Write-Ok "Node.js instalado correctamente mediante MSI ($currentNodeVersion)"
                $installed = $true
            }
        } catch {
            Write-Warn "Fallo la descarga o instalacion por MSI: $_"
        }
    }

    if (-not $installed) {
        throw "Falta Node.js (>= 22.12). Se intento la instalacion automatica pero no concluyo. Instalalo manualmente desde https://nodejs.org."
    }
} else {
    Write-Ok "Node.js $currentNodeVersion"
}

if (-not (Test-Command 'cargo')) {
    Write-Warn 'No se encontro el toolchain de Rust (cargo).'

    $rustInstalled = $false

    if (Test-Command 'winget') {
        Write-Step 'Instalando el toolchain de Rust mediante winget...'
        $wingetCode = Invoke-Native 'winget' @(
            'install',
            '--id', 'Rustlang.Rustup',
            '--exact',
            '--source', 'winget',
            '--accept-source-agreements',
            '--accept-package-agreements',
            '--disable-interactivity'
        )
        Refresh-EnvironmentPath
        if (Test-Command 'cargo') {
            $rustInstalled = $true
        }
    }

    if (-not $rustInstalled) {
        Write-Step 'Instalando Rust mediante descarga directa de rustup-init.exe...'
        try {
            $rustupUrl = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
            New-Item -ItemType Directory -Force -Path $script:BuildTempDir | Out-Null
            $rustupPath = Join-Path $script:BuildTempDir 'rustup-init.exe'
            Write-Host "    Descargando $rustupUrl ..." -ForegroundColor Yellow
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupPath -UseBasicParsing

            Write-Host '    Ejecutando rustup-init.exe (-y)...' -ForegroundColor Yellow
            $rustCode = Invoke-Native $rustupPath @('-y', '--default-toolchain', 'stable')
            Remove-Item $rustupPath -Force -ErrorAction SilentlyContinue

            Refresh-EnvironmentPath
            if (Test-Command 'cargo') {
                $rustInstalled = $true
            }
        } catch {
            Write-Warn "Fallo la descarga o instalacion de rustup: $_"
        }
    }

    if (-not (Test-Command 'cargo')) {
        throw 'Falta el toolchain de Rust. Se intento la instalacion automatica pero no concluyo. Instalalo manualmente desde https://rustup.rs y reabre la terminal.'
    }
}
$cargoVersion = (& cargo --version) -replace '^cargo\s+', ''
Write-Ok "cargo $cargoVersion"

function Get-VisualStudioInstallationPath {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
    ) | Where-Object { $_ -and (Test-Path $_ -PathType Leaf) }
    foreach ($vswhere in $candidates) {
        $path = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1)
        if ($path -and (Test-Path ([string]$path).Trim() -PathType Container)) {
            return ([string]$path).Trim()
        }
    }
    return $null
}

function Import-MSVCEnvironment {
    if ((Test-Command 'link.exe') -and (Test-Command 'cl.exe')) { return $true }
    $installation = Get-VisualStudioInstallationPath
    if ([string]::IsNullOrWhiteSpace($installation)) { return $false }
    $devCmd = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
    if (-not (Test-Path $devCmd -PathType Leaf)) { return $false }

    # Cargo no hereda el entorno de una instalación de Visual Studio solo por
    # existir vswhere.exe. Importamos la salida de VsDevCmd en este proceso para
    # que link.exe, cl.exe y el Windows SDK sean visibles aunque el usuario haya
    # lanzado la build desde PowerShell normal o haciendo doble clic.
    $commandLine = '"' + $devCmd + '" -arch=x64 -host_arch=x64 && set'
    # COMSPEC apunta al intérprete del Windows que está ejecutando la build.
    # Usarlo evita que un `cmd.exe` alternativo del PATH sea el que cargue
    # Visual Studio; el literal queda como respaldo para sesiones dañadas.
    $comSpec = if (-not [string]::IsNullOrWhiteSpace($env:ComSpec)) { $env:ComSpec } else { 'cmd.exe' }
    # VsDevCmd.bat invoca `vswhere.exe` sin ruta. Desde una consola sin la
    # carpeta del instalador en PATH, cmd escribe «no se reconoce» en stderr y
    # Windows PowerShell 5.1 lo convierte en error fatal con
    # ErrorActionPreference=Stop. Se añade el instalador al PATH solo para esta
    # llamada y se tolera su stderr: el código de salida decide.
    $installerDirectories = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'),
        (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer')
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'vswhere.exe') -PathType Leaf) }
    $pathBeforeDevCmd = $env:Path
    $errorPreferenceBeforeDevCmd = $ErrorActionPreference
    try {
        if ($installerDirectories) { $env:Path = (@($installerDirectories) + $env:Path) -join ';' }
        $ErrorActionPreference = 'Continue'
        $environmentLines = @(& $comSpec /d /s /c $commandLine 2>$null)
        $devCmdExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $errorPreferenceBeforeDevCmd
        $env:Path = $pathBeforeDevCmd
    }
    if ($devCmdExitCode -ne 0) { return $false }
    $previousPath = $env:Path
    $previousEnvironment = [Environment]::GetEnvironmentVariables('Process')
    # `set` separa por líneas los valores multilínea. No dejar que la salida de
    # VsDevCmd convierta una clave PEM Ed25519 en su primera línea: las claves
    # se conservan desde el entorno original y se pasan intactas a Node.
    $preservedMultilineEnvironment = @(
        'LTERMINAL_SIGNING_PRIVATE_KEY',
        'LTERMINAL_UPDATE_PUBLIC_KEY',
        'LTERMINAL_SSH_UPDATE_PUBLIC_KEY',
        'LTERMINAL_SSH_UPDATE_IDENTITY',
        'LTERMINAL_SSH_SIGNING_IDENTITY'
    )
    foreach ($line in $environmentLines) {
        if ([string]$line -match '^([^=]+)=(.*)$') {
            if ($matches[1] -in $preservedMultilineEnvironment) { continue }
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
    if ((Test-Command 'link.exe') -and (Test-Command 'cl.exe')) { return $true }

    # VsDevCmd puede existir en una instalación incompleta. No conservar un
    # PATH parcial que oculte cargo/rustc y haga fallar el fallback rust-lld.
    $currentEnvironment = [Environment]::GetEnvironmentVariables('Process')
    foreach ($name in @($currentEnvironment.Keys)) {
        if (-not $previousEnvironment.Contains($name)) {
            [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
        }
    }
    foreach ($name in @($previousEnvironment.Keys)) {
        [Environment]::SetEnvironmentVariable([string]$name, [string]$previousEnvironment[$name], 'Process')
    }
    # El snapshot del entorno puede traer las claves PATH/Path duplicadas en
    # PowerShell; restaurar la variable del provider garantiza conservar ambas
    # rutas inyectadas y las herramientas del usuario.
    $env:Path = $previousPath
    return $false
}

function Test-MSVCLinker {
    return Import-MSVCEnvironment
}

function Get-RustLldPath {
    # El toolchain MSVC de Rust incluye rust-lld.exe y Cargo puede usarlo como
    # fallback cuando no hay una instalación completa de Visual Studio. Esto
    # es especialmente útil en Windows recortados: exigir cl.exe aquí hacía
    # abortar la build antes de que Cargo pudiera enlazar correctamente.
    if (-not (Test-Command 'rustc')) { return $null }
    # PowerShell 5.1 transforma stderr de un proceso nativo en un
    # NativeCommandError cuando ErrorActionPreference es Stop. Algunas builds
    # de rustc emiten un aviso inocuo de canonicalización antes de devolver el
    # sysroot; se captura con la preferencia temporalmente relajada y se elige
    # la primera línea que parezca una ruta real.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $sysrootOutput = @(& rustc --print sysroot 2>&1)
    } finally {
        $ErrorActionPreference = $previous
    }
    $sysroot = $sysrootOutput |
        ForEach-Object { [string]$_ } |
        Where-Object { $_ -match '^[A-Za-z]:\\|^/' } |
        Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace([string]$sysroot)) { return $null }
    $candidate = Join-Path ([string]$sysroot).Trim() 'lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe'
    if (Test-Path $candidate -PathType Leaf) { return $candidate }
    return $null
}

function Test-MSVCImportLibraries {
    # rust-lld solo sustituye a link.exe: sigue necesitando las bibliotecas de
    # importación del Windows SDK (kernel32.lib) y del CRT de MSVC (msvcrt.lib).
    # En un Windows sin Visual Studio ni SDK no existen y el enlace fallaría
    # dentro de Cargo; en ese caso hay que instalar las Build Tools.
    $directories = @(([string]$env:LIB) -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($library in @('kernel32.lib', 'msvcrt.lib')) {
        $found = $directories | Where-Object { Test-Path (Join-Path $_ $library) -PathType Leaf } | Select-Object -First 1
        if (-not $found) { return $false }
    }
    return $true
}

function Test-WindowsLinker {
    if (Test-MSVCLinker) { return 'msvc' }
    if ((Get-RustLldPath) -and (Test-MSVCImportLibraries)) { return 'rust-lld' }
    return $null
}

function Use-RustLldLinker {
    # Cargo usa link.exe por defecto en el target MSVC aunque no exista. Se
    # exporta rust-lld para este proceso y sus hijos (npm, cargo test, tauri).
    $rustLld = Get-RustLldPath
    if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER)) {
        $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $rustLld
    }
    return $rustLld
}

if (-not (Test-WindowsLinker)) {
    Write-Warn 'No se encontro el compilador/enlazador de C++ (link.exe / Visual Studio Build Tools).'
    if (Test-Command 'winget') {
        Write-Step 'Instalando Visual Studio 2022 Build Tools (C++) mediante winget...'
        $wingetCode = Invoke-Native 'winget' @(
            'install',
            '--id', 'Microsoft.VisualStudio.2022.BuildTools',
            '--exact',
            '--source', 'winget',
            '--override', '--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended',
            '--accept-source-agreements',
            '--accept-package-agreements',
            '--disable-interactivity'
        )
        # Esperar si el instalador de Visual Studio esta ejecutandose en segundo plano
        $vsSetup = Get-Process -Name 'setup' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Microsoft Visual Studio*' }
        if ($vsSetup) {
            Write-Host '    Esperando a que finalice la instalacion de Visual Studio Build Tools...' -ForegroundColor Yellow
            $vsSetup | Wait-Process -Timeout 600 -ErrorAction SilentlyContinue
        }

        Refresh-EnvironmentPath
        $detectedLinker = Test-WindowsLinker
        if ($detectedLinker -eq 'msvc') {
            Write-Ok 'Visual Studio C++ Build Tools instaladas correctamente'
        } elseif ($detectedLinker -eq 'rust-lld') {
            [void](Use-RustLldLinker)
            Write-Warn 'Visual Studio no quedó disponible; se mantiene el enlazador Rust LLD'
            Write-Ok 'Rust LLD disponible: se puede compilar la aplicación sin Visual Studio Build Tools'
        } else {
            throw 'Faltan las Visual Studio C++ Build Tools (link.exe). Se intento la instalacion con winget pero no concluyo. Instalalas manualmente desde https://visualstudio.microsoft.com/visual-cpp-build-tools/'
        }
    } else {
        throw 'Faltan las Visual Studio C++ Build Tools (link.exe) para compilar en Windows. Instalalas desde https://visualstudio.microsoft.com/visual-cpp-build-tools/'
    }
} elseif ((Test-MSVCLinker)) {
    Write-Ok 'Visual Studio C++ Build Tools (cl.exe + link.exe + Windows SDK)'
} else {
    $rustLld = Use-RustLldLinker
    Write-Warn "No se encontraron cl.exe/link.exe; se usará el enlazador incluido en Rust: $rustLld"
    Write-Ok 'Rust LLD disponible: se puede compilar la aplicación sin Visual Studio Build Tools'
}

function Find-SevenZip {
    return @(
        $env:LTERMINAL_7ZIP,
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles '7-Zip\7z.exe' }),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}

# Con instalador, la carpeta desempaquetada y el portable reutilizan el
# WebView2 offline que se extrae del NSIS con 7-Zip. Se comprueba aquí, antes
# de compilar, para no descubrir la falta tras la batería completa.
if ($Installer) {
    if (Find-SevenZip) {
        Write-Ok '7-Zip disponible para extraer WebView2 offline del NSIS'
    } elseif (Test-Command 'winget') {
        Write-Step 'Instalando 7-Zip mediante winget...'
        [void](Invoke-Native 'winget' @(
            'install',
            '--id', '7zip.7zip',
            '--exact',
            '--source', 'winget',
            '--accept-source-agreements',
            '--accept-package-agreements',
            '--disable-interactivity'
        ))
        if (-not (Find-SevenZip)) {
            throw 'Falta 7-Zip para extraer WebView2 offline del NSIS. Se intento la instalacion con winget pero no concluyo. Instalalo desde https://www.7-zip.org/'
        }
        Write-Ok '7-Zip instalado correctamente'
    } else {
        throw 'Falta 7-Zip para extraer WebView2 offline del NSIS. Instalalo desde https://www.7-zip.org/'
    }
}

# La versión se pregunta antes de empaquetar. Enter conserva la actual; el
# parámetro permite builds automatizadas sin diálogo.
$packageJson = Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
$currentVersion = $packageJson.version
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = $currentVersion }

if ($Version -ne $currentVersion) {
    Backup-VersionManifests
    if ((Invoke-Native 'node' @('scripts/set-package-version.mjs', $Version)) -ne 0) {
        throw 'La versión indicada no es válida o no se pudo guardar en todos los manifiestos.'
    }
} else {
    Write-Ok "Se conserva la versión $currentVersion sin modificar los manifiestos"
}
if ($env:LTERMINAL_TEST_FAIL_AFTER_VERSION -eq '1') {
    throw 'Fallo de prueba solicitado después de aplicar la versión.'
}
if ($env:LTERMINAL_TEST_REMOVE_VERSION_BACKUP) {
    if ($env:LTERMINAL_TEST_REMOVE_VERSION_BACKUP -notin @('package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock')) {
        throw 'El manifiesto solicitado para la prueba no está permitido.'
    }
    $testBackup = Join-Path $script:VersionManifestBackupDir $env:LTERMINAL_TEST_REMOVE_VERSION_BACKUP
    Remove-Item -LiteralPath $testBackup -Force -ErrorAction Stop
}
if ($env:LTERMINAL_TEST_EXIT_AFTER_VERSION -eq '1') {
    exit 0
}

$packageJson = Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
$version = $packageJson.version
Write-Ok "Version a compilar: $version"


# ---------------------------------------------------------------------------
# 2. conpty.dll
# ---------------------------------------------------------------------------
# Sin ella, en un Windows recortado las pestanas se quedan en blanco varios
# minutos y luego fallan con STATUS_DLL_INIT_FAILED. build.rs la copia junto al
# binario en cada compilacion, pero si no esta en vendor/ no hay nada que copiar
# y el fallo no se ve hasta ejecutar la app. La explicación se mantiene en la
# sección «conpty.dll» del README raíz para no duplicar documentación.
Write-Step 'Comprobando conpty.dll'
$conptyFiles = @('conpty.dll', 'OpenConsole.exe')
$prepareConptyCode = Invoke-Native 'node' @('scripts/prepare-conpty.mjs') -CaptureOutput
if ($prepareConptyCode -ne 0) {
    throw "No se pudieron descargar/verificar los recursos ConPTY oficiales. $script:LastNativeOutput"
}
$missing = $conptyFiles | Where-Object { -not (Test-Path (Join-Path $VendorDir $_)) }
if ($missing) {
    throw "Faltan en src-tauri\vendor\conpty: $($missing -join ', '). Sin ellos la app no abre ni una pestana."
}
Write-Ok 'conpty.dll y OpenConsole.exe presentes'

# ---------------------------------------------------------------------------
# 3. Nada en marcha que bloquee los archivos
# ---------------------------------------------------------------------------
# Windows no deja borrar un archivo en uso. `npm ci` empieza por vaciar
# node_modules, asi que un servidor de desarrollo abierto lo hace fallar con un
# EPERM sobre esbuild.exe que no dice en ningun sitio cual es la causa real. Lo
# mismo con la app compilada: si esta corriendo, el .exe no se puede sobrescribir.
Write-Step 'Comprobando que no haya nada en marcha'

$devServer = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
if ($devServer) {
    Write-Err 'Hay un servidor de desarrollo escuchando en el puerto 1420.'
    Write-Err 'Cierra `npm start` / `npm run dev` antes de compilar: mantiene bloqueado esbuild.exe'
    Write-Err 'y npm ci fallaria con un EPERM al vaciar node_modules.'
    throw 'Servidor de desarrollo en marcha.'
}

$running = Get-Process -Name 'wterminal' -ErrorAction SilentlyContinue
if ($running) {
    Write-Err "WTerminal esta abierto ($($running.Count) proceso(s))."
    Write-Err 'Cierralo antes de compilar: su .exe y su conpty.dll no se pueden reemplazar en uso.'
    throw 'La aplicacion esta en marcha.'
}

$esbuildProcs = Get-Process -Name 'esbuild' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*$ProjectRoot*" }
if ($esbuildProcs) {
    Write-Warn 'Se detecto un proceso esbuild.exe activo de este proyecto. Deteniendolo para desbloquear node_modules...'
    $esbuildProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

Write-Ok 'Nada bloqueando los archivos'

# ---------------------------------------------------------------------------
# 4. Dependencias
# ---------------------------------------------------------------------------
if ($Clean) {
    Write-Step 'Limpiando (node_modules y target)'
    Remove-Item -Recurse -Force (Join-Path $ProjectRoot 'node_modules') -ErrorAction SilentlyContinue
    $code = Invoke-Native 'cargo' @('clean', '--manifest-path', (Join-Path $TauriDir 'Cargo.toml'))
    if ($code -ne 0) { Write-Warn 'cargo clean fallo; se sigue igualmente.' }
}

Write-Step 'Instalando dependencias del frontend (npm ci)'
$npmUserConfig = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.npmrc'
$npmConfigArgs = if (Test-Path -LiteralPath $npmUserConfig -PathType Leaf) {
    @('--userconfig', $npmUserConfig)
} else {
    @()
}
# npm 11 puede interpretar un `allow-scripts` heredado del perfil del usuario
# como una opción de proyecto cuando se ejecuta desde PowerShell. Pasar el
# archivo de configuración explícitamente hace que npm aplique el campo
# allowScripts del package.json de este proyecto de forma determinista, sin
# modificar la configuración global del usuario.
$previousNpmAllowScripts = $env:NPM_CONFIG_ALLOW_SCRIPTS
Remove-Item Env:NPM_CONFIG_ALLOW_SCRIPTS -ErrorAction SilentlyContinue
try {
    $code = Invoke-Native 'npm' ($npmConfigArgs + @('ci'))
    if ($code -ne 0) {
        Write-Warn 'npm ci no pudo vaciar node_modules por bloqueo de archivos en Windows. Reintentando con npm install...'
        $code = Invoke-Native 'npm' ($npmConfigArgs + @('install'))
        if ($code -ne 0) { throw "La instalacion de dependencias fallo (codigo $code)." }
    }
} finally {
    if ($null -eq $previousNpmAllowScripts) {
        Remove-Item Env:NPM_CONFIG_ALLOW_SCRIPTS -ErrorAction SilentlyContinue
    } else {
        $env:NPM_CONFIG_ALLOW_SCRIPTS = $previousNpmAllowScripts
    }
}
Write-Ok 'Dependencias instaladas'

# ---------------------------------------------------------------------------
# 5. Comprobaciones
# ---------------------------------------------------------------------------
# Compilar una release que no pasa sus propias pruebas no tiene sentido: se
# tarda mas en descubrirlo despues que en comprobarlo aqui.
if (-not $SkipChecks) {
    Write-Step 'Comprobando tipos, formato, clippy y pruebas'
    # npm puede salir con 0 en algunos hosts de PowerShell aunque uno de los
    # procesos encadenados (cargo/clippy) haya escrito un error fatal. Capturar
    # la salida permite detectar también ese caso y evita imprimir «Todo
    # verde» después de un `could not compile`.
    $code = Invoke-Native 'npm' @('run', 'check') -CaptureOutput
    $checkOutputFailed = $script:LastNativeOutput -match '(?im)\b(?:error:\s+could not compile|error\[E\d+\]:|svelte-check found\s+[1-9]\d*\s+errors?)\b'
    if ($code -ne 0 -or $checkOutputFailed) {
        throw "Las comprobaciones fallaron (codigo $code). Usa -SkipChecks para saltarlas."
    }
    Write-Ok 'Todo verde'
    Add-BuildTest 'Comprobaciones (npm run check: tipos, formato, clippy y pruebas de unidad)' 'OK'
} else {
    Write-Step 'Ejecutando la auditoría mínima de workflows de GitHub'
    $securityCheckCode = Invoke-Native 'npm' @('run', 'check:github-security') -CaptureOutput
    if ($securityCheckCode -ne 0) {
        throw "La auditoría de workflows de GitHub falló (código $securityCheckCode)."
    }
    Write-Warn 'Comprobaciones saltadas por peticion (-SkipChecks)'
    Add-BuildTest 'Comprobaciones (npm run check)' 'OMITIDAS' '-SkipChecks; solo la auditoría de workflows'
}

# ---------------------------------------------------------------------------
# 6. Compilacion
# ---------------------------------------------------------------------------
# Las claves públicas de actualización forman parte del ejecutable: no basta
# con firmar después el ZIP. Cargarlas antes de invocar Tauri permite que
# `build.rs` las pase a rustc y evita publicar una aplicación que solo descubre
# el problema al pulsar «Volver a comprobar».
function Import-UpdateTrustMaterialForBuild {
    if ($env:CI -match '^(1|true|yes)$') { return }
    $desktop = [Environment]::GetFolderPath('Desktop')
    $documents = [Environment]::GetFolderPath('MyDocuments')
    $configRoot = if (-not [string]::IsNullOrWhiteSpace($env:XDG_CONFIG_HOME)) {
        $env:XDG_CONFIG_HOME
    } elseif ($env:USERPROFILE) {
        Join-Path $env:USERPROFILE '.config'
    }
    if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_UPDATE_PUBLIC_KEY)) {
        $publicCandidates = @(
            $env:LTERMINAL_UPDATE_PUBLIC_KEY_FILE,
            $(if ($configRoot) { Join-Path $configRoot 'lterminal\release-signing-public.hex' }),
            $(if ($desktop) { Join-Path $desktop 'release-signing-public.hex' })
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
        if ($publicCandidates) {
            $env:LTERMINAL_UPDATE_PUBLIC_KEY = (Get-Content -LiteralPath @($publicCandidates)[0] -Raw).Trim()
        }
    }
    if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_SSH_UPDATE_PUBLIC_KEY)) {
        $sshCandidates = @(
            $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE,
            $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.ssh\lterminal-release-signing.pub' }),
            $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.ssh\ltools-release-signing.pub' }),
            $(if ($documents) { Join-Path $documents '.ssh\lterminal-release-signing.pub' }),
            $(if ($documents) { Join-Path $documents '.ssh\ltools-release-signing.pub' }),
            $(if ($desktop) { Join-Path $desktop 'lterminal-release-signing.pub' }),
            $(if ($desktop) { Join-Path $desktop 'ltools-release-signing.pub' })
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
        if ($sshCandidates) {
            $env:LTERMINAL_SSH_UPDATE_PUBLIC_KEY = (Get-Content -LiteralPath @($sshCandidates)[0] -Raw).Trim()
        }
    }
    if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_SSH_UPDATE_IDENTITY)) {
        $env:LTERMINAL_SSH_UPDATE_IDENTITY = if ($env:GIT_AUTHOR_EMAIL) { $env:GIT_AUTHOR_EMAIL } else { 'lterminal-release@local' }
    }
    $trustRequired = $env:LTERMINAL_REQUIRE_SIGNING -match '^(1|true|yes)$'
    if ($trustRequired -and ([string]::IsNullOrWhiteSpace($env:LTERMINAL_UPDATE_PUBLIC_KEY) -or
            [string]::IsNullOrWhiteSpace($env:LTERMINAL_SSH_UPDATE_PUBLIC_KEY))) {
        throw 'Faltan las claves públicas de confianza antes de compilar; no se generará una release actualizable.'
    }
}

Import-UpdateTrustMaterialForBuild

function Invoke-TauriBuild {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $previousSkipChecks = $env:LTERMINAL_SKIP_CHECKS
    $previousPnpmVerifyDeps = $env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN
    try {
        if ($script:UsingPnpmNpmShim) {
            # El beforeBuildCommand ejecuta prebuild en un proceso Node hijo.
            # pnpm repara node_modules de forma automática si no recibe esta
            # preferencia heredable, y esa reparación falla sin TTY.
            $env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = 'false'
        }
        if ($SkipChecks) {
            # Tauri ejecuta npm run build internamente. Este entorno llega también
            # al prebuild y al build del frontend, de modo que -SkipChecks no
            # vuelve a lanzar enlaces, fuentes externas ni svelte-check.
            $env:LTERMINAL_SKIP_CHECKS = '1'
        } else {
            Remove-Item Env:LTERMINAL_SKIP_CHECKS -ErrorAction SilentlyContinue
        }
        $usePnpmTauri = $script:UsingPnpmNpmShim -and
            $Arguments.Count -ge 4 -and
            $Arguments[0] -eq 'run' -and
            $Arguments[1] -eq 'tauri' -and
            $Arguments[2] -eq '--'
        if ($usePnpmTauri) {
            # pnpm conserva `--` como argumento de Tauri mientras npm lo quita.
            # En PowerShell, `pnpm exec` puede perder la resolución de .bin al
            # ejecutarse desde el builder; Node ejecuta el entrypoint local sin
            # depender de esa resolución y el shim npm sigue cubriendo hooks.
            $tauriCli = Join-Path $ProjectRoot 'node_modules\@tauri-apps\cli\tauri.js'
            if (-not (Test-Path -LiteralPath $tauriCli -PathType Leaf)) {
                throw "No se encontró el CLI local de Tauri: $tauriCli"
            }
            $tauriArguments = @($tauriCli) + @($Arguments | Select-Object -Skip 3)
            $code = Invoke-Native 'node' $tauriArguments -CaptureOutput
        } else {
            $code = Invoke-Native 'npm' $Arguments -CaptureOutput
        }
        # En algunos hosts npm/tauri puede devolver cero aunque el proceso de
        # Cargo haya dejado un error fatal en la salida (por ejemplo, una
        # compilación fallida seguida de un ejecutable release antiguo). No se
        # debe empaquetar ni ejecutar ese artefacto obsoleto: los marcadores de
        # error de Cargo/Tauri son una segunda señal defensiva junto al código.
        if ($code -eq 0 -and $script:LastNativeOutput -match '(?im)^\s*(?:error(?:\[E\d+\])?:|failed to build app\b|could not compile\b)') {
            return 1
        }
        return $code
    } finally {
        if ($null -eq $previousSkipChecks) {
            Remove-Item Env:LTERMINAL_SKIP_CHECKS -ErrorAction SilentlyContinue
        } else {
            $env:LTERMINAL_SKIP_CHECKS = $previousSkipChecks
        }
        if ($null -eq $previousPnpmVerifyDeps) {
            Remove-Item Env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN -ErrorAction SilentlyContinue
        } else {
            $env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = $previousPnpmVerifyDeps
        }
    }
}

function Find-WebView2Loader {
    $target = Join-Path $ReleaseDir 'WebView2Loader.dll'
    if (Test-Path $target -PathType Leaf) { return $target }
    $buildDir = Join-Path $ReleaseDir 'build'
    $candidate = Get-ChildItem -Path $buildDir -Filter 'WebView2Loader.dll' -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\webview2-com-sys-[^\\]+\\out\\x64\\WebView2Loader\.dll$' } |
        Select-Object -First 1
    if ($null -ne $candidate) { return $candidate.FullName }
    return $null
}

function Ensure-WebView2Loader {
    $target = Join-Path $ReleaseDir 'WebView2Loader.dll'
    $source = Find-WebView2Loader
    if ([string]::IsNullOrWhiteSpace($source)) {
        throw "No se encontró WebView2Loader.dll en $ReleaseDir ni en la salida x64 de webview2-com-sys."
    }
    if ($source -ne $target) {
        Copy-Item $source $target -Force
        Write-Ok 'WebView2Loader.dll copiado a target\\release para el empaquetador y la release portable'
    }
    if (-not (Test-Path $target -PathType Leaf)) {
        throw "No se pudo preparar WebView2Loader.dll en $target."
    }
    return $target
}

function Find-PortableWebView2Bootstrapper {
    $mode = if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER)) {
        'auto'
    } else {
        $env:LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER
    }
    if ($mode -eq '0') { return $null }
    if ($mode -notin @('auto', '1')) {
        throw 'LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER debe ser 0, auto o 1.'
    }

    $candidate = $env:LTERMINAL_WEBVIEW2_INSTALLER
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        New-Item -ItemType Directory -Force -Path $script:BuildTempDir | Out-Null
        $candidate = Join-Path $script:BuildTempDir 'MicrosoftEdgeWebview2Setup.exe'
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -and $mode -eq '1') {
        Write-Host '    Descargando bootstrapper WebView2 para el portable...' -ForegroundColor DarkGray
        Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $candidate -UseBasicParsing
    }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $size = (Get-Item -LiteralPath $candidate).Length
        if ($size -ge 100KB) { return (Get-Item -LiteralPath $candidate).FullName }
        if ($mode -eq '1') { throw "El bootstrapper WebView2 descargado parece incompleto ($size bytes)." }
    }
    if ($mode -eq '1') { throw "No se pudo preparar el bootstrapper WebView2: $candidate" }
    Write-Warn 'No se incluirá bootstrapper WebView2 en el portable; usa WTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER=1 para descargarlo.'
    return $null
}

function Extract-OfflineWebView2Installer {
    param([Parameter(Mandatory = $true)][string]$NsisPath)
    $sevenZip = Find-SevenZip
    if (-not $sevenZip) { throw 'La release Windows completa necesita 7-Zip para extraer WebView2 offline del NSIS.' }
    $cacheDir = Join-Path $TauriDir 'target\release\portable-webview2'
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    $offlinePath = Join-Path $cacheDir 'MicrosoftEdgeWebView2RuntimeInstaller.exe'
    Remove-Item -LiteralPath $offlinePath -Force -ErrorAction SilentlyContinue
    & $sevenZip e -y "-o$cacheDir" $NsisPath '$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe' | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $offlinePath -PathType Leaf)) {
        throw "No se pudo extraer WebView2 offline del instalador NSIS: $NsisPath"
    }
    $offline = Get-Item -LiteralPath $offlinePath
    if ($offline.Length -lt 100MB) {
        throw "WebView2 offline extraído está incompleto ($($offline.Length) bytes)."
    }
    return $offline.FullName
}

# Marcar el inicio de esta pasada permite detectar un ejecutable `wterminal.exe`
# que haya quedado de una build anterior. `cargo build` genera
# `winslim-terminal.exe`, mientras que solo Tauri aplica `mainBinaryName` y
# escribe el binario publicable `wterminal.exe`.
$buildStartedUtc = (Get-Date).ToUniversalTime()
if ($Installer) {
    # Tauri/tauri-build solo copia automáticamente WebView2Loader para GNU; en
    # MSVC queda dentro de build\\webview2-com-sys-*\\out\\x64. Primero se hace
    # una pasada sin bundler, se copia el DLL al nivel de target\\release y solo
    # entonces se genera NSIS. Sin esta fase el instalador podía compilar bien y
    # entregar una aplicación sin su loader nativo.
    Write-Step 'Compilando el binario Windows antes del instalador'
    $code = Invoke-TauriBuild @('run', 'tauri', '--', 'build', '--no-bundle')
    if ($code -ne 0) { throw "La compilacion del binario fallo (codigo $code)." }
    Ensure-WebView2Loader | Out-Null

    Write-Step 'Empaquetando (Tauri + instalador NSIS offline de WebView2)'
    # El binario ya se compiló en la pasada --no-bundle anterior. `bundle`
    # reutiliza ese ejecutable y evita una segunda compilación LTO completa;
    # `build --config` volvía a enlazar todo el crate aunque solo se necesitara
    # generar el instalador.
    $code = Invoke-TauriBuild @('run', 'tauri', '--', 'bundle', '--config', 'src-tauri/tauri.windows.installer.conf.json')
} else {
    Write-Step 'Compilando (tauri build --no-bundle)'
    # --no-bundle es redundante con bundle.active:false de tauri.windows.conf.json,
    # pero se pasa igualmente para que la intención se lea aquí.
    $code = Invoke-TauriBuild @('run', 'tauri', '--', 'build', '--no-bundle')
}
if ($code -ne 0) { throw "La compilacion fallo (codigo $code)." }

$installerPath = $null
if ($Installer) {
    $nsisDir = Join-Path $TauriDir 'target\release\bundle\nsis'
    $installers = @(Get-ChildItem $nsisDir -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    if ($installers.Count -eq 0) {
        throw "La compilacion termino sin generar instalador NSIS en $nsisDir."
    }
    $installerPath = $installers[0]
    # `offlineInstaller` incluye el runtime Evergreen completo de WebView2.
    # Un NSIS de unos pocos megabytes es el bootstrapper online y dejaría sin
    # conexión a una instalación nueva; rechazarlo aquí evita publicarlo con
    # la etiqueta de instalador offline.
    if ($installerPath.Length -lt 100MB) {
        throw "El instalador NSIS no contiene el runtime WebView2 offline ($($installerPath.Length) bytes): $($installerPath.FullName)."
    }
    Write-Ok "Instalador NSIS con WebView2 offline: $($installerPath.FullName)"
}

# Evita publicar por accidente un frontend anterior (por ejemplo, una copia
# del proyecto sin los últimos cambios compartidos). No se buscan nombres de
# funciones TypeScript: Vite puede minificarlos o renombrarlos en producción.
# Los marcadores son claves de preferencias/eventos estables del contrato
# runtime; las herramientas opcionales se detectan en ejecución y nunca
# condicionan la compilación.
$frontendBundles = Get-ChildItem (Join-Path $ProjectRoot 'dist\assets') -Filter 'index-*.js' -File
$frontendText = ($frontendBundles | ForEach-Object { Get-Content $_.FullName -Raw }) -join "`n"
foreach ($marker in @('shortcutPaneLeft', 'shortcutOpenSystemExplorer', 'environment-controls')) {
    if ($frontendText -notmatch [regex]::Escape($marker)) {
        throw "El frontend compilado no contiene '$marker': parece una build desactualizada y no se publicara."
    }
}
Write-Ok 'Frontend compartido actualizado: atajos configurables y preferencias compactas presentes'

$exePath = Join-Path $ReleaseDir 'wterminal.exe'
if (-not (Test-Path $exePath)) { throw "La compilacion termino pero no hay ejecutable en $exePath." }
$exeInfo = Get-Item -LiteralPath $exePath -ErrorAction Stop
if ($exeInfo.LastWriteTimeUtc -lt $buildStartedUtc.AddSeconds(-5)) {
    throw "La compilacion no actualizo $exePath (fecha $($exeInfo.LastWriteTimeUtc.ToString('o')); inicio $($buildStartedUtc.ToString('o'))). No se empaquetara una release antigua."
}
Write-Ok "Compilado y actualizado: $exePath ($($exeInfo.LastWriteTimeUtc.ToString('o')) UTC)"

# `cargo build` directo puede dejar el nombre del paquete junto al binario
# (`winslim-terminal.exe`) en target/release. No es un artefacto publicable ni
# debe confundirse con WTerminal: la build Tauri ya produjo `wterminal.exe`.
$legacyCargoExe = Join-Path $ReleaseDir 'winslim-terminal.exe'
if (Test-Path -LiteralPath $legacyCargoExe -PathType Leaf) {
    Remove-Item -LiteralPath $legacyCargoExe -Force
    Write-Ok 'Artefacto Cargo winslim-terminal.exe eliminado; se conserva solo wterminal.exe'
}

# ---------------------------------------------------------------------------
# 7. Carpeta desempaquetada
# ---------------------------------------------------------------------------
# target/release contiene ademas todos los artefactos de cargo (deps/, build/,
# .pdb: cientos de megas). Lo que se distribuye son el ejecutable, sus DLL/host
# nativos y el árbol `scripts/` declarado en bundle.resources. Se copian a una
# carpeta limpia para no publicar el resto por accidente. Las builds rápidas
# usan además una carpeta y un nombre distintos para que un ZIP de desarrollo
# no pueda confundirse con la release comprimida.
Write-Step 'Preparando la carpeta desempaquetada'
# NO en dist/: ahi escribe Vite el frontend compilado y lo vacia en cada build,
# asi que la release anterior desapareceria al compilar la siguiente.
# release\ queda solo para lo que se sube a GitHub (instalador, portable, ZIP y
# el manifiesto con sus firmas). La carpeta desempaquetada y todo lo de las
# builds rapidas son salidas intermedias: viven en src-tauri\target\dist,
# ignorado por git.
$distSuffix = if ($Fast) { '-dev' } else { '' }
$distRoot = Join-Path $TauriDir 'target\dist'
$distDir = Join-Path $distRoot "WTerminal-$version$distSuffix"
$releaseArtifactRoot = $env:LTERMINAL_RELEASE_DIR
if ([string]::IsNullOrWhiteSpace($releaseArtifactRoot)) {
    $releaseArtifactRoot = Join-Path $ProjectRoot 'release'
} elseif (-not [IO.Path]::IsPathRooted($releaseArtifactRoot)) {
    $releaseArtifactRoot = Join-Path $ProjectRoot $releaseArtifactRoot
}
$releaseArtifactRoot = [IO.Path]::GetFullPath($releaseArtifactRoot)
$releaseArtifactOut = if ($Fast) { Join-Path $distRoot 'dev' } else { $releaseArtifactRoot }
$singleFilePath = Join-Path $releaseArtifactOut "WTerminal-$version$distSuffix-Portable.exe"
Remove-Item -Recurse -Force $distDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

Ensure-WebView2Loader | Out-Null

$payload = @('wterminal.exe') + $conptyFiles + @('WebView2Loader.dll')
$portableWebView2Bootstrapper = if ($Installer -and $installerPath) {
    # El NSIS ya contiene el runtime completo. Reutilizar exactamente ese
    # instalador permite que unpacked y el portable arranquen sin red en una
    # máquina limpia, sin descargar ni compilar una segunda copia.
    Extract-OfflineWebView2Installer -NsisPath $installerPath.FullName
} else {
    Find-PortableWebView2Bootstrapper
}
if ($SingleFile -and -not $portableWebView2Bootstrapper) {
    # El portable debe poder reparar WebView2 en una máquina limpia. El
    # bootstrapper va dentro del .exe y el preflight de Rust solo lo saca y ejecuta si
    # el runtime no existe; no se reinstala en cada apertura normal.
    $previousWebViewMode = $env:LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER
    try {
        $env:LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER = '1'
        $portableWebView2Bootstrapper = Find-PortableWebView2Bootstrapper
    } finally {
        if ($null -eq $previousWebViewMode) {
            Remove-Item Env:LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER -ErrorAction SilentlyContinue
        } else {
            $env:LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER = $previousWebViewMode
        }
    }
}
if ($portableWebView2Bootstrapper) {
    Copy-Item -LiteralPath $portableWebView2Bootstrapper -Destination (Join-Path $ReleaseDir 'MicrosoftEdgeWebView2Setup.exe') -Force
    $payload += 'MicrosoftEdgeWebView2Setup.exe'
}
foreach ($file in $payload) {
    $source = Join-Path $ReleaseDir $file
    if (-not (Test-Path $source)) {
        throw "Falta $file en $ReleaseDir. La carpeta quedaria incompleta y la app no abriria pestanas."
    }
    Copy-Item $source (Join-Path $distDir $file) -Force
}
$baseConfig = Get-Content (Join-Path $TauriDir 'tauri.conf.json') -Raw | ConvertFrom-Json
$resourceMap = $baseConfig.bundle.resources
$resourceCount = 0
foreach ($resource in $resourceMap.PSObject.Properties) {
    $source = Join-Path $TauriDir ([string]$resource.Name)
    $destination = Join-Path $distDir ([string]$resource.Value)
    if (-not (Test-Path $source -PathType Leaf)) {
        throw "Falta el recurso declarado por bundle.resources: $source"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item $source $destination -Force
    $resourceCount++
}
if ($resourceCount -eq 0) {
    throw 'La carpeta portable no contiene recursos de bundle.resources; la Biblioteca perdería sus scripts integrados.'
}
$sizeMb = [math]::Round(((Get-ChildItem $distDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Ok "Carpeta lista: $distDir ($sizeMb MB, $($payload.Count) binarios + $resourceCount recursos)"
$artifactCode = Invoke-Native 'node' @(
    'scripts/verify-release-artifacts.mjs',
    '--windows', (Join-Path $distDir 'wterminal.exe'),
    '--windows-dir', $distDir
)
if ($artifactCode -ne 0) { throw "La validación PE/runtime de Windows falló (código $artifactCode)." }
Write-Ok 'Estructura PE x64 y runtime Windows verificados'

$singleFileCreated = $false
if ($SingleFile) {
    Write-Step 'Creando el portable de un solo archivo (.exe autónomo, sin extracción)'
    if (-not $portableWebView2Bootstrapper) {
        throw 'El portable de un solo archivo requiere el bootstrapper WebView2; no se pudo preparar.'
    }
    $singleFileCode = Invoke-Native 'node' @(
        'scripts/create-single-file-portable.mjs',
        '--input', $distDir,
        '--output', $singleFilePath
    )
    if ($singleFileCode -ne 0 -or -not (Test-Path -LiteralPath $singleFilePath -PathType Leaf)) {
        throw "No se pudo crear el portable de un solo archivo: $singleFilePath"
    }
    $singleFileCreated = $true
    Write-Ok "Portable de un solo archivo publicado: $singleFilePath"
}

# ---------------------------------------------------------------------------
# 8. Comprobacion de humo
# ---------------------------------------------------------------------------
# Que compile o mantenga un proceso vivo no demuestra que WebView, xterm y el
# primer PTY hayan terminado de inicializar. Un token unico debe volver por IPC
# y quedar escrito en el log antes de permitir publicar la release.
Write-Step 'Comprobacion de humo (ventana, frontend, terminal y PTY)'
Write-Host '    Este paso comprueba solo el arranque mínimo y se cerrará automáticamente.' -ForegroundColor DarkGray
Write-Host '    Las pestañas, menús, acciones y redimensionado se prueban después en E2E ampliado.' -ForegroundColor DarkGray
$smokeToken = "windows-build-$([guid]::NewGuid().ToString('N'))"
$logPath = Join-Path $script:BuildTempDir 'smoke\main.log'
$smokeAppDataDir = Join-Path $script:BuildTempDir 'smoke\appdata'
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath)
$previousSmokeToken = $env:LTERMINAL_SMOKE_TOKEN
$previousLogFile = $env:LTERMINAL_LOG_FILE
$previousSmokeAutoExit = $env:LTERMINAL_SMOKE_AUTO_EXIT
$previousDisableAdmin = $env:LTERMINAL_E2E_DISABLE_ADMIN
$previousDisablePathAuto = $env:LTERMINAL_E2E_DISABLE_PATH_AUTO
$previousE2eTesting = $env:LTERMINAL_E2E_TESTING
$previousE2eAppDataDir = $env:LTERMINAL_E2E_APP_DATA_DIR
$process = $null
# El smoke debe iniciar sin el shimming RUNASADMIN ya registrado: Windows
# eleva el proceso antes de que Rust pueda leer LTERMINAL_E2E_DISABLE_ADMIN y
# el broker UAC no hereda el token del smoke. La app volverá a sincronizar la
# preferencia durante ese arranque; al terminar restauramos el valor exacto.
$appCompatLayersKey = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
$appCompatValueName = Join-Path $distDir 'wterminal.exe'
$previousAppCompatValue = $null
$hadAppCompatValue = $false
$appCompatProperties = Get-ItemProperty -LiteralPath $appCompatLayersKey -ErrorAction SilentlyContinue
if ($appCompatProperties) {
    $appCompatProperty = $appCompatProperties.PSObject.Properties[$appCompatValueName]
    if ($appCompatProperty) {
        $previousAppCompatValue = [string]$appCompatProperty.Value
        $hadAppCompatValue = $true
    }
}
$appCompatWithoutRunAsAdmin = ($previousAppCompatValue -split '\s+' |
    Where-Object { $_ -and $_ -notmatch '^RUNASADMIN$' }) -join ' '
if ($previousAppCompatValue -match '(?i)(^|\s)RUNASADMIN(\s|$)') {
    if ($appCompatWithoutRunAsAdmin) {
        Set-ItemProperty -LiteralPath $appCompatLayersKey -Name $appCompatValueName -Value $appCompatWithoutRunAsAdmin -ErrorAction Stop
    } else {
        Remove-ItemProperty -LiteralPath $appCompatLayersKey -Name $appCompatValueName -ErrorAction Stop
    }
}
# Algunas builds del WebView pueden crear un segundo proceso de la app durante
# el arranque (el primero confirma el smoke y el segundo queda sin ventana).
# Recordar los PIDs previos permite limpiar únicamente los que pertenecen a
# esta prueba, sin cerrar una instancia que ya estuviera abierta al comenzar.
$preSmokeProcessIds = @(
    Get-Process -Name 'wterminal' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id
)
try {
    $env:LTERMINAL_SMOKE_TOKEN = $smokeToken
    # El smoke observa el proceso hijo y su token de éxito. La elevación UAC
    # crea otro proceso sin heredar las variables del padre, así que la prueba
    # de arranque debe omitir la elevación igual que la batería E2E.
    $env:LTERMINAL_E2E_DISABLE_ADMIN = '1'
    # El smoke debe validar arranque sin registrar la carpeta portable de build
    # en el PATH persistente del usuario.
    $env:LTERMINAL_E2E_DISABLE_PATH_AUTO = '1'
    $env:LTERMINAL_E2E_TESTING = '1'
    $env:LTERMINAL_E2E_APP_DATA_DIR = $smokeAppDataDir
    # La app debe cerrar su PTY de forma ordenada. TerminateProcess sobre el
    # padre mientras cmd.exe aún conecta al pseudoterminal genera el diálogo
    # STATUS_DLL_INIT_FAILED (0xc0000142) aunque las DLL sean correctas.
    $env:LTERMINAL_SMOKE_AUTO_EXIT = '1'
    # Resource-dir, WebView2 y los scripts deben resolverse contra la carpeta
    # desempaquetada, no contra la carpeta desde la que se lanzó PowerShell.
    $env:LTERMINAL_LOG_FILE = $logPath
    # El manifiesto exige UAC y ShellExecute no garantiza conservar las
    # variables temporales del proceso padre. Pasarlas como argumentos privados
    # permite que el binario configure el smoke dentro del proceso elevado.
    $smokeArguments = @(
        "--wterminal-smoke-token=$smokeToken",
        '--wterminal-smoke-auto-exit',
        '--wterminal-e2e-testing',
        '--wterminal-e2e-disable-admin',
        '--wterminal-e2e-disable-path-auto',
        "--wterminal-e2e-app-data-dir=$smokeAppDataDir",
        "--wterminal-log-file=$logPath"
    )
    $process = Start-Process -FilePath (Join-Path $distDir 'wterminal.exe') -WorkingDirectory $distDir -ArgumentList $smokeArguments -PassThru
    $ready = $false
    # El PTY tiene un límite propio de 30 s y se crea en segundo plano; el
    # smoke necesita margen para cargar WebView y completar el handshake.
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        Start-Sleep -Seconds 1
        $process.Refresh()
        if ($process.HasExited) {
            if (Test-SmokeReady $logPath $smokeToken) {
                $ready = $true
                break
            }
            Write-Err "La aplicacion se cerro sola con codigo $($process.ExitCode)."
            Show-SmokeDiagnostics $logPath $smokeToken
            throw 'La build compila pero no arranca. Revisa el log en %APPDATA%\wterminal\logs.'
        }
        if (Test-SmokeReady $logPath $smokeToken) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        Show-SmokeDiagnostics $logPath $smokeToken
        throw "La ventana siguio viva, pero frontend/xterm/PTY no confirmaron el arranque en 45 s. Revisa $logPath."
    }
    Write-Ok 'Smoke mínimo completado: frontend, terminal y PTY confirmaron el arranque'
    Add-BuildTest 'Smoke mínimo (ventana, frontend, terminal y PTY)' 'OK'
} finally {
    if ($process -and -not $process.HasExited) {
        # Dar tiempo a la salida solicitada por frontend_ready. Solo se fuerza
        # el proceso si una versión antigua o un cierre defectuoso no responde.
        for ($wait = 0; $wait -lt 20 -and -not $process.HasExited; $wait++) {
            Start-Sleep -Milliseconds 250
            $process.Refresh()
        }
        if (-not $process.HasExited) {
            Write-Warn 'La app no respondió al cierre ordenado del smoke; se fuerza el cierre como último recurso.'
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    # La salida ordenada puede dejar un proceso hermano durante unos cientos
    # de milisegundos. Esperarlo aquí evita que la copia de la carpeta portable
    # falle con "archivo en uso" aunque el proceso principal ya haya terminado.
    for ($cleanupAttempt = 0; $cleanupAttempt -lt 8; $cleanupAttempt++) {
        $smokeRemainders = @(
            Get-Process -Name 'wterminal' -ErrorAction SilentlyContinue |
                Where-Object { $_.Id -notin $preSmokeProcessIds }
        )
        if (-not $smokeRemainders) { break }
        $smokeRemainders | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 250
    }
    if ($null -eq $previousSmokeToken) {
        Remove-Item Env:LTERMINAL_SMOKE_TOKEN -ErrorAction SilentlyContinue
    } else {
        $env:LTERMINAL_SMOKE_TOKEN = $previousSmokeToken
    }
    if ($null -eq $previousLogFile) {
        Remove-Item Env:LTERMINAL_LOG_FILE -ErrorAction SilentlyContinue
    } else {
        $env:LTERMINAL_LOG_FILE = $previousLogFile
    }
    if ($null -eq $previousSmokeAutoExit) {
        Remove-Item Env:LTERMINAL_SMOKE_AUTO_EXIT -ErrorAction SilentlyContinue
    } else {
        $env:LTERMINAL_SMOKE_AUTO_EXIT = $previousSmokeAutoExit
    }
    if ($null -eq $previousDisableAdmin) {
        Remove-Item Env:LTERMINAL_E2E_DISABLE_ADMIN -ErrorAction SilentlyContinue
    } else {
        $env:LTERMINAL_E2E_DISABLE_ADMIN = $previousDisableAdmin
    }
    if ($null -eq $previousDisablePathAuto) {
        Remove-Item Env:LTERMINAL_E2E_DISABLE_PATH_AUTO -ErrorAction SilentlyContinue
    } else {
        $env:LTERMINAL_E2E_DISABLE_PATH_AUTO = $previousDisablePathAuto
    }
    if ($null -eq $previousE2eTesting) {
        Remove-Item Env:LTERMINAL_E2E_TESTING -ErrorAction SilentlyContinue
    } else {
        $env:LTERMINAL_E2E_TESTING = $previousE2eTesting
    }
    if ($null -eq $previousE2eAppDataDir) {
        Remove-Item Env:LTERMINAL_E2E_APP_DATA_DIR -ErrorAction SilentlyContinue
    } else {
        $env:LTERMINAL_E2E_APP_DATA_DIR = $previousE2eAppDataDir
    }
    try {
        if ($hadAppCompatValue) {
            if (-not (Test-Path -LiteralPath $appCompatLayersKey)) {
                New-Item -Path $appCompatLayersKey -Force | Out-Null
            }
            New-ItemProperty -LiteralPath $appCompatLayersKey -Name $appCompatValueName -PropertyType String -Value $previousAppCompatValue -Force | Out-Null
        } else {
            $currentAppCompatProperties = Get-ItemProperty -LiteralPath $appCompatLayersKey -ErrorAction SilentlyContinue
            if ($currentAppCompatProperties -and $currentAppCompatProperties.PSObject.Properties[$appCompatValueName]) {
                Remove-ItemProperty -LiteralPath $appCompatLayersKey -Name $appCompatValueName -ErrorAction Stop
            }
        }
    } catch {
        Write-Err "No se pudo restaurar exactamente la compatibilidad AppCompat del ejecutable después del smoke: $_"
        throw
    }
}

# ---------------------------------------------------------------------------
# 8b. Pruebas ampliadas
# ---------------------------------------------------------------------------
# El smoke ya comprobó ventana, frontend, xterm y PTY. Esta batería adicional
# comprueba los ejecutables que la aplicación usa para preparar una sesión en
# Windows y ejecuta el E2E real de WebDriver (pestañas, menús, acciones y
# redimensionado). Se ejecuta por defecto en todos los modos: omitirla requiere
# -NoExtendedTests explícito para que una build no parezca verificada cuando
# solo arrancó la ventana.
$runExtendedTests = $FullTests.IsPresent -or $StrictTests.IsPresent
$strictExtendedTests = $FullTests.IsPresent -or $StrictTests.IsPresent -or (-not $NoExtendedTests.IsPresent)
$strictProbeFailure = $false
if ($NoExtendedTests) {
    $runExtendedTests = $false
    Write-Warn 'Batería ampliada omitida por -NoExtendedTests: esta build solo valida el arranque mínimo.'
} elseif ($runExtendedTests) {
    Write-Host '    Batería ampliada seleccionada explícitamente.' -ForegroundColor DarkGray
} else {
    $runExtendedTests = $true
    Write-Host '    Batería ampliada activada por defecto: se ejecutarán shells, herramientas y E2E.' -ForegroundColor DarkGray
}
if ($runExtendedTests) {
    try {
        Write-Step 'Pruebas ampliadas de Windows (shells, herramientas y E2E)'
    $systemCmd = if (-not [string]::IsNullOrWhiteSpace($env:ComSpec)) { $env:ComSpec } else { 'cmd.exe' }
    $probes = @(
        @{ Name = 'cmd'; Exe = $systemCmd; Args = @('/d', '/c', 'exit 0') },
        @{ Name = 'PowerShell'; Exe = 'powershell.exe'; Args = @('-NoProfile', '-NonInteractive', '-Command', 'exit 0') },
        @{ Name = 'PowerShell 7'; Exe = 'pwsh'; Args = @('-NoProfile', '-NonInteractive', '-Command', 'exit 0') },
        @{ Name = 'Nushell'; Exe = 'nu'; Args = @('--version') },
        # `wt.exe --version` abre un diálogo gráfico de ayuda en lugar de ser
        # una sonda CLI. Se lee la versión del alias ejecutable sin lanzarlo.
        @{ Name = 'Windows Terminal'; Detect = 'wt.exe'; Exe = 'powershell.exe'; Args = @('-NoProfile', '-NonInteractive', '-Command', '$wt = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue; if (-not $wt) { exit 1 }; $wt.FileVersionInfo.ProductVersion') },
        @{ Name = 'NSudo'; Exe = 'NSudoLC.exe'; Args = @('-?') },
        @{ Name = 'Node.js'; Exe = 'node'; Args = @('-e', 'process.exit(0)') },
        @{ Name = 'npm'; Exe = 'npm'; Args = @('--version') },
        @{ Name = 'Git'; Exe = 'git'; Args = @('--version') },
        # Windows PowerShell 5.1 elimina comillas dobles internas al construir
        # la línea de un proceso nativo. Código como print("texto") llegaba a
        # Python como print(texto). Las comillas simples forman parte del
        # argumento y son sintaxis válida en estos intérpretes.
        @{ Name = 'Python'; Exe = 'python'; Args = @('-I', '-c', "print('LTERMINAL_REPL_OK')"); Expect = 'LTERMINAL_REPL_OK' },
        @{ Name = 'Ruby'; Exe = 'ruby'; Args = @('-e', "puts 'LTERMINAL_REPL_OK'"); Expect = 'LTERMINAL_REPL_OK' },
        @{ Name = 'PHP'; Exe = 'php'; Args = @('-r', "echo 'LTERMINAL_REPL_OK';"); Expect = 'LTERMINAL_REPL_OK' },
        @{ Name = 'MariaDB'; Exe = 'mariadb'; Args = @('--version') },
        @{ Name = 'MySQL'; Exe = 'mysql'; Args = @('--version') },
        @{ Name = 'PostgreSQL'; Exe = 'psql'; Args = @('--version') },
        @{ Name = 'Kotlin'; Exe = 'kotlinc'; Args = @('-version') },
        @{ Name = 'Dart'; Exe = 'dart'; Args = @('--version') },
        @{ Name = 'Zig'; Exe = 'zig'; Args = @('version') },
        @{ Name = 'Swift'; Exe = 'swift'; Args = @('--version') },
        @{ Name = 'MongoDB Shell'; Exe = 'mongosh'; Args = @('--version') },
        @{ Name = 'Redis CLI'; Exe = 'redis-cli'; Args = @('--version') },
        @{ Name = 'Rust/Cargo'; Exe = 'cargo'; Args = @('--version') },
        @{ Name = 'Rustc'; Exe = 'rustc'; Args = @('--version') },
        @{ Name = 'Java'; Exe = 'java'; Args = @('-version') },
        @{ Name = 'Go'; Exe = 'go'; Args = @('version') },
        @{ Name = 'Perl'; Exe = 'perl'; Args = @('-e', 'print qq(LTERMINAL_REPL_OK\n)'); Expect = 'LTERMINAL_REPL_OK' },
        @{ Name = 'Lua'; Exe = 'lua'; Args = @('-e', "print('LTERMINAL_REPL_OK')"); Expect = 'LTERMINAL_REPL_OK' },
        @{ Name = 'Deno'; Exe = 'deno'; Args = @('--version') },
        @{ Name = 'Bun'; Exe = 'bun'; Args = @('--version') },
        @{ Name = 'Julia'; Exe = 'julia'; Args = @('--version') },
        @{ Name = 'R'; Exe = 'R.exe'; Args = @('--version') },
        @{ Name = '.NET'; Exe = 'dotnet'; Args = @('--info') },
        @{ Name = 'Clang'; Exe = 'clang'; Args = @('--version') },
        @{ Name = 'CMake'; Exe = 'cmake'; Args = @('--version') },
        @{ Name = 'Maven'; Exe = 'mvn'; Args = @('--version') },
        @{ Name = 'Gradle'; Exe = 'gradle'; Args = @('--version') },
        @{ Name = 'Ant'; Exe = 'ant'; Args = @('-version') },
        @{ Name = 'Bazel'; Exe = 'bazel'; Args = @('--version') },
        @{ Name = 'Ninja'; Exe = 'ninja'; Args = @('--version') },
        @{ Name = 'Meson'; Exe = 'meson'; Args = @('--version') },
        @{ Name = 'GDB'; Exe = 'gdb'; Args = @('--version') },
        @{ Name = 'Groovy'; Exe = 'groovysh'; Args = @('--version') },
        @{ Name = 'SQLite'; Exe = 'sqlite3'; Args = @('--version') },
        @{ Name = 'jq'; Exe = 'jq'; Args = @('--version') },
        @{ Name = 'yq'; Exe = 'yq'; Args = @('--version') },
        @{ Name = 'Docker'; Exe = 'docker'; Args = @('--version') },
        @{ Name = 'kubectl'; Exe = 'kubectl'; Args = @('version', '--client=true') },
        @{ Name = 'Helm'; Exe = 'helm'; Args = @('version', '--short') },
        @{ Name = 'k9s'; Exe = 'k9s'; Args = @('version', '--short') },
        @{ Name = 'OpenVPN'; Exe = 'openvpn'; Args = @('--version') },
        @{ Name = 'WireGuard'; Exe = 'wg.exe'; Args = @('--version') },
        @{ Name = 'Tailscale'; Exe = 'tailscale'; Args = @('version') },
        @{ Name = 'QEMU'; Exe = 'qemu-system-x86_64'; Args = @('--version') },
        @{ Name = 'VirtualBox'; Exe = 'VBoxManage.exe'; Args = @('--version') }
    )
    $missingProbes = @()
    $failedProbes = @()
    foreach ($probe in $probes) {
        $resolvedExe = Resolve-ProbeExecutable $probe
        $detectCommand = if ($probe.ContainsKey('Detect')) { [string]$probe.Detect } else { [string]$probe.Exe }
        if (-not $resolvedExe -or ($probe.ContainsKey('Detect') -and -not (Test-Command $detectCommand))) {
            Write-Warn "$($probe.Name) no está instalado o no está en PATH."
            $missingProbes += $probe.Name
            continue
        }
        $probeCode = Invoke-Native $resolvedExe $probe.Args -CaptureOutput
        if ($probeCode -eq 9009) {
            Write-Warn "$($probe.Name) tiene una entrada en PATH, pero su ejecutable real no está disponible."
            $missingProbes += $probe.Name
            continue
        }
        if ($probeCode -ne 0) {
            Write-Warn "$($probe.Name) falló (código $probeCode); se continúa para no ocultar el resto de diagnósticos."
            $failedProbes += "$($probe.Name) [$probeCode]"
            continue
        }
        if ($probe.ContainsKey('Expect') -and
            $script:LastNativeOutput -notmatch [regex]::Escape([string]$probe.Expect)) {
            Write-Warn "$($probe.Name) terminó con código 0, pero no produjo el marcador esperado."
            $failedProbes += "$($probe.Name) [sin marcador]"
            continue
        }
        Write-Ok "$($probe.Name) respondió correctamente"
    }
    Write-Host "    Resumen de herramientas: $($probes.Count - $missingProbes.Count)/$($probes.Count) disponibles." -ForegroundColor Cyan
    if ($missingProbes.Count -gt 0) {
        Write-Warn "Faltan $($missingProbes.Count) sondas: $($missingProbes -join ', ')"
    }
    if ($failedProbes.Count -gt 0) {
        Write-Warn "Fallaron $($failedProbes.Count) sondas: $($failedProbes -join ', ')"
    }
    # -FullTests exige que todo lo instalado responda y que se ejecute el E2E,
    # pero el catálogo contiene herramientas opcionales: no obliga a tenerlas
    # todas. -StrictTests sí convierte también las ausencias en fallo.
    $strictProbeFailure = ($strictExtendedTests -and $failedProbes.Count -gt 0) -or
        ($StrictTests.IsPresent -and $missingProbes.Count -gt 0)

    # La batería ampliada está activa por defecto, por tanto su controlador no
    # puede depender de una segunda opción que el usuario tenga que adivinar.
    # -InstallE2eDriver se conserva por compatibilidad con comandos antiguos,
    # pero una build que llega hasta E2E prepara el driver siempre que falte.
    if (-not (Test-Command 'tauri-driver')) {
        if (-not (Test-Command 'cargo')) {
            throw 'E2E no se puede preparar: falta cargo para instalar tauri-driver.'
        }
        Write-Warn 'Falta tauri-driver; se instalará automáticamente con cargo para completar E2E.'
        $driverCode = Invoke-Native 'cargo' @('install', 'tauri-driver', '--locked')
        if ($driverCode -ne 0) { throw "No se pudo instalar tauri-driver (código $driverCode)." }
        Refresh-EnvironmentPath
        if (-not (Test-Command 'tauri-driver')) {
            throw 'cargo terminó sin error, pero tauri-driver no apareció en PATH. Comprueba %USERPROFILE%\.cargo\bin.'
        }
        Write-Ok 'tauri-driver instalado y disponible para la batería E2E'
    }
    $nativeE2eDriver = Ensure-MsEdgeDriver
    Write-Step 'E2E ampliado (WebDriver, ventana, terminal y paneles)'
    if (Test-Command 'tauri-driver') {
        $previousE2eBinary = $env:E2E_BINARY
        $previousE2eReport = $env:LTERMINAL_SMOKE_REPORT
        $previousE2eLogFile = $env:LTERMINAL_LOG_FILE
        $previousNativeE2eDriver = $env:TAURI_NATIVE_DRIVER
        $previousE2eCaptureDir = $env:E2E_CAPTURE_DIR
        $e2eUnpackedDir = Join-Path (Get-BuildArtifactsDir) 'e2e-desempaquetado'
        try {
            # El smoke activa CDP mediante la API de WebView2 al lanzar la app.
            # Probar la propia release evita una segunda compilación y asegura
            # que el ejecutable que se distribuye supera también el E2E.
            $env:E2E_BINARY = Join-Path $distDir 'wterminal.exe'
            New-Item -ItemType Directory -Force -Path $e2eUnpackedDir | Out-Null
            $env:LTERMINAL_SMOKE_REPORT = Join-Path $e2eUnpackedDir 'e2e-report.json'
            $env:E2E_CAPTURE_DIR = Join-Path $e2eUnpackedDir 'capturas'
            $e2eUnpackedStartedAt = [DateTime]::UtcNow
            $env:TAURI_NATIVE_DRIVER = $nativeE2eDriver
            # El binario lanzado por tauri-driver debe escribir en el mismo
            # archivo que el smoke de arranque. Así el informe no puede pasar
            # por leer un log antiguo o una ruta distinta de la release.
            $env:LTERMINAL_LOG_FILE = $logPath
            $e2eReportPath = $env:LTERMINAL_SMOKE_REPORT
            Write-Host "    Informe E2E: $e2eReportPath" -ForegroundColor DarkGray
            $e2eCode = Invoke-Native 'npm' @('run', 'e2e')
            if ($e2eCode -ne 0) { throw "E2E falló (código $e2eCode). Revisa el informe y el log en $logPath." }
            Assert-E2eReport $e2eReportPath
            $reportCode = Invoke-Native 'node' @('scripts/verify-e2e-report.mjs', $e2eReportPath) -CaptureOutput
            # El verificador escribe «Informe E2E verificado» cuando todo va
            # bien. Buscar cualquier aparición de «informe E2E» convertía ese
            # mensaje de éxito en un falso fallo aunque el proceso devolviese
            # código 0. Solo se consideran errores las formas explícitas del
            # stack de Node o de los mensajes de rechazo del verificador.
            $reportOutputFailed = $script:LastNativeOutput -match '(?im)(?:^\s*Error:|^\s*El E2E no\b|\binforme E2E (?:incompleto|no es|no valid[oó]|fall[oó])\b)'
            if ($reportCode -ne 0 -or $reportOutputFailed) {
                throw "El informe E2E está incompleto (código $reportCode): $e2eReportPath"
            }
            Write-Ok 'E2E confirmó todas las fases: ventana, terminal, paneles, comandos, preferencias y redimensionado'
            Add-BuildTest 'E2E completo del desempaquetado' 'OK' ('{0:N0} s' -f ([DateTime]::UtcNow - $e2eUnpackedStartedAt).TotalSeconds)
        } catch {
            Add-BuildTest 'E2E completo del desempaquetado' 'FALLO' $_.Exception.Message
            throw
        } finally {
            if ($null -eq $previousE2eCaptureDir) { Remove-Item Env:E2E_CAPTURE_DIR -ErrorAction SilentlyContinue } else { $env:E2E_CAPTURE_DIR = $previousE2eCaptureDir }
            if ($null -eq $previousE2eBinary) {
                Remove-Item Env:E2E_BINARY -ErrorAction SilentlyContinue
            } else {
                $env:E2E_BINARY = $previousE2eBinary
            }
            if ($null -eq $previousE2eReport) {
                Remove-Item Env:LTERMINAL_SMOKE_REPORT -ErrorAction SilentlyContinue
            } else {
                $env:LTERMINAL_SMOKE_REPORT = $previousE2eReport
            }
            if ($null -eq $previousE2eLogFile) {
                Remove-Item Env:LTERMINAL_LOG_FILE -ErrorAction SilentlyContinue
            } else {
                $env:LTERMINAL_LOG_FILE = $previousE2eLogFile
            }
            if ($null -eq $previousNativeE2eDriver) {
                Remove-Item Env:TAURI_NATIVE_DRIVER -ErrorAction SilentlyContinue
            } else {
                $env:TAURI_NATIVE_DRIVER = $previousNativeE2eDriver
            }
        }
    } else {
        throw 'E2E no se ejecutó: tauri-driver sigue sin estar disponible después de prepararlo.'
    }

        if ($singleFileCreated -and (Test-Path -LiteralPath $singleFilePath -PathType Leaf) -and (Test-Command 'tauri-driver')) {
            try {
                Write-Step 'E2E ampliado del portable de un solo archivo, solo en una carpeta vacía'
                $previousSingleE2eBinary = $env:E2E_BINARY
                $previousSingleE2eReport = $env:LTERMINAL_SMOKE_REPORT
                $previousSingleE2eLogFile = $env:LTERMINAL_LOG_FILE
                $previousSingleNativeDriver = $env:TAURI_NATIVE_DRIVER
                $previousSingleExpect = $env:E2E_EXPECT_SINGLE_FILE
                $previousSingleCaptureDir = $env:E2E_CAPTURE_DIR
                $previousSingleVideo = $env:E2E_CAPTURE_VIDEO
                $e2ePortableDir = Join-Path (Get-BuildArtifactsDir) 'e2e-portable'
                try {
                    # El portable es el propio ejecutable de Tauri con conpty,
                    # OpenConsole y el instalador de WebView2 dentro. Se copia
                    # SOLO a una carpeta vacía: si arranca, abre shells y pasa el
                    # recorrido completo ahí, no depende de nada a su lado. El
                    # smoke exige además que el ConPTY salga de su caché.
                    $portableAloneDir = Join-Path $script:BuildTempDir 'single-file-e2e'
                    Remove-Item -LiteralPath $portableAloneDir -Recurse -Force -ErrorAction SilentlyContinue
                    New-Item -ItemType Directory -Path $portableAloneDir -Force | Out-Null
                    $portableAlone = Join-Path $portableAloneDir (Split-Path -Leaf $singleFilePath)
                    Copy-Item -LiteralPath $singleFilePath -Destination $portableAlone -Force
                    $portableVerifyCode = Invoke-Native 'node' @('scripts/create-single-file-portable.mjs', '--verify', $portableAlone, '--input', $distDir)
                    if ($portableVerifyCode -ne 0) { throw "El portable no coincide con la release unpacked (código $portableVerifyCode)." }
                    Write-Ok 'Portable: imagen PE y archivos embebidos coinciden por SHA256 con la release unpacked'
                    $env:E2E_BINARY = $portableAlone
                    $env:E2E_EXPECT_SINGLE_FILE = '1'
                    New-Item -ItemType Directory -Force -Path $e2ePortableDir | Out-Null
                    $env:LTERMINAL_SMOKE_REPORT = Join-Path $e2ePortableDir 'e2e-report.json'
                    $env:E2E_CAPTURE_DIR = Join-Path $e2ePortableDir 'capturas'
                    # Con -VideoTest cada forma de distribución deja su vídeo:
                    # el desempaquetado en la suite «video», el instalador en
                    # la suite «installer» y el portable aquí.
                    if ($VideoTest.IsPresent) { $env:E2E_CAPTURE_VIDEO = '1' }
                    $e2ePortableStartedAt = [DateTime]::UtcNow
                    $env:TAURI_NATIVE_DRIVER = $nativeE2eDriver
                    $env:LTERMINAL_LOG_FILE = $logPath
                    $singleE2eReportPath = $env:LTERMINAL_SMOKE_REPORT
                    Write-Host "    Informe E2E portable: $singleE2eReportPath" -ForegroundColor DarkGray
                    $singleE2eCode = Invoke-Native 'npm' @('run', 'e2e')
                    if ($singleE2eCode -ne 0) { throw "E2E del portable falló (código $singleE2eCode). Revisa el informe y el log en $logPath." }
                    Assert-E2eReport $singleE2eReportPath
                    $singleReportCode = Invoke-Native 'node' @('scripts/verify-e2e-report.mjs', $singleE2eReportPath) -CaptureOutput
                    $singleReportOutputFailed = $script:LastNativeOutput -match '(?im)(?:^\s*Error:|^\s*El E2E no\b|\binforme E2E (?:incompleto|no es|no valid[oó]|fall[oó])\b)'
                    if ($singleReportCode -ne 0 -or $singleReportOutputFailed) {
                        throw "El informe E2E del portable está incompleto (código $singleReportCode): $singleE2eReportPath"
                    }
                    $portableLeftovers = @(Get-ChildItem -LiteralPath $portableAloneDir -Force | Where-Object { $_.FullName -ne $portableAlone })
                    if ($portableLeftovers.Count -gt 0) {
                        throw "El portable dejó archivos junto a sí: $(($portableLeftovers | ForEach-Object Name) -join ', ')"
                    }
                    Write-Ok 'E2E confirmó todas las fases con el portable solo en su carpeta, sin dejar nada a su lado'
                    Add-BuildTest "E2E completo del portable$(if ($VideoTest.IsPresent) { ' (con vídeo)' })" 'OK' ('{0:N0} s' -f ([DateTime]::UtcNow - $e2ePortableStartedAt).TotalSeconds)
                } catch {
                    Add-BuildTest 'E2E completo del portable' 'FALLO' $_.Exception.Message
                    throw
                } finally {
                    if ($null -eq $previousSingleCaptureDir) { Remove-Item Env:E2E_CAPTURE_DIR -ErrorAction SilentlyContinue } else { $env:E2E_CAPTURE_DIR = $previousSingleCaptureDir }
                    if ($null -eq $previousSingleVideo) { Remove-Item Env:E2E_CAPTURE_VIDEO -ErrorAction SilentlyContinue } else { $env:E2E_CAPTURE_VIDEO = $previousSingleVideo }
                    if ($null -eq $previousSingleE2eBinary) { Remove-Item Env:E2E_BINARY -ErrorAction SilentlyContinue } else { $env:E2E_BINARY = $previousSingleE2eBinary }
                    if ($null -eq $previousSingleE2eReport) { Remove-Item Env:LTERMINAL_SMOKE_REPORT -ErrorAction SilentlyContinue } else { $env:LTERMINAL_SMOKE_REPORT = $previousSingleE2eReport }
                    if ($null -eq $previousSingleE2eLogFile) { Remove-Item Env:LTERMINAL_LOG_FILE -ErrorAction SilentlyContinue } else { $env:LTERMINAL_LOG_FILE = $previousSingleE2eLogFile }
                    if ($null -eq $previousSingleNativeDriver) { Remove-Item Env:TAURI_NATIVE_DRIVER -ErrorAction SilentlyContinue } else { $env:TAURI_NATIVE_DRIVER = $previousSingleNativeDriver }
                    if ($null -eq $previousSingleExpect) { Remove-Item Env:E2E_EXPECT_SINGLE_FILE -ErrorAction SilentlyContinue } else { $env:E2E_EXPECT_SINGLE_FILE = $previousSingleExpect }
                }
            } catch {
                Add-PostBuildIssue "E2E portable de un solo archivo: $($_.Exception.Message)"
            }
        }

        if ($strictProbeFailure) {
            throw 'La batería ampliada detectó herramientas instaladas que fallaron, o ausencias bajo -StrictTests. Revisa el diagnóstico anterior.'
        }
    } catch {
        # El binario/instalador ya compilado debe publicarse aunque una sonda
        # opcional o el WebDriver fallen. El detalle queda visible al final y
        # mantiene el código de salida no cero para no ocultarlo a CI.
        Add-PostBuildIssue "Batería ampliada/E2E: $($_.Exception.Message)"
    }
}

if ($CrossLinux) {
    try {
        Invoke-CrossLinuxTests
    } catch {
        Add-PostBuildIssue "Build/pruebas Linux en WSL: $($_.Exception.Message)"
    }
}

if ($runExtendedTests) {
    Write-Ok 'Validación completa de Windows: batería de herramientas y E2E ejecutados'
} else {
    Write-Warn 'Validación parcial de Windows: solo se ejecutó el smoke mínimo; no se probaron pestañas, menús ni redimensionado.'
}

# ---------------------------------------------------------------------------
# 9. Release comprimida
# ---------------------------------------------------------------------------
# El nombre importa: es el que busca el actualizador de la propia app al elegir
# el adjunto de la release (ver self_update::asset_for_platform, que se queda
# con el .zip que no mencione otra plataforma).
Write-Step 'Comprimiendo la release y calculando su huella'
$releaseRoot = $env:LTERMINAL_RELEASE_DIR
if ([string]::IsNullOrWhiteSpace($releaseRoot)) {
    $releaseRoot = Join-Path $ProjectRoot 'release'
} elseif (-not [IO.Path]::IsPathRooted($releaseRoot)) {
    $releaseRoot = Join-Path $ProjectRoot $releaseRoot
}
$releaseOut = [IO.Path]::GetFullPath($releaseRoot)
if ($Fast) {
    $releaseOut = Join-Path $distRoot 'dev'
}
New-Item -ItemType Directory -Force -Path $releaseOut | Out-Null
if (-not $Fast) {
    # release\ debe contener exactamente lo que se sube a GitHub de ESTA
    # versión. Lo demás (carpetas de builds anteriores, otras versiones y el
    # manifiesto viejo, que se regenera ahora) se aparta sin borrarlo.
    $keepInRelease = @()
    if ($singleFileCreated) { $keepInRelease += (Split-Path $singleFilePath -Leaf) }
    $stale = @(Get-ChildItem -LiteralPath $releaseOut -Force | Where-Object { $keepInRelease -notcontains $_.Name })
    if ($stale.Count -gt 0) {
        $staleArchive = Join-Path $distRoot ('release-anterior\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Force -Path $staleArchive | Out-Null
        foreach ($entry in $stale) {
            Move-Item -LiteralPath $entry.FullName -Destination (Join-Path $staleArchive $entry.Name) -Force
        }
        Write-Ok "Contenido anterior de release\ apartado en $staleArchive ($($stale.Count) elementos)"
    }
}
$zipSuffix = if ($Fast) { '-dev' } else { '' }
$zipPath = Join-Path $releaseOut "WTerminal-Unpacked-$version$zipSuffix.zip"
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
# Se comprime el CONTENIDO, sin carpeta intermedia. El actualizador acepta las
# dos formas, pero asi la carpeta de destino queda igual que la de aqui.
Compress-Archive -Path (Join-Path $distDir '*') -DestinationPath $zipPath -Force

$hash = Get-Sha256Hash $zipPath
$checksumManifest = Join-Path $releaseOut 'SHA256SUMS.txt'
$hashCode = Invoke-Native 'node' @(
    'scripts/update-release-hash.mjs',
    '--manifest', $checksumManifest,
    '--artifact', (Split-Path $zipPath -Leaf),
    '--hash', $hash
)
if ($hashCode -ne 0) { throw "No se pudo actualizar el manifiesto SHA256: $checksumManifest" }
Write-Ok "Release: $zipPath"
Write-Ok "SHA256: $hash"
# Lo que esta build publica: la validación final exige exactamente estos
# artefactos en SHA256SUMS.txt (una build portable sin instalador ni .exe único solo
# publica el ZIP y antes fallaba por exigir siempre dos).
$publishedArtifacts = @((Split-Path $zipPath -Leaf))

if ($singleFileCreated) {
    if (-not (Test-Path -LiteralPath $singleFilePath -PathType Leaf)) {
        throw "El portable de un solo archivo se creó pero no está disponible para publicar: $singleFilePath"
    }
    $singleFileHash = Get-Sha256Hash $singleFilePath
    $singleHashCode = Invoke-Native 'node' @(
        'scripts/update-release-hash.mjs',
        '--manifest', $checksumManifest,
        '--artifact', (Split-Path $singleFilePath -Leaf),
        '--hash', $singleFileHash
    )
    if ($singleHashCode -ne 0) { throw "No se pudo actualizar el manifiesto SHA256 del portable: $checksumManifest" }
    $publishedArtifacts += (Split-Path $singleFilePath -Leaf)
    Write-Ok "Portable de un solo archivo: $singleFilePath"
    Write-Ok "SHA256 portable: $singleFileHash"
}

# El bundle NSIS de Tauri pertenece a target/ porque es salida intermedia de
# Cargo, pero el instalador también es un artefacto publicable. Se copia con
# un nombre estable junto al ZIP para que no haya que buscarlo en target/ ni
# se confunda con una build anterior. La fuente se conserva: Tauri puede
# reutilizarla durante builds posteriores y el destino de distribución se
# controla con LTERMINAL_RELEASE_DIR (por defecto, release/).
if ($Installer) {
    if ($null -eq $installerPath -or -not (Test-Path -LiteralPath $installerPath.FullName -PathType Leaf)) {
        throw 'La build indicó que generó NSIS, pero no queda ningún instalador para publicar.'
    }
    $installerReleasePath = Join-Path $releaseOut "WTerminal-$version$zipSuffix-x64-setup.exe"
    Copy-Item -LiteralPath $installerPath.FullName -Destination $installerReleasePath -Force
    $publishedInstaller = Get-Item -LiteralPath $installerReleasePath
    if ($publishedInstaller.Length -ne $installerPath.Length -or $publishedInstaller.Length -lt 100MB) {
        throw "La copia del instalador NSIS en release es incompleta: $installerReleasePath"
    }
    $installerHash = Get-Sha256Hash $installerReleasePath
    $sourceInstallerHash = Get-Sha256Hash $installerPath.FullName
    if ($installerHash -ne $sourceInstallerHash) {
        throw "La copia del instalador NSIS no coincide con el bundle generado: $installerReleasePath"
    }
    $installerHashCode = Invoke-Native 'node' @(
        'scripts/update-release-hash.mjs',
        '--manifest', $checksumManifest,
        '--artifact', (Split-Path $installerReleasePath -Leaf),
        '--hash', $installerHash
    )
    if ($installerHashCode -ne 0) { throw "No se pudo actualizar el manifiesto SHA256 del instalador: $checksumManifest" }
    $publishedArtifacts += (Split-Path $installerReleasePath -Leaf)
    Write-Ok "Instalador publicado: $installerReleasePath"
    Write-Ok "SHA256 instalador: $installerHash"
}

function Import-LocalSigningMaterial {
    # Las builds locales pueden reutilizar el mismo material que linux. CI no
    # inspecciona el perfil ni el Escritorio: recibe sus secretos explícitos.
    if ($env:CI -match '^(1|true|yes)$') { return }

    $configRoot = if (-not [string]::IsNullOrWhiteSpace($env:XDG_CONFIG_HOME)) {
        $env:XDG_CONFIG_HOME
    } elseif ($env:USERPROFILE) {
        Join-Path $env:USERPROFILE '.config'
    }
    $desktop = [Environment]::GetFolderPath('Desktop')
    $documents = [Environment]::GetFolderPath('MyDocuments')
    $privateCandidates = @(
        $env:LTERMINAL_SIGNING_PRIVATE_KEY_FILE,
        $(if ($configRoot) { Join-Path $configRoot 'lterminal\release-signing-private.pem' }),
        $(if ($desktop) { Join-Path $desktop 'release-signing-private.pem' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | ForEach-Object { $_ }
    $privateCandidates = @($privateCandidates)
    $publicCandidates = @(
        $env:LTERMINAL_UPDATE_PUBLIC_KEY_FILE,
        $(if ($configRoot) { Join-Path $configRoot 'lterminal\release-signing-public.hex' }),
        $(if ($desktop) { Join-Path $desktop 'release-signing-public.hex' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | ForEach-Object { $_ }
    $publicCandidates = @($publicCandidates)

    # La firma SSH adicional es la autorización de publicación de releases.
    # Se reutiliza la convención del proyecto Tools y nunca se copia la clave
    # privada al repositorio: solo se pasa su ruta al helper de ssh-keygen.
    $sshPrivateCandidates = @(
        $env:LTERMINAL_SSH_SIGNING_KEY_FILE,
        $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.ssh\lterminal-release-signing' }),
        $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.ssh\ltools-release-signing' }),
        $(if ($documents) { Join-Path $documents '.ssh\lterminal-release-signing' }),
        $(if ($documents) { Join-Path $documents '.ssh\ltools-release-signing' }),
        $(if ($desktop) { Join-Path $desktop 'lterminal-release-signing' }),
        $(if ($desktop) { Join-Path $desktop 'ltools-release-signing' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | ForEach-Object { $_ }
    $sshPrivateCandidates = @($sshPrivateCandidates)
    $sshPublicCandidates = @(
        $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE,
        $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.ssh\lterminal-release-signing.pub' }),
        $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.ssh\ltools-release-signing.pub' }),
        $(if ($documents) { Join-Path $documents '.ssh\lterminal-release-signing.pub' }),
        $(if ($documents) { Join-Path $documents '.ssh\ltools-release-signing.pub' }),
        $(if ($desktop) { Join-Path $desktop 'lterminal-release-signing.pub' }),
        $(if ($desktop) { Join-Path $desktop 'ltools-release-signing.pub' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | ForEach-Object { $_ }
    $sshPublicCandidates = @($sshPublicCandidates)

    if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_SIGNING_PRIVATE_KEY) -and $privateCandidates.Count -gt 0) {
        $env:LTERMINAL_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath $privateCandidates[0] -Raw
    }
    if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_UPDATE_PUBLIC_KEY) -and $publicCandidates.Count -gt 0) {
        $env:LTERMINAL_UPDATE_PUBLIC_KEY = (Get-Content -LiteralPath $publicCandidates[0] -Raw).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_SSH_SIGNING_KEY_FILE) -and $sshPrivateCandidates.Count -gt 0) {
        $env:LTERMINAL_SSH_SIGNING_KEY_FILE = $sshPrivateCandidates[0]
    }
    if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE) -and $sshPublicCandidates.Count -gt 0) {
        $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE = $sshPublicCandidates[0]
    }
    if ($env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE -and [string]::IsNullOrWhiteSpace($env:LTERMINAL_SSH_UPDATE_PUBLIC_KEY)) {
        $env:LTERMINAL_SSH_UPDATE_PUBLIC_KEY = (Get-Content -LiteralPath $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE -Raw).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_SSH_SIGNING_IDENTITY)) {
        $env:LTERMINAL_SSH_SIGNING_IDENTITY = if ($env:GIT_AUTHOR_EMAIL) { $env:GIT_AUTHOR_EMAIL } else { 'lterminal-release@local' }
    }
    if ([string]::IsNullOrWhiteSpace($env:LTERMINAL_SSH_UPDATE_IDENTITY)) {
        $env:LTERMINAL_SSH_UPDATE_IDENTITY = $env:LTERMINAL_SSH_SIGNING_IDENTITY
    }
    if ($env:LTERMINAL_SIGNING_PRIVATE_KEY -or $env:LTERMINAL_UPDATE_PUBLIC_KEY -or $env:LTERMINAL_SSH_SIGNING_KEY_FILE) {
        Write-Ok 'Material de firma local cargado automáticamente'
    }
}

Import-LocalSigningMaterial

$signingRequired = if (-not [string]::IsNullOrWhiteSpace($env:LTERMINAL_REQUIRE_SIGNING)) {
    $env:LTERMINAL_REQUIRE_SIGNING -match '^(1|true|yes)$'
} else {
    $env:CI -match '^(1|true|yes)$'
}
if ($env:LTERMINAL_SIGNING_PRIVATE_KEY) {
    $signatureCode = Invoke-Native 'node' @(
        'scripts/sign-release-manifest.mjs',
        '--manifest', $checksumManifest,
        '--signature', (Join-Path $releaseOut 'SHA256SUMS.txt.sig')
    )
    if ($signatureCode -ne 0) { throw 'No se pudo firmar SHA256SUMS.txt.' }
    if ($env:LTERMINAL_UPDATE_PUBLIC_KEY) {
        $verifyCode = Invoke-Native 'node' @(
            'scripts/sign-release-manifest.mjs',
            '--manifest', $checksumManifest,
            '--signature', (Join-Path $releaseOut 'SHA256SUMS.txt.sig'),
            '--verify'
        )
        if ($verifyCode -ne 0) { throw 'La firma Ed25519 del manifiesto no se pudo verificar.' }
        Write-Ok 'Firma Ed25519 del manifiesto verificada'
    } else {
        Write-Warn 'Manifiesto firmado con Ed25519, pero falta la clave pública para verificarlo localmente.'
    }
} elseif ($signingRequired) {
    throw 'Falta la clave privada Ed25519: una release oficial no puede publicarse sin firma.'
} else {
    Write-Warn 'Release local sin firma Ed25519; el actualizador rechazará este artefacto.'
}

$sshSignaturePath = Join-Path $releaseOut 'SHA256SUMS.txt.sshsig'
if ($env:LTERMINAL_SSH_SIGNING_KEY_FILE -and $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE) {
    $sshSignCode = Invoke-Native 'node' @(
        'scripts/sign-release-ssh.mjs',
        '--manifest', $checksumManifest,
        '--signature', $sshSignaturePath
    )
    if ($sshSignCode -ne 0) { throw 'No se pudo firmar SHA256SUMS.txt con OpenSSH.' }
    $sshVerifyCode = Invoke-Native 'node' @(
        'scripts/sign-release-ssh.mjs',
        '--manifest', $checksumManifest,
        '--signature', $sshSignaturePath,
        '--verify'
    )
    if ($sshVerifyCode -ne 0) { throw 'La firma OpenSSH del manifiesto no se pudo verificar.' }
    Write-Ok 'Firma SSHSIG del manifiesto verificada'
} elseif ($env:LTERMINAL_SSH_SIGNING_KEY_FILE -or $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE) {
    Write-Warn 'Material OpenSSH incompleto: se requiere la clave privada y la pública para firmar y verificar.'
} elseif ($signingRequired) {
    throw 'Faltan la clave privada SSH de firma y su clave pública: una release oficial no puede publicarse sin firma SSH.'
} else {
    Remove-Item -LiteralPath $sshSignaturePath -Force -ErrorAction SilentlyContinue
    Write-Warn 'Release local sin firma SSHSIG; el actualizador rechazará este artefacto.'
}

# Un apagado brusco a los pocos minutos dejó en release\ el instalador con su
# final a ceros y SHA256SUMS.txt, .sig y .sshsig llenos de ceros: Windows aún
# no había escrito su contenido. Cada archivo publicado se vuelca a disco
# (FlushFileBuffers) antes de seguir con pruebas largas.
function Sync-PublishedFiles([string]$Directory) {
    foreach ($file in Get-ChildItem -LiteralPath $Directory -File) {
        $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        try { $stream.Flush($true) } finally { $stream.Dispose() }
    }
}
Sync-PublishedFiles $releaseOut
Write-Ok 'Release volcada a disco (un apagado ya no la deja a medias)'

# La comprobación preventiva del catálogo también valida el informe E2E y los
# hashes/firma de la release. Esos artefactos solo existen después de este
# punto, por lo que el `npm check` inicial la ejecuta en modo diferido y aquí
# se repite una única vez con el informe recién generado como entrada.
if ($runExtendedTests -and -not [string]::IsNullOrWhiteSpace($e2eReportPath)) {
    $previousRequiredReport = $env:WTERMINAL_REQUIRE_E2E_REPORT
    $previousReportOverride = $env:WTERMINAL_E2E_REPORT
    $previousReleaseOverride = $env:LTERMINAL_RELEASE_DIR
    $previousExpectedArtifacts = $env:WTERMINAL_EXPECTED_RELEASE_ARTIFACTS
    $previousExpectedSignatures = $env:WTERMINAL_EXPECTED_RELEASE_SIGNATURES
    try {
        $env:WTERMINAL_EXPECTED_RELEASE_ARTIFACTS = ($publishedArtifacts -join ';')
        # Solo se exigen las firmas que esta build generó: sin clave local la
        # release queda sin firmar con un aviso, no rota.
        $env:WTERMINAL_EXPECTED_RELEASE_SIGNATURES = (@('SHA256SUMS.txt.sig', 'SHA256SUMS.txt.sshsig') |
            Where-Object { $signingRequired -or (Test-Path -LiteralPath (Join-Path $releaseOut $_) -PathType Leaf) }) -join ';'
        $env:WTERMINAL_REQUIRE_E2E_REPORT = '1'
        $env:WTERMINAL_E2E_REPORT = $e2eReportPath
        $env:LTERMINAL_RELEASE_DIR = $releaseOut
        $preventiveCode = Invoke-Native 'node' @('scripts/test-install-actions-preventive.mjs') -CaptureOutput
        if ($preventiveCode -ne 0) {
            throw "La validación preventiva final falló (código $preventiveCode)."
        }
        Write-Ok 'Validación preventiva final: catálogo, E2E, capturas, hashes y firmas'
    } finally {
        if ($null -eq $previousRequiredReport) { Remove-Item Env:WTERMINAL_REQUIRE_E2E_REPORT -ErrorAction SilentlyContinue } else { $env:WTERMINAL_REQUIRE_E2E_REPORT = $previousRequiredReport }
        if ($null -eq $previousReportOverride) { Remove-Item Env:WTERMINAL_E2E_REPORT -ErrorAction SilentlyContinue } else { $env:WTERMINAL_E2E_REPORT = $previousReportOverride }
        if ($null -eq $previousReleaseOverride) { Remove-Item Env:LTERMINAL_RELEASE_DIR -ErrorAction SilentlyContinue } else { $env:LTERMINAL_RELEASE_DIR = $previousReleaseOverride }
        if ($null -eq $previousExpectedArtifacts) { Remove-Item Env:WTERMINAL_EXPECTED_RELEASE_ARTIFACTS -ErrorAction SilentlyContinue } else { $env:WTERMINAL_EXPECTED_RELEASE_ARTIFACTS = $previousExpectedArtifacts }
        if ($null -eq $previousExpectedSignatures) { Remove-Item Env:WTERMINAL_EXPECTED_RELEASE_SIGNATURES -ErrorAction SilentlyContinue } else { $env:WTERMINAL_EXPECTED_RELEASE_SIGNATURES = $previousExpectedSignatures }
    }
}

# ---------------------------------------------------------------------------
# 10. Suites E2E estandarizadas (tests/e2e/suites.mjs)
# ---------------------------------------------------------------------------
# La batería ampliada ya ejecutó el recorrido completo sobre el ejecutable y el
# payload del portable (idéntico byte a byte a la carpeta unpacked). Aquí se
# añaden las regresiones enfocadas y, bajo demanda, el vídeo, las descargas
# reales, la auditoría del catálogo y el instalador. Todo pasa por el mismo
# ejecutor (scripts/run-e2e-suite.mjs), contra los artefactos ya firmados, y
# deja un resumen comparable en artifacts/release-validation.
$suiteNames = @()
if ($runExtendedTests -and -not $NoFocusedTests.IsPresent) { $suiteNames += 'focused' }
if ($VideoTest.IsPresent) { $suiteNames += 'video' }
if ($DownloadTests.IsPresent) { $suiteNames += 'downloads' }
if ($DependencyAudit.IsPresent) { $suiteNames += 'dependency-audit' }
if ($InstallerTest.IsPresent) { $suiteNames += 'installer' }
$script:SuiteSummaryPath = $null
$script:SuiteOutDir = $null
if ($suiteNames.Count -gt 0) {
    Write-Step "Suites E2E estandarizadas ($($suiteNames -join ', '))"
    $suiteOut = Join-Path $ProjectRoot ("artifacts\release-validation\WTerminal-$version-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $script:SuiteOutDir = $suiteOut
    $suiteArgs = @('scripts/run-e2e-suite.mjs', '--binary', (Join-Path $distDir 'wterminal.exe'), '--suite', ($suiteNames -join ','), '--out', $suiteOut)
    if ($InstallerTest.IsPresent) {
        if ($installerReleasePath -and (Test-Path -LiteralPath $installerReleasePath -PathType Leaf)) {
            $suiteArgs += @('--installer', $installerReleasePath, '--release-dir', $distDir)
            Write-Host '    La prueba del instalador pedirá permiso de administrador (UAC) una sola vez.' -ForegroundColor Yellow
        } else {
            Add-PostBuildIssue 'Prueba del instalador: no se generó el instalador NSIS, no hay nada que instalar.'
        }
    }
    $previousSuiteDriver = $env:TAURI_NATIVE_DRIVER
    $previousSuitePreference = $ErrorActionPreference
    try {
        if ($nativeE2eDriver) { $env:TAURI_NATIVE_DRIVER = $nativeE2eDriver }
        # Las suites pueden durar una hora: su progreso se muestra línea a
        # línea en vez de esperar al final como hace Invoke-Native. La salida
        # de cada escenario ya queda en su propio log; aquí solo llega el
        # resumen del ejecutor, y el código de salida decide el resultado.
        $ErrorActionPreference = 'Continue'
        & node @suiteArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
        $suiteCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousSuitePreference
        if ($null -eq $previousSuiteDriver) { Remove-Item Env:TAURI_NATIVE_DRIVER -ErrorAction SilentlyContinue } else { $env:TAURI_NATIVE_DRIVER = $previousSuiteDriver }
    }
    $script:SuiteSummaryPath = Join-Path $suiteOut 'summary.md'
    if ($suiteCode -ne 0) {
        Add-PostBuildIssue "Suites E2E estandarizadas con fallos (código $suiteCode). Resumen: $script:SuiteSummaryPath"
    } else {
        Write-Ok "Suites E2E estandarizadas: todo OK. Resumen: $script:SuiteSummaryPath"
    }
    # Una validación omitida (por ejemplo, el instalador cuando ya hay un
    # WTerminal instalado) no rompe el build, pero tampoco cuenta como hecha.
    $suiteSummaryJson = Join-Path $suiteOut 'summary.json'
    if (Test-Path -LiteralPath $suiteSummaryJson -PathType Leaf) {
        $suiteSummary = Get-Content -LiteralPath $suiteSummaryJson -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($skipped in @($suiteSummary.results | Where-Object { $_.status -eq 'skipped' })) {
            Add-PostBuildIssue "Validación omitida: $($skipped.title) — $($skipped.summary)"
        }
        foreach ($result in @($suiteSummary.results)) {
            $label = switch ($result.status) { 'passed' { 'OK' } 'skipped' { 'OMITIDA' } 'timeout' { 'FALLO' } default { 'FALLO' } }
            $seconds = if ($result.durationMs) { '{0:N0} s' -f ($result.durationMs / 1000) } else { '' }
            $detail = (@($seconds, $result.summary) | Where-Object { $_ }) -join ' · '
            Add-BuildTest "Suite $($result.suite): $($result.title)" $label $detail
        }
    } else {
        Add-BuildTest "Suites E2E ($($suiteNames -join ', '))" $(if ($suiteCode -eq 0) { 'OK' } else { 'FALLO' }) 'sin summary.json'
    }
}

if (-not $NoRun) {
    Write-Step 'Lanzando la version compilada'
    Start-Process -FilePath (Join-Path $distDir 'wterminal.exe') -WorkingDirectory $distDir
}

Write-BuildSummary
Write-Host ''
Write-Host "Listo. WTerminal $version compilado y verificado." -ForegroundColor Green
if ($script:SuiteSummaryPath) { Write-Host "  Validación E2E: $script:SuiteSummaryPath" }
if ($script:PostBuildIssues.Count -gt 0) {
    Write-Host ''
    Write-Host 'La build terminó y publicó sus artefactos, pero quedaron validaciones pendientes:' -ForegroundColor Yellow
    foreach ($issue in $script:PostBuildIssues) { Write-Host "  - $issue" -ForegroundColor Yellow }
    Write-Host 'El código de salida es 1 para que CI no ignore estos diagnósticos.' -ForegroundColor Yellow
    exit 1
}
} finally {
    try {
        Restore-VersionManifests
    } finally {
        if ($script:BuildTempDir -and (Test-Path -LiteralPath $script:BuildTempDir -PathType Container)) {
            try {
                Remove-Item -LiteralPath $script:BuildTempDir -Recurse -Force -ErrorAction Stop
            } catch {
                Write-Warning "No se pudo eliminar el temporal de build propio $script:BuildTempDir : $($_.Exception.Message)"
            }
        }
    }
}
