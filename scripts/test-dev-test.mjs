// Comprueba el bucle rápido `npm run dev:test` sin compilar ni lanzar la
// aplicación: argumentos, escenarios del catálogo, binario de cada perfil, que
// el perfil `fast` de Cargo sigue siendo release sin LTO y la firma, con claves
// de usar y tirar.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    binaryFor, defaultKeysDir, findSigningKeys, parseDevTestArgs, prepareSigning, resolveScenarios, run, signBinary,
} from './dev-test.mjs';
import { resolveSshKeygen } from './lib/ssh-signing.mjs';

// Sin E2E no se compila; con E2E, el perfil rápido salvo que se pida otro.
assert.equal(parseDevTestArgs(['--rust', 'wsl::tests']).build, 'none');
assert.equal(parseDevTestArgs(['--only', 'resize-type']).build, 'fast');
assert.equal(parseDevTestArgs(['--matrix', 'lang:scala', '--build', 'release']).build, 'release');
assert.equal(parseDevTestArgs(['--only', 'resize-type', '--binary', 'x.exe']).build, 'none');
assert.throws(() => parseDevTestArgs(['--binary', 'x.exe', '--build', 'fast']), /--binary/u);
assert.throws(() => parseDevTestArgs(['--build', 'lento']), /--build/u);
assert.throws(() => parseDevTestArgs(['--repeat', '0']), /--repeat/u);
assert.throws(() => parseDevTestArgs(['--env', 'SIN_IGUAL']), /CLAVE=valor/u);
assert.throws(() => parseDevTestArgs(['--only']), /Falta el valor/u);
assert.throws(() => parseDevTestArgs(['--nada']), /desconocida/u);

const options = parseDevTestArgs([
    '--only', 'resize-type, shell-assist', '--only', 'tiny-grow',
    '--matrix', 'lang:haskell,lang:scala', '--repeat', '3', '--video',
    '--env', 'E2E_RESIZE_TYPE_ATTEMPTS=10', '--env', 'X=a=b', '--js', 'test:frontend-logic,check:docs',
]);
assert.deepEqual(options.only, ['resize-type', 'shell-assist', 'tiny-grow']);
assert.deepEqual(options.matrix, ['lang:haskell', 'lang:scala']);
assert.deepEqual(options.js, ['test:frontend-logic', 'check:docs']);
assert.deepEqual(options.env, { E2E_RESIZE_TYPE_ATTEMPTS: '10', X: 'a=b' });
assert.equal(options.repeat, 3);
assert.equal(options.video, true);

// Los escenarios se buscan en todas las suites, con su variable y su plazo.
const [resize, newTab] = resolveScenarios(['resize-type', 'new-tab-echo-1']);
assert.equal(resize.suite, 'focused');
assert.equal(resize.env.E2E_RESIZE_TYPE_ONLY, '1');
assert(resize.timeoutMs > 0);
assert.equal(newTab.scenario, 'new-tab-echo');
assert.throws(() => resolveScenarios(['no-existe']), /Escenario desconocido/u);

// Tauri deja cada perfil en su carpeta de target.
assert(binaryFor('fast', 'win32').endsWith(join('target', 'fast', 'wterminal.exe')));
assert(binaryFor('none', 'win32').endsWith(join('target', 'fast', 'wterminal.exe')));
assert(binaryFor('release', 'linux').endsWith(join('target', 'release', 'wterminal')));

// El perfil rápido hereda de release (mismas opciones de pánico y
// optimización) y solo quita LTO y paraleliza: es el que se prueba.
const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
const fast = /\[profile\.fast\]([\s\S]*?)(?:\n\[|$)/u.exec(cargo)?.[1] ?? '';
assert(/inherits = "release"/u.test(fast), 'el perfil fast debe heredar de release');
assert(/lto = false/u.test(fast) && /incremental = true/u.test(fast), 'el perfil fast debe quitar LTO y ser incremental');
assert(!/opt-level|panic/u.test(fast), 'el perfil fast no debe cambiar la optimización ni el pánico de release');

const script = await readFile('scripts/dev-test.mjs', 'utf8');
assert(script.includes("args.push('--', '--profile', 'fast')"), 'dev:test debe compilar con el perfil fast');
assert(script.includes('delete process.env.WSL_UTF8'), 'dev:test debe lanzar los E2E sin WSL_UTF8');
assert(script.includes("E2E_SHELL_MATRIX_IDS: options.matrix.join(',')"), 'dev:test debe limitar la matriz con E2E_SHELL_MATRIX_IDS');
assert(script.includes("LTERMINAL_SKIP_CHECKS: '1', ...signing.trust"), 'dev:test debe compilar con las claves públicas dentro');

// Se firma lo que se compila, salvo que se pida lo contrario.
assert.equal(parseDevTestArgs(['--only', 'resize-type']).sign, true);
assert.equal(parseDevTestArgs(['--only', 'resize-type', '--no-sign']).sign, false);
assert.equal(parseDevTestArgs(['--only', 'resize-type', '--keys-dir', 'claves']).keysDir, 'claves');
assert.throws(() => parseDevTestArgs(['--only', 'resize-type', '--keys-dir', 'claves', '--no-sign']), /se contradicen/u);
assert.throws(() => parseDevTestArgs(['--rust', 'wsl::tests', '--keys-dir', 'claves']), /sin compilar/u);
assert.throws(() => parseDevTestArgs(['--only', 'resize-type', '--binary', 'x.exe', '--keys-dir', 'claves']), /sin compilar/u);

const keysRoot = await mkdtemp(join(tmpdir(), 'wterminal-dev-test-keys-'));
const spawnKeygen = async (args) => new Promise((resolveKeygen, reject) => {
    resolveSshKeygen().then((keygen) => {
        const child = spawn(keygen, args, { stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('close', resolveKeygen);
    }, reject);
});
try {
    // La carpeta: la que recuerda build.ps1, que la guarda con BOM, y si ya no
    // existe, la habitual.
    const memory = join(keysRoot, 'local', 'WTerminalBuild');
    await mkdir(memory, { recursive: true });
    await writeFile(join(memory, 'keys-dir.txt'), `﻿${keysRoot}\r\n`);
    assert.equal(defaultKeysDir({ LOCALAPPDATA: join(keysRoot, 'local') }, 'casa'), keysRoot);
    await writeFile(join(memory, 'keys-dir.txt'), join(keysRoot, 'ya-no-existe'));
    assert.equal(defaultKeysDir({ LOCALAPPDATA: join(keysRoot, 'local') }, 'casa'), join('casa', 'Desktop', 'Claves SSH'));
    assert.equal(defaultKeysDir({}, 'casa'), join('casa', 'Desktop', 'Claves SSH'));

    // Cada clave en la carpeta o en su `.ssh`; la de WTerminal antes que la de Tools.
    const keysDir = join(keysRoot, 'claves');
    await mkdir(join(keysDir, '.ssh'), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    await writeFile(join(keysDir, 'release-signing-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.deepEqual(Object.keys(findSigningKeys(keysDir)), ['private']);
    await writeFile(join(keysDir, 'release-signing-public.hex'), `${publicHex}\n`);
    await writeFile(join(keysDir, '.ssh', 'ltools-release-signing'), 'vieja');
    assert.equal(findSigningKeys(keysDir).sshPrivate, join(keysDir, '.ssh', 'ltools-release-signing'));

    // Sin claves completas: aviso si la carpeta es la de siempre, error si se pidió esa.
    const incomplete = await prepareSigning({ build: 'fast', sign: true }, {}, join(keysRoot, 'casa'));
    assert(incomplete.warning && incomplete.note.startsWith('**sin firmar**') && !incomplete.keys);
    await assert.rejects(() => prepareSigning({ build: 'fast', sign: true, keysDir }), /faltan claves.*sshPublic/u);
    assert(!(await prepareSigning({ build: 'none', sign: true })).keys);
    assert(!(await prepareSigning({ build: 'fast', sign: false })).keys);

    await rm(join(keysDir, '.ssh', 'ltools-release-signing'));
    const sshKey = join(keysDir, '.ssh', 'lterminal-release-signing');
    assert.equal(await spawnKeygen(['-q', '-t', 'ed25519', '-N', '', '-C', 'dev-test', '-f', sshKey]), 0);
    const signing = await prepareSigning({ build: 'fast', sign: true, keysDir }, { GIT_AUTHOR_EMAIL: 'alguien@local' });
    assert.equal(signing.trust.LTERMINAL_UPDATE_PUBLIC_KEY, publicHex);
    assert.equal(signing.trust.LTERMINAL_SSH_UPDATE_IDENTITY, 'alguien@local');
    assert.match(signing.trust.LTERMINAL_SSH_UPDATE_PUBLIC_KEY, /^ssh-ed25519 /u);
    // La compilación recibe esto: nada de la clave privada.
    assert.deepEqual(Object.keys(signing.trust).sort(), [
        'LTERMINAL_SSH_UPDATE_IDENTITY', 'LTERMINAL_SSH_UPDATE_PUBLIC_KEY', 'LTERMINAL_UPDATE_PUBLIC_KEY',
    ]);
    assert(!JSON.stringify(signing.trust).includes('PRIVATE KEY'));

    // Firma de verdad, con los scripts de la release, y verificable aparte.
    const binary = join(keysRoot, 'wterminal.exe');
    await writeFile(binary, 'binario de prueba');
    const signed = join(keysRoot, 'firma');
    assert.equal(await signBinary(binary, signed, signing, run), true);
    const manifest = await readFile(join(signed, 'SHA256SUMS.txt'));
    assert.equal(manifest.toString(), `${createHash('sha256').update('binario de prueba').digest('hex')}  wterminal.exe\n`);
    const signature = Buffer.from(await readFile(join(signed, 'SHA256SUMS.txt.sig'), 'utf8'), 'base64');
    assert(verify(null, manifest, publicKey, signature));
    assert.match(await readFile(join(signed, 'SHA256SUMS.txt.sshsig'), 'utf8'), /BEGIN SSH SIGNATURE/u);

    // Un paso de firma que falla no se da por bueno.
    assert.equal(await signBinary(binary, signed, signing, async () => 1), false);
} finally {
    await rm(keysRoot, { recursive: true, force: true });
}

console.log('dev:test verificado: argumentos, escenarios, binarios, perfil fast y firma.');
