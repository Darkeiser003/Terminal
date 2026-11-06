import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'lterminal-release-manifest-'));
const helper = resolve('scripts/create-release-manifest.mjs');

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
    const files = new Map([
        ['LTerminal-1.0.0-x86_64.AppImage', 'linux image payload'],
        ['WTerminal-Unpacked-1.0.0.zip', 'windows portable payload'],
        ['WTerminal-1.0.0-x64-setup.exe', 'windows installer payload'],
        ['WTerminal-1.0.0-Portable.exe', 'windows single-file payload'],
        ['LTerminal_1.0.0_amd64.deb', 'debian package payload'],
        ['LTerminal-1.0.0-1.x86_64.rpm', 'rpm package payload'],
        ['LTerminal-Unpacked-1.0.0-x86_64.tar.gz', 'linux folder payload'],
    ]);
    for (const [name, contents] of files) await writeFile(join(directory, name), contents);
    await writeFile(join(directory, 'unrelated.log'), 'must not be published');
    await writeFile(join(directory, 'SHA256SUMS.txt'), 'stale platform-only manifest\n');

    const result = await run('--directory', directory);
    assert.equal(result.code, 0, result.stderr);
    const manifest = await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8');
    const expected = [...files]
        .map(([name, contents]) => ({ name, hash: createHash('sha256').update(contents).digest('hex') }))
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
        .map(({ name, hash }) => `${hash}  ${name}`)
        .join('\n') + '\n';
    assert.equal(manifest, expected, 'debe reemplazar el manifiesto previo por hashes de ambas plataformas, ordenados');
    assert.doesNotMatch(manifest, /unrelated\.log|stale platform/);

    await rm(join(directory, 'WTerminal-1.0.0-x64-setup.exe'));
    const insufficient = await run('--directory', directory);
    assert.notEqual(insufficient.code, 0, 'debe rechazar una publicación sin instalador Windows');
    assert.equal(await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8'), manifest,
        'un intento incompleto no debe reemplazar el manifiesto anterior');

    // Sin el portable de un solo archivo tampoco vale: el actualizador lo busca.
    await writeFile(join(directory, 'WTerminal-1.0.0-x64-setup.exe'), 'windows installer payload');
    await rm(join(directory, 'WTerminal-1.0.0-Portable.exe'));
    const noPortable = await run('--directory', directory);
    assert.notEqual(noPortable.code, 0, 'debe rechazar una publicación sin el portable de un solo archivo');
    assert.match(noPortable.stderr, /portable de un solo archivo/u);

    // Solo Windows: el AppImage deja de ser obligatorio; el portable, no.
    await writeFile(join(directory, 'WTerminal-1.0.0-Portable.exe'), 'windows single-file payload');
    for (const name of ['LTerminal-1.0.0-x86_64.AppImage', 'LTerminal_1.0.0_amd64.deb', 'LTerminal-1.0.0-1.x86_64.rpm', 'LTerminal-Unpacked-1.0.0-x86_64.tar.gz']) {
        await rm(join(directory, name));
    }
    assert.notEqual((await run('--directory', directory)).code, 0, 'de serie Linux es obligatorio');
    const windowsOnly = await run('--directory', directory, '--platforms', 'windows');
    assert.equal(windowsOnly.code, 0, windowsOnly.stderr);
    assert.equal((await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n').length, 3);
    assert.notEqual((await run('--directory', directory, '--platforms', 'macos')).code, 0, 'sistema desconocido');

    console.log('Manifiesto de release unificado: hashes correctos, orden determinista, portable y paquetes de Linux incluidos, no publicables excluidos e incompletos rechazados.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
