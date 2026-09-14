#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

function argument(name) {
    const args = process.argv.slice(2);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

async function sha256(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

const directory = argument('--directory');
if (!directory) {
    console.error('Uso: node scripts/create-release-manifest.mjs --directory CARPETA_RELEASE');
    process.exit(2);
}

const releaseDirectory = resolve(directory);
const entries = await readdir(releaseDirectory, { withFileTypes: true });
const assets = [];
const expectedAssetNames = [
    /^LTerminal-[A-Za-z0-9.+-]+-[A-Za-z0-9_-]+\.AppImage$/,
    /^WinSlimTerminal-Unpacked-[A-Za-z0-9.+-]+\.zip$/,
    /^WinSlimTerminal-[A-Za-z0-9.+-]+-x64-setup\.exe$/,
];
for (const entry of entries) {
    const isPublishable = entry.name.endsWith('.AppImage')
        || entry.name.endsWith('.zip')
        || entry.name.endsWith('-x64-setup.exe');
    if (!isPublishable) continue;

    const path = resolve(releaseDirectory, entry.name);
    const metadata = await lstat(path);
    if (!entry.isFile() || !metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`El artefacto publicable no es un archivo regular: ${entry.name}`);
    }
    if (basename(path) !== entry.name || !expectedAssetNames.some((pattern) => pattern.test(entry.name))) {
        throw new Error(`Nombre de artefacto no válido: ${JSON.stringify(entry.name)}`);
    }
    assets.push({ name: entry.name, hash: await sha256(path) });
}

const hasLinuxAppImage = assets.some(({ name }) => name.endsWith('.AppImage'));
const hasWindowsArchive = assets.some(({ name }) => name.startsWith('WinSlimTerminal-Unpacked-') && name.endsWith('.zip'));
const hasWindowsInstaller = assets.some(({ name }) => name.endsWith('-x64-setup.exe'));
if (!hasLinuxAppImage || !hasWindowsArchive || !hasWindowsInstaller) {
    throw new Error('La publicación necesita al menos un AppImage Linux, un ZIP portable Windows y un instalador NSIS Windows.');
}
assets.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
const manifestPath = resolve(releaseDirectory, 'SHA256SUMS.txt');
const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
const contents = `${assets.map(({ hash, name }) => `${hash}  ${name}`).join('\n')}\n`;

try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    await rename(temporaryPath, manifestPath);
} catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
}

console.log(`Manifiesto común creado con ${assets.length} artefactos: ${manifestPath}`);
