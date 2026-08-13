#requires -Version 5.0
<#
    Build de LTerminal (Tauri 2 + Rust) para Windows.

    Produce UNA sola cosa: la carpeta desempaquetada con el .exe, conpty.dll y
    OpenConsole.exe. Sin instalador NSIS, sin portable y sin accesos directos;
    el porque esta en src-tauri/BUNDLE.md.

    Requisitos: Node.js >= 22.12 y el toolchain de Rust (rustup/cargo). WebView2
    lo trae Windows 10/11 de serie.
#>

param(
    [switch]$Clean,
    [switch]$NoRun,
    [switch]$SkipChecks,
    [string]$Version,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'

function Write-Step ($Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   ($Message) { Write-Host "    OK: $Message" -ForegroundColor Green }
function Write-Warn ($Message) { Write-Host "    AVISO: $Message" -ForegroundColor Yellow }
function Write-Err  ($Message) { Write-Host "    ERROR: $Message" -ForegroundColor Red }

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
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command @Arguments | Out-Host
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Test-Command ($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

$WindowsDir  = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $WindowsDir
$TauriDir    = Join-Path $ProjectRoot 'src-tauri'
$ReleaseDir  = Join-Path $TauriDir 'target\release'
$VendorDir   = Join-Path $TauriDir 'vendor\conpty'

Set-Location $ProjectRoot

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
    $env:Path    = "$machinePath;$userPath"

    $commonDirs = @(
        "${env:ProgramFiles}\nodejs",
        "${env:ProgramFiles(x86)}\nodejs",
        "$env:LocalAppData\Programs\node",
        "$env:USERPROFILE\.cargo\bin"
    )
    foreach ($dir in $commonDirs) {
        if ($dir -and (Test-Path $dir) -and ($env:Path -notlike "*$dir*")) {
            $env:Path = "$dir;$env:Path"
        }
    }
}

$minNodeVersion = [version]'22.12.0'
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
        Write-Step 'Instalando Node.js (v22.14.0 LTS) mediante descarga directa (MSI)...'
        try {
            $msiUrl = 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi'
            $msiPath = Join-Path $env:TEMP 'node-v22.14.0-x64.msi'
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
            $rustupPath = Join-Path $env:TEMP 'rustup-init.exe'
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

function Test-MSVCLinker {
    if (Test-Command 'link') { return $true }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($path -and (Test-Path $path)) { return $true }
    }
    return $false
}

if (-not (Test-MSVCLinker)) {
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

        if (Test-MSVCLinker) {
            Write-Ok 'Visual Studio C++ Build Tools instaladas correctamente'
        } else {
            throw 'Faltan las Visual Studio C++ Build Tools (link.exe). Se intento la instalacion con winget pero no concluyo. Instalalas manualmente desde https://visualstudio.microsoft.com/visual-cpp-build-tools/'
        }
    } else {
        throw 'Faltan las Visual Studio C++ Build Tools (link.exe) para compilar en Windows. Instalalas desde https://visualstudio.microsoft.com/visual-cpp-build-tools/'
    }
} else {
    Write-Ok 'Visual Studio C++ Build Tools (link.exe)'
}

# La versión se pregunta antes de empaquetar. Enter conserva la actual; el
# parámetro permite builds automatizadas sin diálogo.
$packageJson = Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
$currentVersion = $packageJson.version
if (-not $Version) {
    if ($NonInteractive) {
        $Version = $currentVersion
    } else {
        $enteredVersion = Read-Host "Versión a compilar [$currentVersion]"
        $Version = if ([string]::IsNullOrWhiteSpace($enteredVersion)) { $currentVersion } else { $enteredVersion.Trim() }
    }
}

if ((Invoke-Native 'node' @('scripts/set-package-version.mjs', $Version)) -ne 0) {
    throw 'La versión indicada no es válida o no se pudo guardar en todos los manifiestos.'
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
# y el fallo no se ve hasta ejecutar la app. Ver vendor/conpty/README.md.
Write-Step 'Comprobando conpty.dll'
$conptyFiles = @('conpty.dll', 'OpenConsole.exe')
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

$running = Get-Process -Name 'winslim-terminal' -ErrorAction SilentlyContinue
if ($running) {
    Write-Err "LTerminal esta abierto ($($running.Count) proceso(s))."
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
$code = Invoke-Native 'npm' @('ci')
if ($code -ne 0) {
    Write-Warn 'npm ci no pudo vaciar node_modules por bloqueo de archivos en Windows. Reintentando con npm install...'
    $code = Invoke-Native 'npm' @('install')
    if ($code -ne 0) { throw "La instalacion de dependencias fallo (codigo $code)." }
}
Write-Ok 'Dependencias instaladas'

# ---------------------------------------------------------------------------
# 5. Comprobaciones
# ---------------------------------------------------------------------------
# Compilar una release que no pasa sus propias pruebas no tiene sentido: se
# tarda mas en descubrirlo despues que en comprobarlo aqui.
if (-not $SkipChecks) {
    Write-Step 'Comprobando tipos, formato, clippy y pruebas'
    $code = Invoke-Native 'npm' @('run', 'check')
    if ($code -ne 0) { throw "Las comprobaciones fallaron (codigo $code). Usa -SkipChecks para saltarlas." }
    Write-Ok 'Todo verde'
} else {
    Write-Warn 'Comprobaciones saltadas por peticion (-SkipChecks)'
}

# ---------------------------------------------------------------------------
# 6. Compilacion
# ---------------------------------------------------------------------------
Write-Step 'Compilando (tauri build --no-bundle)'
# Comprobar también las capacidades exclusivas del backend. Estos textos no
# viven en el bundle de Vite, por lo que validar solo JavaScript permitía crear
# una build con UI nueva pero un catálogo Windows incompleto.
$actionsSource = Get-Content (Join-Path $TauriDir 'src\packages\actions.rs') -Raw
foreach ($capability in @(
    'M2Team.NSudo',
    'C:\WSCore\Components\Hooks\NSudo\NSudoLC.exe',
    'OpenVPNTechnologies.OpenVPN',
    'WireGuard.WireGuard',
    'Tailscale.Tailscale',
    'Kubernetes.kubectl',
    'Helm.Helm',
    'Derailed.k9s'
)) {
    if ($actionsSource -notmatch [regex]::Escape($capability)) {
        throw "El catálogo Windows no contiene '$capability'; no se generará una release parcial."
    }
}
Write-Ok 'Catálogo Windows: NSudo, VPN y Kubernetes presentes'
# --no-bundle es redundante con bundle.active:false de tauri.windows.conf.json,
# pero se pasa igualmente para que la intencion se lea aqui: esta build NO
# genera instalador.
$code = Invoke-Native 'npm' @('run', 'tauri', '--', 'build', '--no-bundle')
if ($code -ne 0) { throw "La compilacion fallo (codigo $code)." }

# Evita publicar por accidente un frontend anterior (por ejemplo, una copia
# del proyecto sin los últimos cambios compartidos). Los marcadores están en
# la build minificada únicamente si incluye WASD con Control derecho, filtros
# compactos y el catálogo de Kubernetes actual.
$frontendBundles = Get-ChildItem (Join-Path $ProjectRoot 'dist\assets') -Filter 'index-*.js' -File
$frontendText = ($frontendBundles | ForEach-Object { Get-Content $_.FullName -Raw }) -join "`n"
foreach ($marker in @('ControlRight', 'KeyW', 'environment-controls')) {
    if ($frontendText -notmatch [regex]::Escape($marker)) {
        throw "El frontend compilado no contiene '$marker': parece una build desactualizada y no se publicara."
    }
}
Write-Ok 'Frontend compartido actualizado: Control derecho + WASD y preferencias compactas presentes'

$exePath = Join-Path $ReleaseDir 'winslim-terminal.exe'
if (-not (Test-Path $exePath)) { throw "La compilacion termino pero no hay ejecutable en $exePath." }
Write-Ok "Compilado: $exePath"

# ---------------------------------------------------------------------------
# 7. Carpeta desempaquetada
# ---------------------------------------------------------------------------
# target/release contiene ademas todos los artefactos de cargo (deps/, build/,
# .pdb: cientos de megas). Lo que se distribuye son tres archivos, y se copian a
# una carpeta limpia para no publicar el resto por accidente.
Write-Step 'Preparando la carpeta desempaquetada'
# NO en dist/: ahi escribe Vite el frontend compilado y lo vacia en cada build,
# asi que la release anterior desapareceria al compilar la siguiente.
$distDir = Join-Path $ProjectRoot "release\WinSlimTerminal-$version"
Remove-Item -Recurse -Force $distDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

$payload = @('winslim-terminal.exe') + $conptyFiles
foreach ($file in $payload) {
    $source = Join-Path $ReleaseDir $file
    if (-not (Test-Path $source)) {
        throw "Falta $file en $ReleaseDir. La carpeta quedaria incompleta y la app no abriria pestanas."
    }
    Copy-Item $source (Join-Path $distDir $file) -Force
}
$sizeMb = [math]::Round(((Get-ChildItem $distDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Ok "Carpeta lista: $distDir ($sizeMb MB, $($payload.Count) archivos)"

# ---------------------------------------------------------------------------
# 8. Comprobacion de humo
# ---------------------------------------------------------------------------
# Que compile o mantenga un proceso vivo no demuestra que WebView, xterm y el
# primer PTY hayan terminado de inicializar. Un token unico debe volver por IPC
# y quedar escrito en el log antes de permitir publicar la release.
Write-Step 'Comprobacion de humo (ventana, frontend, terminal y PTY)'
$smokeToken = "windows-build-$([guid]::NewGuid().ToString('N'))"
$logPath = Join-Path $env:APPDATA 'winslim-terminal\logs\main.log'
$previousSmokeToken = $env:LTERMINAL_SMOKE_TOKEN
$process = $null
try {
    $env:LTERMINAL_SMOKE_TOKEN = $smokeToken
    $process = Start-Process -FilePath (Join-Path $distDir 'winslim-terminal.exe') -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        $process.Refresh()
        if ($process.HasExited) {
            Write-Err "La aplicacion se cerro sola con codigo $($process.ExitCode)."
            throw 'La build compila pero no arranca. Revisa el log en %APPDATA%\winslim-terminal\logs.'
        }
        if (Test-Path $logPath) {
            $recentLog = Get-Content $logPath -Tail 200 -ErrorAction SilentlyContinue
            if (($recentLog -join "`n") -match [regex]::Escape($smokeToken)) {
                $ready = $true
                break
            }
        }
    }
    if (-not $ready) {
        throw "La ventana siguio viva, pero frontend/xterm/PTY no confirmaron el arranque en 30 s. Revisa $logPath."
    }
    Write-Ok 'Frontend, terminal y PTY confirmaron el arranque'
} finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -eq $previousSmokeToken) {
        Remove-Item Env:LTERMINAL_SMOKE_TOKEN -ErrorAction SilentlyContinue
    } else {
        $env:LTERMINAL_SMOKE_TOKEN = $previousSmokeToken
    }
}

# ---------------------------------------------------------------------------
# 9. Release comprimida
# ---------------------------------------------------------------------------
# El nombre importa: es el que busca el actualizador de la propia app al elegir
# el adjunto de la release (ver self_update::asset_for_platform, que se queda
# con el .zip que no mencione otra plataforma).
Write-Step 'Comprimiendo la release y calculando su huella'
$releaseOut = Join-Path $ProjectRoot 'release'
New-Item -ItemType Directory -Force -Path $releaseOut | Out-Null
$zipPath = Join-Path $releaseOut "WinSlimTerminal-Unpacked-$version.zip"
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
# Se comprime el CONTENIDO, sin carpeta intermedia. El actualizador acepta las
# dos formas, pero asi la carpeta de destino queda igual que la de aqui.
Compress-Archive -Path (Join-Path $distDir '*') -DestinationPath $zipPath -Force

$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $zipPath -Leaf)" | Set-Content (Join-Path $releaseOut 'SHA256SUMS.txt') -Encoding ascii
Write-Ok "Release: $zipPath"
Write-Ok "SHA256: $hash"

if (-not $NoRun) {
    Write-Step 'Lanzando la version compilada'
    Start-Process -FilePath (Join-Path $distDir 'winslim-terminal.exe')
}

Write-Host ''
Write-Host "Listo. LTerminal $version compilado y verificado." -ForegroundColor Green
Write-Host "  Carpeta: $distDir"
Write-Host "  Release: $zipPath"
