#requires -Version 5.0
<#
    Build de WinSlim Terminal (Tauri 2 + Rust) para Windows.

    Produce por defecto la carpeta desempaquetada con el .exe, conpty.dll,
    OpenConsole.exe y WebView2Loader.dll. Con -Installer genera además un instalador NSIS con el
    WebView2 offline incluido; el porqué está en src-tauri/BUNDLE.md.

    Requisitos: Node.js >= 22.12 y el toolchain de Rust (rustup/cargo). La
    carpeta desempaquetada necesita WebView2 ya instalado; el instalador
    offline lo instala en el equipo destino.
#>

param(
    [switch]$Clean,
    [switch]$NoRun,
    [switch]$Installer,
    [switch]$SkipChecks,
    [switch]$AllowOfflineChecks,
    [string]$Version,
    [switch]$InstallE2eDriver,
    [switch]$NonInteractive,
    [switch]$FullTests,
    [switch]$StrictTests,
    [switch]$CrossLinux
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
        ForEach-Object { ([string]$_).Trim() } |
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
        throw "WSL no pudo convertir la ruta del proyecto Windows: $ProjectRoot"
    }

    # WSLg expone DISPLAY/WAYLAND_DISPLAY; build.sh instala WebKitGTK, Node,
    # Rust, WebKitWebDriver y tauri-driver dentro de la distribución. El E2E
    # ejecuta la aplicación Linux real y --no-run evita dejarla abierta al
    # terminar las pruebas.
    $escapedRoot = $wslRoot.Replace("'", "'\''")
    $linuxCommand = "cd '$escapedRoot' && bash linux/build.sh --full-tests --install-e2e-driver --no-run --non-interactive"
    Write-Step "Compilando y probando Linux dentro de WSL ($distro)"
    $code = Invoke-Native 'wsl.exe' @('--distribution', $distro, '--', 'bash', '-lc', $linuxCommand)
    if ($code -ne 0) {
        throw "Las pruebas Linux en WSL fallaron (código $code). Comprueba WSLg y la distribución Ubuntu."
    }
    Write-Ok 'AppImage Linux compilado y probado desde Windows mediante WSL'
}

$WindowsDir  = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $WindowsDir
$TauriDir    = Join-Path $ProjectRoot 'src-tauri'
$ReleaseDir  = Join-Path $TauriDir 'target\release'
$VendorDir   = Join-Path $TauriDir 'vendor\conpty'

Set-Location $ProjectRoot

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
    $environmentLines = @(& $comSpec /d /s /c $commandLine 2>$null)
    if ($LASTEXITCODE -ne 0) { return $false }
    foreach ($line in $environmentLines) {
        if ([string]$line -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
    return (Test-Command 'link.exe') -and (Test-Command 'cl.exe')
}

function Test-MSVCLinker {
    return Import-MSVCEnvironment
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

        Refresh-EnvironmentPath
        if (Test-MSVCLinker) {
            Write-Ok 'Visual Studio C++ Build Tools instaladas correctamente'
        } else {
            throw 'Faltan las Visual Studio C++ Build Tools (link.exe). Se intento la instalacion con winget pero no concluyo. Instalalas manualmente desde https://visualstudio.microsoft.com/visual-cpp-build-tools/'
        }
    } else {
        throw 'Faltan las Visual Studio C++ Build Tools (link.exe) para compilar en Windows. Instalalas desde https://visualstudio.microsoft.com/visual-cpp-build-tools/'
    }
} else {
    Write-Ok 'Visual Studio C++ Build Tools (cl.exe + link.exe + Windows SDK)'
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
    Write-Err "WinSlim Terminal esta abierto ($($running.Count) proceso(s))."
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
function Invoke-TauriBuild {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $previousSkipChecks = $env:LTERMINAL_SKIP_CHECKS
    try {
        if ($SkipChecks) {
            # Tauri ejecuta npm run build internamente. Este entorno llega también
            # al prebuild y al build del frontend, de modo que -SkipChecks no
            # vuelve a lanzar enlaces, fuentes externas ni svelte-check.
            $env:LTERMINAL_SKIP_CHECKS = '1'
        } else {
            Remove-Item Env:LTERMINAL_SKIP_CHECKS -ErrorAction SilentlyContinue
        }
        return (Invoke-Native 'npm' $Arguments)
    } finally {
        if ($null -eq $previousSkipChecks) {
            Remove-Item Env:LTERMINAL_SKIP_CHECKS -ErrorAction SilentlyContinue
        } else {
            $env:LTERMINAL_SKIP_CHECKS = $previousSkipChecks
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

    Write-Step 'Compilando (Tauri + instalador NSIS offline de WebView2)'
    $code = Invoke-TauriBuild @('run', 'tauri', '--', 'build', '--config', 'src-tauri/tauri.windows.installer.conf.json')
} else {
    Write-Step 'Compilando (tauri build --no-bundle)'
    # --no-bundle es redundante con bundle.active:false de tauri.windows.conf.json,
    # pero se pasa igualmente para que la intención se lea aquí.
    $code = Invoke-TauriBuild @('run', 'tauri', '--', 'build', '--no-bundle')
}
if ($code -ne 0) { throw "La compilacion fallo (codigo $code)." }

if ($Installer) {
    $nsisDir = Join-Path $TauriDir 'target\release\bundle\nsis'
    $installers = @(Get-ChildItem $nsisDir -Filter '*.exe' -File -ErrorAction SilentlyContinue)
    if ($installers.Count -eq 0) {
        throw "La compilacion termino sin generar instalador NSIS en $nsisDir."
    }
    if ($installers[0].Length -lt 1MB) {
        throw "El instalador NSIS parece incompleto ($($installers[0].Length) bytes): $($installers[0].FullName)."
    }
    Write-Ok "Instalador NSIS con WebView2 offline: $($installers[0].FullName)"
}

# Evita publicar por accidente un frontend anterior (por ejemplo, una copia
# del proyecto sin los últimos cambios compartidos). Estos marcadores solo
# validan funciones del frontend; las herramientas opcionales se detectan en
# tiempo de ejecución y nunca condicionan la compilación.
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
# .pdb: cientos de megas). Lo que se distribuye son el ejecutable, sus DLL/host
# nativos y el árbol `scripts/` declarado en bundle.resources. Se copian a una
# carpeta limpia para no publicar el resto por accidente.
Write-Step 'Preparando la carpeta desempaquetada'
# NO en dist/: ahi escribe Vite el frontend compilado y lo vacia en cada build,
# asi que la release anterior desapareceria al compilar la siguiente.
$distDir = Join-Path $ProjectRoot "release\WinSlimTerminal-$version"
Remove-Item -Recurse -Force $distDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

Ensure-WebView2Loader | Out-Null

$payload = @('winslim-terminal.exe') + $conptyFiles + @('WebView2Loader.dll')
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
    '--windows', (Join-Path $distDir 'winslim-terminal.exe'),
    '--windows-dir', $distDir
)
if ($artifactCode -ne 0) { throw "La validación PE/runtime de Windows falló (código $artifactCode)." }
Write-Ok 'Estructura PE x64 y runtime Windows verificados'

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
            if (Test-Path $logPath) { Get-Content $logPath -Tail 80 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray } }
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
        if (Test-Path $logPath) { Get-Content $logPath -Tail 80 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray } }
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
# 8b. Pruebas ampliadas opcionales
# ---------------------------------------------------------------------------
# El smoke ya comprobó ventana, frontend, xterm y PTY. Esta batería adicional
# comprueba los ejecutables que la aplicación usa para preparar una sesión en
# Windows. Se pregunta también con -NoRun: compilar sin lanzar la ventana no
# debe esconder una validación que el usuario pidió explícitamente.
$runExtendedTests = $FullTests.IsPresent -or $StrictTests.IsPresent
$strictExtendedTests = $FullTests.IsPresent -or $StrictTests.IsPresent
if (-not $runExtendedTests -and -not $NonInteractive) {
    $extendedReply = Read-Host '¿Ejecutar también la batería completa de shells y herramientas instaladas? [s/N]'
    $runExtendedTests = $extendedReply -match '^(s|si|sí)$'
}
if ($runExtendedTests) {
    Write-Step 'Pruebas ampliadas de Windows (shells, herramientas y E2E)'
    $probes = @(
        @{ Name = 'cmd'; Exe = 'cmd.exe'; Args = @('/d', '/c', 'exit 0') },
        @{ Name = 'PowerShell'; Exe = 'powershell.exe'; Args = @('-NoProfile', '-NonInteractive', '-Command', 'exit 0') },
        @{ Name = 'PowerShell 7'; Exe = 'pwsh'; Args = @('-NoProfile', '-NonInteractive', '-Command', 'exit 0') },
        @{ Name = 'Nushell'; Exe = 'nu'; Args = @('--version') },
        @{ Name = 'Windows Terminal'; Exe = 'wt.exe'; Args = @('--version') },
        @{ Name = 'NSudo'; Exe = 'NSudoLC.exe'; Args = @('-?') },
        @{ Name = 'Node.js'; Exe = 'node'; Args = @('-e', 'process.exit(0)') },
        @{ Name = 'npm'; Exe = 'npm'; Args = @('--version') },
        @{ Name = 'Git'; Exe = 'git'; Args = @('--version') },
        @{ Name = 'Python'; Exe = 'python'; Args = @('-I', '-c', 'print("LTERMINAL_REPL_OK")') },
        @{ Name = 'Ruby'; Exe = 'ruby'; Args = @('-e', 'puts "LTERMINAL_REPL_OK"') },
        @{ Name = 'PHP'; Exe = 'php'; Args = @('-r', 'echo "LTERMINAL_REPL_OK";') },
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
        @{ Name = 'Perl'; Exe = 'perl'; Args = @('-e', 'print "LTERMINAL_REPL_OK\n"') },
        @{ Name = 'Lua'; Exe = 'lua'; Args = @('-e', 'print("LTERMINAL_REPL_OK")') },
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
        @{ Name = 'VirtualBox'; Exe = 'VBoxManage.exe'; Args = @('--version') },
        @{ Name = 'VMware'; Exe = 'vmrun.exe'; Args = @('-T', 'ws', 'version') }
    )
    $missingProbes = @()
    foreach ($probe in $probes) {
        if (-not (Test-Command $probe.Exe)) {
            Write-Warn "$($probe.Name) no está instalado o no está en PATH."
            $missingProbes += $probe.Name
            continue
        }
        $probeCode = Invoke-Native $probe.Exe $probe.Args
        if ($probeCode -ne 0) {
            throw "La prueba de $($probe.Name) falló (código $probeCode)."
        }
        Write-Ok "$($probe.Name) respondió correctamente"
    }
    Write-Host "    Resumen de herramientas: $($probes.Count - $missingProbes.Count)/$($probes.Count) disponibles." -ForegroundColor Cyan
    if ($missingProbes.Count -gt 0) {
        Write-Warn "Faltan $($missingProbes.Count) sondas: $($missingProbes -join ', ')"
        if ($strictExtendedTests) {
            throw 'La batería ampliada estricta detectó herramientas ausentes. Instálalas desde Entorno y componentes o ejecuta la build sin -StrictTests.'
        }
    }

    if (-not (Test-Command 'tauri-driver') -and $InstallE2eDriver -and (Test-Command 'cargo')) {
        Write-Warn 'Falta tauri-driver; se instalará con cargo para completar E2E.'
        $driverCode = Invoke-Native 'cargo' @('install', 'tauri-driver', '--locked')
        if ($driverCode -ne 0) { throw "No se pudo instalar tauri-driver (código $driverCode)." }
        Refresh-EnvironmentPath
    }
    if (-not (Test-Command 'tauri-driver')) {
        throw 'Falta tauri-driver. Reintenta con -InstallE2eDriver o instálalo con cargo.'
    }
    $previousE2eBinary = $env:E2E_BINARY
    try {
        $env:E2E_BINARY = Join-Path $distDir 'winslim-terminal.exe'
        $e2eCode = Invoke-Native 'npm' @('run', 'e2e')
        if ($e2eCode -ne 0) { throw "E2E falló (código $e2eCode). Revisa el log en $logPath." }
        Write-Ok 'E2E confirmó ventana, terminal, barra y Ajustes'
    } finally {
        if ($null -eq $previousE2eBinary) {
            Remove-Item Env:E2E_BINARY -ErrorAction SilentlyContinue
        } else {
            $env:E2E_BINARY = $previousE2eBinary
        }
    }
}

if ($CrossLinux) {
    Invoke-CrossLinuxTests
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
Write-Host "Listo. WinSlim Terminal $version compilado y verificado." -ForegroundColor Green
Write-Host "  Carpeta: $distDir"
Write-Host "  Release: $zipPath"
