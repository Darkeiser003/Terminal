param(
    [string]$Action = 'menu',
    [string[]]$Arguments = @()
)

$ErrorActionPreference = 'Continue'

function Require-Ssh {
    if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
        throw 'SSH no está instalado o no está en PATH. Instálalo desde Entorno y dependencias.'
    }
}

function Get-SshHosts {
    $config = Join-Path $HOME '.ssh/config'
    if (-not (Test-Path -LiteralPath $config)) {
        Write-Host "No existe todavía $config"
        return
    }
    Get-Content -LiteralPath $config | ForEach-Object {
        if ($_ -match '^\s*Host\s+(.+)$') {
            $Matches[1] -split '\s+' | Where-Object { $_ -and $_ -notmatch '[*?!]' }
        }
    } | Sort-Object -Unique
}

function Connect-Ssh([string]$HostName) {
    Require-Ssh
    if (-not $HostName) {
        $known = @(Get-SshHosts)
        if ($known.Count -gt 0) {
            Write-Host 'Hosts guardados:'
            for ($i = 0; $i -lt $known.Count; $i++) { Write-Host "  $($i + 1)) $($known[$i])" }
            $selection = Read-Host 'Host o número (0 para cancelar)'
            if ($selection -eq '0') { return }
            if ($selection -match '^\d+$' -and [int]$selection -ge 1 -and [int]$selection -le $known.Count) {
                $HostName = $known[[int]$selection - 1]
            } else {
                $HostName = $selection
            }
        } else {
            $HostName = Read-Host 'Host, usuario@host o alias SSH'
        }
    }
    if ($HostName) { & ssh.exe $HostName @Arguments }
}

function Show-NetworkInfo {
    Write-Host 'Direcciones de red:'
    Get-NetIPConfiguration | Where-Object IPv4Address | Select-Object InterfaceAlias,IPv4Address,IPv6Address | Format-Table -AutoSize
    if (Get-Command tailscale.exe -ErrorAction SilentlyContinue) {
        Write-Host ''
        Write-Host 'Tailscale:'
        & tailscale.exe status
        & tailscale.exe ip
    }
    if (Get-Command wg.exe -ErrorAction SilentlyContinue) {
        Write-Host ''
        Write-Host 'WireGuard:'
        & wg.exe show interfaces
    }
    Write-Host ''
    Write-Host 'Adaptadores activos:'
    Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name,InterfaceDescription,LinkSpeed | Format-Table -AutoSize
}

function Show-Menu {
    while ($true) {
        Write-Host ''
        Write-Host 'SSH y acceso remoto'
        Write-Host '  1) Conectar a un host'
        Write-Host '  2) Ver hosts guardados'
        Write-Host '  3) Ver IPs y VPN'
        Write-Host '  0) Salir'
        switch (Read-Host 'Opción') {
            '1' { Connect-Ssh }
            '2' { Get-SshHosts }
            '3' { Show-NetworkInfo }
            '0' { return }
            default { Write-Warning 'Opción no válida.' }
        }
    }
}

try {
    switch ($Action.ToLowerInvariant()) {
        'menu' { Show-Menu }
        'connect' { Connect-Ssh ($Arguments | Select-Object -First 1) }
        'hosts' { Get-SshHosts }
        'config' { Get-SshHosts }
        'network' { Show-NetworkInfo }
        'ip' { Show-NetworkInfo }
        'vpn' { Show-NetworkInfo }
        default { throw "Acción desconocida: $Action" }
    }
} catch {
    Write-Error $_
    exit 1
}
