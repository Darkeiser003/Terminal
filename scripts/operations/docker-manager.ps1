param(
    [string]$Action = 'menu',
    [string[]]$Arguments = @()
)

if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    Write-Error 'Docker no está instalado o no está en PATH. Instálalo desde Entorno y dependencias.'
    exit 1
}

function Invoke-Docker([string[]]$Parts) { & docker.exe @Parts }
function Show-Status { Invoke-Docker @('info'); Write-Host ''; Invoke-Docker @('ps', '-a') }
function Show-Menu {
    while ($true) {
        Write-Host ''
        Write-Host 'Docker Compose y contenedores'
        Write-Host '  1) Resumen del motor'
        Write-Host '  2) Contenedores'
        Write-Host '  3) Imágenes'
        Write-Host '  4) Recursos'
        Write-Host '  0) Salir'
        switch (Read-Host 'Opción') {
            '1' { Show-Status }
            '2' { Invoke-Docker @('ps', '-a') }
            '3' { Invoke-Docker @('images') }
            '4' { Invoke-Docker @('stats', '--no-stream') }
            '0' { return }
            default { Write-Warning 'Opción no válida.' }
        }
    }
}

switch ($Action.ToLowerInvariant()) {
    'menu' { Show-Menu }
    'status' { Show-Status }
    'containers' { Invoke-Docker @('ps', '-a') }
    'images' { Invoke-Docker @('images') }
    'stats' { Invoke-Docker @('stats', '--no-stream') }
    default { Invoke-Docker $Arguments }
}
