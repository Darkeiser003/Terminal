import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
    console.log('SKIP: empaquetado GNU cruzado; la release Windows nativa usa Compress-Archive en PowerShell.');
    process.exit(0);
}
const zipProbe = spawnSync('zip', ['-v'], { stdio: 'ignore' });
if (zipProbe.error?.code === 'ENOENT') {
    console.log('SKIP: falta zip; el builder Windows cruzado lo instalará o solicitará antes de compilar.');
    process.exit(0);
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), 'lterminal-windows-cross-release-'));
const source = join(fixture, 'cargo-release');
const release = join(fixture, 'release');
const helper = join(root, 'scripts/package-windows-cross.mjs');
const version = '9.8.7';
const required = ['winslim-terminal.exe', 'conpty.dll', 'OpenConsole.exe', 'WebView2Loader.dll'];

async function run(fast = false) {
    const args = [helper, '--source', source, '--project', root, '--release', release, '--version', version];
    if (fast) args.push('--fast');
    return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
}

try {
    await mkdir(source, { recursive: true });
    for (const name of required) await writeFile(join(source, name), `fixture:${name}\n`);

    let result = await run();
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const portable = join(release, `WinSlimTerminal-${version}`);
    const archive = join(release, `WinSlimTerminal-Unpacked-${version}.zip`);
    const manifest = join(release, 'SHA256SUMS.txt');
    for (const name of required) assert.equal(await readFile(join(portable, name), 'utf8'), `fixture:${name}\n`);
    assert.ok((await readdir(portable)).includes('scripts'), 'se deben incluir los recursos Tauri en su ruta portable');
    const hashLine = (await readFile(manifest, 'utf8')).split('\n').find((line) => line.endsWith(`  WinSlimTerminal-Unpacked-${version}.zip`));
    assert.ok(hashLine, 'el manifiesto debe identificar el ZIP publicado');
    assert.equal(hashLine.slice(0, 64), createHash('sha256').update(await readFile(archive)).digest('hex'));
    const entries = spawnSync('zip', ['-sf', archive], { encoding: 'utf8' });
    assert.equal(entries.status, 0, entries.stderr);
    assert.match(entries.stdout, /winslim-terminal\.exe/);
    assert.match(entries.stdout, /scripts\/operations\/ssh-manager\.ps1/);

    const existingArchive = await readFile(archive);
    const signature = join(release, 'SHA256SUMS.txt.sig');
    await writeFile(signature, 'firma anterior');
    await writeFile(join(portable, 'keep-on-failure.txt'), 'previous package stays intact');
    await rm(join(source, 'OpenConsole.exe'));
    result = await run();
    assert.notEqual(result.status, 0, 'un runtime incompleto debe impedir la publicación');
    assert.deepEqual(await readFile(archive), existingArchive, 'un empaquetado fallido no debe reemplazar el ZIP válido anterior');
    assert.equal(await readFile(signature, 'utf8'), 'firma anterior', 'un fallo previo a publicar debe conservar la firma vigente');
    assert.equal(await readFile(join(portable, 'keep-on-failure.txt'), 'utf8'), 'previous package stays intact');

    await writeFile(join(source, 'OpenConsole.exe'), 'fixture:OpenConsole.exe\n');
    result = await run();
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    await assert.rejects(readFile(signature), { code: 'ENOENT' }, 'una actualización del manifiesto no debe dejar una firma vieja inválida');

    result = await run(true);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const devDir = join(release, 'dev');
    assert.ok((await readdir(devDir)).includes(`WinSlimTerminal-${version}-dev`));
    assert.ok((await readdir(devDir)).includes(`WinSlimTerminal-Unpacked-${version}-dev.zip`));
    assert.ok((await readdir(devDir)).includes('SHA256SUMS.txt'));
    assert.equal((await readdir(release)).includes(`WinSlimTerminal-${version}-dev`), false, 'el perfil rápido no debe contaminar release/ normal');

    console.log('OK: cross-build Windows publica portable y ZIP en release/ o release/dev, conserva hashes y no reemplaza artefactos válidos si falla.');
} finally {
    await rm(fixture, { recursive: true, force: true });
}
