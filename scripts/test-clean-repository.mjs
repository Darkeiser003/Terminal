import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform === 'win32') {
    console.log('SKIP: prueba funcional del limpiador Bash; el limpiador PowerShell se valida por análisis estático en Windows.');
    process.exit(0);
}

const fixture = await mkdtemp(join(tmpdir(), 'lterminal-cleaner-test-'));
try {
    const project = join(fixture, 'project');
    const temp = join(fixture, 'temp');
    const home = join(fixture, 'home');
    const config = join(fixture, 'config');
    const cache = join(fixture, 'cache');
    const externalData = join(fixture, 'external-data');
    const scripts = join(project, 'scripts');
    const source = join(project, 'src');
    const release = join(project, 'release');
    const releases = join(project, 'releases');
    const generated = join(project, 'node_modules');
    const scalaBuild = join(project, '.scala-build');
    const versionBackup = join(temp, 'lterminal-version-backup.ABC123');
    const wineRunner = join(temp, 'lterminal-wine-runner.XYZ789');
    const windowsBuildTemp = join(temp, 'winslim-terminal-build-test123');
    const unrelatedTemp = join(temp, 'other-application-cache');
    const unrelatedNodeInstaller = join(temp, 'node-v22.14.0-x64.msi');
    const unrelatedRustupInstaller = join(temp, 'rustup-init.exe');
    const releaseAuditCaptures = join(temp, 'lterminal-release-audit-captures.test123');
    const adbAuditCaptures = join(temp, 'lterminal-adb-audit.test123');
    const appImageStale = join(temp, 'appimage_extracted_lterminal-stale');
    const appImageActive = join(temp, 'appimage_extracted_lterminal-active');
    const appImageOther = join(temp, 'appimage_extracted_other-application');
    await mkdir(project, { recursive: true });
    await Promise.all([
        mkdir(scripts),
        mkdir(source),
        mkdir(release),
        mkdir(releases),
        mkdir(generated),
        mkdir(scalaBuild),
        mkdir(temp),
        mkdir(home),
        mkdir(config),
        mkdir(cache),
        mkdir(versionBackup),
        mkdir(wineRunner),
        mkdir(windowsBuildTemp),
        mkdir(unrelatedTemp),
        mkdir(releaseAuditCaptures),
        mkdir(adbAuditCaptures),
        mkdir(join(appImageStale, 'usr/bin'), { recursive: true }),
        mkdir(join(appImageStale, 'usr/share/applications'), { recursive: true }),
        mkdir(join(appImageActive, 'usr/bin'), { recursive: true }),
        mkdir(join(appImageActive, 'usr/share/applications'), { recursive: true }),
        mkdir(join(appImageOther, 'usr/bin'), { recursive: true }),
        mkdir(join(externalData, 'logs'), { recursive: true }),
    ]);
    const cleaner = await readFile(new URL('./clean-repository.sh', import.meta.url), 'utf8');
    await writeFile(join(scripts, 'clean-repository.sh'), cleaner, { mode: 0o755 });
    await writeFile(join(source, 'keep.txt'), 'user data\n');
    await writeFile(join(release, 'LTerminal-1.0.0.AppImage'), 'published release\n');
    await writeFile(join(releases, 'LTerminal-1.0.0.AppImage'), 'published plural release\n');
    await writeFile(join(releases, 'build-report.md'), 'packaged release documentation\n');
    await writeFile(join(generated, 'generated.txt'), 'generated\n');
    await writeFile(join(scalaBuild, 'generated.txt'), 'generated cache\n');
    await writeFile(join(versionBackup, 'manifest.bak'), 'generated backup\n');
    await writeFile(join(wineRunner, 'runner.exe'), 'generated runner\n');
    await writeFile(join(windowsBuildTemp, 'node-v22.14.0-x64.msi'), 'build download\n');
    await writeFile(join(windowsBuildTemp, 'rustup-init.exe'), 'build download\n');
    await writeFile(join(unrelatedTemp, 'keep.txt'), 'not owned by LTerminal\n');
    await writeFile(unrelatedNodeInstaller, 'external download\n');
    await writeFile(unrelatedRustupInstaller, 'external download\n');
    await writeFile(join(releaseAuditCaptures, 'capture.png'), 'LTerminal audit output\n');
    await writeFile(join(adbAuditCaptures, 'capture.png'), 'LTerminal ADB audit output\n');
    for (const appImageDirectory of [appImageStale, appImageActive]) {
        await writeFile(join(appImageDirectory, 'usr/bin/lterminal'), 'LTerminal executable marker\n', { mode: 0o755 });
        await writeFile(join(appImageDirectory, 'usr/share/applications/LTerminal.desktop'), 'LTerminal desktop marker\n');
    }
    await writeFile(join(appImageOther, 'usr/bin/other-terminal'), 'not LTerminal\n');
    await writeFile(join(externalData, 'logs', 'keep.log'), 'user log\n');
    await symlink(source, join(project, 'dist'), 'dir');
    await symlink(externalData, join(config, 'winslim-terminal'), 'dir');

    const activeAppImageProcess = existsSync('/proc')
        ? spawn('sleep', ['30'], { cwd: appImageActive, stdio: 'ignore' })
        : null;
    if (activeAppImageProcess) {
        await new Promise((resolve, reject) => {
            activeAppImageProcess.once('spawn', resolve);
            activeAppImageProcess.once('error', reject);
        });
    }
    const result = spawnSync('bash', [join(scripts, 'clean-repository.sh'), '--apply'], {
        cwd: project,
        encoding: 'utf8',
        env: {
            ...process.env,
            TMPDIR: temp,
            HOME: home,
            XDG_CONFIG_HOME: config,
            XDG_CACHE_HOME: cache,
        },
        timeout: 15000,
    });
    assert.equal(result.status, 0, `El limpiador terminó con ${result.status}:\n${result.stdout}\n${result.stderr}`);
    if (activeAppImageProcess) {
        assert.match(result.stdout, /Se conserva AppImage de LTerminal activo/);
        activeAppImageProcess.kill('SIGTERM');
        await new Promise((resolve) => activeAppImageProcess.once('exit', resolve));
    }
    assert.equal((await lstat(join(project, 'dist'))).isSymbolicLink(), true, 'el enlace dist se conserva intacto');
    assert.equal(await readFile(join(source, 'keep.txt'), 'utf8'), 'user data\n', 'el destino del enlace no se borra');
    assert.equal(await readFile(join(release, 'LTerminal-1.0.0.AppImage'), 'utf8'), 'published release\n', 'release/ y los artefactos publicados quedan intactos');
    assert.equal(await readFile(join(releases, 'LTerminal-1.0.0.AppImage'), 'utf8'), 'published plural release\n', 'releases/ y los artefactos publicados quedan intactos');
    assert.equal(await readFile(join(releases, 'build-report.md'), 'utf8'), 'packaged release documentation\n', 'releases/ conserva también sus Markdown empaquetados');
    assert.equal(await readFile(join(externalData, 'logs', 'keep.log'), 'utf8'), 'user log\n', 'no se atraviesa el enlace de la carpeta de configuración');
    await assert.rejects(lstat(generated), { code: 'ENOENT' }, 'las salidas normales sí se limpian');
    await assert.rejects(lstat(scalaBuild), { code: 'ENOENT' }, 'la caché Scala ignorada también se limpia');
    await assert.rejects(lstat(versionBackup), { code: 'ENOENT' }, 'se limpian los backups temporales de versión propios');
    await assert.rejects(lstat(wineRunner), { code: 'ENOENT' }, 'se limpian los temporales del runner Wine propios');
    await assert.rejects(lstat(windowsBuildTemp), { code: 'ENOENT' }, 'se limpian descargas Windows solo dentro de su carpeta propia');
    await assert.rejects(lstat(releaseAuditCaptures), { code: 'ENOENT' }, 'se limpian capturas de auditoría con prefijo propio');
    await assert.rejects(lstat(adbAuditCaptures), { code: 'ENOENT' }, 'se limpian capturas de auditoría ADB con prefijo propio');
    if (activeAppImageProcess) {
        await assert.rejects(lstat(appImageStale), { code: 'ENOENT' }, 'se limpia una extracción AppImage identificada como LTerminal e inactiva');
        await lstat(appImageActive);
    } else {
        await lstat(appImageStale);
        await lstat(appImageActive);
    }
    assert.equal(await readFile(join(appImageOther, 'usr/bin/other-terminal'), 'utf8'), 'not LTerminal\n', 'no se borran extracciones de otras aplicaciones');
    assert.equal(await readFile(join(unrelatedTemp, 'keep.txt'), 'utf8'), 'not owned by LTerminal\n', 'no se eliminan temporales de otras aplicaciones');
    assert.equal(await readFile(unrelatedNodeInstaller, 'utf8'), 'external download\n', 'no se elimina un MSI genérico externo');
    assert.equal(await readFile(unrelatedRustupInstaller, 'utf8'), 'external download\n', 'no se elimina un instalador genérico externo');
    console.log('OK: el limpiador borra salidas reales sin atravesar enlaces de salida o configuración.');

    const powerShellProbe = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], {
        encoding: 'utf8',
        timeout: 10000,
    });
    if (powerShellProbe.status === 0) {
        const psProject = join(fixture, 'powershell-project');
        const psScripts = join(psProject, 'scripts');
        const psRelease = join(psProject, 'release');
        const psReleases = join(psProject, 'releases');
        const psTemp = join(fixture, 'powershell-temp');
        const psHome = join(fixture, 'powershell-home');
        const psBuildTemp = join(psTemp, 'winslim-terminal-build-regression');
        const psExternalMsi = join(psTemp, 'node-v22.14.0-x64.msi');
        const psExternalRustup = join(psTemp, 'rustup-init.exe');
        await Promise.all([
            mkdir(psScripts, { recursive: true }),
            mkdir(psRelease, { recursive: true }),
            mkdir(psReleases, { recursive: true }),
            mkdir(psBuildTemp, { recursive: true }),
            mkdir(psHome, { recursive: true }),
        ]);
        await writeFile(join(psScripts, 'clean-repository.ps1'), await readFile(new URL('./clean-repository.ps1', import.meta.url)));
        await writeFile(join(psRelease, 'WinSlimTerminal-1.0.0.zip'), 'published release\n');
        await writeFile(join(psReleases, 'WinSlimTerminal-1.0.0.zip'), 'published plural release\n');
        await writeFile(join(psReleases, 'build-report.md'), 'release documentation\n');
        await writeFile(join(psBuildTemp, 'node-v22.14.0-x64.msi'), 'LTerminal build download\n');
        await writeFile(join(psBuildTemp, 'rustup-init.exe'), 'LTerminal build download\n');
        await writeFile(psExternalMsi, 'external installer\n');
        await writeFile(psExternalRustup, 'external installer\n');
        const psResult = spawnSync('pwsh', [
            '-NoLogo', '-NoProfile', '-File', join(psScripts, 'clean-repository.ps1'), '-Apply',
        ], {
            cwd: psProject,
            encoding: 'utf8',
            env: {
                ...process.env,
                TMPDIR: psTemp,
                HOME: psHome,
                APPDATA: join(psHome, '.config'),
                LOCALAPPDATA: join(psHome, '.local', 'share'),
                XDG_CONFIG_HOME: join(psHome, '.config'),
                XDG_CACHE_HOME: join(psHome, '.cache'),
            },
            timeout: 15000,
        });
        assert.equal(psResult.status, 0, `El limpiador PowerShell terminó con ${psResult.status}:\n${psResult.stdout}\n${psResult.stderr}`);
        await assert.rejects(lstat(psBuildTemp), { code: 'ENOENT' }, 'PowerShell limpia el staging propio de descargas Windows');
        assert.equal(await readFile(join(psRelease, 'WinSlimTerminal-1.0.0.zip'), 'utf8'), 'published release\n', 'PowerShell conserva release/');
        assert.equal(await readFile(join(psReleases, 'WinSlimTerminal-1.0.0.zip'), 'utf8'), 'published plural release\n', 'PowerShell conserva releases/');
        assert.equal(await readFile(join(psReleases, 'build-report.md'), 'utf8'), 'release documentation\n', 'PowerShell conserva la documentación dentro de releases/');
        assert.equal(await readFile(psExternalMsi, 'utf8'), 'external installer\n', 'PowerShell conserva un MSI genérico ajeno');
        assert.equal(await readFile(psExternalRustup, 'utf8'), 'external installer\n', 'PowerShell conserva un instalador genérico ajeno');
        console.log('OK: PowerShell limpia solo la carpeta propia y conserva instaladores externos con nombres genéricos.');
    }
} finally {
    await rm(fixture, { recursive: true, force: true });
}
