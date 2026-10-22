#requires -Version 5.0
<#
    Mitad elevada de la prueba del instalador NSIS (scripts/test-installer.mjs).

    Se lanza con un único aviso de UAC: instala en silencio, deja constancia en
    `installed.json`, espera a que la prueba sin privilegios termine el E2E
    sobre la aplicación instalada (archivo `uninstall.request`) y desinstala.
    Si nadie lo pide antes del límite, desinstala igualmente: la prueba nunca
    debe dejar WTerminal instalado en el equipo.
#>
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [int]$WaitMinutes = 60
)

$ErrorActionPreference = 'Stop'

function Write-State {
    param([string]$Name, [hashtable]$Data)
    $Data.at = (Get-Date).ToString('o')
    $Data | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $WorkDir $Name) -Encoding UTF8
}

function Get-UninstallEntry {
    $roots = @(
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    Get-ChildItem $roots -ErrorAction SilentlyContinue |
        Get-ItemProperty -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq 'WTerminal' } |
        Select-Object -First 1
}

function Get-InstallDirectory {
    $entry = Get-UninstallEntry
    if ($entry -and $entry.InstallLocation) { return $entry.InstallLocation.Trim('"') }
    return (Join-Path $env:ProgramFiles 'WTerminal')
}

try {
    Write-State 'elevated-started.json' @{ pid = $PID }
    $install = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
    $installDir = Get-InstallDirectory
    Write-State 'installed.json' @{
        exitCode = $install.ExitCode
        installDir = $installDir
        files = @(Get-ChildItem -LiteralPath $installDir -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    }

    $deadline = (Get-Date).AddMinutes($WaitMinutes)
    $request = Join-Path $WorkDir 'uninstall.request'
    while (-not (Test-Path -LiteralPath $request) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
    }
    $requested = Test-Path -LiteralPath $request

    $uninstaller = Join-Path $installDir 'uninstall.exe'
    $uninstallCode = $null
    if (Test-Path -LiteralPath $uninstaller) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
        $uninstallCode = $uninstall.ExitCode
        # El desinstalador de NSIS se copia a TEMP y termina antes de borrar:
        # se espera a que desaparezcan el ejecutable y la entrada del registro.
        $removalDeadline = (Get-Date).AddMinutes(3)
        while (((Test-Path -LiteralPath (Join-Path $installDir 'wterminal.exe')) -or (Get-UninstallEntry)) -and (Get-Date) -lt $removalDeadline) {
            Start-Sleep -Milliseconds 500
        }
    }
    Write-State 'uninstalled.json' @{
        requested = $requested
        exitCode = $uninstallCode
        installDirExists = Test-Path -LiteralPath $installDir
        executableExists = Test-Path -LiteralPath (Join-Path $installDir 'wterminal.exe')
        uninstallEntryExists = [bool](Get-UninstallEntry)
    }
} catch {
    Write-State 'elevated-error.json' @{ message = $_.Exception.Message }
    exit 1
}
