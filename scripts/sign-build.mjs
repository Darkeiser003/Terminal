#!/usr/bin/env node
// Firma una build YA compilada (22-11, Romen: «en firma, firmarlas, si no las
// firmaste al buildear»): escribe SHA256SUMS.txt con lo que haya en la carpeta
// (o los archivos pedidos), lo firma con Ed25519 y con SSH y verifica las dos
// firmas, igual que hace windows/build.ps1 al publicar en release\.
//
// Uso:
//   node scripts/sign-build.mjs --dir release [--keys-dir RUTA]
//   node scripts/sign-build.mjs --files a.exe,b.zip --out carpeta [--keys-dir RUTA]
// Las claves se buscan como en dev-test: --keys-dir, la carpeta que recuerda
// windows/build.ps1 o Escritorio\Claves SSH.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { defaultKeysDir, findSigningKeys, run, trustEnv } from './dev-test.mjs';

const SIGNABLE = /\.(exe|zip|appimage|deb|rpm|msi|msix|dmg|tar\.gz)$/iu;

export function parseSignArgs(argv) {
    const options = { files: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = () => {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith('--')) throw new Error(`Falta el valor de ${arg}`);
            index += 1;
            return next;
        };
        if (arg === '--dir') options.dir = value();
        else if (arg === '--files') options.files.push(...value().split(',').map((item) => item.trim()).filter(Boolean));
        else if (arg === '--out') options.out = value();
        else if (arg === '--keys-dir') options.keysDir = value();
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`Opción desconocida: ${arg}`);
    }
    if (!options.help && !options.dir && options.files.length === 0) throw new Error('Indica --dir o --files');
    return options;
}

/** Lo que se firma: lo pedido o, en la carpeta, los paquetes publicables. */
export function signableFiles(options) {
    if (options.files.length > 0) return options.files.map((file) => resolve(file));
    const dir = resolve(options.dir);
    return readdirSync(dir)
        .filter((name) => SIGNABLE.test(name))
        .map((name) => join(dir, name))
        .filter((path) => statSync(path).isFile())
        .sort();
}

async function sha256(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

async function main() {
    const options = parseSignArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write('Uso: node scripts/sign-build.mjs --dir CARPETA | --files a,b --out CARPETA [--keys-dir RUTA]\n');
        return 0;
    }
    const files = signableFiles(options);
    if (files.length === 0) throw new Error('No hay nada que firmar (ni .exe, ni .zip, ni AppImage…)');
    const out = resolve(options.out ?? options.dir ?? '.');
    await mkdir(out, { recursive: true });
    const folder = options.keysDir ? resolve(options.keysDir) : defaultKeysDir();
    const keys = findSigningKeys(folder);
    const missing = ['public', 'private', 'sshPublic', 'sshPrivate'].filter((kind) => !keys[kind]);
    if (missing.length) throw new Error(`Faltan claves en ${folder}: ${missing.join(', ')}`);
    const lines = [];
    for (const file of files) lines.push(`${await sha256(file)}  ${basename(file)}`);
    const manifest = join(out, 'SHA256SUMS.txt');
    await writeFile(manifest, `${lines.join('\n')}\n`);
    const trust = await trustEnv(keys);
    const env = {
        ...trust,
        LTERMINAL_SIGNING_PRIVATE_KEY: await readFile(keys.private, 'utf8'),
        LTERMINAL_SSH_SIGNING_KEY_FILE: keys.sshPrivate,
        LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE: keys.sshPublic,
        LTERMINAL_SSH_SIGNING_IDENTITY: trust.LTERMINAL_SSH_UPDATE_IDENTITY,
    };
    const ed25519 = ['scripts/sign-release-manifest.mjs', '--manifest', manifest, '--signature', `${manifest}.sig`];
    const ssh = ['scripts/sign-release-ssh.mjs', '--manifest', manifest, '--signature', `${manifest}.sshsig`];
    for (const args of [ed25519, [...ed25519, '--verify'], ssh, [...ssh, '--verify']]) {
        if (await run(process.execPath, args, env) !== 0) throw new Error(`Falló: node ${args.join(' ')}`);
    }
    process.stdout.write(`Firmados ${files.length} archivo(s) en ${manifest} (Ed25519 y SSHSIG verificadas).\n`);
    return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))) {
    main().then((code) => process.exit(code), (error) => {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    });
}
export { existsSync };
