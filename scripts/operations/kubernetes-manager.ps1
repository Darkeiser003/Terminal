param(
    [string]$Action = 'menu',
    [string[]]$Arguments = @()
)

if (-not (Get-Command kubectl.exe -ErrorAction SilentlyContinue)) {
    Write-Error 'kubectl no está instalado o no está en PATH. Instálalo desde Entorno y dependencias.'
    exit 1
}

function Invoke-Kubectl([string[]]$Parts) { & kubectl.exe @Parts }
function Show-Menu {
    while ($true) {
        Write-Host ''
        Write-Host 'Kubernetes'
        Write-Host '  1) Pods'
        Write-Host '  2) Contextos'
        Write-Host '  3) Namespaces'
        Write-Host '  0) Salir'
        switch (Read-Host 'Opción') {
            '1' { Invoke-Kubectl @('get', 'pods', '-o', 'wide') }
            '2' { Invoke-Kubectl @('config', 'get-contexts') }
            '3' { Invoke-Kubectl @('get', 'namespaces') }
            '0' { return }
            default { Write-Warning 'Opción no válida.' }
        }
    }
}

switch ($Action.ToLowerInvariant()) {
    'menu' { Show-Menu }
    'status' { Invoke-Kubectl @('get', 'pods', '-o', 'wide') }
    'contexts' { Invoke-Kubectl @('config', 'get-contexts') }
    'namespaces' { Invoke-Kubectl @('get', 'namespaces') }
    default { Invoke-Kubectl $Arguments }
}
