import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    assert.equal(result.status, 0, `El menú terminó con ${result.status}:\n${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /Configurar firma SSH de commits para GitHub/);
    assert.match(output, /La vista previa falló; se cancela la limpieza/);
    assert.doesNotMatch(output, /¿Aplicar esta limpieza ahora\?/);

    const help = spawnSync('/bin/bash', ['build-tools/build.sh', '--help'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
    });
    assert.equal(help.status, 0, `La ayuda del menú falló: ${help.stderr}`);
    assert.match(help.stdout, /--setup-git-signing/);

    const testRepo = join(fixture, 'repo');
    const testKey = join(fixture, 'test-signing-key');
    await mkdir(testRepo);
    const initRepo = spawnSync('git', ['init', '--quiet', testRepo], { encoding: 'utf8' });
    assert.equal(initRepo.status, 0, `No se pudo crear el repositorio de prueba: ${initRepo.stderr}`);
    const generatedKey = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'build-menu-test', '-f', testKey], { encoding: 'utf8' });
    assert.equal(generatedKey.status, 0, `No se pudo crear la clave temporal de prueba: ${generatedKey.stderr}`);

    const signingSetup = join(root, 'build-tools/configure-git-signing.sh');
    const declined = spawnSync('/bin/bash', [signingSetup, '--repo', testRepo, '--key', testKey], {
        cwd: root,
        encoding: 'utf8',
        input: 'n\n',
        timeout: 10_000,
    });
    assert.equal(declined.status, 0, `La cancelación terminó con error: ${declined.stderr}`);
    const absentAfterDecline = spawnSync('git', ['-C', testRepo, 'config', '--local', '--get', 'gpg.format'], { encoding: 'utf8' });
    assert.notEqual(absentAfterDecline.status, 0, 'Cancelar la configuración no debe modificar el repositorio.');

    const configured = spawnSync('/bin/bash', [signingSetup, '--repo', testRepo, '--key', testKey], {
        cwd: root,
        encoding: 'utf8',
        input: 's\n',
        timeout: 10_000,
    });
    assert.equal(configured.status, 0, `La configuración de firma falló: ${configured.stdout}\n${configured.stderr}`);
    assert.match(configured.stdout, /Key type: Signing key/);
    assert.match(configured.stdout, /ssh-ed25519 /);
    for (const [setting, expected] of [
        ['gpg.format', 'ssh'],
        ['user.signingkey', testKey],
        ['commit.gpgsign', 'true'],
    ]) {
        const value = spawnSync('git', ['-C', testRepo, 'config', '--local', '--get', setting], { encoding: 'utf8' });
        assert.equal(value.status, 0, `No se configuró ${setting}: ${value.stderr}`);
        assert.equal(value.stdout.trim(), expected, `Valor inesperado de ${setting}`);
    }

    const testEmail = 'build-menu-test@example.invalid';
    for (const [setting, value] of [['user.name', 'Build Menu Test'], ['user.email', testEmail]]) {
        const configuredIdentity = spawnSync('git', ['-C', testRepo, 'config', '--local', setting, value], { encoding: 'utf8' });
        assert.equal(configuredIdentity.status, 0, `No se pudo configurar ${setting}: ${configuredIdentity.stderr}`);
    }
    await writeFile(join(testRepo, 'signed.txt'), 'La firma SSH funciona.\n');
    const staged = spawnSync('git', ['-C', testRepo, 'add', 'signed.txt'], { encoding: 'utf8' });
    assert.equal(staged.status, 0, `No se pudo preparar el commit firmado: ${staged.stderr}`);
    const allowedSigners = join(fixture, 'allowed_signers');
    const publicKey = (await readFile(`${testKey}.pub`, 'utf8')).trim();
    await writeFile(allowedSigners, `${testEmail} ${publicKey}\n`);
    const signedCommit = spawnSync('git', ['-C', testRepo, '-c', `gpg.ssh.allowedSignersFile=${allowedSigners}`, 'commit', '-m', 'test signed commit'], { encoding: 'utf8' });
    assert.equal(signedCommit.status, 0, `No se pudo crear el commit firmado: ${signedCommit.stdout}\n${signedCommit.stderr}`);
    const verifiedCommit = spawnSync('git', ['-C', testRepo, '-c', `gpg.ssh.allowedSignersFile=${allowedSigners}`, 'verify-commit', 'HEAD'], { encoding: 'utf8' });
    assert.equal(verifiedCommit.status, 0, `Git no validó la firma SSH: ${verifiedCommit.stdout}\n${verifiedCommit.stderr}`);

    const powerShellPath = spawnSync('/bin/sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout.trim();
    if (powerShellPath) {
        const isolatedTempRoot = join(fixture, 'temporary root with spaces');
        const smokeTarget = join(isolatedTempRoot, 'lterminal-smoke-path-prefix-regression');
        const smokeMarker = join(smokeTarget, 'preserve.txt');
        await mkdir(smokeTarget, { recursive: true });
        await writeFile(smokeMarker, 'La vista previa no debe borrar este archivo.\n');
        const cleanerPreview = spawnSync(powerShellPath, ['-NoProfile', '-File', 'scripts/clean-repository.ps1'], {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, TMPDIR: isolatedTempRoot },
            timeout: 20_000,
        });
        assert.equal(cleanerPreview.status, 0, `La vista previa PowerShell falló:\n${cleanerPreview.stdout}\n${cleanerPreview.stderr}`);
        assert.match(cleanerPreview.stdout, /VISTA PREVIA/);
        assert.match(cleanerPreview.stdout, /lterminal-smoke-path-prefix-regression/);
        assert.match(cleanerPreview.stdout, /No se ha borrado nada/);
        assert.equal(await readFile(smokeMarker, 'utf8'), 'La vista previa no debe borrar este archivo.\n');

        // PowerShell prefers the path of its running executable when resolving
        // `pwsh`, so putting a fake executable first in PATH still launched
        // the real cleaner as a child. Inject a function into this isolated
        // PowerShell runspace instead; this also avoids Read-Host input being
        // consumed by a nested PowerShell process.
        const successfulPreview = spawnSync(powerShellPath, ['-NoProfile', '-Command', [
            "function pwsh { Write-Output 'VISTA PREVIA'; Write-Output 'No se ha borrado nada'; $global:LASTEXITCODE = 0 }",
            ". './build-tools/build.ps1'",
        ].join('; ')], {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${mockBin}${delimiter}${process.env.PATH ?? ''}` },
            input: '4\n\nn\n0\n',
            timeout: 10_000,
        });
        assert.equal(successfulPreview.status, 0, `El menú PowerShell terminó con ${successfulPreview.status}; señal=${successfulPreview.signal}; error=${successfulPreview.error?.message ?? 'ninguno'}:\n${successfulPreview.stdout}\n${successfulPreview.stderr}`);
        const powerShellOutput = `${successfulPreview.stdout}\n${successfulPreview.stderr}`;
        assert.match(powerShellOutput, /VISTA PREVIA/);
        assert.match(powerShellOutput, /No se ha borrado nada/);
        assert.match(powerShellOutput, /release\/ se conserva/);
        assert.doesNotMatch(powerShellOutput, /Eliminando cachés y salidas temporales conocidas/);

        const failedPreview = spawnSync(powerShellPath, ['-NoProfile', '-Command', [
            "function pwsh { Write-Output 'MOCK_PWSH_EXIT_73'; $global:LASTEXITCODE = 73 }",
            ". './build-tools/build.ps1'",
        ].join('; ')], {
            cwd: root,
            encoding: 'utf8',
            input: '4\n\n0\n',
            timeout: 10_000,
        });
        assert.equal(failedPreview.status, 0, `El fallo simulado de la vista previa no se recuperó: ${failedPreview.error?.message ?? failedPreview.status}\n${failedPreview.stdout}\n${failedPreview.stderr}`);
        const failedPreviewOutput = `${failedPreview.stdout}\n${failedPreview.stderr}`;
        assert.match(failedPreviewOutput, /MOCK_PWSH_EXIT_73/);
        assert.match(failedPreviewOutput, /La vista previa falló; se cancela la limpieza/);
        assert.doesNotMatch(failedPreviewOutput, /release\/ se conserva\. ¿Aplicar ahora/);
    }

    console.log('OK: menú, cancelación de limpieza y configuración explícita de firma SSH verificados.');
} finally {
    await rm(fixture, { recursive: true, force: true });
}
