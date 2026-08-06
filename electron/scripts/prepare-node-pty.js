// electron-rebuild coloca los .node recompilados en build/Release, que es
// la primera ruta que node-pty carga. El backend useConptyDll busca entonces
// su DLL en build/Release/conpty, mientras el paquete npm la distribuye en
// prebuilds/<plataforma>-<arquitectura>/conpty. Se sincroniza justo después
// de instalar y de nuevo en beforePack para cubrir ambos órdenes de build.

const fs = require('fs');
const path = require('path');
const { validateReleaseMetadata } = require('./validate-release-metadata');

function prepareNodePty() {
    if (process.platform !== 'win32') return { skipped: true, reason: 'non-windows' };
    const packageRoot = path.join(__dirname, '..', 'node_modules', 'node-pty');
    const source = path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'conpty');
    const release = path.join(packageRoot, 'build', 'Release');
    const target = path.join(release, 'conpty');
    if (!fs.existsSync(source)) throw new Error(`node-pty no incluye la DLL ConPTY esperada: ${source}`);
    if (!fs.existsSync(release)) {
        // En instalaciones que usan únicamente prebuilds no hay build/Release
        // y node-pty cargará la DLL desde prebuilds directamente.
        return { skipped: true, reason: 'prebuild-only' };
    }
    fs.cpSync(source, target, { recursive: true, force: true });
    const dll = path.join(target, 'conpty.dll');
    if (!fs.existsSync(dll)) throw new Error(`No se pudo preparar ${dll}`);
    return { skipped: false, target: dll };
}

if (require.main === module) {
    const result = prepareNodePty();
    console.log(result.skipped ? `ConPTY: ${result.reason}` : `ConPTY preparado: ${result.target}`);
}

// El paquete NO lleva node_modules/node-pty/prebuilds: sería una segunda copia
// de los mismos binarios (~2,5 MB) porque node-pty carga primero desde
// build/Release, que es donde electron-rebuild deja el módulo recompilado
// contra el ABI de Electron.
//
// Por eso aquí build/Release deja de ser opcional. Sin esta comprobación, un
// `npm run dist:win` sobre un node_modules a medio instalar producía un .exe
// que arrancaba y solo fallaba al abrir la primera pestaña, sin PTY.
function assertNativeModulePacked() {
    const binary = path.join(__dirname, '..', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node');
    if (!fs.existsSync(binary)) {
        throw new Error(`Falta ${binary}. node-pty no está recompilado y el paquete ya no incluye prebuilds:`
            + ' ejecuta `npm ci` (o borra node_modules/node-pty y reinstala) antes de empaquetar.');
    }
}

module.exports = async function beforePack() {
    validateReleaseMetadata();
    prepareNodePty();
    assertNativeModulePacked();
};
module.exports.prepareNodePty = prepareNodePty;
module.exports.assertNativeModulePacked = assertNativeModulePacked;
