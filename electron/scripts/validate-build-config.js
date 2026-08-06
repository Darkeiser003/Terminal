// Reglas de distribución que deben mantenerse aunque se edite package.json.

const pkg = require('../package.json');
const linux = require('../electron-builder.linux');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function validateBuildConfig() {
    const build = pkg.build || {};
    assert(pkg.engines && pkg.engines.node === '>=22.12.0', 'La build debe exigir la versión mínima de Node compatible con Electron 43.');
    const languages = Array.isArray(build.electronLanguages) ? build.electronLanguages : [];
    assert(languages.includes('es') && languages.includes('en-US'), 'La build debe conservar locales es y en-US.');
    assert(languages.length <= 3, 'La build incluye demasiados locales de Chromium.');
    assert(build.toolsets && build.toolsets.appimage === '1.0.3', 'AppImage debe usar el runtime estático 1.0.3.');
    const files = Array.isArray(build.files) ? build.files : [];
    assert(files.some((rule) => /iobj,ipdb/.test(rule)), 'Falta excluir artefactos de enlace incremental de node-pty.');
    assert(files.some((rule) => /node-pty\/bin/.test(rule)), 'Falta excluir la copia ABI auxiliar de node-pty.');
    // Los prebuilds son una segunda copia de los mismos binarios: node-pty
    // carga primero desde build/Release, donde electron-rebuild deja el módulo
    // recompilado. beforePack exige que build/Release exista, así que excluir
    // prebuilds no puede dejar el paquete sin PTY.
    assert(files.includes('!node_modules/node-pty/prebuilds/**'),
        'Falta excluir node-pty/prebuilds: duplicaba los binarios nativos en el paquete.');
    assert(Array.isArray(build.linux && build.linux.files)
        && build.linux.files.includes('!node_modules/node-pty/prebuilds/**'),
        'La build Linux también debe excluir node-pty/prebuilds.');

    // Un formato por sistema, a propósito: en Windows la carpeta
    // desempaquetada y en Linux el AppImage. Mantener además un portable de
    // Windows y un linux-unpacked duplicaba cada release sin que nadie los
    // usara, y el portable era justo el que bloqueaba la carpeta de salida
    // mientras estaba en ejecución.
    const winTargets = Array.isArray(build.win && build.win.target) ? build.win.target : [];
    assert(winTargets.length === 1 && winTargets[0] === 'dir', 'Windows solo debe generar la versión desempaquetada.');
    assert(!build.portable, 'La configuración del portable de Windows ya no debe existir.');
    assert(pkg.scripts['dist:win'].includes('--win dir'), 'dist:win debe empaquetar solo la carpeta desempaquetada.');
    assert(linux.linux.target === 'AppImage', 'Linux solo debe generar el AppImage.');
    assert(pkg.scripts['dist:linux'].includes('--linux AppImage'), 'dist:linux debe empaquetar solo el AppImage.');
    assert(pkg.scripts['dist:linux'].includes('--config electron-builder.linux.js'),
        'dist:linux debe usar la configuración Linux, no la identidad de Windows.');

    // Formatos que la distribución retiró a propósito. Añadir cualquiera de
    // ellos vuelve a duplicar cada release, así que se bloquea desde aquí y no
    // solo desde los scripts de build.
    ['nsis', 'nsisWeb', 'portable', 'msi', 'appx', 'squirrel', 'deb', 'rpm', 'snap', 'pacman', 'flatpak']
        .forEach((format) => {
            assert(!build[format], `La configuración de "${format}" no debe existir: un formato por sistema.`);
            assert(!winTargets.includes(format), `Windows no debe generar "${format}".`);
            assert(linux.linux.target !== format, `Linux no debe generar "${format}".`);
        });

    // Las pruebas y los validadores tienen que correr ANTES de empaquetar: si
    // `check` deja de encadenarlos, una build rota se publica igual.
    const check = pkg.scripts.check || '';
    assert(/(^|&&)\s*npm test\b/.test(check), 'npm run check debe empezar ejecutando las pruebas.');
    assert((pkg.scripts.test || '').includes('node --test'), 'npm test debe usar el runner de Node.');
    ['check-syntax', 'validate-i18n', 'validate-release-metadata', 'validate-build-config']
        .forEach((step) => assert(check.includes(step), `npm run check debe ejecutar ${step}.`));

    assert(linux.productName === 'LTerminal', 'La build Linux debe llamarse LTerminal.');
    assert(linux.appId === 'org.lterminal.app', 'La build Linux debe tener un appId propio.');
    assert(linux.extraMetadata && linux.extraMetadata.name === 'lterminal', 'El package.json interno de Linux debe usar lterminal.');
    assert(linux.linux.executableName === 'lterminal', 'El ejecutable Linux debe llamarse lterminal.');
    assert(/^LTerminal-/.test(linux.linux.artifactName), 'El AppImage debe usar el prefijo LTerminal.');
    assert(!/WinSlim/i.test(JSON.stringify({
        productName: linux.productName,
        appId: linux.appId,
        copyright: linux.copyright,
        extraMetadata: linux.extraMetadata,
        linux: linux.linux
    })), 'Los metadatos públicos Linux no deben contener la marca WinSlim.');
    return { languages, appImageRuntime: build.toolsets.appimage, linuxProduct: linux.productName };
}

if (require.main === module) {
    const result = validateBuildConfig();
    console.log(`Build validada: ${result.linuxProduct}; locales ${result.languages.join(', ')}; AppImage ${result.appImageRuntime}.`);
}

module.exports = { validateBuildConfig };
