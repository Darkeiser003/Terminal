#requires -Version 5.0
<#
    Recorre el instalador NSIS de WTerminal página a página, de forma visible,
    y guarda una captura de cada una; después hace lo mismo con el
    desinstalador. Es la pasada visible que acompaña a la instalación
    silenciosa del E2E (`scripts/test-installer.mjs`): esa prueba comprueba
    archivos y registro, esta enseña cómo se ve cada página.

    Uso (necesita poder elevar: el instalador es por máquina):
      powershell -ExecutionPolicy Bypass -File scripts/capture-installer-pages.ps1 `
          -Installer release\WTerminal-1.0.0-x64-setup.exe -OutDir artifacts\installer-pages

    El script se relanza elevado si hace falta: Windows no deja que un proceso
    sin elevar pulse botones de una ventana elevada (UIPI). Avanza con «Intro»,
    que en cada página de NSIS es «Siguiente», «Instalar», «Desinstalar» o
    «Terminar». No marca «Borrar los datos de la aplicación» al desinstalar.
#>
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$PageTimeoutSeconds = 120,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path -LiteralPath $Installer).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
        '-Installer', "`"$Installer`"", '-OutDir', "`"$OutDir`"", '-PageTimeoutSeconds', $PageTimeoutSeconds, '-Elevated')
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    exit $process.ExitCode
}

# La copia elevada no tiene una consola que vea quien la lanzó: deja su salida
# en la carpeta de capturas.
if ($Elevated) { Start-Transcript -LiteralPath (Join-Path $OutDir 'capture.log') -Force | Out-Null }

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class InstallerWindows {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);

    public static IntPtr TopWindowOf(uint[] pids) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, l) => {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (IsWindowVisible(hwnd) && Array.IndexOf(pids, pid) >= 0) { found = hwnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static string Title(IntPtr hwnd) { var b = new StringBuilder(256); GetWindowText(hwnd, b, 256); return b.ToString(); }
}
'@

function Get-ProcessTreeIds([int]$RootId) {
    $all = Get-CimInstance Win32_Process
    $ids = New-Object System.Collections.Generic.List[uint32]
    $ids.Add([uint32]$RootId)
    for ($i = 0; $i -lt 4; $i++) {
        foreach ($p in $all) { if ($ids.Contains([uint32]$p.ParentProcessId) -and -not $ids.Contains([uint32]$p.ProcessId)) { $ids.Add([uint32]$p.ProcessId) } }
    }
    return $ids.ToArray()
}

function Save-WindowCapture([IntPtr]$Window, [string]$Path) {
    $rect = New-Object InstallerWindows+RECT
    [void][InstallerWindows]::GetWindowRect($Window, [ref]$rect)
    $width = [Math]::Max(1, $rect.Right - $rect.Left)
    $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    # PW_RENDERFULLCONTENT (2): también en sesiones sin compositor activo.
    $ok = [InstallerWindows]::PrintWindow($Window, $hdc, 2)
    $graphics.ReleaseHdc($hdc)
    if (-not $ok) { $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size) }
    $graphics.Dispose()
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

# Pulsa el botón por defecto de la página (id 1 en NSIS: Siguiente, Instalar,
# Desinstalar, Terminar) en cuanto está activo.
function Push-NextButton([IntPtr]$Window) {
    $button = [InstallerWindows]::GetDlgItem($Window, 1)
    if ($button -eq [IntPtr]::Zero -or -not [InstallerWindows]::IsWindowEnabled($button)) { return $false }
    # WM_COMMAND (BN_CLICKED, id 1) a la ventana del asistente: es lo que NSIS
    # recibe al pulsar el botón. BM_CLICK no siempre llega en la página final
    # («Terminar»), donde el botón no tiene el foco.
    [void][InstallerWindows]::SetForegroundWindow($Window)
    # PostMessage y no SendMessage: al pasar a la página final NSIS no devuelve
    # el control hasta que esa página se cierra, y SendMessage dejaba el script
    # bloqueado (y el asistente en pantalla) sin llegar a medir el tiempo.
    [void][InstallerWindows]::PostMessage($Window, 0x0111, [IntPtr]1, $button)
    return $true
}

function Invoke-WizardCapture([string]$Exe, [string]$Arguments, [string]$Prefix, [scriptblock]$Done) {
    $process = if ([string]::IsNullOrWhiteSpace($Arguments)) {
        Start-Process -FilePath $Exe -PassThru
    } else {
        Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
    }
    $page = 0
    $lastSignature = ''
    $lastClick = Get-Date
    $deadline = (Get-Date).AddSeconds($PageTimeoutSeconds)
    while (-not $process.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 700
        $window = [InstallerWindows]::TopWindowOf((Get-ProcessTreeIds $process.Id))
        if ($window -eq [IntPtr]::Zero) { continue }
        $title = [InstallerWindows]::Title($window)
        $button = [InstallerWindows]::GetDlgItem($window, 1)
        $enabled = $button -ne [IntPtr]::Zero -and [InstallerWindows]::IsWindowEnabled($button)
        # Todas las páginas comparten ventana y título: lo que cambia es el
        # texto del botón por defecto y el título de la cabecera de MUI (1037).
        $buttonText = if ($button -ne [IntPtr]::Zero) { [InstallerWindows]::Title($button) } else { '' }
        $header = [InstallerWindows]::GetDlgItem($window, 1037)
        $headerText = if ($header -ne [IntPtr]::Zero) { [InstallerWindows]::Title($header) } else { '' }
        $signature = "$window|$title|$enabled|$buttonText|$headerText"
        # Con el botón desactivado el asistente está trabajando (copiando archivos,
        # instalando WebView2): eso no cuenta como estar atascado.
        if (-not $enabled) { $deadline = (Get-Date).AddSeconds($PageTimeoutSeconds) }
        if ($signature -eq $lastSignature) {
            # Misma página y botón activo tras unos segundos: el clic anterior
            # no llegó (la página aún se estaba pintando); se repite sin capturar.
            if ($enabled -and ((Get-Date) - $lastClick).TotalSeconds -gt 4) {
                Write-Host "Reintento en la misma página: $signature"
                [void](Push-NextButton $window)
                $lastClick = Get-Date
            }
            continue
        }
        $lastSignature = $signature
        Write-Host "Página nueva: $signature"
        $page++
        $safe = ($title -replace '[^\w\- ]', '').Trim() -replace '\s+', '-'
        $file = Join-Path $OutDir ('{0}-{1:00}-{2}.png' -f $Prefix, $page, $safe)
        Start-Sleep -Milliseconds 400
        Save-WindowCapture $window $file
        Write-Host "Captura: $file"
        $deadline = (Get-Date).AddSeconds($PageTimeoutSeconds)
        if ($enabled) {
            [void](Push-NextButton $window)
            $lastClick = Get-Date
        }
    }
    if (-not $process.HasExited) {
        # La última página («Terminar») no siempre acepta el clic simulado. Si el
        # trabajo ya está hecho (instalado o desinstalado), se captura como está
        # y se cierra el asistente; si no, es un fallo de verdad.
        $finished = $Done -and (& $Done)
        if ($finished) {
            $window = [InstallerWindows]::TopWindowOf((Get-ProcessTreeIds $process.Id))
            if ($window -ne [IntPtr]::Zero) {
                $page++
                Save-WindowCapture $window (Join-Path $OutDir ('{0}-{1:00}-final.png' -f $Prefix, $page))
            }
        }
        # No dejar un asistente abierto en pantalla esperando a alguien.
        foreach ($id in (Get-ProcessTreeIds $process.Id)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        if (-not $finished) { throw "$Prefix no terminó en $PageTimeoutSeconds s sin avanzar de página." }
    }
    return $page
}

function Get-UninstallEntry {
    Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -eq 'WTerminal' } | Select-Object -First 1
}

$installPages = Invoke-WizardCapture $Installer '' 'instalador' {
    $entry = Get-UninstallEntry
    $entry -and (Test-Path -LiteralPath (Join-Path ([string]$entry.InstallLocation).Trim('"') 'wterminal.exe'))
}
$uninstallKey = Get-UninstallEntry

if (-not $uninstallKey) { throw 'Tras la instalación visible no aparece WTerminal en Programas.' }
$uninstaller = ([string]$uninstallKey.UninstallString).Trim('"')
# Cerrar la app que abre la página final antes de desinstalar.
Get-Process wterminal -ErrorAction SilentlyContinue | Stop-Process -Force
# _?= hace que el desinstalador corra en su sitio y no se copie a %TEMP%:
# así su proceso es el que se sigue y no termina antes de tiempo.
$installDir = Split-Path -Parent $uninstaller
$uninstallPages = Invoke-WizardCapture $uninstaller "_?=$installDir" 'desinstalador' {
    -not (Test-Path -LiteralPath (Join-Path $installDir 'wterminal.exe'))
}
# Con _?= el desinstalador no se borra a sí mismo: se quita la carpeta vacía.
Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
@{ installer = $Installer; installPages = $installPages; uninstallPages = $uninstallPages } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutDir 'pages.json') -Encoding UTF8
Write-Host "Instalador: $installPages páginas; desinstalador: $uninstallPages páginas."
