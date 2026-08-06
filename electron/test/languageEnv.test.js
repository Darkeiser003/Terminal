const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLanguageEnvironments, LANGUAGE_DEFS } = require('../main/languageEnv');
const { buildInitScript } = require('../main/aliasProfiles');
const { getInstallActions } = require('../main/installActions');

test('solo aparecen los lenguajes cuyo intérprete existe', () => {
    const instalados = new Set(['python', 'node', 'irb']);
    const { envs } = detectLanguageEnvironments({
        platform: 'win32',
        isInstalled: (exe) => instalados.has(exe)
    });
    assert.deepEqual(envs.map((env) => env.id), ['lang:python', 'lang:node', 'lang:ruby']);
    assert.equal(detectLanguageEnvironments({ platform: 'linux', isInstalled: () => false }).envs.length, 0);
});

test('cada entorno de lenguaje se marca como REPL y no como shell', () => {
    const { envs } = detectLanguageEnvironments({ platform: 'linux', isInstalled: () => true });
    assert.equal(envs.length, LANGUAGE_DEFS.length);
    envs.forEach((env) => {
        assert.equal(env.repl, true, env.id);
        assert.equal(env.kind, 'repl', env.id);
        assert.equal(env.transport, 'native', env.id);
        assert.ok(env.label.endsWith('· REPL'), env.label);
    });
    // Python usa python3 en Unix y python en Windows.
    assert.equal(envs.find((env) => env.id === 'lang:python').exe, 'python3');
    const windows = detectLanguageEnvironments({ platform: 'win32', isInstalled: () => true });
    assert.equal(windows.envs.find((env) => env.id === 'lang:python').exe, 'python');
});

test('un REPL no recibe alias de shell', () => {
    // buildInitScript devuelve null para los kinds que no son familias de
    // shell: escribir "doskey" o "alias" dentro de Python es un error.
    assert.equal(buildInitScript('repl', { platform: 'win32', windowsManager: 'winget' }), null);
});

test('cada lenguaje del selector se puede instalar desde el panel', () => {
    const acciones = getInstallActions({ platform: 'win32', pkgManager: null, wsl: null });
    const etiquetas = acciones.map((accion) => accion.label.toLowerCase()).join(' | ');
    ['python', 'node', 'ruby', 'java', 'php', 'lua', 'deno', 'perl'].forEach((lenguaje) => {
        assert.match(etiquetas, new RegExp('instalar[^|]*' + lenguaje), `falta instalar ${lenguaje}`);
    });
});

test('las herramientas ofrecen instalar, actualizar, desinstalar y ver versión', () => {
    [
        { platform: 'win32', prefijo: 'winget-python', cmd: 'python' },
        { platform: 'linux', prefijo: 'pkg-python', cmd: 'python3' },
        { platform: 'darwin', prefijo: 'brew-python', cmd: 'python3' }
    ].forEach(({ platform, prefijo, cmd }) => {
        const porId = new Map(getInstallActions({ platform, pkgManager: 'apt', wsl: null }).map((a) => [a.id, a]));
        const instalar = porId.get(prefijo);
        const actualizar = porId.get(prefijo + '-update');
        const desinstalar = porId.get(prefijo + '-uninstall');
        const version = porId.get(prefijo + '-version');
        assert.ok(instalar && actualizar && desinstalar && version, `faltan acciones en ${platform}`);
        // Instalar solo se ofrece si falta; el resto, solo si ya está.
        assert.equal(instalar.checkCmd, cmd);
        assert.equal(actualizar.requiresCmd, cmd);
        assert.equal(desinstalar.requiresCmd, cmd);
        assert.equal(version.requiresCmd, cmd);
        assert.equal(desinstalar.verb, 'Desinstalar');
        assert.equal(version.verb, 'Versión');
    });
});

test('ninguna acción de Windows lleva comillas dobles', () => {
    // wrapPowerShellCommand las envuelve entre comillas dobles al invocarlas
    // desde cmd.exe: una comilla doble dentro rompería el comando.
    getInstallActions({ platform: 'win32', pkgManager: null, wsl: null, projectsFolder: 'C:\\P' })
        .filter((action) => action.shell === 'powershell')
        .forEach((action) => {
            assert.doesNotMatch(action.command, /"/, action.id);
        });
});
