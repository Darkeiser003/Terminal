#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function usage() {
    console.error('Uso: node scripts/update-release-hash.mjs --manifest RUTA --artifact NOMBRE --hash SHA256');
}

function argument(name, args) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

const manifestPath = argument('--manifest', process.argv.slice(2));
const artifact = argument('--artifact', process.argv.slice(2));
const hash = argument('--hash', process.argv.slice(2))?.toLowerCase();

if (!manifestPath || !artifact || !hash) {
    usage();
    process.exitCode = 2;
} else if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`SHA-256 no válido para ${artifact}: ${hash}`);
} else if (artifact.includes('\\') || artifact.includes('/') || artifact.trim() !== artifact || artifact.length === 0) {
    throw new Error(`El artefacto debe ser un nombre de archivo, no una ruta: ${artifact}`);
} else {
    const target = resolve(manifestPath);
    let previous = '';
    try {
        previous = await readFile(target, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    // SHA256SUMS sigue el formato de sha256sum: «hash  nombre». Solo se
    // sustituye la entrada del artefacto actual; comentarios, líneas vacías y
    // hashes de otras arquitecturas/versiones se conservan literalmente.
    const lines = previous.split(/\r?\n/);
    if (lines.length && lines.at(-1) === '') lines.pop();
    const kept = lines.filter((line) => {
        const fields = line.trim().split(/\s+/);
        return fields.length < 2 || fields[1].replace(/^\*/, '') !== artifact;
    });
    kept.push(`${hash}  ${artifact}`);
    const content = `${kept.join('\n')}\n`;

    // Escribir en el mismo directorio y renombrar evita dejar el manifiesto a
    // medio escribir si el proceso se interrumpe durante una build.
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
        // UTF-8 sin BOM conserva nombres de archivo y comentarios Unicode;
        // sha256sum y los validadores de descarga aceptan este formato igual
        // que el ASCII tradicional.
        await writeFile(temporary, content, { encoding: 'utf8', mode: 0o644 });
        await rename(temporary, target);
    } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
    }
}
