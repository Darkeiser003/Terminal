const test = require('node:test');
const assert = require('node:assert/strict');
const { clearCommand, CLEAR_MARKER } = require('../main/aliasProfiles');
const { getInstallActions } = require('../main/installActions');

// ConPTY reemite el título actual de la consola cada vez que un proceso hijo
// termina y lo restaura. Si el marcador siguiera puesto, cada winget/wsl/ssh
// que acabara parecería una limpieza nueva y borraría su propia salida.
test('la limpieza devuelve el título a un valor sin marcador', () => {
    const cmd = clearCommand('cmd', 'C:\\Temp\\banner.txt', false, 'native', 'WinSlim Terminal');
    assert.ok(cmd.indexOf(CLEAR_MARKER) < cmd.indexOf('cls'), 'el marcador va antes del borrado');
    assert.ok(cmd.lastIndexOf('title WinSlim Terminal') > cmd.indexOf('cls'), 'el título se restaura tras el borrado');
    assert.doesNotMatch(cmd.slice(cmd.indexOf('cls')), new RegExp(CLEAR_MARKER));

    const ps = clearCommand('powershell', 'C:\\Temp\\banner.txt', false, 'native', 'WinSlim Terminal');
    assert.ok(ps.lastIndexOf('WindowTitle') > ps.indexOf('Clear-Host'));
    assert.doesNotMatch(ps.slice(ps.indexOf('Clear-Host')), new RegExp(CLEAR_MARKER));

    const bash = clearCommand('bash', '/tmp/banner.txt', false, 'native', 'LTerminal');
    assert.ok(bash.lastIndexOf('\\033]0;LTerminal\\007') > bash.indexOf('command clear'));
    assert.doesNotMatch(bash.slice(bash.indexOf('command clear')), new RegExp(CLEAR_MARKER));
});

test('el banner se sigue imprimiendo al final de la limpieza', () => {
    const cmd = clearCommand('cmd', 'C:\\Temp\\banner.txt', false, 'native', 'WinSlim Terminal');
    assert.ok(cmd.lastIndexOf('type "C:\\Temp\\banner.txt"') > cmd.lastIndexOf('title WinSlim Terminal'));
    const bash = clearCommand('bash', '/tmp/banner.txt', false, 'native', 'LTerminal');
    assert.ok(bash.lastIndexOf("cat '/tmp/banner.txt'") > bash.indexOf('command clear'));
});

test('el listado de distros WSL pide salida UTF-8', () => {
    const actions = getInstallActions({ platform: 'win32', pkgManager: null, wsl: { available: true, installed: [], online: [] } });
    const list = actions.find((action) => action.id === 'wsl-list');
    assert.match(list.command, /WSL_UTF8=1/);
    assert.match(list.command, /wsl\.exe --list --verbose/);
});

test('actualizar todo alcanza a los paquetes de versión desconocida y a los repos git', () => {
    const actions = getInstallActions({
        platform: 'win32', pkgManager: null, wsl: null, projectsFolder: 'C:\\Proyectos'
    });
    const byId = new Map(actions.map((action) => [action.id, action]));
    assert.match(byId.get('winget-upgrade').command, /--include-unknown/);

    const git = byId.get('git-pull-projects');
    assert.equal(git.requiresCmd, 'git');
    assert.equal(git.group, 'Actualizaciones');
    assert.match(git.command, /pull --ff-only/);
    assert.match(git.command, /C:\\Proyectos/);
    // Se escribe tal cual dentro de comillas dobles al invocarlo desde cmd.
    assert.doesNotMatch(git.command, /"/);
});

test('Linux y macOS también actualizan sus repositorios clonados', () => {
    ['linux', 'darwin'].forEach((platform) => {
        const actions = getInstallActions({ platform, pkgManager: 'apt', projectsFolder: '/home/u/Proyectos' });
        const git = actions.find((action) => action.id === 'git-pull-projects');
        assert.ok(git, `${platform} debe ofrecer la actualización con git`);
        assert.match(git.command, /git -C "\$dir" pull --ff-only/);
    });
});
