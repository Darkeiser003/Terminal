param([string]$Action = 'menu')

function Show-Interfaces {
    Write-Host 'Interfaces y direcciones:'
    Get-NetIPConfiguration | Where-Object IPv4Address |
        Select-Object InterfaceAlias,IPv4Address,IPv6Address | Format-Table -AutoSize
    Write-Host ''
    Write-Host 'Rutas:'
    Get-NetRoute -AddressFamily IPv4 | Select-Object DestinationPrefix,NextHop,InterfaceAlias,RouteMetric |
        Format-Table -AutoSize
}

function Show-Vpn {
    Write-Host 'VPN y túneles detectados:'
    if (Get-Command tailscale.exe -ErrorAction SilentlyContinue) {
        Write-Host ''
        Write-Host '[Tailscale]'
        & tailscale.exe status
        & tailscale.exe ip
    }
    if (Get-Command wg.exe -ErrorAction SilentlyContinue) {
        Write-Host ''
        Write-Host '[WireGuard]'
        & wg.exe show
    }
    Get-VpnConnection -AllUserConnection -ErrorAction SilentlyContinue |
        Select-Object Name,ConnectionStatus,ServerAddress | Format-Table -AutoSize
    Get-VpnConnection -ErrorAction SilentlyContinue |
        Select-Object Name,ConnectionStatus,ServerAddress | Format-Table -AutoSize
}

function Show-Menu {
    while ($true) {
        Write-Host ''
        Write-Host 'Red y VPN'
        Write-Host '  1) Interfaces y rutas'
        Write-Host '  2) Estado de VPN y túneles'
        Write-Host '  0) Salir'
        switch (Read-Host 'Opción') {
            '1' { Show-Interfaces }
            '2' { Show-Vpn }
            '0' { return }
            default { Write-Warning 'Opción no válida.' }
        }
    }
}

switch ($Action.ToLowerInvariant()) {
    'menu' { Show-Menu }
    'interfaces' { Show-Interfaces }
    'ip' { Show-Interfaces }
    'routes' { Show-Interfaces }
    'vpn' { Show-Vpn }
    'tunnels' { Show-Vpn }
    default { Write-Error "Acción desconocida: $Action"; exit 1 }
}
