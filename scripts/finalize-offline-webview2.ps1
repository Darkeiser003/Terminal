param([string]$Version = '1.0.0')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
# La carpeta desempaquetada es salida intermedia (src-tauri\target\dist);
# release\ solo contiene lo que se sube a GitHub.
$unpacked = Join-Path $projectRoot "src-tauri\target\dist\WTerminal-$Version"
$installer = Join-Path $releaseRoot "WTerminal-$Version-x64-setup.exe"
$portable = Join-Path $releaseRoot "WTerminal-$Version-Portable.exe"
$zip = Join-Path $releaseRoot "WTerminal-Unpacked-$Version.zip"
$manifest = Join-Path $releaseRoot 'SHA256SUMS.txt'
$sevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) { throw 'Falta 7-Zip.' }
foreach ($path in @($unpacked, $installer, $manifest)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Falta el artefacto $path" }
}

$staging = Join-Path $projectRoot 'src-tauri\target\release\portable-webview2'
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$offline = Join-Path $staging 'MicrosoftEdgeWebView2RuntimeInstaller.exe'
Remove-Item -LiteralPath $offline -Force -ErrorAction SilentlyContinue
& $sevenZip e -y "-o$staging" $installer '$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe' | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $offline -PathType Leaf)) {
    throw 'No se pudo extraer el runtime WebView2 offline del instalador NSIS.'
}
if ((Get-Item -LiteralPath $offline).Length -lt 100MB) { throw 'Runtime WebView2 offline incompleto.' }
$signature = Get-AuthenticodeSignature -LiteralPath $offline
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
    throw "Firma Authenticode de WebView2 no válida: $($signature.Status)"
}
Copy-Item -LiteralPath $offline -Destination (Join-Path $unpacked 'MicrosoftEdgeWebView2Setup.exe') -Force

Push-Location $projectRoot
try {
    & node scripts/create-single-file-portable.mjs --input $unpacked --output $portable
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo recrear el portable de un solo archivo.' }
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $unpacked '*') -DestinationPath $zip -Force
    foreach ($artifact in @($zip, $portable)) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
        & node scripts/update-release-hash.mjs --manifest $manifest --artifact (Split-Path -Leaf $artifact) --hash $hash
        if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar SHA256SUMS.txt para $artifact" }
    }

    $configRoot = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $env:USERPROFILE '.config' }
    $privateFile = if ($env:LTERMINAL_SIGNING_PRIVATE_KEY_FILE) { $env:LTERMINAL_SIGNING_PRIVATE_KEY_FILE } else { Join-Path $configRoot 'lterminal\release-signing-private.pem' }
    $publicFile = if ($env:LTERMINAL_UPDATE_PUBLIC_KEY_FILE) { $env:LTERMINAL_UPDATE_PUBLIC_KEY_FILE } else { Join-Path $configRoot 'lterminal\release-signing-public.hex' }
    if (-not (Test-Path -LiteralPath $privateFile) -or -not (Test-Path -LiteralPath $publicFile)) {
        throw 'Faltan las claves locales para volver a firmar el manifiesto.'
    }
    $env:LTERMINAL_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath $privateFile -Raw
    $env:LTERMINAL_UPDATE_PUBLIC_KEY = (Get-Content -LiteralPath $publicFile -Raw).Trim()
    & node scripts/sign-release-manifest.mjs --manifest $manifest --signature (Join-Path $releaseRoot 'SHA256SUMS.txt.sig')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo firmar el manifiesto Ed25519.' }
    & node scripts/sign-release-manifest.mjs --manifest $manifest --signature (Join-Path $releaseRoot 'SHA256SUMS.txt.sig') --verify
    if ($LASTEXITCODE -ne 0) { throw 'Falló la verificación Ed25519.' }

    $sshKey = if ($env:LTERMINAL_SSH_SIGNING_KEY_FILE) {
        $env:LTERMINAL_SSH_SIGNING_KEY_FILE
    } elseif (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.ssh\lterminal-release-signing')) {
        Join-Path $env:USERPROFILE '.ssh\lterminal-release-signing'
    } else {
        Join-Path $env:USERPROFILE '.ssh\ltools-release-signing'
    }
    $sshPublic = if ($env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE) { $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE } else { "$sshKey.pub" }
    if (-not (Test-Path -LiteralPath $sshKey) -or -not (Test-Path -LiteralPath $sshPublic)) {
        throw 'Faltan las claves SSH locales para volver a firmar el manifiesto.'
    }
    $env:LTERMINAL_SSH_SIGNING_KEY_FILE = $sshKey
    $env:LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE = $sshPublic
    $env:LTERMINAL_SSH_SIGNING_IDENTITY = if ($env:GIT_AUTHOR_EMAIL) { $env:GIT_AUTHOR_EMAIL } else { 'lterminal-release@local' }
    $env:LTERMINAL_SSH_UPDATE_PUBLIC_KEY = (Get-Content -LiteralPath $sshPublic -Raw).Trim()
    $env:LTERMINAL_SSH_UPDATE_IDENTITY = $env:LTERMINAL_SSH_SIGNING_IDENTITY
    & node scripts/sign-release-ssh.mjs --manifest $manifest --signature (Join-Path $releaseRoot 'SHA256SUMS.txt.sshsig')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo firmar el manifiesto SSH.' }
    & node scripts/sign-release-ssh.mjs --manifest $manifest --signature (Join-Path $releaseRoot 'SHA256SUMS.txt.sshsig') --verify
    if ($LASTEXITCODE -ne 0) { throw 'Falló la verificación SSH.' }
} finally {
    Remove-Item Env:LTERMINAL_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Output "WebView2 offline incluido: $((Get-Item -LiteralPath $offline).Length) bytes."
Write-Output "Unpacked: $zip"
Write-Output "Portable: $portable"
