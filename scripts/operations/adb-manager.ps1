param(
    [string]$Action = 'menu',
    [string]$Serial = ''
)

if (-not (Get-Command adb.exe -ErrorAction SilentlyContinue)) {
    Write-Error 'ADB no está instalado o no está en PATH. Instálalo desde Entorno y dependencias.'
    exit 1
}

function Show-Devices { & adb.exe devices -l }
function Restart-Adb {
    & adb.exe kill-server
    & adb.exe start-server
    Show-Devices
}
function Open-AdbShell {
    if (-not $Serial) { $Serial = Read-Host 'Serie del dispositivo (vacío para el primero)' }
    if ($Serial) { & adb.exe -s $Serial shell } else { & adb.exe shell }
}
function Show-Menu {
    while ($true) {
        Write-Host ''
        Write-Host 'Android Debug Bridge'
        Write-Host '  1) Ver dispositivos'
        Write-Host '  2) Reiniciar servidor ADB'
        Write-Host '  3) Abrir shell del dispositivo'
        Write-Host '  0) Salir'
        switch (Read-Host 'Opción') {
            '1' { Show-Devices }
            '2' { Restart-Adb }
            '3' { Open-AdbShell }
            '0' { return }
            default { Write-Warning 'Opción no válida.' }
        }
    }
}

switch ($Action.ToLowerInvariant()) {
    'menu' { Show-Menu }
    'devices' { Show-Devices }
    'status' { Show-Devices }
    'restart' { Restart-Adb }
    'shell' { Open-AdbShell }
    default { Write-Error "Acción desconocida: $Action"; exit 1 }
}
