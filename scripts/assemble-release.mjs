#!/usr/bin/env node
// Prepara la carpeta que se sube a una release de GitHub a partir de builds ya
// validadas (por ejemplo `E:\WTerminal\releases\46` de Windows y la de Linux).
// No compila ni sube nada:
//   1. se niega si un origen tiene `NO-PUBLICAR.txt`;
//   2. comprueba que cada archivo de un origen coincide con su `SHA256SUMS.txt`
//      y que ese manifiesto lleva sus dos firmas válidas (los bytes son los de
//      la build validada);
//   3. copia solo lo publicable a una carpeta nueva y vacía;
//   4. crea el manifiesto común y lo firma con Ed25519 y SSH, y lo verifica;
//   5. deja un informe AL LADO de la carpeta (no dentro: no se sube).
//
// Uso:
//   node scripts/assemble-release.mjs --from DIR [--from DIR ...] --out DIR
//        [--platforms windows,linux] [--keys-dir CARPETA] [--no-sign]
// Sin `--keys-dir` se usan las claves de `Escritorio\Claves SSH` (como dev:test).
// `--no-sign` solo para pruebas: ni verifica las firmas de los orígenes ni firma.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findSigningKeys, trustEnv } from './dev-test.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const values = (name) => args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []));
const sources = values('--from').map((dir) => resolve(dir));
const out = values('--out')[0] ? resolve(values('--out')[0]) : null;
const platforms = values('--platforms')[0] ?? 'windows,linux';
const sign = !args.includes('--no-sign');

function fail(message) {
    console.error(`No se preparó la release: ${message}`);
    process.exit(1);
}

if (!sources.length || !out) {
    console.error('Uso: node scripts/assemble-release.mjs --from DIR [--from DIR ...] --out DIR [--platforms windows,linux] [--keys-dir CARPETA] [--no-sign]');
    process.exit(2);
}

async function sha256(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

function run(script, scriptArgs, env) {
    return new Promise((resolveRun) => {
        const child = spawn(process.execPath, [join(projectRoot, script), ...scriptArgs], {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('close', (code) => resolveRun({ code, output: output.trim() }));
    });
}

// Las claves, por ruta: nunca se leen las privadas salvo para pasárselas al
// script de firma, y nunca se imprimen.
let signingEnv = null;
if (sign) {
    const folder = values('--keys-dir')[0] ? resolve(values('--keys-dir')[0]) : join(homedir(), 'Desktop', 'Claves SSH');
    const keys = findSigningKeys(folder);
    const missing = ['private', 'public', 'sshPrivate', 'sshPublic'].filter((kind) => !keys[kind]);
    if (missing.length) fail(`faltan claves en ${folder}: ${missing.join(', ')}`);
    const trust = await trustEnv(keys);
    signingEnv = {
        ...trust,
        LTERMINAL_SIGNING_PRIVATE_KEY: await readFile(keys.private, 'utf8'),
        LTERMINAL_SSH_SIGNING_KEY_FILE: keys.sshPrivate,
        LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE: keys.sshPublic,
        LTERMINAL_SSH_SIGNING_IDENTITY: trust.LTERMINAL_SSH_UPDATE_IDENTITY,
    };
}

if (existsSync(out) && (await readdir(out)).length > 0) fail(`la carpeta de salida no está vacía: ${out}`);

// 1 y 2: cada origen, íntegro y firmado.
const files = new Map();
for (const source of sources) {
    if (existsSync(join(source, 'NO-PUBLICAR.txt'))) fail(`${source} está marcada como no publicable (NO-PUBLICAR.txt)`);
    const manifestPath = join(source, 'SHA256SUMS.txt');
    if (!existsSync(manifestPath)) fail(`${source} no tiene SHA256SUMS.txt`);
    if (sign) {
        for (const [script, signature] of [['scripts/sign-release-manifest.mjs', 'SHA256SUMS.txt.sig'], ['scripts/sign-release-ssh.mjs', 'SHA256SUMS.txt.sshsig']]) {
            const result = await run(script, ['--manifest', manifestPath, '--signature', join(source, signature), '--verify'], signingEnv);
            if (result.code !== 0) fail(`la firma ${signature} de ${source} no es válida: ${result.output}`);
        }
    }
    const lines = (await readFile(manifestPath, 'utf8')).split(/\r?\n/u).filter(Boolean);
    for (const line of lines) {
        const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/u);
        if (!match) fail(`línea no válida en ${manifestPath}: ${JSON.stringify(line)}`);
        const [, hash, name] = match;
        if (name !== basename(name)) fail(`ruta no permitida en ${manifestPath}: ${name}`);
        const path = join(source, name);
        if (!existsSync(path)) fail(`${name} figura en ${manifestPath} pero no está en ${source}`);
        if (await sha256(path) !== hash) fail(`${name} de ${source} no coincide con su hash: no es el archivo validado`);
        if (files.has(name)) fail(`${name} está en dos orígenes: ${files.get(name).source} y ${source}`);
        files.set(name, { source, hash, size: (await stat(path)).size });
    }
}

// 3: copia limpia, comprobada otra vez tras copiar.
await mkdir(out, { recursive: true });
for (const [name, file] of files) {
    await copyFile(join(file.source, name), join(out, name));
    if (await sha256(join(out, name)) !== file.hash) fail(`la copia de ${name} no coincide con el original`);
}

// 4: manifiesto común (rechaza lo que falte para los sistemas pedidos) y firmas.
const manifest = await run('scripts/create-release-manifest.mjs', ['--directory', out, '--platforms', platforms], {});
if (manifest.code !== 0) fail(manifest.output);
const common = join(out, 'SHA256SUMS.txt');
if (sign) {
    for (const scriptArgs of [
        ['scripts/sign-release-manifest.mjs', ['--manifest', common, '--signature', `${common}.sig`]],
        ['scripts/sign-release-manifest.mjs', ['--manifest', common, '--signature', `${common}.sig`, '--verify']],
        ['scripts/sign-release-ssh.mjs', ['--manifest', common, '--signature', `${common}.sshsig`]],
        ['scripts/sign-release-ssh.mjs', ['--manifest', common, '--signature', `${common}.sshsig`, '--verify']],
    ]) {
        const result = await run(scriptArgs[0], scriptArgs[1], signingEnv);
        if (result.code !== 0) fail(`no se pudo firmar o verificar el manifiesto común: ${result.output}`);
    }
}

// 5: informe, fuera de la carpeta que se sube.
const published = (await readdir(out)).sort();
const report = [
    `Release preparada: ${out}`,
    `Sistemas: ${platforms}${sign ? '' : ' (SIN FIRMAR: --no-sign, solo para pruebas)'}`,
    '',
    'Archivos que se suben, tal cual:',
    ...published.map((name) => {
        const file = files.get(name);
        return file
            ? `  ${name}  ${(file.size / 1024 / 1024).toFixed(1)} MB  ${file.hash}  (de ${file.source})`
            : `  ${name}  (manifiesto común y sus firmas)`;
    }),
    '',
].join('\n');
const reportPath = join(dirname(out), `${basename(out)}.informe.txt`);
await writeFile(reportPath, report);
console.log(report);
console.log(`Informe: ${reportPath}`);
