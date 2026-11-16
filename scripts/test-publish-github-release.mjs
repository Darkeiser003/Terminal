import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// Prueba `publish-github-release.mjs` con un `gh` falso que guarda en un JSON
// el estado de la release: nada sale a la red ni a GitHub.
const helper = resolve('scripts/publish-github-release.mjs');
const root = await mkdtemp(join(tmpdir(), 'wterminal-github-release-'));
const state = join(root, 'gh-state.json');
const fakeGh = join(root, 'fake-gh.mjs');

await writeFile(fakeGh, `
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
const file = ${JSON.stringify(state)};
const s = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
s.calls.push(args);
const save = () => writeFileSync(file, JSON.stringify(s));
const [group, action] = args;
let code = 0;
if (group === 'auth') code = s.loggedIn ? 0 : 1;
else if (group === 'api') code = s.tagExists ? 0 : 1;
else if (group === 'release' && action === 'view') {
    if (!s.release) code = 1;
    else process.stdout.write(JSON.stringify({ ...s.release, url: 'https://github.com/x/y/releases/tag/v9.9.9' }));
} else if (group === 'release' && action === 'create') {
    s.release = { isDraft: args.includes('--draft'), assets: [] };
} else if (group === 'release' && action === 'upload') {
    for (const path of args.slice(5)) s.release.assets.push({ name: basename(path), size: statSync(path).size });
} else if (group === 'release' && action === 'edit') {
    s.release.isDraft = !args.includes('--draft=false');
}
save();
process.exit(code);
`);

async function ghState(overrides = {}) {
    await writeFile(state, JSON.stringify({ loggedIn: true, tagExists: true, release: null, calls: [], ...overrides }));
}

function run(...args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [helper, ...args, '--no-verify-signatures', '--repo', 'x/y'], {
            env: { ...process.env, WTERMINAL_FAKE_GH: fakeGh },
        });
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
    await writeFile(join(dir, 'SHA256SUMS.txt.sig'), 'firma');
    await writeFile(join(dir, 'SHA256SUMS.txt.sshsig'), 'firma ssh');
}

const readState = async () => JSON.parse(await readFile(state, 'utf8'));

try {
    const dir = join(root, 'v9.9.9');
    await release(dir, {
        'WTerminal-9.9.9-x64-setup.exe': 'instalador',
        'WTerminal-9.9.9-Portable.exe': 'portable',
        'WTerminal-Unpacked-9.9.9.zip': 'zip',
        'LTerminal-9.9.9-x86_64.AppImage': 'appimage',
    });

    // --dry-run: todo comprobado y ni una llamada a gh.
    await ghState();
    const dry = await run('--dir', dir, '--tag', 'v9.9.9', '--dry-run');
    assert.equal(dry.code, 0, dry.output);
    assert.match(dry.output, /gh release create v9\.9\.9 --repo x\/y --verify-tag --draft/u);
    assert.equal((await readState()).calls.length, 0, '--dry-run no llama a gh');

    // Lo normal: borrador nuevo con los 7 archivos, comprobados en GitHub.
    await ghState();
    const ok = await run('--dir', dir, '--tag', 'v9.9.9');
    assert.equal(ok.code, 0, ok.output);
    let s = await readState();
    assert.equal(s.release.isDraft, true, 'se queda en borrador');
    assert.deepEqual(s.release.assets.map((asset) => asset.name).sort(), [
        'LTerminal-9.9.9-x86_64.AppImage',
        'SHA256SUMS.txt',
        'SHA256SUMS.txt.sig',
        'SHA256SUMS.txt.sshsig',
        'WTerminal-9.9.9-Portable.exe',
        'WTerminal-9.9.9-x64-setup.exe',
        'WTerminal-Unpacked-9.9.9.zip',
    ]);
    assert(s.calls.some((call) => call[0] === 'release' && call[1] === 'create' && call.includes('--notes-file')), 'con notas');

    // Una release que ya tiene adjuntos no se toca.
    const again = await run('--dir', dir, '--tag', 'v9.9.9');
    assert.notEqual(again.code, 0);
    assert.match(again.output, /ya tiene 7 adjuntos/u);
    s = await readState();
    assert.equal(s.calls.filter((call) => call[1] === 'upload').length, 1, 'no se vuelve a subir nada');

    // --publish la publica después de comprobarla.
    await ghState();
    const published = await run('--dir', dir, '--tag', 'v9.9.9', '--publish');
    assert.equal(published.code, 0, published.output);
    assert.equal((await readState()).release.isDraft, false);

    // Sin sesión de gh, o sin la etiqueta en GitHub, no se crea nada.
    await ghState({ loggedIn: false });
    assert.match((await run('--dir', dir, '--tag', 'v9.9.9')).output, /gh auth login/u);
    await ghState({ tagExists: false });
    assert.match((await run('--dir', dir, '--tag', 'v9.9.9')).output, /git push origin v9\.9\.9/u);
    assert.equal((await readState()).release, null);

    // Una etiqueta de otra versión no encuentra sus adjuntos.
    await ghState();
    assert.match((await run('--dir', dir, '--tag', 'v1.2.3', '--dry-run')).output, /faltan los adjuntos obligatorios de v1\.2\.3/u);

    // Un archivo cambiado, uno de más o NO-PUBLICAR.txt: se niega.
    await writeFile(join(dir, 'NOTAS.txt'), 'no va');
    assert.match((await run('--dir', dir, '--tag', 'v9.9.9', '--dry-run')).output, /no están en el manifiesto/u);
    await rm(join(dir, 'NOTAS.txt'));
    await writeFile(join(dir, 'WTerminal-9.9.9-Portable.exe'), 'otro');
    assert.match((await run('--dir', dir, '--tag', 'v9.9.9', '--dry-run')).output, /no coincide con su hash/u);
    await writeFile(join(dir, 'WTerminal-9.9.9-Portable.exe'), 'portable');
    await writeFile(join(dir, 'NO-PUBLICAR.txt'), 'pendiente');
    assert.match((await run('--dir', dir, '--tag', 'v9.9.9', '--dry-run')).output, /no publicable/u);
    await rm(join(dir, 'NO-PUBLICAR.txt'));

    // Solo Windows, si se pide.
    const windows = join(root, 'solo-windows');
    await release(windows, {
        'WTerminal-9.9.9-x64-setup.exe': 'instalador',
        'WTerminal-9.9.9-Portable.exe': 'portable',
        'WTerminal-Unpacked-9.9.9.zip': 'zip',
    });
    assert.notEqual((await run('--dir', windows, '--tag', 'v9.9.9', '--dry-run')).code, 0, 'de serie van los dos sistemas');
    assert.equal((await run('--dir', windows, '--tag', 'v9.9.9', '--dry-run', '--platforms', 'windows')).code, 0);

    assert(!existsSync(join(dir, 'notas.md')), 'las notas no quedan en la carpeta que se sube');
    console.log('Publicación en GitHub verificada: dry-run, borrador, adjuntos comprobados, sin reemplazar, --publish, sesión, etiqueta, versión, hashes, extras, NO-PUBLICAR y solo Windows.');
} finally {
    await rm(root, { recursive: true, force: true });
}
