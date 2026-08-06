// main/settings.js
// Configuración persistente de la app, guardada como JSON simple en
// <userData>/settings.json. No usa ninguna dependencia nueva.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const logger = require('./logger');

function settingsPath() {
    return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
    const target = settingsPath();
    try {
        return JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (e) {
        if (e.code === 'ENOENT') return {};
        logger.warn('No se pudo leer settings.json; se intentará la copia de respaldo', { error: e.message });
        try {
            const recovered = JSON.parse(fs.readFileSync(target + '.bak', 'utf8'));
            logger.info('Configuración recuperada desde settings.json.bak');
            return recovered;
        } catch (backupError) {
            logger.warn('No hay una copia de configuración recuperable', { error: backupError.message });
            return {};
        }
    }
}

function saveSettings(settings) {
    let tempPath = null;
    let backupPath = null;
    let targetPath = null;
    try {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        // Los callers guardan parches parciales (por ejemplo, solo la carpeta
        // de scripts). Fusionarlos evita borrar otras preferencias como
        // autoStartDocker al modificar una opción distinta.
        const next = { ...loadSettings(), ...(settings || {}) };
        targetPath = settingsPath();
        backupPath = targetPath + '.bak';
        tempPath = targetPath + `.tmp-${process.pid}`;
        fs.writeFileSync(tempPath, JSON.stringify(next, null, 2));

        // En Windows renombrar encima de un fichero existente puede fallar.
        // Se aparta primero la versión anterior: si el proceso se interrumpe
        // entre ambos renombres, loadSettings todavía puede recuperar .bak.
        fs.rmSync(backupPath, { force: true });
        if (fs.existsSync(targetPath)) fs.renameSync(targetPath, backupPath);
        fs.renameSync(tempPath, targetPath);
        // Verificación temprana: no se elimina el respaldo hasta comprobar
        // que el JSON final puede volver a abrirse.
        JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        fs.rmSync(backupPath, { force: true });
        return next;
    } catch (e) {
        logger.error('No se pudo guardar settings.json', { error: e.message });
        if (tempPath) {
            try { fs.rmSync(tempPath, { force: true }); } catch (cleanupError) { }
        }
        // Si el destino quedó apartado pero no se pudo instalar el nuevo,
        // se restaura la configuración anterior en el mejor esfuerzo.
        if (targetPath && backupPath && !fs.existsSync(targetPath) && fs.existsSync(backupPath)) {
            try { fs.renameSync(backupPath, targetPath); } catch (restoreError) {
                logger.error('No se pudo restaurar settings.json.bak', { error: restoreError.message });
            }
        }
        return null;
    }
}

module.exports = { settingsPath, loadSettings, saveSettings };
