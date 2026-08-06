// main/currentDir.js
// Extrae el directorio actual a partir del último prompt visible. No existe
// una API portable para consultar el cwd de un proceso hijo (en especial con
// ConPTY), así que se reconocen los prompts por defecto de las shells que la
// aplicación crea. Si el usuario personaliza el prompt se conserva el último
// cwd válido y la UI permite elegir una carpeta manualmente.

const path = require('path');

function isWindowsHostPath(value) {
    return /^[A-Za-z]:[\\/]/.test(String(value || '')) || /^\\\\/.test(String(value || ''));
}

function joinHostPath(root, child) {
    if (isWindowsHostPath(root)) return path.win32.join(root, String(child || '').replace(/\//g, '\\'));
    return path.join(root, String(child || '').replace(/\\/g, '/'));
}

function stripAnsi(value) {
    return String(value || '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
        .replace(/\r/g, '');
}

function wslPathToWindows(value) {
    const match = String(value || '').match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
    if (!match) return null;
    const rest = (match[2] || '').replace(/\//g, '\\');
    return match[1].toUpperCase() + ':\\' + rest;
}

function msysPathToWindows(value) {
    const match = String(value || '').match(/^\/([a-zA-Z])(?:\/(.*))?$/);
    if (!match) return null;
    const rest = (match[2] || '').replace(/\//g, '\\');
    return match[1].toUpperCase() + ':\\' + rest;
}

function mapRemotePath(rawPath, env) {
    if (!rawPath) return null;
    let value = rawPath.trim();
    if (value === '~') return env && env.hostHome ? env.hostHome : null;
    if (value.startsWith('~/') && env && env.hostHome) {
        return joinHostPath(env.hostHome, value.slice(2));
    }

    if (env && env.transport === 'wsl') {
        const mounted = wslPathToWindows(value);
        if (mounted) return mounted;
        // Los archivos internos de una distro también son visibles desde
        // Windows mediante el recurso oficial \\wsl$\<distro>. Esto permite
        // que «Aquí» escanee /home, /opt, etc., no solo /mnt/c.
        if (env.distro && value.startsWith('/')) {
            return `\\\\wsl$\\${env.distro}\\${value.slice(1).replace(/\//g, '\\')}`;
        }
        return null;
    }
    if (env && env.transport === 'msys') return msysPathToWindows(value);
    if (env && env.transport === 'docker' && env.hostRoot && env.containerRoot) {
        const root = env.containerRoot.replace(/\/$/, '');
        if (value === root) return env.hostRoot;
        if (value.startsWith(root + '/')) {
            return joinHostPath(env.hostRoot, value.slice(root.length + 1));
        }
        return null;
    }
    return value;
}

// Wine monta la raíz del sistema anfitrión en Z: y su propio prefijo (con el
// registro y C:\windows falsos) en C:. Solo Z: corresponde a rutas reales del
// host: cualquier otra unidad no existe fuera de Wine y no sirve como cwd.
function winePathToPosix(value) {
    const match = String(value || '').match(/^([A-Za-z]):\\(.*)$/);
    if (!match || match[1].toUpperCase() !== 'Z') return null;
    return '/' + match[2].replace(/\\/g, '/').replace(/\/+$/, '');
}

function lastMatch(text, regex) {
    let result = null;
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) result = match;
    return result;
}

function detectCurrentDirectory(output, env, fallback) {
    const text = stripAnsi(output).slice(-12000);
    let match;

    // PowerShell: PS C:\ruta>  / cmd.exe: C:\ruta>
    match = lastMatch(text, /(?:^|\n)(?:PS\s+)?([A-Za-z]:\\[^\n<>|?*]*?)>\s*$/gm);
    if (match) {
        if (env && env.transport === 'wine') return winePathToPosix(match[1]) || fallback || null;
        return path.win32.normalize(match[1]);
    }

    // Git Bash por defecto: "MINGW64 /c/ruta" y el símbolo $ en la línea
    // siguiente. También cubre MSYS y MINGW32.
    match = lastMatch(text, /(?:MSYS|MINGW(?:32|64))\s+([^\n]+)\n[$#]\s*$/gm);
    if (match) return mapRemotePath(match[1], env);

    // bash/zsh/fish/sh: usuario@host:/ruta$ o root@contenedor:/ruta#.
    match = lastMatch(text, /(?:^|\n)[^\n:]+:([^\n$#]+)[$#]\s*$/gm);
    if (match) return mapRemotePath(match[1], env);

    return fallback || null;
}

module.exports = {
    stripAnsi,
    wslPathToWindows,
    msysPathToWindows,
    winePathToPosix,
    mapRemotePath,
    detectCurrentDirectory
};
