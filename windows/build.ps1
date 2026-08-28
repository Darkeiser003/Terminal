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
    [Alias('h')][switch]$Help,
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
    [switch]$NoExtendedTests,
    [switch]$Fast,
    [switch]$CrossLinux
)

$ErrorActionPreference = 'Stop'

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
    Write-Host '  -Installer             Genera ademas el instalador NSIS offline.'
    Write-Host '  -InstallE2eDriver     Instala tauri-driver si falta.'
    Write-Host '  -Version X.Y.Z        Sobrescribe la version del paquete.'
    Write-Host '  -NonInteractive        No espera entrada del usuario.'
    Write-Host '  Sin opciones           Muestra un selector interactivo; Enter conserva los valores actuales.'
    exit 0
}

$script:BuildStartedAt = [DateTime]::UtcNow
$script:StepStartedAt = $script:BuildStartedAt

# Windows PowerShell 5.1 necesita el BOM del propio archivo para leer bien sus
# literales UTF-8 y, además, una codificación de consola explícita para no
# convertir en «Ã³/Ã¡» la salida UTF-8 de Node, Cargo y las herramientas.
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

# Una ejecución sin argumentos ofrece una configuración cómoda antes de tocar
# dependencias o empezar a compilar. Los scripts siguen siendo totalmente
# automatizables: si se pasa cualquier opción, se conserva exactamente la
# semántica anterior; -NonInteractive también desactiva el diálogo.
$hasExplicitBuildOptions = @($PSBoundParameters.Keys | Where-Object { $_ -ne 'Help' }).Count -gt 0
$isCiEnvironment = $env:CI -match '^(1|true|yes)$'
$interactiveBuild = -not $NonInteractive.IsPresent -and
    -not $hasExplicitBuildOptions -and
    -not $isCiEnvironment -and
    [Environment]::UserInteractive -and
    -not [Console]::IsInputRedirected
if ($interactiveBuild) {
    Write-Host ''
    Write-Host 'Configuración de build (Enter conserva el valor actual):' -ForegroundColor Cyan
    $Clean = Read-BuildChoice 'Limpiar dependencias y target antes de compilar' $Clean
    $Fast = Read-BuildChoice 'Usar perfil rápido de desarrollo' $Fast
    $Installer = Read-BuildChoice 'Generar también instalador NSIS offline' $Installer
    $SkipChecks = Read-BuildChoice 'Saltar comprobaciones locales' $SkipChecks
    $AllowOfflineChecks = Read-BuildChoice 'Convertir comprobaciones externas en avisos' $AllowOfflineChecks
    if (-not $FullTests.IsPresent -and -not $StrictTests.IsPresent) {
        $NoExtendedTests = [switch](-not (Read-BuildChoice 'Ejecutar pruebas ampliadas y E2E' (-not $NoExtendedTests.IsPresent)))
    }
    $CrossLinux = Read-BuildChoice 'Ejecutar también la build Linux mediante WSL' $CrossLinux
    $NoRun = [switch](-not (Read-BuildChoice 'Lanzar la aplicación al terminar' (-not $NoRun)))
    Write-Host '  Opciones seleccionadas. La build comenzará ahora.' -ForegroundColor DarkGray
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
        $LASTEXITCODE = 0
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
            & $Command @Arguments | Out-Host
            return [int]$LASTEXITCODE
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
        @{ Name = 'Ventana inicial'; Pattern = 'Ventana inicial mostrada' },
        @{ Name = 'PTY preparado'; Pattern = 'Preparando pty' },
        @{ Name = 'PTY creado'; Pattern = 'pty spawneado' },
        @{ Name = 'Error de PTY'; Pattern = 'No se pudo spawnear el pty|Frontend preparado pero sin sesión PTY' },
        @{ Name = 'Frontend'; Pattern = 'Frontend y terminal preparados' }
    )
    foreach ($marker in $markers) {
        $state = if ($text -match $marker.Pattern) { 'sí' } else { 'no' }
        Write-Host "      $($marker.Name): $state" -ForegroundColor DarkGray
    }
    if ($text -match '0xC0000142|STATUS_DLL_INIT_FAILED|DLL_INIT_FAILED') {
        Write-Err 'El log contiene STATUS_DLL_INIT_FAILED (0xC0000142): el fallo está en la inicialización de una DLL/proceso hijo, no en la batería WebDriver.'
        Write-Err 'Comprueba especialmente conpty.dll/OpenConsole.exe, WebView2Loader.dll y el cmd.exe del sistema.'
    } elseif ($text -match 'No se pudo spawnear el pty|Frontend preparado pero sin sesión PTY') {
        Write-Err 'La ventana sí llegó a iniciar, pero la primera shell no consiguió crear un PTY; por eso el E2E no se lanza.'
    } elseif ($text -notmatch 'Ventana inicial mostrada') {
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
    # El token también aparece en el marcador de error «sin sesión PTY». Solo
    # el hito de éxito de ESTA sesión prueba frontend + xterm + PTY real; los
    # errores de una ejecución anterior no contaminan el resultado.
    return $current -match 'Frontend y terminal preparados' -and
        $current -notmatch 'Frontend preparado pero sin sesión PTY'
}

function Test-Command ($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

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
        $LASTEXITCODE = 0
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

function Test-WindowsLinker {
    if (Test-MSVCLinker) { return 'msvc' }
    if (Get-RustLldPath) { return 'rust-lld' }
    return $null
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
    $rustLld = Get-RustLldPath
    Write-Warn "No se encontraron cl.exe/link.exe; se usará el enlazador incluido en Rust: $rustLld"
    Write-Ok 'Rust LLD disponible: se puede compilar la aplicación sin Visual Studio Build Tools'
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
        $code = Invoke-Native 'npm' $Arguments -CaptureOutput
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
# carpeta limpia para no publicar el resto por accidente. Las builds rápidas
# usan además una carpeta y un nombre distintos para que un ZIP de desarrollo
# no pueda confundirse con la release comprimida.
Write-Step 'Preparando la carpeta desempaquetada'
# NO en dist/: ahi escribe Vite el frontend compilado y lo vacia en cada build,
# asi que la release anterior desapareceria al compilar la siguiente.
$distSuffix = if ($Fast) { '-dev' } else { '' }
$distDir = Join-Path $ProjectRoot "release\WinSlimTerminal-$version$distSuffix"
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
Write-Host '    Este paso comprueba solo el arranque mínimo y se cerrará automáticamente.' -ForegroundColor DarkGray
Write-Host '    Las pestañas, menús, acciones y redimensionado se prueban después en E2E ampliado.' -ForegroundColor DarkGray
$smokeToken = "windows-build-$([guid]::NewGuid().ToString('N'))"
$logPath = Join-Path $env:APPDATA 'winslim-terminal\logs\main.log'
$previousSmokeToken = $env:LTERMINAL_SMOKE_TOKEN
$previousLogFile = $env:LTERMINAL_LOG_FILE
$previousSmokeAutoExit = $env:LTERMINAL_SMOKE_AUTO_EXIT
$process = $null
try {
    $env:LTERMINAL_SMOKE_TOKEN = $smokeToken
    # La app debe cerrar su PTY de forma ordenada. TerminateProcess sobre el
    # padre mientras cmd.exe aún conecta al pseudoterminal genera el diálogo
    # STATUS_DLL_INIT_FAILED (0xc0000142) aunque las DLL sean correctas.
    $env:LTERMINAL_SMOKE_AUTO_EXIT = '1'
    # Resource-dir, WebView2 y los scripts deben resolverse contra la carpeta
    # desempaquetada, no contra la carpeta desde la que se lanzó PowerShell.
    $env:LTERMINAL_LOG_FILE = $logPath
    $process = Start-Process -FilePath (Join-Path $distDir 'winslim-terminal.exe') -WorkingDirectory $distDir -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        $process.Refresh()
        if ($process.HasExited) {
            if (Test-SmokeReady $logPath $smokeToken) {
                $ready = $true
                break
            }
            Write-Err "La aplicacion se cerro sola con codigo $($process.ExitCode)."
            Show-SmokeDiagnostics $logPath $smokeToken
            throw 'La build compila pero no arranca. Revisa el log en %APPDATA%\winslim-terminal\logs.'
        }
        if (Test-SmokeReady $logPath $smokeToken) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        Show-SmokeDiagnostics $logPath $smokeToken
        throw "La ventana siguio viva, pero frontend/xterm/PTY no confirmaron el arranque en 30 s. Revisa $logPath."
    }
    Write-Ok 'Smoke mínimo completado: frontend, terminal y PTY confirmaron el arranque'
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
$strictExtendedTests = $FullTests.IsPresent -or $StrictTests.IsPresent
$strictProbeFailure = $false
if ($NoExtendedTests -and ($FullTests.IsPresent -or $StrictTests.IsPresent)) {
    throw '-NoExtendedTests no se puede combinar con -FullTests ni -StrictTests.'
}
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
        @{ Name = 'VirtualBox'; Exe = 'VBoxManage.exe'; Args = @('--version') },
        @{ Name = 'VMware'; Exe = 'vmrun.exe'; Args = @('-T', 'ws', 'version') }
    )
    $missingProbes = @()
    $failedProbes = @()
    foreach ($probe in $probes) {
        $detectCommand = if ($probe.ContainsKey('Detect')) { [string]$probe.Detect } else { [string]$probe.Exe }
        if (-not (Test-Command $detectCommand)) {
            Write-Warn "$($probe.Name) no está instalado o no está en PATH."
            $missingProbes += $probe.Name
            continue
        }
        $probeCode = Invoke-Native $probe.Exe $probe.Args -CaptureOutput
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
        try {
            # El smoke activa CDP mediante la API de WebView2 al lanzar la app.
            # Probar la propia release evita una segunda compilación y asegura
            # que el ejecutable que se distribuye supera también el E2E.
            $env:E2E_BINARY = Join-Path $distDir 'winslim-terminal.exe'
            $env:LTERMINAL_SMOKE_REPORT = Join-Path $env:TEMP "winslim-terminal-e2e-$([guid]::NewGuid().ToString('N')).json"
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
            $reportCode = Invoke-Native 'node' @('scripts/verify-e2e-report.mjs', $e2eReportPath)
            if ($reportCode -ne 0) { throw "El informe E2E está incompleto (código $reportCode): $e2eReportPath" }
            Write-Ok 'E2E confirmó todas las fases: ventana, terminal, paneles, comandos, preferencias y redimensionado'
        } finally {
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

    if ($strictProbeFailure) {
        throw 'La batería ampliada detectó herramientas instaladas que fallaron, o ausencias bajo -StrictTests. Revisa el diagnóstico anterior.'
    }
}

if ($CrossLinux) {
    Invoke-CrossLinuxTests
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
$releaseOut = Join-Path $ProjectRoot 'release'
if ($Fast) {
    $releaseOut = Join-Path $releaseOut 'dev'
}
New-Item -ItemType Directory -Force -Path $releaseOut | Out-Null
$zipSuffix = if ($Fast) { '-dev' } else { '' }
$zipPath = Join-Path $releaseOut "WinSlimTerminal-Unpacked-$version$zipSuffix.zip"
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
# Se comprime el CONTENIDO, sin carpeta intermedia. El actualizador acepta las
# dos formas, pero asi la carpeta de destino queda igual que la de aqui.
Compress-Archive -Path (Join-Path $distDir '*') -DestinationPath $zipPath -Force

$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
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

if (-not $NoRun) {
    Write-Step 'Lanzando la version compilada'
    Start-Process -FilePath (Join-Path $distDir 'winslim-terminal.exe') -WorkingDirectory $distDir
}

Write-Host ''
Write-Host "Listo. WinSlim Terminal $version compilado y verificado." -ForegroundColor Green
Write-Host "  Carpeta: $distDir"
Write-Host "  Release: $zipPath"
$totalSeconds = ([DateTime]::UtcNow - $script:BuildStartedAt).TotalSeconds
Write-Host ("  Tiempo total: {0:N1} s" -f $totalSeconds) -ForegroundColor DarkGray
