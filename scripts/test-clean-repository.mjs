import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    const docs = join(project, 'docs');
    const generated = join(project, 'node_modules');
    const scalaBuild = join(project, '.scala-build');
    const evidence = join(docs, 'evidence');
    await mkdir(project, { recursive: true });
    await Promise.all([
        mkdir(scripts),
        mkdir(source),
        mkdir(evidence, { recursive: true }),
        mkdir(generated),
        mkdir(scalaBuild),
        mkdir(temp),
        mkdir(home),
        mkdir(config),
        mkdir(cache),
        mkdir(join(externalData, 'logs'), { recursive: true }),
    ]);
    const cleaner = await readFile(new URL('./clean-repository.sh', import.meta.url), 'utf8');
    await writeFile(join(scripts, 'clean-repository.sh'), cleaner, { mode: 0o755 });
    await writeFile(join(source, 'keep.txt'), 'user data\n');
    await writeFile(join(docs, 'guide.md'), 'maintained documentation\n');
    await writeFile(join(evidence, 'screenshot.png'), 'generated evidence\n');
    await writeFile(join(generated, 'generated.txt'), 'generated\n');
    await writeFile(join(scalaBuild, 'generated.txt'), 'generated cache\n');
    await writeFile(join(externalData, 'logs', 'keep.log'), 'user log\n');
    await symlink(source, join(project, 'dist'), 'dir');
    await symlink(externalData, join(config, 'winslim-terminal'), 'dir');

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
    assert.equal(result.error, undefined, `No se pudo ejecutar el limpiador: ${result.error?.message}`);
    assert.equal(result.status, 0, `El limpiador terminó con ${result.status}:\n${result.stdout}\n${result.stderr}`);
    assert.equal((await lstat(join(project, 'dist'))).isSymbolicLink(), true, 'el enlace dist se conserva intacto');
    assert.equal(await readFile(join(source, 'keep.txt'), 'utf8'), 'user data\n', 'el destino del enlace no se borra');
    assert.equal(await readFile(join(externalData, 'logs', 'keep.log'), 'utf8'), 'user log\n', 'no se atraviesa el enlace de la carpeta de configuración');
    await assert.rejects(lstat(generated), { code: 'ENOENT' }, 'las salidas normales sí se limpian');
    await assert.rejects(lstat(scalaBuild), { code: 'ENOENT' }, 'la caché Scala ignorada también se limpia');
    await assert.rejects(lstat(evidence), { code: 'ENOENT' }, 'las capturas de auditoría también se limpian');
    assert.equal(await readFile(join(docs, 'guide.md'), 'utf8'), 'maintained documentation\n', 'la documentación mantenida se conserva');
    console.log('OK: el limpiador borra salidas reales sin atravesar enlaces de salida o configuración.');
} finally {
    await rm(fixture, { recursive: true, force: true });
}
