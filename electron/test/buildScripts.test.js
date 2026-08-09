// Los scripts de build no se pueden ejecutar en una prueba unitaria (uno
// necesita electron-builder y el otro PowerShell y una máquina Windows), pero
// sí se puede comprobar que siguen conteniendo las garantías que hacen que una
// release sea publicable: un solo formato por sistema, huellas verificadas y
// las pruebas ejecutadas ANTES de empaquetar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { validateBuildConfig } = require('../scripts/validate-build-config');
const { version } = require('../package.json');

const projectRoot = path.join(__dirname, '..', '..');
const windowsBuild = fs.readFileSync(path.join(projectRoot, 'windows', 'build.ps1'), 'utf8');
const linuxBuild = fs.readFileSync(path.join(projectRoot, 'linux', 'build.sh'), 'utf8');

test('la configuración de empaquetado sigue siendo un formato por sistema', () => {
    const result = validateBuildConfig();
    assert.equal(result.linuxProduct, 'LTerminal');
    assert.deepEqual(result.languages, ['es', 'en-US']);
});

// Localiza la línea que INVOCA un script de npm, sea directamente (`npm run
// check`) o a través de un envoltorio (`Invoke-Npm -Arguments @('run',
// 'check')`). Se saltan los comentarios, porque la cabecera de build.sh
// menciona `npm run dist:linux` mucho antes de ejecutarlo.
function npmStepLine(text, script) {
    const lines = text.split('\n');
    const invocation = new RegExp("run(?:\\s+|',\\s*')" + script + "\\b");
    for (let i = 0; i < lines.length; i += 1) {
        if (/^\s*#/.test(lines[i])) continue;
        if (!/\b(?:npm|Invoke-Npm)\b/.test(lines[i])) continue;
        if (invocation.test(lines[i])) return i;
    }
    return -1;
}

test('los dos builds ejecutan npm run check antes de empaquetar', () => {
    // El orden importa: comprobar después de empaquetar no impide publicar
    // una build rota, solo lo cuenta más tarde.
    const winCheck = npmStepLine(windowsBuild, 'check');
    const winPack = npmStepLine(windowsBuild, 'dist:win');
    assert.ok(winCheck > -1, 'build.ps1 debe ejecutar npm run check');
    assert.ok(winPack > -1, 'build.ps1 debe ejecutar npm run dist:win');
    assert.ok(winCheck < winPack, 'build.ps1 debe verificar antes de empaquetar');

    const linuxCheck = npmStepLine(linuxBuild, 'check');
    const linuxPack = npmStepLine(linuxBuild, 'dist:linux');
    assert.ok(linuxCheck > -1, 'build.sh debe ejecutar npm run check');
    assert.ok(linuxPack > -1, 'build.sh debe ejecutar npm run dist:linux');
    assert.ok(linuxCheck < linuxPack, 'build.sh debe verificar antes de empaquetar');
});

test('build.ps1 no deja que un aviso de npm aborte la instalacion', () => {
    // Windows PowerShell 5.1 convierte cada línea de stderr en error
    // terminante cuando la salida se redirige y ErrorActionPreference vale
    // 'Stop'. npm avisa por stderr ("npm warn deprecated ..."), así que un
    // aviso inofensivo dejaba node_modules a medias. Lo único que decide si
    // npm falló es su código de salida.
    assert.match(windowsBuild, /function Invoke-Npm/);
    assert.match(windowsBuild, /\$ErrorActionPreference = 'Continue'/);
    assert.match(windowsBuild, /return \$LASTEXITCODE/);
    // Y ninguna invocación de npm puede quedarse fuera del envoltorio. Se
    // busca npm al PRINCIPIO de una sentencia (con o sin asignación y `&`),
    // no dentro de un mensaje: "Reintentando npm ci..." es texto, no una
    // llamada.
    const bareNpm = windowsBuild.split('\n')
        .filter((line) => /^\s*(?:\$\w+\s*=\s*)?(?:&\s*)?npm\s+(?:ci|install|run)\b/.test(line));
    assert.deepEqual(bareNpm, [], 'toda llamada a npm debe pasar por Invoke-Npm');
});

test('los dos builds verifican las huellas que publican', () => {
    // Windows recalcula cada hash del archivo y lo compara.
    assert.match(windowsBuild, /Verificando SHA256SUMS\.txt/);
    assert.match(windowsBuild, /La huella de \$name no coincide/);
    // Linux usa la misma herramienta que usará quien descargue la release.
    assert.match(linuxBuild, /sha256sum -c --strict SHA256SUMS\.txt/);
});

test('los dos builds retiran las releases de versiones anteriores', () => {
    // Sin esto SHA256SUMS.txt acumulaba versiones: la fusión conserva las
    // líneas cuyo archivo sigue existiendo, y los ZIP viejos seguían ahí.
    assert.match(windowsBuild, /WinSlimTerminal-\*\.zip/);
    assert.match(windowsBuild, /Release anterior retirada/);
    assert.match(linuxBuild, /LTerminal-AppImage-\*\.tar\.gz/);
    assert.match(linuxBuild, /Release anterior retirada/);
});

test('los dos builds rechazan cualquier formato extra que aparezca en dist', () => {
    assert.match(windowsBuild, /solo debe producir win-unpacked/);
    assert.match(linuxBuild, /solo debe producir el AppImage/);
});

test('el AppImage se localiza por versión, no el primero que aparezca', () => {
    // Tras subir de versión, dist/ conserva el AppImage anterior y el orden de
    // find no está definido: se llegó a empaquetar el binario viejo.
    assert.match(linuxBuild, /LTerminal-\$VERSION-\*\.AppImage/);
    assert.match(linuxBuild, /Hay varios AppImage de la version/);
});

test('los dos builds miden el peso y lo comparan con un tope', () => {
    // No es para adelgazar Electron (no se puede), es para detectar que una
    // exclusión se cae de package.json y el paquete recupera los .pdb, los
    // prebuilds duplicados o node_modules entero.
    assert.match(windowsBuild, /\$MaxUnpackedMB = \d+/);
    assert.match(windowsBuild, /La aplicacion empaquetada pesa .* y el tope es/);
    assert.match(linuxBuild, /MAX_APPIMAGE_MB=\d+/);
    assert.match(linuxBuild, /El AppImage pesa .* y el tope es/);
});

// El SHA de una plataforma no se puede perder al compilar la otra: las dos
// publican en la MISMA carpeta dist/release. Cada script conserva las líneas
// ajenas cuyo archivo sigue existiendo y solo regenera las propias. Aquí se
// ejecuta esa lógica de verdad (la versión de build.sh, portada a JS) en vez de
// confiar en que el comentario siga siendo cierto.
test('compilar una plataforma no borra las huellas de la otra', (t) => {
    const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winslim-sha-'));
    t.after(() => fs.rmSync(releaseDir, { recursive: true, force: true }));
    const sumsPath = path.join(releaseDir, 'SHA256SUMS.txt');

    const hashOf = (name) => crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(releaseDir, name))).digest('hex');

    // Fusión: se descarta la línea propia (se regenera) y las que apuntan a un
    // archivo que ya no existe; el resto se conserva.
    const publish = (ownName) => {
        const preserved = fs.existsSync(sumsPath)
            ? fs.readFileSync(sumsPath, 'utf8').split('\n')
                .filter((line) => line.trim())
                .filter((line) => {
                    const name = line.replace(/^[0-9a-fA-F]+\s+\*?/, '');
                    return name !== ownName && fs.existsSync(path.join(releaseDir, name));
                })
            : [];
        const merged = preserved.concat([`${hashOf(ownName)} *${ownName}`])
            .sort((a, b) => a.replace(/^[0-9a-fA-F]+\s+\*?/, '').localeCompare(b.replace(/^[0-9a-fA-F]+\s+\*?/, '')));
        fs.writeFileSync(sumsPath, merged.join('\n') + '\n');
    };

    const winZip = `WinSlimTerminal-Unpacked-${version}.zip`;
    const linuxTar = `LTerminal-AppImage-${version}-x86_64.tar.gz`;
    fs.writeFileSync(path.join(releaseDir, winZip), 'contenido windows');
    publish(winZip);
    assert.deepEqual(fs.readFileSync(sumsPath, 'utf8').trim().split('\n').length, 1);

    // Ahora se compila Linux en la misma carpeta.
    fs.writeFileSync(path.join(releaseDir, linuxTar), 'contenido linux');
    publish(linuxTar);
    const lines = fs.readFileSync(sumsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'las dos plataformas deben convivir en SHA256SUMS.txt');
    assert.ok(lines.some((line) => line.endsWith(winZip)), 'la huella de Windows debe sobrevivir');
    assert.ok(lines.some((line) => line.endsWith(linuxTar)));
    // Y las huellas conservadas siguen siendo correctas, no una copia obsoleta.
    lines.forEach((line) => {
        const [hash, name] = [line.slice(0, 64), line.replace(/^[0-9a-fA-F]+\s+\*?/, '')];
        assert.equal(hash, hashOf(name), `la huella de ${name} debe seguir cuadrando`);
    });

    // Recompilar Windows con contenido nuevo actualiza SOLO su línea.
    const linuxHashBefore = hashOf(linuxTar);
    fs.writeFileSync(path.join(releaseDir, winZip), 'contenido windows v2');
    publish(winZip);
    const after = fs.readFileSync(sumsPath, 'utf8').trim().split('\n');
    assert.equal(after.length, 2);
    assert.ok(after.some((line) => line.startsWith(linuxHashBefore)), 'la línea de Linux no debe cambiar');
    assert.ok(after.some((line) => line.startsWith(hashOf(winZip))), 'la de Windows debe actualizarse');

    // Si el archivo de la otra plataforma desaparece, su línea también: un
    // SHA256SUMS.txt no debe prometer un archivo que no se publica.
    fs.rmSync(path.join(releaseDir, linuxTar));
    publish(winZip);
    const final = fs.readFileSync(sumsPath, 'utf8').trim().split('\n');
    assert.equal(final.length, 1);
    assert.ok(final[0].endsWith(winZip));
});

test('los scripts de shell están en LF y .gitattributes lo garantiza', () => {
    // Un .sh con CRLF no arranca en Linux: el shebang se lee como "bash\r".
    // Es exactamente el script que compila el AppImage.
    assert.ok(!linuxBuild.includes('\r'), 'linux/build.sh debe estar en LF');
    const attributes = fs.readFileSync(path.join(projectRoot, '.gitattributes'), 'utf8');
    assert.match(attributes, /^\* text=auto eol=lf$/m);
    assert.match(attributes, /^\*\.sh text eol=lf$/m);
});
