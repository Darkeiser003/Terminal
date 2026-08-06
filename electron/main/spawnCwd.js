// main/spawnCwd.js
// Con qué directorio se lanza el proceso de una pestaña nueva.
//
// Cada shell traduce sola el directorio del proceso a su propia convención
// (cmd y PowerShell lo usan tal cual, Git Bash lo ve como /c/..., WSL como
// /mnt/c/...), así que heredar la carpeta es simplemente lanzar el pty ahí.
// No hace falta escribir ningún `cd` en la terminal ni usar `wsl --cd`.

const fs = require('fs');

// Devuelve el directorio heredado si de verdad sirve para este entorno, o
// null para que el llamante caiga al home:
//   - los contenedores y los dispositivos ADB no comparten el sistema de
//     archivos del host (Docker monta una carpeta fija en /workspace),
//   - las rutas UNC (\\wsl$\..., unidades de red) no valen como directorio
//     actual: cmd.exe no las admite y CreateProcess puede fallar,
//   - y la carpeta tiene que existir todavía.
function usableSpawnCwd(candidate, env, options) {
    const fsImpl = (options && options.fs) || fs;
    if (!candidate || typeof candidate !== 'string') return null;
    if (env && (env.transport === 'docker' || env.transport === 'android')) return null;
    if (/^\\\\/.test(candidate)) return null;
    try {
        return fsImpl.statSync(candidate).isDirectory() ? candidate : null;
    } catch (error) {
        return null;
    }
}

// Directorio definitivo: el heredado si sirve, el propio del entorno (Docker
// monta el home del usuario) y, como último recurso, la carpeta personal.
function resolveSpawnCwd(candidate, env, homeCwd, options) {
    return usableSpawnCwd(candidate, env, options)
        || (env && env.initialHostCwd)
        || homeCwd;
}

module.exports = { usableSpawnCwd, resolveSpawnCwd };
