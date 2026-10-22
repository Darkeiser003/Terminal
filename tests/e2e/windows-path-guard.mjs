// Copia exacta del PATH del usuario y del estado de «Invocar WTerminal desde
// el PATH» (HKCU). El perfil aislado del E2E no cubre el registro: cualquier
// prueba que toque la integración debe guardar esta copia antes y reponerla
// después, y las suites comprueban al final que no cambió nada.
import { execFile as execFileCallback } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const WINDOWS_PATH_STATE_KEY = 'Software\\WTerminal\\PathIntegration';

const SNAPSHOT_SCRIPT = `$ErrorActionPreference = 'Stop'
$root = [Microsoft.Win32.Registry]::CurrentUser
$environment = $root.OpenSubKey('Environment')
$path = $null; $kind = $null
if ($environment -and ($environment.GetValueNames() -contains 'Path')) {
    $path = $environment.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
    $kind = $environment.GetValueKind('Path').ToString()
}
$state = $root.OpenSubKey('${WINDOWS_PATH_STATE_KEY}')
$values = @()
if ($state) { foreach ($name in $state.GetValueNames()) { $values += @{ name = $name; kind = $state.GetValueKind($name).ToString(); value = "$($state.GetValue($name))" } } }
@{ path = $path; kind = $kind; stateExists = [bool]$state; state = $values } | ConvertTo-Json -Compress -Depth 4`;

const RESTORE_SCRIPT = `$ErrorActionPreference = 'Stop'
$snapshot = $env:WTERMINAL_E2E_PATH_SNAPSHOT | ConvertFrom-Json
if ($null -eq $snapshot) { throw 'Copia del PATH vacía: no se restaura nada.' }
$root = [Microsoft.Win32.Registry]::CurrentUser
$environment = $root.CreateSubKey('Environment')
if ($null -eq $snapshot.path) { $environment.DeleteValue('Path', $false) }
else { $environment.SetValue('Path', [string]$snapshot.path, [Microsoft.Win32.RegistryValueKind]$snapshot.kind) }
$root.DeleteSubKeyTree('${WINDOWS_PATH_STATE_KEY}', $false)
if ($snapshot.stateExists) {
    $state = $root.CreateSubKey('${WINDOWS_PATH_STATE_KEY}')
    foreach ($item in @($snapshot.state)) {
        $kind = [Microsoft.Win32.RegistryValueKind]$item.kind
        $value = if ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord) { [int]$item.value } else { [string]$item.value }
        $state.SetValue($item.name, $value, $kind)
    }
}`;

/** Devuelve la copia, o `null` fuera de Windows. */
export async function snapshotWindowsPathIntegration() {
    if (process.platform !== 'win32') return null;
    const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_SCRIPT], { windowsHide: true });
    const snapshot = JSON.parse(stdout.trim());
    snapshot.state = Array.isArray(snapshot.state) ? snapshot.state : (snapshot.state ? [snapshot.state] : []);
    return snapshot;
}

export function sameWindowsPathSnapshot(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

/** Repone la copia y comprueba que el registro quedó exactamente igual. */
export async function restoreWindowsPathIntegration(snapshot) {
    if (!snapshot || process.platform !== 'win32') return;
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', RESTORE_SCRIPT], {
        windowsHide: true,
        env: { ...process.env, WTERMINAL_E2E_PATH_SNAPSHOT: JSON.stringify(snapshot) },
    });
    const after = await snapshotWindowsPathIntegration();
    if (!sameWindowsPathSnapshot(after, snapshot)) {
        throw new Error(`No se pudo restaurar exactamente el PATH del usuario: ${JSON.stringify({ before: snapshot, after })}`);
    }
}
