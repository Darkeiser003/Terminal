#requires -Version 5.0
<#
.SYNOPSIS
  Build larga (= release validada) POR ETAPAS y reanudable.

.DESCRIPTION
  Equivale a `windows/build.ps1 -ReleaseValidation`, pero cada etapa apunta en
  un archivo de estado que terminó. Si el equipo se cae o se para a mano, se
  vuelve a lanzar con la misma -Label y SOLO se repite lo que faltaba.

    0. comprobar (con -CheckFirst): npm run check:local y cargo test; si
       fallan, no se compila nada;
    1. compilar: windows/build.ps1 -FullTests -NoFocusedTests (comprobaciones,
       clippy, pruebas, binario, instalador, portable, firma y los E2E de la
       carpeta y del portable), sin las suites;
    2. una suite cada vez con scripts/run-e2e-suite.mjs sobre lo ya firmado
       (por defecto focused, video, downloads, dependency-audit e installer);
    3. veredicto: si algo falló, release\NO-PUBLICAR.txt.

  Con -ResumeAfterReboot deja apuntada la orden en
  artifacts\build-stages\pendiente.txt; windows/build-stages-resume.ps1 (que
  se puede poner al iniciar sesión con -InstallResumeAtLogon) la relanza tras
  un reinicio, como mucho dos veces seguidas.

  Viene de los envoltorios que se usaban fuera del repositorio
  (E:\WTerminal\logs, desde el 10-11). Romen, 22-11: «usa y mejora mis
  scripts, modularizándolos, añadiendo opciones y builds por pasos».

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File windows/build-stages.ps1 -Label 83 -CheckFirst -SkipWsl
  powershell -ExecutionPolicy Bypass -File windows/build-stages.ps1 -Label 83 -Suites focused,installer
  powershell -ExecutionPolicy Bypass -File windows/build-stages.ps1 -Label 83 -Restart
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Label,
    [string]$Description = '',
    [string]$KeysDir = '',
    [string[]]$Suites = @('focused', 'video', 'downloads', 'dependency-audit', 'installer'),
    [switch]$CheckFirst,
    [switch]$SkipWsl,
    [switch]$Restart,
    [switch]$ResumeAfterReboot,
    [switch]$InstallResumeAtLogon,
    [switch]$NoSign
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
if ($Label -notmatch '^[A-Za-z0-9._-]{1,40}$') { throw "Etiqueta no válida: $Label (letras, números, punto, guion)" }
# Una lista separada por comas que llega como una sola cadena (desde el menú).
$Suites = @($Suites | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$stateRoot = Join-Path $Root 'artifacts\build-stages'
$stateDir = Join-Path $stateRoot $Label
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$stateFile = Join-Path $stateDir 'estado.txt'
$log = Join-Path $stateDir 'build.log'
$pending = Join-Path $stateRoot 'pendiente.txt'
$version = ((Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw) | ConvertFrom-Json).version
$dist = Join-Path $Root "src-tauri\target\dist\WTerminal-$version"
$release = Join-Path $Root 'release'
$out = Join-Path $Root "artifacts\release-validation\WTerminal-$version-build-$Label"

if ($InstallResumeAtLogon) {
    $startup = [Environment]::GetFolderPath('Startup')
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path $startup 'WTerminal - reanudar build por etapas.lnk'))
    $link.TargetPath = (Get-Command powershell).Source
    $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$(Join-Path $PSScriptRoot 'build-stages-resume.ps1')`""
    $link.WorkingDirectory = $Root
    $link.Save()
    Write-Host 'Acceso de inicio creado: tras un reinicio se reanuda la build pendiente.'
}

if ($Restart) { Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue }
$done = @{}
if (Test-Path -LiteralPath $stateFile) {
    foreach ($line in Get-Content -LiteralPath $stateFile) {
        $parts = $line -split ' '
        if ($parts.Count -ge 3) { $done[$parts[0]] = [int]$parts[2] }
    }
}
# Al relanzar, la comprobación y la compilación que fallaron se repiten (24-11:
# la 86 se paró en `cargo fmt --check` y, arreglado, el relanzamiento daba la
# compilación por hecha y no pasaba de ahí). Las suites no: su fallo queda
# para el veredicto y se repiten aparte sobre el mismo binario.
foreach ($stage in @('comprobar', 'compilar')) {
    if ($done.ContainsKey($stage) -and $done[$stage] -ne 0) {
        Write-Host "La etapa $stage falló la vez anterior (código $($done[$stage])): se repite."
        $done.Remove($stage)
    }
}

function Write-Stage([string]$stage, [int]$code) {
    $line = "$stage codigo $code $(Get-Date -Format s)"
    Add-Content -LiteralPath $stateFile -Value $line -Encoding utf8
    Add-Content -LiteralPath $log -Value $line -Encoding utf8
    Write-Host $line
}

function Invoke-Logged([string]$title, [scriptblock]$action) {
    Add-Content -LiteralPath $log -Value "==> $title $(Get-Date -Format s)" -Encoding utf8
    Write-Host "==> $title"
    # Lo que los programas escriben por la salida de errores (cargo pone ahí
    # «Finished…») no es un fallo: manda el código de salida. Con 'Stop',
    # PowerShell 5 lo convertía en error y paraba la build (23-11).
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $action *>&1 | ForEach-Object { "$_" } | Out-File -FilePath $log -Append -Encoding utf8
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return $code
}

function Resolve-KeysDir {
    if ($NoSign) { return '' }
    if ($KeysDir) { return $KeysDir }
    $memory = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'WTerminalBuild\keys-dir.txt' }
    if ($memory -and (Test-Path -LiteralPath $memory -PathType Leaf)) {
        $last = (Get-Content -LiteralPath $memory -Raw).Trim()
        if ($last -and (Test-Path -LiteralPath $last -PathType Container)) { return $last }
    }
    $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claves SSH'
    if (Test-Path -LiteralPath $desktop -PathType Container) { return $desktop }
    return ''
}

if ($SkipWsl) { $env:E2E_SKIP_WSL = '1' }
$env:WSL_UTF8 = $null
if ($ResumeAfterReboot) {
    # Lo que relanza build-stages-resume.ps1: esta misma orden.
    $again = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Label', $Label, '-Suites', ($Suites -join ','), '-ResumeAfterReboot')
    if ($SkipWsl) { $again += '-SkipWsl' }
    if ($NoSign) { $again += '-NoSign' }
    if ($KeysDir) { $again += @('-KeysDir', "`"$KeysDir`"") }
    Set-Content -LiteralPath $pending -Value ($again -join ' ') -Encoding utf8
}

$started = Get-Date
Add-Content -LiteralPath $log -Value ("inicio build $Label por etapas ($Description; ya hechas: {0}) {1}" -f (($done.Keys | Sort-Object) -join ', '), $started.ToString('s')) -Encoding utf8
$exitCode = 0
try {
    if ($CheckFirst -and -not $done.ContainsKey('comprobar')) {
        $code = Invoke-Logged 'comprobar: npm run check:local' { node scripts/package-scripts.mjs run check:local }
        if ($code -eq 0) {
            $code = Invoke-Logged 'comprobar: cargo test' { node scripts/run-rust-tool.mjs cargo test --manifest-path src-tauri/Cargo.toml --lib }
        }
        Write-Stage 'comprobar' $code
        $done['comprobar'] = $code
        if ($code -ne 0) { throw 'La comprobación previa falló: no se compila nada.' }
    }

    if (-not $done.ContainsKey('compilar')) {
        if (Get-Command wsl.exe -ErrorAction SilentlyContinue) { wsl.exe --shutdown 2>$null }
        $buildArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build.ps1'),
            '-NoRun', '-NonInteractive', '-FullTests', '-NoFocusedTests', '-AllowOfflineChecks')
        $keys = Resolve-KeysDir
        if ($keys) { $buildArgs += @('-KeysDir', $keys) }
        # En otro proceso: build.ps1 puede acabar con `exit`, que cerraría este.
        $code = Invoke-Logged 'compilar' { & powershell @buildArgs }
        Write-Stage 'compilar' $code
        $done['compilar'] = $code
    }
    # build.ps1 sale con 1 también cuando compiló y firmó pero falló una
    # validación del portable. Si la release está entera, las suites se pasan
    # igual y el fallo queda en el veredicto; solo se para si no hay nada.
    # La release tiene que ser de ESTA compilación: la 84 se paró en la
    # comprobación de espacio y, como la release de la 83 tenía menos de 12 h,
    # las suites probaron el binario viejo. Vale la hora del último
    # «==> compilar» del registro (también tras reanudar).
    if ($done['compilar'] -ne 0) {
        $manifest = Join-Path $release 'SHA256SUMS.txt'
        $compileStart = $started
        $mark = Select-String -LiteralPath $log -Pattern '^==> compilar (\S+)$' -ErrorAction SilentlyContinue | Select-Object -Last 1
        if ($mark) { try { $compileStart = [datetime]::Parse($mark.Matches[0].Groups[1].Value) } catch { } }
        $exe = Join-Path $dist 'wterminal.exe'
        $complete = (Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $manifest) `
            -and ((Get-Item -LiteralPath $manifest).LastWriteTime -gt $compileStart) `
            -and ((Get-Item -LiteralPath $exe).LastWriteTime -gt $compileStart)
        if (-not $complete) { throw "La etapa compilar acabó con código $($done['compilar']) sin release completa: no se pasan las suites." }
        Add-Content -LiteralPath $log -Value "compilar con validaciones pendientes: se siguen las suites sobre la release $(Get-Date -Format s)" -Encoding utf8
    }

    $notice = Join-Path $release 'NO-PUBLICAR.txt'
    $left = @($Suites | Where-Object { -not $done.ContainsKey($_) })
    if ($left.Count -gt 0) {
        Set-Content -LiteralPath $notice -Encoding utf8 -Value "WTerminal $version · build $Label · $(Get-Date -Format 'yyyy-MM-dd HH:mm')`r`nFaltan suites por pasar ($($left -join ', ')): no la publiques ni la repartas. Si la build ya no corre, se cortó a mitad."
    }
    $installer = Join-Path $release "WTerminal-$version-x64-setup.exe"
    $driver = Get-ChildItem (Join-Path $Root 'src-tauri\target\e2e-driver') -Directory -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } | Select-Object -Last 1
    if ($driver) { $env:TAURI_NATIVE_DRIVER = Join-Path $driver.FullName 'msedgedriver.exe' }
    foreach ($suite in $Suites) {
        if ($done.ContainsKey($suite)) { continue }
        if (Get-Command wsl.exe -ErrorAction SilentlyContinue) { wsl.exe --shutdown 2>$null }
        $suiteArgs = @('scripts/run-e2e-suite.mjs', '--binary', (Join-Path $dist 'wterminal.exe'), '--suite', $suite, '--out', (Join-Path $out $suite))
        if ($suite -eq 'installer') { $suiteArgs += @('--installer', $installer, '--release-dir', $dist) }
        $code = Invoke-Logged $suite { node @suiteArgs }
        Write-Stage $suite $code
        $done[$suite] = $code
    }

    $failed = @($done.Keys | Where-Object { $done[$_] -ne 0 })
    if ($failed.Count -gt 0) {
        Set-Content -LiteralPath $notice -Encoding utf8 -Value "WTerminal $version · build $Label · $(Get-Date -Format 'yyyy-MM-dd HH:mm')`r`nEsta build terminó con validaciones pendientes: no la publiques ni la repartas.`r`n`r`nEtapas con fallos: $($failed -join ', '). Detalle en $log y $out."
    } elseif (Test-Path -LiteralPath $notice) {
        Remove-Item -LiteralPath $notice -Force
    }
    Write-Stage 'veredicto' $failed.Count
    $exitCode = [int]($failed.Count -gt 0)
    Write-Host ("Build {0}: {1} en {2:N0} min. Estado: {3}" -f $Label, $(if ($exitCode -eq 0) { 'VERDE' } else { "con fallos ($($failed -join ', '))" }), ((Get-Date) - $started).TotalMinutes, $stateFile)
} catch {
    Add-Content -LiteralPath $log -Value "ERROR $($_.Exception.Message) $(Get-Date -Format s)" -Encoding utf8
    Write-Host "ERROR: $($_.Exception.Message) (registro: $log)"
    $exitCode = 1
} finally {
    Remove-Item -LiteralPath $pending, (Join-Path $stateRoot 'pendiente-intentos.txt') -ErrorAction SilentlyContinue
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) { wsl.exe --shutdown 2>$null }
}
exit $exitCode
