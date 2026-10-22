#!/usr/bin/env node

import { signSshManifest, verifySshManifest } from './lib/ssh-signing.mjs';

function argument(name) {
    const args = process.argv.slice(2);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

const manifest = argument('--manifest');
const signature = argument('--signature') || `${manifest || 'SHA256SUMS.txt'}.sshsig`;
if (!manifest || process.argv.includes('--help')) {
    console.error('Uso: node scripts/sign-release-ssh.mjs --manifest RUTA [--signature RUTA] [--verify]');
    process.exit(process.argv.includes('--help') ? 0 : 2);
}

if (process.argv.includes('--verify')) {
    await verifySshManifest(manifest, signature);
    console.log(`Firma OpenSSH verificada: ${signature}`);
} else {
    await signSshManifest(manifest, signature);
    console.log(`Manifiesto firmado y verificado con OpenSSH: ${signature}`);
}
