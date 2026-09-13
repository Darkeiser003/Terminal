import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

if (process.platform === 'win32') {
    console.log('SKIP: prueba interactiva del menú Bash; la ruta PowerShell se valida estáticamente en Windows.');
    process.exit(0);
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), 'lterminal-build-menu-test-'));
try {
    const mockBin = join(fixture, 'bin');
    const mockBash = join(mockBin, 'bash');
    await mkdir(mockBin);
    await writeFile(mockBash, '#!/bin/sh\nexit 73\n');
    await chmod(mockBash, 0o755);

    const result = spawnSync('/bin/bash', ['build-tools/build.sh'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${mockBin}${delimiter}${process.env.PATH ?? ''}` },
        input: '4\n\n0\n',
        timeout: 10_000,
    });
    assert.equal(result.error, undefined, `No se pudo ejecutar el menú: ${result.error?.message}`);
    assert.equal(result.status, 0, `El menú terminó con ${result.status}:\n${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /La vista previa falló; se cancela la limpieza/);
    assert.doesNotMatch(output, /¿Aplicar esta limpieza ahora\?/);

    const powerShellPath = spawnSync('/bin/sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout.trim();
    if (powerShellPath) {
        const mockPowerShell = join(mockBin, 'pwsh');
        await writeFile(mockPowerShell, '#!/bin/sh\nexit 73\n');
        await chmod(mockPowerShell, 0o755);
        const powerShellResult = spawnSync(powerShellPath, ['-NoProfile', '-File', 'build-tools/build.ps1'], {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${mockBin}${delimiter}${process.env.PATH ?? ''}` },
            input: '4\n\n0\n',
            timeout: 10_000,
        });
        assert.equal(powerShellResult.error, undefined, `No se pudo ejecutar el menú PowerShell: ${powerShellResult.error?.message}`);
        assert.equal(powerShellResult.status, 0, `El menú PowerShell terminó con ${powerShellResult.status}:\n${powerShellResult.stdout}\n${powerShellResult.stderr}`);
        const powerShellOutput = `${powerShellResult.stdout}\n${powerShellResult.stderr}`;
        assert.match(powerShellOutput, /La vista previa falló; se cancela la limpieza/);
        assert.doesNotMatch(powerShellOutput, /¿Aplicar ahora la limpieza/);
    }

    console.log('OK: los menús disponibles cancelan la limpieza si falla la vista previa.');
} finally {
    await rm(fixture, { recursive: true, force: true });
}
