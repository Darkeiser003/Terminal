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
    console.error('Uso: node scripts/create-release-manifest.mjs --directory CARPETA_RELEASE [--platforms windows,linux]');
    process.exit(2);
}
// Qué sistemas deben venir completos. Windows y Linux salen juntos, así que
// es lo de serie; `--platforms windows` sirve para preparar solo uno.
const platforms = new Set((argument('--platforms') ?? 'windows,linux').split(',').map((name) => name.trim()).filter(Boolean));
for (const platform of platforms) {
    if (platform !== 'windows' && platform !== 'linux') {
        console.error(`Sistema desconocido en --platforms: ${platform}`);
        process.exit(2);
    }
}

const releaseDirectory = resolve(directory);
const entries = await readdir(releaseDirectory, { withFileTypes: true });
const assets = [];
// Todo lo que se publica: los nombres que busca el actualizador de la app
// (`updater/self_update.rs`, `asset_for_package`). El portable de un solo
// archivo faltaba aquí y en `release.yml`: sin su hash en el manifiesto, quien
// lo usaba no podía actualizarse.
const expectedAssetNames = [
    /^LTerminal-[A-Za-z0-9.+-]+-[A-Za-z0-9_-]+\.AppImage$/,
    /^LTerminal_[A-Za-z0-9.+~-]+_[A-Za-z0-9_]+\.deb$/,
    /^LTerminal-[A-Za-z0-9.+~-]+\.[A-Za-z0-9_]+\.rpm$/,
    /^LTerminal-Unpacked-[A-Za-z0-9.+-]+-[A-Za-z0-9_]+\.tar\.gz$/,
    /^WTerminal-Unpacked-[A-Za-z0-9.+-]+\.zip$/,
    /^WTerminal-[A-Za-z0-9.+-]+-x64-setup\.exe$/,
    /^WTerminal-[A-Za-z0-9.+-]+-Portable\.exe$/,
];
const publishableSuffixes = ['.AppImage', '.deb', '.rpm', '.tar.gz', '.zip', '-x64-setup.exe', '-Portable.exe'];
for (const entry of entries) {
    if (!publishableSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue;

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

// Lo obligatorio de cada sistema. En Linux, el AppImage; los `.deb`, `.rpm` y
// `.tar.gz` entran si están, hasta que su build los dé siempre.
const required = {
    windows: [
        ['un ZIP desempaquetado de Windows', ({ name }) => name.startsWith('WTerminal-Unpacked-') && name.endsWith('.zip')],
        ['un instalador NSIS de Windows', ({ name }) => name.endsWith('-x64-setup.exe')],
        ['un portable de un solo archivo de Windows', ({ name }) => name.endsWith('-Portable.exe')],
    ],
    linux: [
        ['un AppImage de Linux', ({ name }) => name.endsWith('.AppImage')],
    ],
};
const missing = [...platforms].flatMap((platform) => required[platform]
    .filter(([, present]) => !assets.some(present))
    .map(([label]) => label));
if (missing.length) {
    throw new Error(`A la publicación le falta: ${missing.join(', ')}.`);
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
