#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifests = [
    'package.json',
    'package-lock.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
];
const testVersion = '98.76.54';

function snapshot() {
    return manifests.map((relative) => {
        const data = readFileSync(join(root, relative));
        return [relative, createHash('sha256').update(data).digest('hex')];
    });
}

function run(label, command, args) {
    const originals = manifests.map((relative) => [relative, readFileSync(join(root, relative))]);
    try {
        const result = spawnSync(command, args, {
            cwd: root,
            env: {
                ...process.env,
                LTERMINAL_TEST_FAIL_AFTER_VERSION: '1',
                LTERMINAL_TEST_REMOVE_VERSION_BACKUP: '',
                LTERMINAL_TEST_EXIT_AFTER_VERSION: '',
            },
            encoding: 'utf8',
            timeout: 20_000,
            maxBuffer: 1024 * 1024,
        });
        assert.notEqual(result.status, null, `${label} no pudo iniciarse: ${result.error?.message ?? ''}`);
        assert.notEqual(result.status, 0, `${label} no falló después de aplicar la versión`);
        assert.deepEqual(snapshot(), before, `${label} dejó algún manifiesto modificado`);
    } finally {
        // Si se rompe justo la restauración que esta prueba protege, el propio
        // test debe devolver el checkout a su estado original antes de fallar.
        for (const [relative, contents] of originals) {
            const path = join(root, relative);
            if (!existsSync(path) || !readFileSync(path).equals(contents)) writeFileSync(path, contents);
        }
    }
}

function runMissingBackup(label, command, args) {
    const originals = manifests.map((relative) => [relative, readFileSync(join(root, relative))]);
    const result = spawnSync(command, args, {
        cwd: root,
        env: {
            ...process.env,
            LTERMINAL_TEST_FAIL_AFTER_VERSION: '',
            LTERMINAL_TEST_REMOVE_VERSION_BACKUP: 'package.json',
            LTERMINAL_TEST_EXIT_AFTER_VERSION: '1',
        },
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const recoveryName = output.match(/\b(lterminal-version-backup\.[A-Za-z0-9]+|winslim-terminal-version-\d+)\b/)?.[1];
    const recoveryDir = recoveryName ? join(tmpdir(), recoveryName) : null;
    try {
        assert.notEqual(result.status, null, `${label} no pudo iniciarse: ${result.error?.message ?? ''}`);
        assert.notEqual(result.status, 0, `${label} anunció éxito sin la copia de seguridad`);
        assert.match(output, /Falta la copia de seguridad|falta la copia de seguridad/i,
            `${label} no informó qué copia de seguridad faltaba`);
        assert.ok(recoveryDir, `${label} no indicó dónde dejó las copias recuperables`);
    } finally {
        // Este escenario provoca deliberadamente una restauración incompleta.
        // Reponer byte a byte el checkout hace que la prueba sea autocontenida.
        for (const [relative, contents] of originals) {
            const path = join(root, relative);
            if (!existsSync(path) || !readFileSync(path).equals(contents)) writeFileSync(path, contents);
        }
        if (
            recoveryDir
            && resolve(recoveryDir).startsWith(`${resolve(tmpdir())}${sep}`)
            && basename(recoveryDir) === recoveryName
        ) {
            rmSync(recoveryDir, { recursive: true, force: true });
        }
    }
    assert.deepEqual(snapshot(), before, `${label} dejó algún manifiesto modificado tras el rollback de la prueba`);
}

const before = snapshot();
const linuxArgs = [
    'linux/build.sh', '--version', testVersion, '--non-interactive',
    '--skip-checks', '--no-extended-tests', '--no-install', '--no-run',
];
const crossWindowsArgs = [
    'linux/build-windows.sh', '--version', testVersion, '--non-interactive',
    '--skip-checks', '--no-install',
];
const hasBash = process.platform !== 'win32'
    || spawnSync('bash', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
if (hasBash) {
    run('linux/build.sh', 'bash', linuxArgs);
    run('linux/build-windows.sh', 'bash', crossWindowsArgs);
    runMissingBackup('linux/build.sh', 'bash', linuxArgs);
    runMissingBackup('linux/build-windows.sh', 'bash', crossWindowsArgs);
} else {
    console.log('SKIP: pruebas de scripts Bash; no hay Bash disponible en este Windows.');
}

if (process.platform === 'win32') {
    const windowsArgs = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'windows/build.ps1',
        '-Version', testVersion, '-NonInteractive', '-SkipChecks',
        '-NoExtendedTests', '-NoInstaller', '-NoRun',
    ];
    run('windows/build.ps1', 'powershell.exe', windowsArgs);
    runMissingBackup('windows/build.ps1', 'powershell.exe', windowsArgs);
}

console.log(`Restauración de versión verificada: ${manifests.length} manifiestos sin cambios tras fallos controlados.`);
