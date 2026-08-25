#!/usr/bin/env node

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};

const linuxPath = valueAfter('--linux');
const windowsPath = valueAfter('--windows');
const windowsDir = valueAfter('--windows-dir');
const appDir = valueAfter('--appdir');

if (args.includes('--help') || (!linuxPath && !windowsPath)) {
    console.log('Uso: verify-release-artifacts.mjs (--linux APPIMAGE [--appdir APPDIR] | --windows EXE [--windows-dir DIR])');
    process.exit(args.includes('--help') ? 0 : 2);
}

const failures = [];
const checks = [];
const check = (name, condition, detail = '') => {
    checks.push(name);
    if (!condition) failures.push(detail ? `${name}: ${detail}` : name);
};

const file = (path, label) => {
    const absolute = resolve(path ?? '');
    try {
        accessSync(absolute, constants.R_OK);
        const size = statSync(absolute).size;
        check(`${label} existe`, size > 0, `está vacío: ${absolute}`);
        return { absolute, size, data: readFileSync(absolute) };
    } catch (error) {
        check(`${label} existe`, false, `${absolute} (${error.message})`);
        return { absolute, size: 0, data: Buffer.alloc(0) };
    }
};

const isPe64 = (data) => {
    if (data.length < 0x40 || data.toString('ascii', 0, 2) !== 'MZ') return false;
    const peOffset = data.readUInt32LE(0x3c);
    if (peOffset + 24 > data.length || data.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return false;
    const machine = data.readUInt16LE(peOffset + 4);
    const optionalHeaderSize = data.readUInt16LE(peOffset + 20);
    const optionalHeader = peOffset + 24;
    if (optionalHeader + optionalHeaderSize > data.length) return false;
    const magic = data.readUInt16LE(optionalHeader);
    return machine === 0x8664 && magic === 0x20b;
};

if (linuxPath) {
    const artifact = file(linuxPath, 'AppImage Linux');
    check('AppImage Linux es ELF', artifact.data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), artifact.absolute);
    check('AppImage Linux es 64-bit', artifact.data.length > 5 && artifact.data[4] === 2, artifact.absolute);
    check('AppImage Linux tiene tamaño razonable', artifact.size >= 5 * 1024 * 1024, `${artifact.size} bytes`);

    if (appDir) {
        const appBinary = file(resolve(appDir, 'usr/bin/lterminal'), 'Ejecutable Linux del AppDir');
        check('AppDir Linux contiene ELF x64', appBinary.data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && appBinary.data[4] === 2, appBinary.absolute);
        const desktop = file(resolve(appDir, 'LTerminal.desktop'), 'Desktop Linux del AppDir');
        check('Desktop Linux apunta a lterminal', desktop.data.toString('utf8').split(/\r?\n/).includes('Exec=lterminal'), desktop.absolute);
        for (const forbidden of ['usr/bin/winslim-terminal', 'usr/bin/com.winslim.terminal']) {
            check(`AppDir Linux no contiene ${forbidden}`, !statExists(resolve(appDir, forbidden)), resolve(appDir, forbidden));
        }
    }
}

if (windowsPath) {
    const artifact = file(windowsPath, 'Ejecutable Windows');
    check('Ejecutable Windows es PE x64', isPe64(artifact.data), artifact.absolute);
    check('Ejecutable Windows tiene tamaño razonable', artifact.size >= 1024 * 1024, `${artifact.size} bytes`);

    const runtimeDir = windowsDir ? resolve(windowsDir) : resolve(windowsPath, '..');
    for (const runtime of ['conpty.dll', 'OpenConsole.exe', 'WebView2Loader.dll']) {
        const runtimeFile = file(resolve(runtimeDir, runtime), `Runtime Windows ${runtime}`);
        check(`Runtime Windows ${runtime} es PE x64`, isPe64(runtimeFile.data), runtimeFile.absolute);
        check(`Runtime Windows ${runtime} no está vacío`, runtimeFile.size >= 16 * 1024, `${runtimeFile.size} bytes`);
    }
    const baseConfig = JSON.parse(
        readFileSync(resolve(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8')
    );
    const resources = Object.values(baseConfig.bundle?.resources ?? {});
    check('El mapa de recursos Windows no está vacío', resources.length > 0, projectRoot);
    for (const resource of resources) {
        const bundled = file(resolve(runtimeDir, resource), `Recurso Windows ${resource}`);
        check(`Recurso Windows ${resource} no está vacío`, bundled.size > 0, bundled.absolute);
    }
}

function statExists(path) {
    try {
        statSync(path);
        return true;
    } catch {
        return false;
    }
}

if (failures.length) {
    console.error(`Artefactos de release inválidos (${failures.length}/${checks.length} comprobaciones fallidas):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Artefactos de release verificados (${checks.length} comprobaciones).`);
