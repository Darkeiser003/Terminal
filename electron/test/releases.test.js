const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    sanitizeRelease, isAllowedAssetUrl, archiveKindFor, buildExtractCommand,
    countLocalRepositories
} = require('../main/githubProjects');

// Una respuesta de la API es texto de fuera: se acepta lo que se entiende y se
// descarta lo demás, en vez de pasárselo entero al renderer.
test('una release se reduce a campos explícitos', () => {
    const release = sanitizeRelease({
        tag_name: 'v1.4.1',
        name: 'LTerminal 1.4.1',
        published_at: '2026-08-06T10:00:00Z',
        html_url: 'https://github.com/owner/repo/releases/tag/v1.4.1',
        prerelease: false,
        zipball_url: 'https://api.github.com/repos/owner/repo/zipball/v1.4.1',
        assets: [
            { name: 'app-x64.tar.gz', browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.1/app-x64.tar.gz', size: 1024, download_count: 7 },
            { name: 'app.exe', browser_download_url: 'https://objects.githubusercontent.com/x/app.exe', size: 2048 }
        ],
        // Campos que no se piden y no deben viajar al renderer.
        author: { login: 'alguien', email: 'privado@ejemplo.com' },
        upload_url: 'https://uploads.github.com/...'
    });

    assert.equal(release.tag, 'v1.4.1');
    assert.equal(release.assets.length, 2);
    assert.equal(release.assets[0].archive, 'tar');
    assert.equal(release.assets[0].downloads, 7);
    assert.equal(release.assets[1].archive, null, 'un .exe no se extrae');
    assert.equal(release.author, undefined);
    assert.equal(release.upload_url, undefined);
});

test('un adjunto con URL o nombre manipulados se descarta', () => {
    const release = sanitizeRelease({
        tag_name: 'v1',
        assets: [
            // Host ajeno: la descarga saldría de GitHub.
            { name: 'malo.zip', browser_download_url: 'https://ejemplo-atacante.com/malo.zip', size: 1 },
            // http en claro.
            { name: 'claro.zip', browser_download_url: 'http://github.com/x/claro.zip', size: 1 },
            // Nombre con separadores: escribiría fuera de la carpeta de destino.
            { name: '../../.bashrc', browser_download_url: 'https://github.com/x/y', size: 1 },
            { name: 'sub/dir.zip', browser_download_url: 'https://github.com/x/y', size: 1 },
            // Credenciales embebidas en la URL.
            { name: 'ok.zip', browser_download_url: 'https://user:pass@github.com/x/ok.zip', size: 1 },
            // El único válido.
            { name: 'bueno.zip', browser_download_url: 'https://github.com/o/r/releases/download/v1/bueno.zip', size: 1 }
        ]
    });
    assert.deepEqual(release.assets.map((asset) => asset.name), ['bueno.zip']);
});

test('solo se siguen redirecciones dentro de los servidores de GitHub', () => {
    assert.equal(isAllowedAssetUrl('https://objects.githubusercontent.com/x'), true);
    assert.equal(isAllowedAssetUrl('https://release-assets.githubusercontent.com/x'), true);
    assert.equal(isAllowedAssetUrl('https://github.com/x'), true);
    assert.equal(isAllowedAssetUrl('https://github.com.ejemplo-atacante.com/x'), false);
    assert.equal(isAllowedAssetUrl('https://raw.githubusercontent.com/x'), false);
    assert.equal(isAllowedAssetUrl('http://github.com/x'), false);
    assert.equal(isAllowedAssetUrl('https://github.com:8443/x'), false);
    assert.equal(isAllowedAssetUrl('file:///etc/passwd'), false);
    assert.equal(isAllowedAssetUrl(''), false);
});

test('cada formato se extrae con la herramienta que lo entiende', () => {
    assert.equal(archiveKindFor('app.tar.zst'), 'tar');
    assert.equal(archiveKindFor('app.tgz'), 'tar');
    assert.equal(archiveKindFor('APP.ZIP'), 'zip');
    assert.equal(archiveKindFor('app.AppImage'), null);
    assert.equal(archiveKindFor('app.exe'), null);

    // El tar de GNU no abre zip: en unix eso es cosa de unzip.
    assert.match(buildExtractCommand('/tmp/a.zip', '/tmp/dest', 'bash'), /^unzip -o /);
    assert.match(buildExtractCommand('/tmp/a.tar.gz', '/tmp/dest', 'bash'), /^tar -xf /);
    // El de Windows es bsdtar y sí abre zip.
    assert.match(buildExtractCommand('C:\\tmp\\a.zip', 'C:\\dest', 'cmd'), /^tar -xf "C:\\tmp\\a\.zip" -C "C:\\dest"$/);
    assert.match(buildExtractCommand('C:\\tmp\\a.zip', 'C:\\dest', 'powershell'), /^Expand-Archive -LiteralPath /);
    assert.match(buildExtractCommand('C:\\tmp\\a.tar.gz', 'C:\\dest', 'powershell'), /^tar -xf /);
    // Lo que no es un comprimido no genera comando ninguno.
    assert.equal(buildExtractCommand('/tmp/app.AppImage', '/tmp/dest', 'bash'), null);
});

test('las rutas con comillas o apóstrofos no rompen el comando', () => {
    const unix = buildExtractCommand("/tmp/o'hara.zip", '/tmp/dest', 'bash');
    assert.ok(unix.includes("'/tmp/o'\\''hara.zip'"), unix);
    const win = buildExtractCommand('C:\\a"b.zip', 'C:\\dest', 'cmd');
    assert.ok(win.includes('"C:\\a""b.zip"'), win);
});

test('el resumen de Git cuenta repositorios de verdad, no carpetas sueltas', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lterminal-repos-'));
    try {
        assert.equal(countLocalRepositories(raiz), 0, 'una carpeta vacía no tiene repositorios');

        fs.mkdirSync(path.join(raiz, 'owner1', 'repoA', '.git'), { recursive: true });
        fs.mkdirSync(path.join(raiz, 'owner1', 'repoB', '.git'), { recursive: true });
        // Carpeta con el nombre de un repositorio pero sin clonar nada dentro.
        fs.mkdirSync(path.join(raiz, 'owner1', 'soloUnaCarpeta'), { recursive: true });
        fs.mkdirSync(path.join(raiz, 'owner2', 'repoC', '.git'), { recursive: true });
        // Un archivo suelto en la raíz no es un propietario.
        fs.writeFileSync(path.join(raiz, 'notas.txt'), 'x');

        assert.equal(countLocalRepositories(raiz), 3);

        // Las descargas de releases viven aparte y no se cuentan como clones.
        fs.mkdirSync(path.join(raiz, '_releases', 'owner1', 'repoA', 'v1'), { recursive: true });
        assert.equal(countLocalRepositories(raiz), 3);
    } finally {
        fs.rmSync(raiz, { recursive: true, force: true });
    }

    // Una carpeta que no existe todavía no es un error: es que aún no se ha
    // descargado nada.
    assert.equal(countLocalRepositories(path.join(raiz, 'no-existe')), 0);
    assert.equal(countLocalRepositories(''), 0);
});
