#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
    chmod,
    copyFile,
    lstat,
    rename,
    rm,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

function argument(name) {
    const args = process.argv.slice(2);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

const source = argument('--source');
const destination = argument('--destination');
if (!source || !destination) {
    console.error('Uso: node scripts/publish-release-artifact.mjs --source ARCHIVO --destination RUTA');
    process.exit(2);
}

const sourcePath = resolve(source);
const destinationPath = resolve(destination);
if (sourcePath === destinationPath) {
    throw new Error('El origen y el destino de publicación deben ser archivos distintos.');
}

const sourceInfo = await lstat(sourcePath);
if (!sourceInfo.isFile()) {
    throw new Error(`El artefacto de origen no es un archivo regular: ${sourcePath}`);
}

try {
    const destinationInfo = await lstat(destinationPath);
    if (!destinationInfo.isFile()) {
        throw new Error(`El destino existente no es un archivo regular: ${destinationPath}`);
    }
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

// Preparar el archivo en el mismo directorio garantiza que rename sea atómico
// y no intente truncar un AppImage que aún esté abierto/ejecutándose.
const temporaryPath = resolve(
    dirname(destinationPath),
    `.${basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
);
try {
    await copyFile(sourcePath, temporaryPath);
    await chmod(temporaryPath, (sourceInfo.mode & 0o777) | 0o111);
    await rename(temporaryPath, destinationPath);
} catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
}

console.log(`Artefacto publicado atómicamente: ${destinationPath}`);
