#!/usr/bin/env node
// Sube a GitHub una release ya ensamblada por `assemble-release.mjs`. No
// compila ni cambia ningún archivo:
//   1. comprueba la carpeta: sin `NO-PUBLICAR.txt`, con `SHA256SUMS.txt` y sus
//      dos firmas, cada archivo igual a su hash, nada que no figure en el
//      manifiesto y los adjuntos obligatorios de la versión de la etiqueta;
//   2. verifica las dos firmas con las claves PÚBLICAS (nunca lee las privadas);
//   3. con `gh`: exige sesión iniciada y que la etiqueta ya exista en GitHub,
//      crea la release en borrador (o usa una vacía) y sube los archivos tal
//      cual. Nunca reemplaza adjuntos: una release que ya los tiene se deja;
//   4. comprueba que GitHub tiene exactamente esos archivos con sus tamaños.
// La release queda en borrador para revisarla; `--publish` la publica.
//
// Uso:
//   node scripts/publish-github-release.mjs --dir CARPETA --tag v1.0.0
//        [--repo propietario/repo] [--platforms windows,linux] [--notes ARCHIVO]
//        [--keys-dir CARPETA] [--publish] [--dry-run] [--no-verify-signatures]
// `--dry-run` hace todas las comprobaciones locales y enseña las órdenes de
// `gh` sin ejecutarlas. `--no-verify-signatures` es solo para las pruebas.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findSigningKeys, trustEnv } from './dev-test.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
};
const dir = value('--dir') ? resolve(value('--dir')) : null;
const tag = value('--tag');
const platforms = (value('--platforms') ?? 'windows,linux').split(',').map((item) => item.trim()).filter(Boolean);
const notesFile = value('--notes') ? resolve(value('--notes')) : null;
const publish = args.includes('--publish');
const dryRun = args.includes('--dry-run');
const verifySignatures = !args.includes('--no-verify-signatures');

function fail(message) {
    console.error(`No se publicó la release: ${message}`);
    process.exit(1);
}

if (!dir || !tag) {
    console.error('Uso: node scripts/publish-github-release.mjs --dir CARPETA --tag v1.0.0 [--repo propietario/repo] [--platforms windows,linux] [--notes ARCHIVO] [--keys-dir CARPETA] [--publish] [--dry-run]');
    process.exit(2);
}
const tagMatch = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(tag);
if (!tagMatch) fail(`la etiqueta ${tag} no es SemVer con «v» delante (por ejemplo v1.0.0)`);
const version = tagMatch[1];
for (const platform of platforms) {
    if (!['windows', 'linux'].includes(platform)) fail(`sistema desconocido en --platforms: ${platform}`);
}

const metadata = JSON.parse(await readFile(join(projectRoot, 'src-tauri/config/package-metadata.json'), 'utf8'));
const repo = value('--repo') ?? /github\.com\/([^/]+\/[^/.]+)/u.exec(metadata.repository ?? '')?.[1];
if (!repo || !/^[\w.-]+\/[\w.-]+$/u.test(repo)) fail('no se sabe a qué repositorio subirla: pasa --repo propietario/repo');

async function sha256(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

function run(command, commandArgs, env = {}) {
    return new Promise((resolveRun) => {
        const child = spawn(command, commandArgs, {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => resolveRun({ code: -1, stdout, stderr: String(error) }));
        child.on('close', (code) => resolveRun({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    });
}

// Las pruebas sustituyen `gh` por un guion de node (`WTERMINAL_FAKE_GH`).
const gh = (ghArgs) => (process.env.WTERMINAL_FAKE_GH
    ? run(process.execPath, [process.env.WTERMINAL_FAKE_GH, ...ghArgs])
    : run('gh', ghArgs));

// 1: la carpeta, íntegra y completa.
if (!existsSync(dir)) fail(`no existe la carpeta ${dir}`);
if (existsSync(join(dir, 'NO-PUBLICAR.txt'))) fail(`${dir} está marcada como no publicable (NO-PUBLICAR.txt)`);
const manifestPath = join(dir, 'SHA256SUMS.txt');
const signatures = ['SHA256SUMS.txt.sig', 'SHA256SUMS.txt.sshsig'];
for (const name of ['SHA256SUMS.txt', ...signatures]) {
    if (!existsSync(join(dir, name))) fail(`falta ${name} en ${dir}: ensambla la release con scripts/assemble-release.mjs`);
}
const listed = new Map();
const hashes = new Map();
for (const line of (await readFile(manifestPath, 'utf8')).split(/\r?\n/u).filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/u.exec(line);
    if (!match) fail(`línea no válida en SHA256SUMS.txt: ${JSON.stringify(line)}`);
    const [, hash, name] = match;
    const path = join(dir, name);
    if (!existsSync(path)) fail(`${name} figura en SHA256SUMS.txt pero no está en la carpeta`);
    if (await sha256(path) !== hash) fail(`${name} no coincide con su hash: no es el archivo validado`);
    listed.set(name, (await stat(path)).size);
    hashes.set(name, hash);
}
const present = (await readdir(dir)).sort();
const extra = present.filter((name) => !listed.has(name) && name !== 'SHA256SUMS.txt' && !signatures.includes(name));
if (extra.length) fail(`la carpeta tiene archivos que no están en el manifiesto y no se subirían: ${extra.join(', ')}`);
const required = [
    ...(platforms.includes('windows') ? [
        `WTerminal-${version}-x64-setup.exe`,
        `WTerminal-${version}-Portable.exe`,
        `WTerminal-Unpacked-${version}.zip`,
    ] : []),
    ...(platforms.includes('linux') ? [`LTerminal-${version}-x86_64.AppImage`] : []),
];
const missing = required.filter((name) => !listed.has(name));
if (missing.length) fail(`faltan los adjuntos obligatorios de ${tag}: ${missing.join(', ')} (¿la etiqueta es de otra versión?)`);

// 2: las dos firmas, solo con las claves públicas.
if (verifySignatures) {
    const folder = value('--keys-dir') ? resolve(value('--keys-dir')) : join(homedir(), 'Desktop', 'Claves SSH');
    const keys = findSigningKeys(folder);
    if (!keys.public || !keys.sshPublic) fail(`faltan las claves públicas de firma en ${folder}`);
    const trust = await trustEnv(keys);
    // La verificación SSH busca la pública por ruta (`scripts/lib/ssh-signing.mjs`).
    const env = {
        ...trust,
        LTERMINAL_SSH_SIGNING_IDENTITY: trust.LTERMINAL_SSH_UPDATE_IDENTITY,
        LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE: keys.sshPublic,
    };
    for (const [script, signature] of [['scripts/sign-release-manifest.mjs', signatures[0]], ['scripts/sign-release-ssh.mjs', signatures[1]]]) {
        const result = await run(process.execPath, [join(projectRoot, script), '--manifest', manifestPath, '--signature', join(dir, signature), '--verify'], env);
        if (result.code !== 0) fail(`la firma ${signature} no es válida: ${result.stdout} ${result.stderr}`.trim());
    }
}

const assets = [...listed.keys(), 'SHA256SUMS.txt', ...signatures].sort();
const sizes = new Map([...listed, ...await Promise.all(['SHA256SUMS.txt', ...signatures].map(async (name) => [name, (await stat(join(dir, name))).size]))]);
const title = `WTerminal / LTerminal ${version}`;
// Las notas: las del archivo pedido o una tabla con el hash de cada adjunto,
// sacado del propio manifiesto.
const notes = notesFile ? await readFile(notesFile, 'utf8') : [
    `${title}.`,
    '',
    'Cada adjunto está en `SHA256SUMS.txt`, firmado con Ed25519 (`SHA256SUMS.txt.sig`) y con SSH (`SHA256SUMS.txt.sshsig`, espacio de nombres `lterminal-release`). La aplicación instalada solo se actualiza si las dos firmas son válidas.',
    '',
    '| Archivo | Tamaño | SHA-256 |',
    '|---|---|---|',
    ...[...listed.keys()].sort().map((name) => `| \`${name}\` | ${(listed.get(name) / 1024 / 1024).toFixed(1)} MB | \`${hashes.get(name)}\` |`),
    '',
    'Licencia: AGPL-3.0-only, con licencia comercial aparte (ver el README).',
    '',
].join('\n');

const plan = [
    ['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', title, '--notes-file', '<notas>'],
    ['release', 'upload', tag, '--repo', repo, ...assets],
    ...(publish ? [['release', 'edit', tag, '--repo', repo, '--draft=false']] : []),
];
console.log(`Release ${tag} de ${repo}: ${assets.length} archivos comprobados${verifySignatures ? ', firmas válidas' : ' (firmas SIN verificar)'}.`);
for (const name of assets) console.log(`  ${name}  ${(sizes.get(name) / 1024 / 1024).toFixed(1)} MB`);
if (dryRun) {
    console.log('\n--dry-run: no se ha llamado a gh. Se ejecutaría:');
    for (const step of plan) console.log(`  gh ${step.join(' ')}`);
    process.exit(0);
}

// 3: GitHub.
const auth = await gh(['auth', 'status']);
if (auth.code !== 0) fail('gh no tiene sesión iniciada: ejecuta «gh auth login» y vuelve a intentarlo');
const remoteTag = await gh(['api', `repos/${repo}/git/ref/tags/${tag}`]);
if (remoteTag.code !== 0) fail(`la etiqueta ${tag} no está en GitHub: créala y súbela antes (git tag -s ${tag} -m "${title}" y git push origin ${tag})`);
const existing = await gh(['release', 'view', tag, '--repo', repo, '--json', 'assets,isDraft']);
if (existing.code === 0) {
    const current = JSON.parse(existing.stdout || '{}');
    if ((current.assets ?? []).length > 0) {
        fail(`la release ${tag} ya tiene ${current.assets.length} adjuntos; no se reemplazan (bórralos a mano si de verdad hay que volver a subirlos)`);
    }
    console.log(`La release ${tag} ya existe y está vacía: se suben a ella los archivos.`);
} else {
    const notesDir = await mkdtemp(join(tmpdir(), 'wterminal-release-notes-'));
    try {
        const notesPath = join(notesDir, 'notas.md');
        await writeFile(notesPath, notes);
        const created = await gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', title, '--notes-file', notesPath]);
        if (created.code !== 0) fail(`gh release create falló: ${created.stderr || created.stdout}`);
    } finally {
        await rm(notesDir, { recursive: true, force: true });
    }
    console.log(`Creada la release ${tag} en borrador.`);
}
const uploaded = await gh(['release', 'upload', tag, '--repo', repo, ...assets.map((name) => join(dir, name))]);
if (uploaded.code !== 0) fail(`gh release upload falló: ${uploaded.stderr || uploaded.stdout}`);

// 4: lo que hay en GitHub es exactamente lo comprobado.
const after = await gh(['release', 'view', tag, '--repo', repo, '--json', 'assets,isDraft,url']);
if (after.code !== 0) fail(`no se pudo leer la release después de subirla: ${after.stderr}`);
const online = JSON.parse(after.stdout || '{}');
const onlineAssets = new Map((online.assets ?? []).map((asset) => [asset.name, asset.size]));
const differences = assets.filter((name) => onlineAssets.get(name) !== sizes.get(name));
if (differences.length || onlineAssets.size !== assets.length) {
    fail(`GitHub no tiene exactamente lo subido (revisa: ${differences.join(', ') || 'adjuntos de más'})`);
}
if (publish) {
    const edited = await gh(['release', 'edit', tag, '--repo', repo, '--draft=false']);
    if (edited.code !== 0) fail(`la release está subida en borrador, pero no se pudo publicar: ${edited.stderr}`);
}
console.log(`\nRelease ${tag} ${publish ? 'publicada' : 'subida en BORRADOR (revísala y publícala en GitHub, o repite con --publish)'}: ${online.url ?? repo}`);
