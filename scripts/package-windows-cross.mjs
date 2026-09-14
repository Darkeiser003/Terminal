#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function argument(name) {
    const args = process.argv.slice(2);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
    console.error('Uso: node scripts/package-windows-cross.mjs --source RUTA --project RUTA --release RUTA --version X.Y.Z [--fast]');
}

const sourceDir = argument('--source');
const projectRoot = argument('--project');
const releaseRoot = argument('--release');
const version = argument('--version');
const fast = process.argv.includes('--fast');
if (!sourceDir || !projectRoot || !releaseRoot || !version) {
    usage();
    process.exit(2);
}
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error(`Versión SemVer no válida: ${version}`);
}

const root = resolve(projectRoot);
const source = resolve(sourceDir);
const outputDir = join(resolve(releaseRoot), ...(fast ? ['dev'] : []));
const suffix = fast ? '-dev' : '';
const portableName = `WinSlimTerminal-${version}${suffix}`;
const archiveName = `WinSlimTerminal-Unpacked-${version}${suffix}.zip`;
const portablePath = join(outputDir, portableName);
const archivePath = join(outputDir, archiveName);
const manifestPath = join(outputDir, 'SHA256SUMS.txt');
const signaturePath = `${manifestPath}.sig`;
const tauriConfigPath = join(root, 'src-tauri', 'tauri.conf.json');
const tauriConfig = JSON.parse(await readFile(tauriConfigPath, 'utf8'));
const resourceMap = tauriConfig.bundle?.resources ?? {};
const payload = [
    'winslim-terminal.exe',
    'conpty.dll',
    'OpenConsole.exe',
    'WebView2Loader.dll',
];

function isWithin(parent, target) {
    const rel = relative(parent, target);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

const resourceFiles = [];
for (const [sourceName, destinationName] of Object.entries(resourceMap)) {
    const sourcePath = resolve(root, 'src-tauri', sourceName);
    const destination = resolve(root, destinationName);
    const destinationRelative = relative(root, destination);
    if (!isWithin(root, sourcePath) || destinationRelative.startsWith(`..${sep}`) || destinationRelative === '..' || isAbsolute(destinationRelative)) {
        throw new Error(`Ruta de recurso fuera del proyecto: ${sourceName} -> ${destinationName}`);
    }
    resourceFiles.push({ source: sourcePath, destination: destinationRelative });
}
if (resourceFiles.length === 0) {
    throw new Error('tauri.conf.json no declara recursos Windows para empaquetar.');
}

for (const name of payload) {
    const path = join(source, name);
    if (!(await stat(path).catch(() => null))?.isFile()) {
        throw new Error(`Falta el archivo runtime requerido para Windows: ${path}`);
    }
}
for (const file of resourceFiles) {
    if (!(await stat(file.source).catch(() => null))?.isFile()) {
        throw new Error(`Falta el recurso de bundle declarado por Tauri: ${file.source}`);
    }
}

const zipProbe = spawnSync('zip', ['-v'], { encoding: 'utf8', stdio: 'ignore' });
if (zipProbe.status !== 0) {
    throw new Error('La herramienta zip no está disponible o no se puede ejecutar correctamente. Instálala antes de compilar.');
}

await mkdir(outputDir, { recursive: true });
const temporaryRoot = await mkdtemp(join(outputDir, '.windows-cross-package-'));
const stagedPortable = join(temporaryRoot, portableName);
const stagedArchive = join(temporaryRoot, archiveName);
const stagedManifest = join(temporaryRoot, 'SHA256SUMS.txt');
const backupDir = join(temporaryRoot, 'previous');
const outputs = [
    { final: portablePath, staged: stagedPortable, backup: join(backupDir, portableName) },
    { final: archivePath, staged: stagedArchive, backup: join(backupDir, archiveName) },
    { final: manifestPath, staged: stagedManifest, backup: join(backupDir, 'SHA256SUMS.txt') },
];
const signatureBackup = { final: signaturePath, backup: join(backupDir, 'SHA256SUMS.txt.sig') };
const movedPrevious = [];
const installed = [];
let preserveTemporaryRoot = false;

async function exists(path) {
    return lstat(path).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
    });
}

async function restorePrevious() {
    const failures = [];
    for (const path of [...installed].reverse()) {
        try {
            await rm(path, { recursive: true, force: true });
            installed.splice(installed.indexOf(path), 1);
        } catch (error) {
            failures.push(`No se pudo retirar ${path}: ${error.message}`);
        }
    }
    for (const item of [...movedPrevious].reverse()) {
        try {
            if (await exists(item.staged)) await rename(item.staged, item.final);
            movedPrevious.splice(movedPrevious.indexOf(item), 1);
        } catch (error) {
            failures.push(`No se pudo restaurar ${item.final}: ${error.message}`);
        }
    }
    if (failures.length) {
        preserveTemporaryRoot = true;
        throw new Error(failures.join('\n'));
    }
}

try {
    await mkdir(stagedPortable, { recursive: true });
    for (const name of payload) await copyFile(join(source, name), join(stagedPortable, name));
    for (const file of resourceFiles) {
        const target = join(stagedPortable, file.destination);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(file.source, target);
    }

    const entries = await readdir(stagedPortable);
    const zip = spawnSync('zip', ['-qr', '-X', stagedArchive, ...entries], {
        cwd: stagedPortable,
        encoding: 'utf8',
    });
    if (zip.status !== 0) {
        throw new Error(`No se pudo crear el ZIP portable: ${zip.error?.message ?? zip.stderr ?? zip.status}`);
    }
    const zipTest = spawnSync('zip', ['-T', stagedArchive], { encoding: 'utf8' });
    if (zipTest.status !== 0) {
        throw new Error(`El ZIP generado no superó su prueba de integridad: ${zipTest.stderr ?? zipTest.status}`);
    }

    const digest = createHash('sha256').update(await readFile(stagedArchive)).digest('hex');
    if (await exists(manifestPath)) await copyFile(manifestPath, stagedManifest);
    const updateHash = spawnSync(process.execPath, [
        join(root, 'scripts', 'update-release-hash.mjs'),
        '--manifest', stagedManifest,
        '--artifact', archiveName,
        '--hash', digest,
    ], { encoding: 'utf8' });
    if (updateHash.status !== 0) {
        throw new Error(`No se pudo actualizar SHA256SUMS.txt: ${updateHash.stderr ?? updateHash.error?.message ?? updateHash.status}`);
    }

    await mkdir(backupDir, { recursive: true });
    for (const item of [...outputs, signatureBackup]) {
        if (await exists(item.final)) {
            await rename(item.final, item.backup);
            movedPrevious.push({ final: item.final, staged: item.backup });
        }
    }
    for (const item of outputs) {
        await rename(item.staged, item.final);
        installed.push(item.final);
    }

    console.log(`Carpeta portable Windows: ${portablePath}`);
    console.log(`ZIP Windows: ${archivePath}`);
    console.log(`SHA256: ${digest}`);
    console.log(`Manifiesto: ${manifestPath}`);
    console.log(`Archivos runtime: ${payload.length}; recursos: ${resourceFiles.length}`);
} catch (error) {
    await restorePrevious().catch((restoreError) => {
        preserveTemporaryRoot = true;
        console.error(`No se pudieron restaurar los artefactos anteriores. Respaldo conservado en ${temporaryRoot}:\n${restoreError.message}`);
    });
    throw error;
} finally {
    if (!preserveTemporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
