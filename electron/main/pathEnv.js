// main/pathEnv.js
// Mantiene el PATH del PROCESO de la app sincronizado con el PATH real del
// sistema, y centraliza la búsqueda de ejecutables (`which`).
//
// El problema que resuelve: un instalador lanzado desde la propia terminal
// (winget, el script de ADB, apt...) escribe la carpeta nueva en el PATH
// persistente del usuario (en Windows, el registro), pero eso NO afecta a
// los procesos ya en marcha. La app heredó su PATH al arrancar y cada
// pestaña se spawnea con `env: process.env`, así que sin esto haría falta
// cerrar y volver a abrir la app entera para que una herramienta recién
// instalada funcionara en una pestaña nueva — y para que la app dejara de
// ofrecer "Instalar" algo que ya está instalado.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const WHICH_CACHE_MS = 5000;
const whichCache = new Map();

function clearWhichCache() {
    whichCache.clear();
}

// El separador de PATH es ':' en las plataformas donde esta función se usa
// de verdad (which() solo la llama fuera de Windows). Se admite indicar otro
// para poder ejercitar la búsqueda desde una prueba en Windows, donde una
// ruta como C:\Temp\... contiene ese mismo ':' y quedaría partida por la
// letra de unidad.
function findUnixExecutable(cmd, pathValue, fsImpl, separator) {
    if (typeof cmd !== 'string' || !cmd || /[\u0000\r\n]/.test(cmd)) return null;
    const sep = typeof separator === 'string' && separator ? separator : ':';
    const candidates = cmd.includes('/')
        ? [path.resolve(cmd)]
        : String(pathValue || '').split(sep).filter(Boolean).map((dir) => path.join(dir, cmd));
    for (const candidate of candidates) {
        try {
            fsImpl.accessSync(candidate, fs.constants.X_OK);
            if (fsImpl.statSync(candidate).isFile()) return candidate;
        } catch (error) { /* no ejecutable o no accesible */ }
    }
    return null;
}

// Busca un ejecutable en el PATH actual del proceso. Devuelve la ruta
// completa o null.
function which(cmd) {
    const cacheKey = `${process.env.PATH || ''}\u0000${cmd}`;
    const cached = whichCache.get(cacheKey);
    if (cached && Date.now() - cached.at < WHICH_CACHE_MS) return cached.value;
    if (process.platform !== 'win32') {
        const value = findUnixExecutable(cmd, process.env.PATH, fs);
        whichCache.set(cacheKey, { at: Date.now(), value });
        return value;
    }
    try {
        const out = execFileSync('where', [cmd], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 1500
        });
        const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        const value = first || null;
        whichCache.set(cacheKey, { at: Date.now(), value });
        return value;
    } catch (e) {
        whichCache.set(cacheKey, { at: Date.now(), value: null });
        return null;
    }
}

// Clave de comparación entre entradas de PATH: Windows no distingue
// mayúsculas y la barra final es irrelevante ("C:\Foo\" == "c:\foo").
function pathKey(entry) {
    let value = entry.trim().replace(/^"|"$/g, '');
    if (process.platform === 'win32') value = value.toLowerCase();
    return value.replace(/[\\/]+$/, '');
}

function splitPath(value) {
    const sep = process.platform === 'win32' ? ';' : ':';
    return (value || '').split(sep).map((s) => s.trim()).filter(Boolean);
}

// Añade una carpeta al PATH del proceso si no estaba ya. Devuelve true si
// de verdad se añadió.
function addToProcessPath(dir) {
    if (!dir) return false;
    const sep = process.platform === 'win32' ? ';' : ':';
    const current = process.env.PATH || '';
    const known = new Set(splitPath(current).map(pathKey));
    if (known.has(pathKey(dir))) return false;
    process.env.PATH = current.replace(new RegExp(sep + '+$'), '') + sep + dir;
    clearWhichCache();
    return true;
}

// Lee el valor "Path" de una clave del registro. `reg query` no traduce los
// nombres de valor ni los tipos, así que el parseo vale en cualquier idioma
// de Windows.
function queryRegistryPath(key) {
    try {
        const out = execFileSync('reg', ['query', key, '/v', 'Path'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 1500
        });
        const match = out.match(/\bPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
        return match ? match[1].trim() : null;
    } catch (e) {
        return null;
    }
}

// El PATH de máquina suele guardarse como REG_EXPAND_SZ con referencias sin
// expandir (%SystemRoot%\system32). Se resuelven contra el entorno actual;
// lo que no se reconozca se deja tal cual (mejor una entrada inservible que
// perder el resto del PATH).
function expandEnvVars(value) {
    return value.replace(/%([^%]+)%/g, (whole, name) => {
        const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? process.env[key] : whole;
    });
}

const REGISTRY_PATH_KEYS = [
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    'HKCU\\Environment'
];

// Vuelve a leer el PATH persistente (máquina + usuario) y añade al PATH del
// proceso las carpetas que aún no estuvieran. Nunca quita nada: las
// entradas que la app heredó al arrancar pueden venir de su lanzador y no
// estar en el registro.
//
// Fuera de Windows no hace nada: en Linux/macOS el PATH viene de los
// archivos de perfil de la shell, no de un almacén consultable, y cada
// pestaña ya lo recalcula al arrancar su shell interactiva.
function refreshSystemPath() {
    if (process.platform !== 'win32') return { changed: false, added: [] };

    const known = new Set(splitPath(process.env.PATH).map(pathKey));
    const added = [];

    REGISTRY_PATH_KEYS.forEach((key) => {
        const raw = queryRegistryPath(key);
        if (!raw) return;
        splitPath(expandEnvVars(raw)).forEach((dir) => {
            const k = pathKey(dir);
            if (!k || known.has(k)) return;
            known.add(k);
            added.push(dir);
        });
    });

    added.forEach((dir) => {
        const sep = ';';
        process.env.PATH = (process.env.PATH || '').replace(/;+$/, '') + sep + dir;
    });
    if (added.length) clearWhichCache();

    return { changed: added.length > 0, added };
}

module.exports = { which, findUnixExecutable, addToProcessPath, refreshSystemPath, splitPath, clearWhichCache };
