param(
    [string]$Action = 'menu',
    [string[]]$Arguments = @()
)

$ErrorActionPreference = 'Continue'

function Show-ServiceStatus {
    Get-Service | Sort-Object Status,Name | Format-Table Status,Name,DisplayName -AutoSize
}

function Restart-SelectedService([string]$Name) {
    if (-not $Name) { $Name = Read-Host 'Nombre del servicio' }
    if (-not $Name) { return }
    try {
        Restart-Service -Name $Name -Force -Confirm:$false -ErrorAction Stop
        Get-Service -Name $Name | Format-Table Status,Name,DisplayName -AutoSize
    } catch {
        Write-Error "No se pudo reiniciar $Name. Puede requerir una consola elevada: $_"
    }
}

function Show-ServiceLogs([string]$Name) {
    if (-not $Name) { $Name = Read-Host 'Nombre del servicio o deja vacío para eventos del sistema' }
    if ($Name) {
        Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName=$Name} -MaxEvents 100 |
            Format-Table TimeCreated,Id,LevelDisplayName,Message -Wrap
    } else {
        Get-WinEvent -LogName System -MaxEvents 100 |
            Format-Table TimeCreated,Id,ProviderName,LevelDisplayName,Message -Wrap
    }
}

function Show-Menu {
    while ($true) {
        Write-Host ''
        Write-Host 'Servicios de Windows'
        Write-Host '  1) Estado de servicios'
        Write-Host '  2) Reiniciar un servicio'
        Write-Host '  3) Ver últimos eventos del sistema'
        Write-Host '  0) Salir'
        switch (Read-Host 'Opción') {
            '1' { Show-ServiceStatus }
            '2' { Restart-SelectedService }
            '3' { Show-ServiceLogs }
            '0' { return }
            default { Write-Warning 'Opción no válida.' }
        }
    }
}

try {
    switch ($Action.ToLowerInvariant()) {
        'menu' { Show-Menu }
        'status' { Show-ServiceStatus }
        'restart' { Restart-SelectedService ($Arguments | Select-Object -First 1) }
        'logs' { Show-ServiceLogs ($Arguments | Select-Object -First 1) }
        default { throw "Acción desconocida: $Action" }
    }
} catch {
    Write-Error $_
    exit 1
}
