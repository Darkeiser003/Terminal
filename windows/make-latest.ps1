<#
.SYNOPSIS
    Crea la versión «Latest» de WTerminal a partir de una release ya hecha.

.DESCRIPTION
    La release se ofrece de dos formas: la versionada (WTerminal-1.0.0-…) y la
    «Latest», con los mismos archivos y el número cambiado por «Latest», para
    enlaces y automatizaciones que siempre quieren la última:

        WTerminal-Latest-x64-setup.exe
        WTerminal-Latest-Portable.exe
        WTerminal-Unpacked-Latest.zip

    El script copia esos archivos desde una release (por defecto release\, la
    última que dejó la build), comprueba antes sus sumas, calcula las nuevas en
    SHA256SUMS.txt y las firma igual que la build (Ed25519 y SSHSIG) si hay
    claves. Si la Latest que ya existe salió de esos mismos archivos, no hace
    nada: no hay cambios. Deja en LATEST-ORIGEN.txt de qué versión y de qué
    carpeta salió.

    No compila nada: para una Latest de código nuevo, primero la build
    (windows\build.ps1 -Latest la crea sola al terminar en verde).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File windows\make-latest.ps1
    powershell -ExecutionPolicy Bypass -File windows\make-latest.ps1 -From E:\WTerminal\releases\77 -KeysDir "C:\Users\yo\Desktop\Claves SSH"
#>
param(
    [Alias('h')][switch]$Help,
    # La release de la que sale (versionada). Por defecto, release\.
    [string]$From,
    # Dónde se deja la Latest. Por defecto, release-latest\.
    [string]$Out,
    # Carpeta de las claves de firma. Sin ella se usa la última que usó la
    # build; si tampoco hay, la Latest sale sin firmar (con aviso).
    [string]$KeysDir,
    # Rehacerla aunque no haya cambios.
    [switch]$Force,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Write-Ok([string]$Text) { Write-Host "    OK: $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "    AVISO: $Text" -ForegroundColor Yellow }
function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }

if ($Help) {
    Get-Help $PSCommandPath -Detailed
    exit 0
}

function Resolve-Folder([string]$Path, [string]$Default) {
    $chosen = if ([string]::IsNullOrWhiteSpace($Path)) { $Default } else { $Path }
    if (-not [IO.Path]::IsPathRooted($chosen)) { $chosen = Join-Path $ProjectRoot $chosen }
    return [IO.Path]::GetFullPath($chosen)
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

# Las sumas de SHA256SUMS.txt: «<hash>  <nombre>» por línea.
function Read-Sums([string]$Manifest) {
    $sums = @{}
    foreach ($line in Get-Content -LiteralPath $Manifest) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') { $sums[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant() }
    }
    return $sums
}

$source = Resolve-Folder $From 'release'
$target = Resolve-Folder $Out 'release-latest'

Write-Step "Release de origen: $source"
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "No existe la carpeta de origen: $source" }
if (Test-Path -LiteralPath (Join-Path $source 'NO-PUBLICAR.txt')) {
    throw "La release de $source está marcada como NO-PUBLICAR (build cortada o con validaciones pendientes): no se hace Latest de ella."
}
$sourceManifest = Join-Path $source 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $sourceManifest -PathType Leaf)) { throw "Falta SHA256SUMS.txt en $source" }

# Los tres archivos versionados. La versión sale del nombre del instalador.
$setup = Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Name -match '^WTerminal-(.+)-x64-setup\.exe$' -and $Matches[1] -ne 'Latest' } | Select-Object -First 1
if (-not $setup) { throw "No hay instalador versionado (WTerminal-<versión>-x64-setup.exe) en $source" }
$null = $setup.Name -match '^WTerminal-(.+)-x64-setup\.exe$'
$version = $Matches[1]
$pairs = [ordered]@{
    "WTerminal-$version-x64-setup.exe" = 'WTerminal-Latest-x64-setup.exe'
    "WTerminal-$version-Portable.exe"  = 'WTerminal-Latest-Portable.exe'
    "WTerminal-Unpacked-$version.zip"  = 'WTerminal-Unpacked-Latest.zip'
}

# Antes de copiar, el origen tiene que ser exactamente lo que dicen sus sumas.
$sourceSums = Read-Sums $sourceManifest
$present = [ordered]@{}
foreach ($name in $pairs.Keys) {
    $path = Join-Path $source $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Warn "No está $name en el origen; la Latest saldrá sin él."
        continue
    }
    if (-not $sourceSums.ContainsKey($name)) { throw "$name no figura en SHA256SUMS.txt del origen." }
    $hash = Get-Sha256 $path
    if ($hash -ne $sourceSums[$name]) { throw "$name no coincide con su suma en el origen: el archivo está dañado o cambió." }
    $present[$name] = $hash
}
if ($present.Count -eq 0) { throw "No hay nada que copiar en $source" }
Write-Ok "Versión $version, $($present.Count) archivos con sus sumas comprobadas"

# ¿Ya existe una Latest de estos mismos archivos? Entonces no hay cambios.
$originFile = Join-Path $target 'LATEST-ORIGEN.txt'
$originLines = @("Versión: $version") + @($present.Keys | ForEach-Object { "$($present[$_])  $_" })
if (-not $Force -and (Test-Path -LiteralPath $originFile -PathType Leaf)) {
    $previous = @(Get-Content -LiteralPath $originFile | Where-Object { $_ -match '^(Versión:|[0-9a-f]{64}  )' })
    $allThere = @($present.Keys | ForEach-Object { Test-Path -LiteralPath (Join-Path $target $pairs[$_]) -PathType Leaf }) -notcontains $false
    if ($allThere -and (($previous -join "`n") -eq ($originLines -join "`n"))) {
        Write-Ok "La Latest de $target ya es la versión $version con estos mismos archivos: sin cambios (usa -Force para rehacerla)."
        exit 0
    }
}

Write-Step "Creando la Latest en $target"
New-Item -ItemType Directory -Force -Path $target | Out-Null
# Fuera lo de una Latest anterior: son copias, el original sigue en su release.
foreach ($old in Get-ChildItem -LiteralPath $target -File) { Remove-Item -LiteralPath $old.FullName -Force }
$manifestLines = @()
foreach ($name in $present.Keys) {
    $latestName = $pairs[$name]
    $destination = Join-Path $target $latestName
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $destination -Force
    $hash = Get-Sha256 $destination
    if ($hash -ne $present[$name]) { throw "La copia de $name no coincide con el original." }
    $manifestLines += "$hash  $latestName"
    Write-Ok "$latestName"
}
$manifest = Join-Path $target 'SHA256SUMS.txt'
[IO.File]::WriteAllText($manifest, (($manifestLines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
Write-Ok 'SHA256SUMS.txt calculado'

# ---- Firma, como la build -------------------------------------------------
function Find-Key([string]$Folder, [string[]]$Names) {
    if (-not $Folder) { return $null }
    foreach ($root in @($Folder, (Join-Path $Folder '.ssh'))) {
        foreach ($name in $Names) {
            $candidate = Join-Path $root $name
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    return $null
}
if ([string]::IsNullOrWhiteSpace($KeysDir) -and $env:LOCALAPPDATA) {
    $memory = Join-Path $env:LOCALAPPDATA 'WTerminalBuild\keys-dir.txt'
    if (Test-Path -LiteralPath $memory -PathType Leaf) { $KeysDir = (Get-Content -LiteralPath $memory -Raw).Trim() }
}
if ($KeysDir -and -not (Test-Path -LiteralPath $KeysDir -PathType Container)) { throw "No existe la carpeta de claves: $KeysDir" }

$private = if ($env:LTERMINAL_SIGNING_PRIVATE_KEY_FILE) { $env:LTERMINAL_SIGNING_PRIVATE_KEY_FILE } else { Find-Key $KeysDir @('release-signing-private.pem') }
$public = if ($env:LTERMINAL_UPDATE_PUBLIC_KEY_FILE) { $env:LTERMINAL_UPDATE_PUBLIC_KEY_FILE } else { Find-Key $KeysDir @('release-signing-public.hex') }
$sshPrivate = if ($env:LTERMINAL_SSH_SIGNING_KEY_FILE) { $env:LTERMINAL_SSH_SIGNING_KEY_FILE } else { Find-Key $KeysDir @('lterminal-release-signing', 'ltools-release-signing') }
$sshPublic = if ($env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE) { $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE } else { Find-Key $KeysDir @('lterminal-release-signing.pub', 'ltools-release-signing.pub') }

$signed = @()
Push-Location $ProjectRoot
try {
    if ($private -and $public) {
        $env:LTERMINAL_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath $private -Raw
        $env:LTERMINAL_UPDATE_PUBLIC_KEY = (Get-Content -LiteralPath $public -Raw).Trim()
        $signature = Join-Path $target 'SHA256SUMS.txt.sig'
        & node scripts/sign-release-manifest.mjs --manifest $manifest --signature $signature
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo firmar SHA256SUMS.txt (Ed25519).' }
        & node scripts/sign-release-manifest.mjs --manifest $manifest --signature $signature --verify
        if ($LASTEXITCODE -ne 0) { throw 'La firma Ed25519 no se pudo verificar.' }
        $signed += 'Ed25519'
    } else {
        Write-Warn 'Sin claves Ed25519: la Latest sale sin esa firma (el actualizador la rechazará).'
    }
    if ($sshPrivate -and $sshPublic) {
        $env:LTERMINAL_SSH_SIGNING_KEY_FILE = $sshPrivate
        $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE = $sshPublic
        if (-not $env:LTERMINAL_SSH_SIGNING_IDENTITY) {
            $env:LTERMINAL_SSH_SIGNING_IDENTITY = if ($env:GIT_AUTHOR_EMAIL) { $env:GIT_AUTHOR_EMAIL } else { 'lterminal-release@local' }
        }
        $env:LTERMINAL_SSH_UPDATE_PUBLIC_KEY = (Get-Content -LiteralPath $sshPublic -Raw).Trim()
        $env:LTERMINAL_SSH_UPDATE_IDENTITY = $env:LTERMINAL_SSH_SIGNING_IDENTITY
        $sshSignature = Join-Path $target 'SHA256SUMS.txt.sshsig'
        & node scripts/sign-release-ssh.mjs --manifest $manifest --signature $sshSignature
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo firmar SHA256SUMS.txt con OpenSSH.' }
        & node scripts/sign-release-ssh.mjs --manifest $manifest --signature $sshSignature --verify
        if ($LASTEXITCODE -ne 0) { throw 'La firma SSHSIG no se pudo verificar.' }
        $signed += 'SSHSIG'
    } else {
        Write-Warn 'Sin claves SSH: la Latest sale sin firma SSHSIG.'
    }
} finally {
    Pop-Location
    Remove-Item Env:LTERMINAL_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
}
if ($signed.Count -gt 0) { Write-Ok "Firmas verificadas: $($signed -join ' y ')" }

Set-Content -LiteralPath $originFile -Encoding UTF8 -Value (@(
        "WTerminal Latest · $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
        "Origen: $source"
    ) + $originLines)

Write-Host ''
Write-Host "Listo. Latest = WTerminal $version, en $target" -ForegroundColor Green
exit 0
