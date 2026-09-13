import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'winslim-release-hash-'));
const manifest = join(directory, 'SHA256SUMS.txt');
const helper = resolve('scripts/update-release-hash.mjs');
const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
const replacement = 'c'.repeat(64);

function run(...args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [helper, ...args], { encoding: 'utf8' });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolvePromise({ code, stderr }));
    });
}

try {
    let result = await run(
        '--manifest', manifest,
        '--artifact', 'fresh-1.4.4.zip',
        '--hash', first,
    );
    assert.equal(result.code, 0, result.stderr);
    let content = await readFile(manifest, 'utf8');
    assert.equal(content, `${first}  fresh-1.4.4.zip\n`, 'debe crear el manifiesto si aún no existe');

    await writeFile(manifest, [
        '# hashes de la release 1.4.4 · compilación local',
        `${first}  WinSlimTerminal-Unpacked-1.4.4.zip`,
        `${second}  LTerminal-1.4.4-x86_64.AppImage`,
        '',
    ].join('\n'));

    result = await run(
        '--manifest', manifest,
        '--artifact', 'WinSlimTerminal-1.4.4-x64-setup.exe',
        '--hash', replacement,
    );
    assert.equal(result.code, 0, result.stderr);
    content = await readFile(manifest, 'utf8');
    assert.match(content, new RegExp(`${first}  WinSlimTerminal-Unpacked-1\\.4\\.4\\.zip`));
    assert.match(content, new RegExp(`${second}  LTerminal-1\\.4\\.4-x86_64\\.AppImage`));
    assert.match(content, new RegExp(`${replacement}  WinSlimTerminal-1\\.4\\.4-x64-setup\\.exe`));

    result = await run(
        '--manifest', manifest,
        '--artifact', 'WinSlimTerminal-Unpacked-1.4.4.zip',
        '--hash', replacement,
    );
    assert.equal(result.code, 0, result.stderr);
    content = await readFile(manifest, 'utf8');
    assert.match(content, /compilación local/, 'los comentarios Unicode deben conservarse');
    assert.equal((content.match(/WinSlimTerminal-Unpacked-1\.4\.4\.zip/g) ?? []).length, 1);
    assert.match(content, new RegExp(`${replacement}  WinSlimTerminal-Unpacked-1\\.4\\.4\\.zip`));
    assert.match(content, new RegExp(`${second}  LTerminal-1\\.4\\.4-x86_64\\.AppImage`));

    result = await run('--manifest', manifest, '--artifact', 'bad.zip', '--hash', 'not-a-hash');
    assert.notEqual(result.code, 0, 'un hash inválido debe rechazarse');
    console.log('Hashes de release verificados: se conservan las variantes y solo se actualiza el artefacto indicado.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
