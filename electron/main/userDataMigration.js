// Unifica los datos creados bajo el nombre visible de Electron con la ruta
// estable basada en el slug de la aplicación. Solo migra configuración y la
// biblioteca de scripts; cachés de Chromium y logs antiguos no se duplican.

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

function readJson(file, fsImpl) {
    try {
        const value = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (error) {
        return null;
    }
}

function modifiedAt(file, fsImpl) {
    try { return fsImpl.statSync(file).mtimeMs || 0; } catch (error) { return 0; }
}

function mergeSettings(legacyDir, canonicalDir, fsImpl, pathImpl) {
    const legacyFile = pathImpl.join(legacyDir, 'settings.json');
    const canonicalFile = pathImpl.join(canonicalDir, 'settings.json');
    const legacy = readJson(legacyFile, fsImpl);
    const canonical = readJson(canonicalFile, fsImpl);
    if (!legacy && !canonical) return false;

    // El archivo más reciente gana solo en claves coincidentes. Así se
    // conservan, por ejemplo, anclados antiguos y preferencias visuales nuevas.
    const legacyIsNewer = modifiedAt(legacyFile, fsImpl) > modifiedAt(canonicalFile, fsImpl);
    const merged = legacyIsNewer
        ? { ...(canonical || {}), ...(legacy || {}) }
        : { ...(legacy || {}), ...(canonical || {}) };
    const current = canonical || {};
    if (isDeepStrictEqual(current, merged)) return false;
    fsImpl.writeFileSync(canonicalFile, JSON.stringify(merged, null, 2), 'utf8');
    return true;
}

function mergeScriptDirectory(source, target, fsImpl, pathImpl) {
    if (!fsImpl.existsSync(source)) return 0;
    fsImpl.mkdirSync(target, { recursive: true });
    let copied = 0;
    fsImpl.readdirSync(source, { withFileTypes: true }).forEach((entry) => {
        const sourcePath = pathImpl.join(source, entry.name);
        const targetPath = pathImpl.join(target, entry.name);
        if (entry.isDirectory()) {
            copied += mergeScriptDirectory(sourcePath, targetPath, fsImpl, pathImpl);
        } else if (entry.isFile() && (!fsImpl.existsSync(targetPath)
            || modifiedAt(sourcePath, fsImpl) > modifiedAt(targetPath, fsImpl))) {
            fsImpl.copyFileSync(sourcePath, targetPath);
            copied += 1;
        }
    });
    return copied;
}

function migrateUserData(legacyDir, canonicalDir, options) {
    const fsImpl = (options && options.fs) || fs;
    const pathImpl = (options && options.path) || path;
    if (!legacyDir || !canonicalDir
        || pathImpl.resolve(legacyDir).toLowerCase() === pathImpl.resolve(canonicalDir).toLowerCase()) {
        return { migrated: false, settingsMerged: false, scriptsCopied: 0 };
    }
    fsImpl.mkdirSync(canonicalDir, { recursive: true });
    const settingsMerged = mergeSettings(legacyDir, canonicalDir, fsImpl, pathImpl);
    const scriptsCopied = mergeScriptDirectory(
        pathImpl.join(legacyDir, 'scripts'),
        pathImpl.join(canonicalDir, 'scripts'),
        fsImpl,
        pathImpl
    );
    return { migrated: settingsMerged || scriptsCopied > 0, settingsMerged, scriptsCopied };
}

module.exports = { migrateUserData, mergeSettings, mergeScriptDirectory };
