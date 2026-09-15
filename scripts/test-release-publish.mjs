import assert from 'node:assert/strict';
import { copyFile, mkdir, open, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const helper = join(root, 'scripts/publish-release-artifact.mjs');
const fixture = await mkdtemp(join(tmpdir(), 'lterminal-release-publish-'));
const source = join(fixture, 'fresh.AppImage');
const destination = join(fixture, 'LTerminal.AppImage');
const marker = join(fixture, 'outside-marker');
const run = (from, to) => spawnSync(process.execPath, [helper, '--source', from, '--destination', to], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
});

try {
    const previousBytes = Buffer.from('old AppImage still mapped by a running process');
    const nextBytes = Buffer.from('new fully built AppImage');
    await writeFile(source, nextBytes, { mode: 0o644 });
    await writeFile(destination, previousBytes, { mode: 0o755 });

    // Linux permits an atomic rename over an executable held open. The old
    // descriptor must keep reading the old inode while new opens see the new
    // bytes; a direct copy/truncate fails with ETXTBSY when that inode runs.
    const runningImage = process.platform === 'win32' ? null : await open(destination, 'r');
    const published = run(source, destination);
    assert.equal(published.status, 0, `${published.stdout}\n${published.stderr}`);
    assert.deepEqual(await readFile(destination), nextBytes);
    if (runningImage) {
        const stillRunningBytes = Buffer.alloc(previousBytes.length);
        await runningImage.read(stillRunningBytes, 0, stillRunningBytes.length, 0);
        assert.deepEqual(stillRunningBytes, previousBytes, 'la instancia abierta conserva el inode previo');
        await runningImage.close();
    }

    assert.notEqual((await stat(destination)).mode & 0o111, 0, 'el AppImage publicado debe conservar permisos ejecutables');

    if (process.platform === 'linux') {
        const sleepProbe = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' });
        assert.equal(sleepProbe.status, 0, `No se pudo localizar sleep: ${sleepProbe.stderr}`);
        await copyFile(await realpath(sleepProbe.stdout.trim()), destination);
        const runningExecutable = spawn(destination, ['2'], { stdio: 'ignore' });
        await once(runningExecutable, 'spawn');
        const atomicWhileExecuting = run(source, destination);
        assert.equal(atomicWhileExecuting.status, 0,
            `Debe poder reemplazar el path de un ejecutable en marcha mediante rename: ${atomicWhileExecuting.stderr}`);
        assert.equal(await once(runningExecutable, 'close').then(([code]) => code), 0,
            'la instancia ya iniciada debe terminar correctamente tras actualizar su ruta');
        assert.deepEqual(await readFile(destination), nextBytes);
    }

    const rejectedSource = run(join(fixture, 'missing.AppImage'), destination);
    assert.notEqual(rejectedSource.status, 0, 'el publicador debe rechazar un origen inexistente');
    assert.deepEqual(await readFile(destination), nextBytes, 'un fallo no debe dañar el artefacto publicado');

    if (process.platform !== 'win32') {
        await writeFile(marker, 'external data stays intact');
        const linkedDestination = join(fixture, 'linked.AppImage');
        await symlink(marker, linkedDestination);
        const rejectedLink = run(source, linkedDestination);
        assert.notEqual(rejectedLink.status, 0, 'el publicador no debe reemplazar destinos que sean enlaces');
        assert.equal(await readFile(marker, 'utf8'), 'external data stays intact');
    } else {
        const directoryDestination = join(fixture, 'directory.AppImage');
        await mkdir(directoryDestination);
        const rejectedDirectory = run(source, directoryDestination);
        assert.notEqual(rejectedDirectory.status, 0, 'el publicador no debe reemplazar destinos que sean directorios');
    }

    console.log('Publicación Linux verificada: reemplaza atómicamente artefactos abiertos y conserva el anterior ante errores.');
} finally {
    await rm(fixture, { recursive: true, force: true });
}
