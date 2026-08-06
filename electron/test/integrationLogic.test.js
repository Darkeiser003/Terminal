const test = require('node:test');
const assert = require('node:assert/strict');
const { clearCommand, buildInitScript } = require('../main/aliasProfiles');
const { buildLaunchCommand, buildCdCommand, environmentKindsForScript, SCRIPT_TYPES } = require('../main/scriptLauncher');
const { parseInstalledDistros, parseOnlineDistros } = require('../main/wslEnv');
const { resolveToolSuggestion } = require('../main/commandNotFound');
const { getInstallActions } = require('../main/installActions');
const { isGitBashPath } = require('../main/shellDetect');

test('clear emite el marcador antes del borrado nativo', () => {
    const cmd = clearCommand('cmd', 'C:\\Temp\\banner.txt', true, 'native', 'WinSlim Terminal');
    assert.ok(cmd.indexOf('title WinSlim Terminal') < cmd.indexOf('cls'));
    const bash = clearCommand('bash', '/tmp/banner.txt', false, 'native', 'LTerminal');
    assert.ok(bash.indexOf('LTerminal __TERMINAL_CLEAR__') < bash.indexOf('command clear'));
});

test('reconoce scripts fish y delega sh desde cmd a bash', () => {
    assert.equal(SCRIPT_TYPES['.fish'], 'fish');
    const command = buildLaunchCommand(
        { type: 'shell', path: 'C:\\Trabajo\\deploy.sh' },
        'cmd',
        false,
        ''
    );
    assert.match(command, /^bash "/);
    assert.match(command, /\/c\/Trabajo\/deploy\.sh/);
});

test('traduce un script compartido con Docker a /workspace', () => {
    const command = buildLaunchCommand(
        { type: 'python', path: 'C:\\Users\\Test\\proyecto\\tool.py' },
        'bash',
        false,
        '',
        { transport: 'docker', hostRoot: 'C:\\Users\\Test', containerRoot: '/workspace' }
    );
    assert.equal(command, "python3 '/workspace/proyecto/tool.py'");
});

test('ejecuta scripts descubiertos dentro del filesystem de WSL', () => {
    const command = buildLaunchCommand(
        { type: 'shell', path: '\\\\wsl$\\Ubuntu\\home\\test\\deploy.sh' },
        'bash',
        false,
        '',
        { transport: 'wsl' }
    );
    assert.equal(command, "bash '/home/test/deploy.sh'");
});

test('traduce rutas locales a /mnt al ejecutar scripts de Windows dentro de WSL', () => {
    const command = buildLaunchCommand(
        { type: 'shell', interpreter: 'bash', path: 'C:\\Users\\Administrador\\Desktop\\Proyecto\\scripts\\docker-manager.sh' },
        'bash',
        false,
        '',
        { transport: 'wsl' }
    );
    assert.equal(command, "bash '/mnt/c/Users/Administrador/Desktop/Proyecto/scripts/docker-manager.sh'");
});

test('no confunde el lanzador bash de WSL con Git Bash', () => {
    assert.equal(isGitBashPath('C:\\Program Files\\Git\\bin\\bash.exe'), true);
    assert.equal(isGitBashPath('C:\\Program Files\\Git\\usr\\bin\\bash.exe'), true);
    assert.equal(isGitBashPath('C:\\Windows\\System32\\bash.exe'), false);
});

test('genera instrucciones para runtimes adicionales, programas y cd', () => {
    assert.equal(
        buildLaunchCommand({ type: 'ruby', path: 'C:\\Trabajo\\tool.rb' }, 'cmd', false, ''),
        'ruby "C:\\Trabajo\\tool.rb"'
    );
    assert.equal(
        buildLaunchCommand({ type: 'java', path: 'C:\\Trabajo\\tool.jar' }, 'powershell', false, '--help'),
        'java -jar "C:\\Trabajo\\tool.jar" --help'
    );
    assert.equal(buildCdCommand('C:\\Trabajo\\scripts\\tool.rb', 'cmd'), 'cd /d "C:\\Trabajo\\scripts"');
    // El explorador lateral navega a la carpeta que está MOSTRANDO, no a su
    // padre. Antes pasaba una entrada ficticia (`join(dir, '.')`) para
    // reutilizar el camino de archivo, pero join normaliza y borra el `.`, así
    // que `cd` dejaba la terminal un nivel más arriba.
    assert.equal(
        buildCdCommand('C:\\Users\\Admin\\Desktop\\Terminal', 'cmd', { directory: true }),
        'cd /d "C:\\Users\\Admin\\Desktop\\Terminal"'
    );
    assert.equal(
        buildCdCommand('C:\\Users\\Admin\\Desktop\\Terminal', 'bash', { directory: true, transport: 'wsl' }),
        "cd '/mnt/c/Users/Admin/Desktop/Terminal'"
    );
    assert.equal(
        buildCdCommand('C:\\Users\\Admin\\Desktop\\Terminal', 'powershell', { directory: true }),
        "Set-Location -LiteralPath 'C:\\Users\\Admin\\Desktop\\Terminal'"
    );
    assert.equal(
        buildCdCommand('C:\\Trabajo\\scripts\\tool.rb', 'bash', { transport: 'wsl' }),
        "cd '/mnt/c/Trabajo/scripts'"
    );
    assert.deepEqual(environmentKindsForScript({ type: 'powershell' }), ['powershell']);
    assert.deepEqual(environmentKindsForScript({ type: 'fish' }), ['fish']);
    assert.deepEqual(environmentKindsForScript({ type: 'shell', interpreter: 'zsh' }), ['zsh']);
});

test('parsea inventarios WSL sin incluir cabeceras', () => {
    assert.deepEqual(parseInstalledDistros('Ubuntu\n* FedoraLinux-44\ndocker-desktop\n'), ['Ubuntu', 'FedoraLinux-44']);
    assert.deepEqual(
        parseOnlineDistros('NAME                      FRIENDLY NAME\nUbuntu-24.04              Ubuntu 24.04 LTS\n'),
        [{ name: 'Ubuntu-24.04', friendlyName: 'Ubuntu 24.04 LTS' }]
    );
});

test('los alias por defecto y de Biblioteca se generan en la shell', () => {
    const init = buildInitScript('bash', {
        scriptAliases: [{
            aliasName: 'deploy',
            script: { type: 'shell', interpreter: 'bash', path: '/tmp/deploy.sh' }
        }]
    });
    assert.match(init.content, /alias ll=/);
    assert.match(init.content, /alias deploy=/);
    assert.match(init.content, /ayuda\(\)/);
});

test('las sugerencias WSL apuntan a acciones de instalación existentes', () => {
    const wsl = {
        available: true,
        online: [],
        installed: [{
            name: 'FedoraLinux-44',
            shell: 'bash',
            shells: ['bash', 'sh'],
            tools: [],
            packageManager: 'dnf'
        }]
    };
    const ids = new Set(getInstallActions({ platform: 'win32', wsl }).map((action) => action.id));
    ['git', 'node', 'python3', 'fish', 'zsh'].forEach((tool) => {
        const suggestion = resolveToolSuggestion(tool, 'win32', {
            transport: 'wsl',
            distro: 'FedoraLinux-44'
        });
        assert.ok(suggestion, `debe reconocer ${tool}`);
        assert.ok(ids.has(suggestion.actionId), `${suggestion.actionId} debe existir`);
    });
});
