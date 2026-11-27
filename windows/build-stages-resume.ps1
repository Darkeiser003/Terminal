#requires -Version 5.0
<#
.SYNOPSIS
  Reanuda la build por etapas que un reinicio dejó a medias.

.DESCRIPTION
  windows/build-stages.ps1 -ResumeAfterReboot apunta su orden en
  artifacts\build-stages\pendiente.txt al empezar y la borra al terminar,
  bien o mal. Si el equipo cae, el aviso se queda y este script (puesto al
  iniciar sesión con build-stages.ps1 -InstallResumeAtLogon) la relanza; cada
  etapa ya hecha se salta. Como mucho dos reanudaciones seguidas.

  Para cancelar una reanudación: borrar artifacts\build-stages\pendiente.txt.
#>
[CmdletBinding()]
param([int]$WaitSeconds = 120)

$Root = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $Root 'artifacts\build-stages'
$pending = Join-Path $stateRoot 'pendiente.txt'
$attempts = Join-Path $stateRoot 'pendiente-intentos.txt'
$journal = Join-Path $stateRoot 'reanudaciones.log'
if (-not (Test-Path -LiteralPath $pending)) { exit 0 }
$arguments = "$(Get-Content -LiteralPath $pending -TotalCount 1)".Trim()
if (-not $arguments) { exit 0 }
$count = 0
if (Test-Path -LiteralPath $attempts) { [void][int]::TryParse("$(Get-Content -LiteralPath $attempts -TotalCount 1)", [ref]$count) }
if ($count -ge 2) {
    Add-Content -LiteralPath $journal -Value "NO se reanuda: ya van $count reanudaciones seguidas $(Get-Date -Format s)" -Encoding utf8
    exit 1
}
Set-Content -LiteralPath $attempts -Value ($count + 1)
Add-Content -LiteralPath $journal -Value "reanudando en $WaitSeconds s: $arguments $(Get-Date -Format s)" -Encoding utf8
# Dejar que el escritorio termine de arrancar antes de cargar el equipo.
Start-Sleep -Seconds $WaitSeconds
Set-Location $Root
Start-Process -FilePath (Get-Command powershell).Source -ArgumentList $arguments -WindowStyle Minimized
