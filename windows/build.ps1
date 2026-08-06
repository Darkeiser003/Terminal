#requires -Version 5.0
<#
    Build reproducible de WinSlim Terminal para Windows.

    Requisito normal: Node.js + npm. node-pty 1.1.0 incluye binarios
    precompilados para Windows, por lo que Python/Visual Studio no se piden
    salvo que npm indique expresamente que debe compilar el modulo nativo.
#>

param(
    [switch]$Reinstall,
    [switch]$NoRun,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'

function Write-Step ($Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   ($Message) { Write-Host "    OK: $Message" -ForegroundColor Green }
function Write-Warn ($Message) { Write-Host "    AVISO: $Message" -ForegroundColor Yellow }
function Write-Err  ($Message) { Write-Host "    ERROR: $Message" -ForegroundColor Red }

function Confirm-Install ($Message) {
    if ($Yes) { return $true }
    return (Read-Host "    $Message (s/N)") -match '^[sSyY]'
}

# Ejecuta npm y devuelve SOLO su codigo de salida.
#
# Windows PowerShell 5.1 convierte en error TERMINANTE cada linea que un
# comando nativo escribe en stderr cuando su salida se redirige y
# ErrorActionPreference vale 'Stop'. npm usa stderr para sus avisos, asi que un
# "npm warn deprecated ..." inofensivo abortaba npm ci a medias y dejaba
# node_modules incompleto. Sin redirigir no pasa, pero entonces no hay log con
# el que distinguir un fallo de compilacion nativa de cualquier otro.
#
# La solucion es la de siempre con comandos nativos: bajar la preferencia
# mientras corre npm y decidir por $LASTEXITCODE, que es lo unico que indica de
# verdad si npm ha fallado. Out-Host deja la salida en pantalla sin devolverla
# como valor de la funcion.
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$LogPath
    )
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    # El paso gyp de winpty ejecuta `cmd /c "cd shared && GetCommitHash.bat"`,
    # que necesita encontrar ejecutables en el directorio actual. Heredar
    # NoDefaultCurrentDirectoryInExePath=1 (lo pone algun endurecimiento del
    # sistema) hace que ese paso falle con "GetCommitHash.bat no se reconoce" y
    # node-pty se queda sin build/Release. El README lo documentaba como
    # solucion manual; se aplica sola, y solo para los procesos que lanza el
    # build: la variable del sistema no se toca.
    $previousNoDefaultCwd = $env:NoDefaultCurrentDirectoryInExePath
    $env:NoDefaultCurrentDirectoryInExePath = $null
    try {
        if ($LogPath) {
            & $Command @Arguments 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $LogPath | Out-Host
        } else {
            & $Command @Arguments 2>&1 | ForEach-Object { "$_" } | Out-Host
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
        if ($null -eq $previousNoDefaultCwd) {
            Remove-Item Env:\NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
        } else {
            $env:NoDefaultCurrentDirectoryInExePath = $previousNoDefaultCwd
        }
    }
}

function Invoke-Npm {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$LogPath
    )
    return Invoke-Native -Command 'npm' -Arguments $Arguments -LogPath $LogPath
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Test-SupportedNode {
    try {
        $detected = & node -p "process.versions.node" 2>$null
        return $LASTEXITCODE -eq 0 -and ([version]$detected -ge [version]'22.12.0')
    } catch {
        return $false
    }
}

function Test-RealPython {
    foreach ($candidate in @('python', 'python3', 'py')) {
        try {
            $output = & $candidate --version 2>&1
            if ($LASTEXITCODE -eq 0 -and "$output" -match 'Python 3\.') { return $true }
        } catch { }
    }
    return $false
}

function Test-CppBuildTools {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $false }
    $installation = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    return !!$installation
}

function Install-NativeFallback ($WingetAvailable) {
    Write-Warn 'node-pty no pudo usar su binario precompilado y npm solicito compilacion nativa.'
    Write-Host '    Solo en este caso hacen falta Python 3 y Visual Studio Build Tools C++.'
    if (-not $WingetAvailable) {
        Write-Host '    Instalalos manualmente y vuelve a ejecutar el build:'
        Write-Host '    https://www.python.org/downloads/'
        Write-Host '    https://visualstudio.microsoft.com/visual-cpp-build-tools/'
        return $false
    }
    if (-not (Confirm-Install 'Instalar automaticamente los requisitos de compilacion nativa y reintentar?')) {
        return $false
    }

    if (-not (Test-RealPython)) {
        winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw "No se pudo instalar Python (codigo $LASTEXITCODE)." }
        Update-SessionPath
    }
    if (-not (Test-CppBuildTools)) {
        winget install --id Microsoft.VisualStudio.2022.BuildTools -e --force `
            --accept-source-agreements --accept-package-agreements `
            --override '--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        if ($LASTEXITCODE -ne 0) { throw "No se pudieron instalar las Build Tools (codigo $LASTEXITCODE)." }
    }
    Write-Ok 'Requisitos de compilacion nativa listos'
    return $true
}

function New-AppShortcut ($TargetExe, $ShortcutPath) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $TargetExe
    $shortcut.WorkingDirectory = Split-Path $TargetExe -Parent
    $shortcut.IconLocation = $TargetExe
    $shortcut.Description = 'WinSlim Terminal'
    $shortcut.Save()
}

$WindowsDir = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $WindowsDir
$ElectronDir = Join-Path $ProjectRoot 'electron'
$DistDir = Join-Path $ElectronDir 'dist'
$UnpackedBuildDir = Join-Path $DistDir 'win-unpacked'

Write-Host '=================================================='
Write-Host '  WinSlim Terminal - build Windows'
Write-Host '=================================================='

if (-not (Test-Path (Join-Path $ElectronDir 'package.json'))) {
    Write-Err "No se encontro el proyecto Electron en $ElectronDir"
    exit 1
}
Write-Ok "Proyecto: $ProjectRoot"

# electron-builder reemplaza win-unpacked. No se mata ninguna terminal: una
# pestana podria contener procesos o trabajo del usuario.
$runningUnpacked = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($UnpackedBuildDir, [StringComparison]::OrdinalIgnoreCase)
})
if ($runningUnpacked.Count -gt 0) {
    Write-Err 'Hay instancias abiertas desde electron\dist\win-unpacked.'
    $runningUnpacked | ForEach-Object { Write-Host "    PID $($_.ProcessId)" }
    Write-Host '    Cierralas y vuelve a ejecutar el build.'
    exit 2
}

$wingetAvailable = !!(Get-Command winget -ErrorAction SilentlyContinue)
$nodeAvailable = (Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)
if (-not $nodeAvailable) {
    Write-Warn 'Node.js/npm no estan disponibles.'
    if ($wingetAvailable -and (Confirm-Install 'Instalar Node.js LTS, unico requisito normal del build?')) {
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw "No se pudo instalar Node.js (codigo $LASTEXITCODE)." }
        Update-SessionPath
    } else {
        Write-Err 'Instala Node.js LTS desde https://nodejs.org y vuelve a intentarlo.'
        exit 1
    }
}
if (-not (Test-SupportedNode)) {
    Write-Warn "Node.js $(node -v) es demasiado antiguo; Electron 43 requiere Node.js 22.12.0 o superior."
    if ($wingetAvailable -and (Confirm-Install 'Actualizar Node.js LTS con winget?')) {
        winget upgrade --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar Node.js (codigo $LASTEXITCODE)." }
        Update-SessionPath
    }
}
if (-not (Test-SupportedNode)) {
    Write-Err "Se necesita Node.js >= 22.12.0 y se detecto $(node -v)."
    Write-Host '    Actualiza Node.js LTS desde https://nodejs.org y vuelve a intentarlo.'
    exit 1
}
Write-Ok "Node.js $(node -v) / npm $(npm -v)"

Push-Location $ElectronDir
try {
    if ($Reinstall -and (Test-Path 'node_modules')) {
        Write-Step 'Eliminando node_modules por peticion de reinstalacion'
        Remove-Item -Recurse -Force 'node_modules'
    }

    Write-Step 'Instalando dependencias reproducibles (npm ci)'
    $npmLog = Join-Path $env:TEMP 'winslim-npm-install.log'
    # Tee-Object en vez de Start-Transcript: una transcripcion ya abierta (por
    # ejemplo si el build se lanza desde otro script que la use) hacia fallar
    # Start-Transcript y, con ErrorActionPreference=Stop, abortaba el build
    # antes de instalar nada, con un error que no tenia que ver con npm.
    $npmCode = Invoke-Npm -Arguments @('ci') -LogPath $npmLog

    if ($npmCode -ne 0) {
        $npmOutput = Get-Content -Raw -Path $npmLog -ErrorAction SilentlyContinue
        # Este fallo concreto NO se arregla instalando Python ni Visual Studio:
        # es el directorio actual excluido del PATH. Invoke-Npm ya lo neutraliza,
        # asi que si aun aparece hay algo mas que lo esta reponiendo, y decirlo
        # ahorra una instalacion larga e inutil de las Build Tools.
        if ($npmOutput -match 'GetCommitHash') {
            Write-Err 'El paso gyp de winpty no encuentra GetCommitHash.bat en el directorio actual.'
            Write-Host '    Algo esta reponiendo NoDefaultCurrentDirectoryInExePath=1 en este proceso.'
            Write-Host '    Borra node_modules\node-pty (saliendo antes de esa carpeta) y repite el build.'
            throw "npm ci fallo al compilar node-pty (codigo $npmCode). Revisa $npmLog"
        }
        $nativeFailure = $npmOutput -match 'node-gyp|gyp ERR|prebuild|MSB80|Visual Studio|Python'
        if (-not $nativeFailure -or -not (Install-NativeFallback $wingetAvailable)) {
            throw "npm ci termino con errores (codigo $npmCode). Revisa $npmLog"
        }
        Write-Step 'Reintentando npm ci tras preparar la compilacion nativa'
        $retryCode = Invoke-Npm -Arguments @('ci') -LogPath $npmLog
        if ($retryCode -ne 0) {
            throw "npm ci sigue fallando (codigo $retryCode). Si aparece MSB8040, anade las bibliotecas MSVC con mitigaciones Spectre desde Visual Studio Installer."
        }
    }
    Write-Ok 'Dependencias instaladas'

    # npm puede dejar sin ejecutar los scripts de instalacion de las
    # dependencias (las versiones recientes los ponen tras una aprobacion
    # explicita: "packages have install scripts not yet covered by
    # allowScripts"). Cuando eso le toca a Electron, node_modules parece
    # completo pero no hay binario, y el fallo aparece mucho despues, al
    # empaquetar o al arrancar. Se comprueba y se repone aqui.
    Write-Step 'Comprobando el binario de Electron y el modulo node-pty'
    $electronDist = Join-Path $ElectronDir 'node_modules\electron\dist'
    if (-not (Test-Path (Join-Path $electronDist 'electron.exe'))) {
        Write-Warn 'npm no dejo instalado el binario de Electron; se descarga ahora.'
        $electronInstall = Join-Path $ElectronDir 'node_modules\electron\install.js'
        if (-not (Test-Path $electronInstall)) { throw 'Falta node_modules\electron: repite npm ci.' }
        $electronCode = Invoke-Native -Command 'node' -Arguments @($electronInstall)
        if ($electronCode -ne 0 -or -not (Test-Path (Join-Path $electronDist 'electron.exe'))) {
            throw 'No se pudo descargar el binario de Electron. Revisa la conexion y repite el build.'
        }
    }
    $ptyModule = Join-Path $ElectronDir 'node_modules\node-pty\build\Release\pty.node'
    if (-not (Test-Path $ptyModule)) {
        throw "Falta $ptyModule. node-pty no llego a compilarse: borra node_modules\node-pty y repite el build."
    }
    Write-Ok 'Electron y node-pty listos'

    Write-Step 'Ejecutando pruebas y comprobacion de sintaxis'
    $checkCode = Invoke-Npm -Arguments @('run', 'check')
    if ($checkCode -ne 0) { throw "Las pruebas fallaron (codigo $checkCode)." }

    Write-Step 'Generando la version desempaquetada'
    $packCode = Invoke-Npm -Arguments @('run', 'dist:win')
    if ($packCode -ne 0) { throw "electron-builder fallo (codigo $packCode)." }
} finally {
    Pop-Location
}

$unpackedExePath = Join-Path $UnpackedBuildDir 'WinSlim Terminal.exe'
if (-not (Test-Path $unpackedExePath)) { throw "No se encontro $unpackedExePath" }

Write-Step 'Validando la aplicacion empaquetada (smoke test invisible)'
$smoke = Start-Process -FilePath $unpackedExePath -ArgumentList '--smoke-test' -WindowStyle Hidden -PassThru
if (-not $smoke.WaitForExit(60000)) {
    try { Stop-Process -Id $smoke.Id -Force -ErrorAction SilentlyContinue } catch {}
    throw 'La aplicacion empaquetada no termino el smoke test en 60 segundos.'
}
$smoke.Refresh()
if ($smoke.ExitCode -ne 0) { throw "La aplicacion empaquetada fallo al arrancar (codigo $($smoke.ExitCode))." }
Write-Ok 'Electron, renderer y PTY arrancan correctamente'

Write-Step 'Midiendo el peso de la aplicacion empaquetada'
# Un tope generoso pero real: la mayor parte es el runtime de Electron, que no
# se puede adelgazar. Lo que este check detecta es una REGRESION: una exclusion
# que se cae de package.json y devuelve al paquete los .pdb, los prebuilds
# duplicados o node_modules entero.
# Medido: 306 MB con las exclusiones actuales. El margen cubre una subida de
# version de Electron; una exclusion que se caiga (los .pdb son ~30 MB) lo pasa.
$MaxUnpackedMB = 340
$unpackedBytes = (Get-ChildItem -LiteralPath $UnpackedBuildDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
$unpackedMB = [math]::Round($unpackedBytes / 1MB, 1)
$asarPath = Join-Path $UnpackedBuildDir 'resources\app.asar'
if (Test-Path $asarPath) {
    Write-Ok "app.asar: $([math]::Round((Get-Item $asarPath).Length / 1MB, 1)) MB"
}
Write-Host "    win-unpacked: $unpackedMB MB (tope $MaxUnpackedMB MB)"
if ($unpackedMB -gt $MaxUnpackedMB) {
    throw "La aplicacion empaquetada pesa $unpackedMB MB y el tope es $MaxUnpackedMB MB. Revisa build.files en package.json."
}
Write-Ok 'Peso dentro del tope'

Write-Step 'Comprobando que electron-builder solo genero la carpeta desempaquetada'
# Un formato por sistema. Si alguien reintroduce nsis/portable/msi en la
# configuracion, el instalador aparece aqui y el build falla en vez de
# publicar en silencio un formato que ya se habia retirado.
$strayInstallers = @(Get-ChildItem -LiteralPath $DistDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.exe', '.msi', '.appx', '.msix' })
if ($strayInstallers.Count -gt 0) {
    $strayInstallers | ForEach-Object { Write-Err "Artefacto inesperado: $($_.Name)" }
    throw 'La build de Windows solo debe producir win-unpacked. Revisa build.win.target en package.json.'
}
Write-Ok 'Solo win-unpacked'

Write-Step 'Creando releases ZIP y huellas SHA-256'
$packageJson = Get-Content (Join-Path $ElectronDir 'package.json') -Raw | ConvertFrom-Json
$version = $packageJson.version
$releaseDir = Join-Path $DistDir 'release'
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

# Los ZIP de versiones anteriores (y los del portable retirado) se quedaban en
# release/ y, como el archivo seguia existiendo, sus huellas sobrevivian a la
# fusion de mas abajo: SHA256SUMS.txt acababa listando varias versiones y ya
# no describia la release que se acaba de compilar.
$unpackedZipName = "WinSlimTerminal-Unpacked-$version.zip"
$unpackedZip = Join-Path $releaseDir $unpackedZipName
$stale = @(Get-ChildItem -LiteralPath $releaseDir -File -Filter 'WinSlimTerminal-*.zip' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne $unpackedZipName })
foreach ($old in $stale) {
    Remove-Item -LiteralPath $old.FullName -Force
    Write-Warn "Release anterior retirada: $($old.Name)"
}

Compress-Archive -Path $UnpackedBuildDir -DestinationPath $unpackedZip -CompressionLevel Optimal -Force
if (-not (Test-Path $unpackedZip)) { throw "No se genero $unpackedZip" }

$checksumPath = Join-Path $releaseDir 'SHA256SUMS.txt'
$ownNames = @($unpackedZipName)
$checksumLines = @($unpackedZip) | ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant()
    "$hash *$(Split-Path $_ -Leaf)"
}

# Windows y Linux publican en la MISMA carpeta release. Reescribir el archivo
# entero borraba las huellas de la otra plataforma (compilar Linux dejaba el
# SHA256SUMS.txt sin los ZIP de Windows). Se conservan las lineas ajenas cuyo
# archivo sigue existiendo y solo se reemplazan las propias.
$preservedLines = @()
if (Test-Path $checksumPath) {
    $preservedLines = @(Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match '\S' } | Where-Object {
        # Formato sha256sum: "<hash> *nombre" (binario) o "<hash>  nombre" (texto).
        $name = ($_ -replace '^[0-9a-fA-F]+\s+\*?', '')
        ($ownNames -notcontains $name) -and (Test-Path (Join-Path $releaseDir $name))
    })
}
# Ordenado por nombre de archivo, igual que el `sort -k2` de linux/build.sh.
$checksumLines = @($preservedLines + $checksumLines) | Sort-Object { $_ -replace '^[0-9a-fA-F]+\s+\*?', '' }
Set-Content -LiteralPath $checksumPath -Value $checksumLines -Encoding ASCII

Write-Step 'Verificando SHA256SUMS.txt contra los archivos publicados'
# Publicar una huella sin comprobarla es publicar una promesa. Se releen las
# lineas del archivo y se recalcula cada hash, igual que hara quien descargue
# la release con `sha256sum -c`.
$verified = 0
foreach ($line in (Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match '\S' })) {
    if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') { throw "Linea ilegible en SHA256SUMS.txt: $line" }
    $expected = $Matches[1].ToLowerInvariant()
    $name = $Matches[2]
    $file = Join-Path $releaseDir $name
    if (-not (Test-Path -LiteralPath $file)) { throw "SHA256SUMS.txt menciona un archivo que no existe: $name" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "La huella de $name no coincide con el archivo publicado." }
    $verified += 1
}
if ($verified -lt 1) { throw 'SHA256SUMS.txt quedo vacio.' }
Write-Ok "$verified archivo(s) con huella verificada"
Write-Ok "Releases: $releaseDir"

Write-Step 'Creando accesos directos'
$desktop = [Environment]::GetFolderPath('Desktop')
New-AppShortcut $unpackedExePath (Join-Path $desktop 'WinSlim Terminal.lnk')
New-AppShortcut $unpackedExePath (Join-Path $ProjectRoot 'WinSlim Terminal.lnk')
Write-Ok 'Accesos directos creados en el escritorio y en la raiz del proyecto'

if (-not $NoRun) {
    Write-Step 'Lanzando la version desempaquetada'
    Start-Process -FilePath $unpackedExePath
}

Write-Host ''
Write-Host "Listo. WinSlim Terminal $version compilado y verificado." -ForegroundColor Green
