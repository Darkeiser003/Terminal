import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const helper = resolve('scripts/assemble-release.mjs');
const root = await mkdtemp(join(tmpdir(), 'wterminal-assemble-'));

function run(...args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [helper, ...args, '--no-sign']);
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolvePromise({ code, output }));
    });
}

async function release(dir, files) {
    await mkdir(dir, { recursive: true });
    const lines = [];
    for (const [name, contents] of Object.entries(files)) {
        await writeFile(join(dir, name), contents);
        lines.push(`${createHash('sha256').update(contents).digest('hex')}  ${name}`);
    }
    await writeFile(join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
}

try {
    const windows = join(root, 'windows');
    const linux = join(root, 'linux');
    await release(windows, {
        'WTerminal-1.0.0-x64-setup.exe': 'instalador',
        'WTerminal-1.0.0-Portable.exe': 'portable',
        'WTerminal-Unpacked-1.0.0.zip': 'zip',
    });
    await writeFile(join(windows, 'NOTAS.txt'), 'no se publica');
    await release(linux, { 'LTerminal-1.0.0-x86_64.AppImage': 'appimage' });

    // Lo validado de los dos sistemas, en una carpeta limpia con un manifiesto común.
    const out = join(root, 'publicar', 'v1.0.0');
    const ok = await run('--from', windows, '--from', linux, '--out', out);
    assert.equal(ok.code, 0, ok.output);
    const published = (await readdir(out)).sort();
    assert.deepEqual(published, [
        'LTerminal-1.0.0-x86_64.AppImage',
        'SHA256SUMS.txt',
        'WTerminal-1.0.0-Portable.exe',
        'WTerminal-1.0.0-x64-setup.exe',
        'WTerminal-Unpacked-1.0.0.zip',
    ], 'solo lo publicable, sin notas ni restos');
    assert.equal((await readFile(join(out, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n').length, 4);
    assert(existsSync(join(root, 'publicar', 'v1.0.0.informe.txt')), 'el informe va al lado, no dentro');

    // Una carpeta de salida con algo dentro no se toca.
    const again = await run('--from', windows, '--from', linux, '--out', out);
    assert.notEqual(again.code, 0);
    assert.match(again.output, /no está vacía/u);

    // Un archivo que no es el validado se rechaza.
    await writeFile(join(linux, 'LTerminal-1.0.0-x86_64.AppImage'), 'otro contenido');
    const tampered = await run('--from', windows, '--from', linux, '--out', join(root, 'b'));
    assert.notEqual(tampered.code, 0);
    assert.match(tampered.output, /no coincide con su hash/u);
    assert(!existsSync(join(root, 'b')), 'no queda una carpeta a medias');

    // Una build marcada como no publicable, tampoco.
    await writeFile(join(windows, 'NO-PUBLICAR.txt'), 'validación pendiente');
    const blocked = await run('--from', windows, '--out', join(root, 'c'), '--platforms', 'windows');
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.output, /no publicable/u);
    await rm(join(windows, 'NO-PUBLICAR.txt'));

    // Sin Linux, la release conjunta no sale; solo Windows, sí.
    const windowsOnly = await run('--from', windows, '--out', join(root, 'd'));
    assert.notEqual(windowsOnly.code, 0, 'de serie salen los dos sistemas juntos');
    assert.equal((await run('--from', windows, '--out', join(root, 'e'), '--platforms', 'windows')).code, 0);

    console.log('Ensamblado de release verificado: carpeta limpia, hashes de origen, salida no vacía, NO-PUBLICAR y sistemas obligatorios.');
} finally {
    await rm(root, { recursive: true, force: true });
}
