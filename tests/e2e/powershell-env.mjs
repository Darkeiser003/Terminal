// Windows PowerShell 5.1 hereda el PSModulePath del proceso que lo lanza. Si
// la suite o el smoke se ejecutan desde PowerShell 7, esa variable apunta
// primero a los módulos de 7 y 5.1 ya no puede cargar los suyos: el
// `Get-AuthenticodeSignature` de la preparación de PSReadLine devolvía una
// firma vacía y shell-assist fallaba antes de abrir la app. Sin la variable,
// cada PowerShell usa sus rutas de siempre (la app hace lo mismo con sus
// pestañas: `process::windows_powershell_module_path`).

const POWERSHELL_7_MODULES = /[\\/]PowerShell[\\/]7[\\/]|[\\/]Documents[\\/]PowerShell[\\/]Modules/iu;

/** Quita de `env` un PSModulePath heredado de PowerShell 7. Devuelve si lo
 *  quitó. Recorre las claves porque una copia de `process.env` conserva la
 *  mayúscula original y deja de ser insensible a mayúsculas. */
export function dropPowerShell7ModulePath(env = process.env) {
    if (process.platform !== 'win32') return false;
    let removed = false;
    for (const key of Object.keys(env)) {
        if (key.toLowerCase() !== 'psmodulepath') continue;
        if (!POWERSHELL_7_MODULES.test(env[key] ?? '')) continue;
        delete env[key];
        removed = true;
    }
    return removed;
}

/** Un entorno para lanzar `powershell.exe` 5.1 desde Node. */
export function windowsPowerShellEnvironment(base = process.env) {
    const env = { ...base };
    dropPowerShell7ModulePath(env);
    return env;
}
