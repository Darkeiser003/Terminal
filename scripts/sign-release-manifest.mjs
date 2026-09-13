#!/usr/bin/env node

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

function argument(name) {
    const args = process.argv.slice(2);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

const manifestPath = argument('--manifest');
const signaturePath = argument('--signature') ?? `${manifestPath ?? 'SHA256SUMS.txt'}.sig`;
const verifyOnly = process.argv.includes('--verify');
if (!manifestPath || !signaturePath) {
    console.error('Uso: node scripts/sign-release-manifest.mjs --manifest RUTA [--signature RUTA] [--verify]');
    process.exit(2);
}

const manifest = await readFile(manifestPath);
if (manifest.length === 0) throw new Error('No se puede firmar un manifiesto vacío.');

if (verifyOnly) {
    const publicKey = process.env.LTERMINAL_UPDATE_PUBLIC_KEY;
    if (!publicKey) throw new Error('LTERMINAL_UPDATE_PUBLIC_KEY es obligatorio para verificar.');
    const signature = Buffer.from((await readFile(signaturePath)).toString('utf8').replace(/\s+/g, ''), 'base64');
    const key = createPublicKey({ key: Buffer.from(`302a300506032b6570032100${publicKey}`, 'hex'), format: 'der', type: 'spki' });
    if (!verify(null, manifest, key, signature)) throw new Error('La firma Ed25519 del manifiesto no es válida.');
    console.log(`Firma verificada: ${signaturePath}`);
} else {
    const privateKeyText = process.env.LTERMINAL_SIGNING_PRIVATE_KEY;
    if (!privateKeyText) {
        throw new Error('Falta LTERMINAL_SIGNING_PRIVATE_KEY; una release oficial no puede publicarse sin firma.');
    }
    const privateKey = createPrivateKey(privateKeyText);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('LTERMINAL_SIGNING_PRIVATE_KEY debe ser una clave Ed25519.');
    }
    const signature = sign(null, manifest, privateKey).toString('base64') + '\n';
    const temporary = `${signaturePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await writeFile(temporary, signature, { encoding: 'ascii', mode: 0o644 });
        await rename(temporary, signaturePath);
    } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
    }
    console.log(`Manifiesto firmado: ${signaturePath}`);
}
