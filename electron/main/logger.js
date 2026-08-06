// main/logger.js
// Logger simple a archivo, sin dependencias externas (evita sumar otro
// paquete no verificado contra el registro real, ver CLAUDE.md).
// Escribe en <userData>/logs/main.log con rotación por tamaño.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB por archivo antes de rotar
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = process.env.LTERMINAL_LOG_LEVEL || process.env.WINSLIM_LOG_LEVEL || 'info';

// Id corto que identifica esta ejecución de la app dentro del archivo de
// log (que es acumulativo entre arranques): sirve para distinguir de un
// vistazo dónde empieza y termina cada sesión.
const sessionId = Date.now().toString(36).slice(-6);

let logDir = null;
let logFile = null;

function resolveLogFile() {
    if (logFile) return logFile;
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'main.log');
    return logFile;
}

function rotateIfNeeded() {
    try {
        const stat = fs.statSync(logFile);
        if (stat.size > MAX_LOG_BYTES) {
            const rotated = logFile + '.1';
            fs.rmSync(rotated, { force: true });
            fs.renameSync(logFile, rotated);
        }
    } catch (e) {
        // El archivo aun no existe la primera vez: no hay nada que rotar.
    }
}

function safeStringify(meta) {
    if (meta instanceof Error) return meta.stack || meta.message;
    if (meta === undefined) return '';
    try {
        return JSON.stringify(meta);
    } catch (e) {
        return String(meta);
    }
}

function write(level, message, meta) {
    if (LEVELS[level] > LEVELS[currentLevel]) return;

    const metaStr = safeStringify(meta);
    const line = `[${new Date().toISOString()}] [${sessionId}] [${level.toUpperCase()}] ${message}` +
        (metaStr ? ' ' + metaStr : '') + '\n';

    try {
        resolveLogFile();
        rotateIfNeeded();
        fs.appendFileSync(logFile, line);
    } catch (e) {
        // Si el disco falla, el logging no debe tumbar la app; se ignora.
    }

    if (!app.isPackaged) {
        const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        consoleFn(line.trim());
    }
}

// Banner visual (varias líneas separadas por "====") para los eventos que
// más importa poder ubicar de un vistazo al ojear el archivo: arranque y
// cierre de la app, sobre todo. No es un nivel de log distinto, es "info"
// con formato especial.
function banner(title, meta) {
    const bar = '='.repeat(Math.max(20, title.length + 8));
    try {
        resolveLogFile();
        rotateIfNeeded();
        const metaStr = safeStringify(meta);
        fs.appendFileSync(
            logFile,
            `\n${bar}\n[${new Date().toISOString()}] [${sessionId}] ${title}${metaStr ? ' ' + metaStr : ''}\n${bar}\n`
        );
    } catch (e) {
        // Igual que write(): un fallo de disco aqui no debe tumbar la app.
    }
    if (!app.isPackaged) {
        console.log(`\n${bar}\n${title}${meta ? ' ' + JSON.stringify(meta) : ''}\n${bar}`);
    }
}

module.exports = {
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    debug: (msg, meta) => write('debug', msg, meta),
    banner,
    sessionId,
    getLogDir: () => {
        resolveLogFile();
        return logDir;
    }
};
