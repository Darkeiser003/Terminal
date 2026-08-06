const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPackageAliasLines, detectWindowsManager, PACKAGE_ALIAS_NAMES } = require('../main/packageAliases');
const { buildInitScript } = require('../main/aliasProfiles');

test('cada shell define todos los alias de gestor de paquetes', () => {
    const kinds = ['cmd', 'powershell', 'bash', 'zsh', 'sh', 'fish'];
    kinds.forEach((kind) => {
        const lines = buildPackageAliasLines(kind, { platform: 'win32', windowsManager: 'winget' }).join('\n');
        PACKAGE_ALIAS_NAMES.forEach((name) => {
            // doskey nombre=..., function nombre {...} / nombre; ..., nombre() {...}
            assert.match(lines, new RegExp('(?:doskey |function |^)' + name + '[ (={;]', 'm'), `${kind} debe definir ${name}`);
        });
    });
});

test('Windows usa el gestor detectado y Unix decide dentro de la propia shell', () => {
    const cmd = buildPackageAliasLines('cmd', { platform: 'win32', windowsManager: 'winget' }).join('\n');
    assert.match(cmd, /doskey install=winget install .*\$\*/);
    assert.match(cmd, /doskey remove=winget uninstall/);

    const choco = buildPackageAliasLines('powershell', { platform: 'win32', windowsManager: 'choco' }).join('\n');
    assert.match(choco, /function install \{ choco install -y @args \}/);

    const bash = buildPackageAliasLines('bash', { platform: 'linux' }).join('\n');
    assert.match(bash, /command -v apt/);
    assert.match(bash, /command -v pacman/);
    assert.match(bash, /command -v brew/);
    // brew se rompe bajo sudo: es el único que no pasa por el envoltorio.
    assert.doesNotMatch(bash, /__wsterm_priv brew/);
});

test('dentro de WSL manda el gestor de la distro, no el de Windows', () => {
    const wslShell = buildPackageAliasLines('bash', { platform: 'win32', transport: 'wsl', windowsManager: 'winget' }).join('\n');
    assert.doesNotMatch(wslShell, /winget/);
    assert.match(wslShell, /apt install -y/);
});

test('install no tapa el binario install de coreutils', () => {
    const bash = buildPackageAliasLines('bash', { platform: 'linux' }).join('\n');
    assert.match(bash, /case "\$\{1:-\}" in -\*\) command install "\$@"/);
    const fish = buildPackageAliasLines('fish', { platform: 'linux' }).join('\n');
    assert.match(fish, /command install \$argv/);
});

test('update sin argumentos actualiza todo el sistema', () => {
    const bash = buildPackageAliasLines('bash', { platform: 'linux' }).join('\n');
    assert.match(bash, /update\(\) \{ if \[ "\$#" -eq 0 \]; then upgrade;/);
    const powershell = buildPackageAliasLines('powershell', { platform: 'win32', windowsManager: 'winget' }).join('\n');
    assert.match(powershell, /function update \{ if \(\$args\.Count -eq 0\) \{ winget upgrade --all/);
});

test('sin gestor en Windows se explica en vez de fallar en silencio', () => {
    const lines = buildPackageAliasLines('cmd', { platform: 'win32', windowsManager: null }).join('\n');
    assert.match(lines, /doskey install=echo No se detecto winget/);
    assert.equal(detectWindowsManager(() => false), null);
    assert.equal(detectWindowsManager((cmd) => cmd === 'scoop'), 'scoop');
    assert.equal(detectWindowsManager(() => true), 'winget');
});

test('search funciona en todas las shells y nunca pide privilegios', () => {
    assert.ok(PACKAGE_ALIAS_NAMES.includes('search'));

    const cmd = buildPackageAliasLines('cmd', { platform: 'win32', windowsManager: 'winget' }).join('\n');
    assert.match(cmd, /doskey search=winget search/);

    const powershell = buildPackageAliasLines('powershell', { platform: 'win32', windowsManager: 'scoop' }).join('\n');
    assert.match(powershell, /function search \{ scoop search @args \}/);

    // Consultar el catálogo es de solo lectura: elevar para buscar sería pedir
    // la contraseña de sudo para nada.
    ['bash', 'zsh', 'sh', 'fish'].forEach((kind) => {
        const lines = buildPackageAliasLines(kind, { platform: 'linux' }).join('\n');
        const searchBlock = lines.split('\n').filter((line) => /(?:^|function )search[ ({;]/.test(line)).join('\n');
        assert.ok(searchBlock, `${kind} debe definir search`);
        assert.doesNotMatch(searchBlock, /__wsterm_priv/, `search en ${kind} no debe elevar privilegios`);
        assert.match(searchBlock, /pacman -Ss/);
    });

    // Pero instalar sí sigue elevando donde hace falta.
    const bashInstall = buildPackageAliasLines('bash', { platform: 'linux' }).join('\n');
    assert.match(bashInstall, /__wsterm_priv apt install -y/);
});

test('la ayuda se escribe en un archivo y explica cada alias', () => {
    const generated = buildInitScript('bash', {
        platform: 'linux',
        appName: 'LTerminal',
        envLabel: 'bash',
        helpPath: '/tmp/session/help-tab-1.txt',
        scriptAliases: []
    });
    // El alias solo imprime el archivo: nada de meter el texto entero dentro
    // del entrecomillado de cada shell.
    assert.match(generated.content, /ayuda\(\) \{ cat '\/tmp\/session\/help-tab-1\.txt'; \}/);
    assert.ok(generated.helpText, 'buildInitScript debe devolver el texto de la ayuda');
    ['install', 'update', 'upgrade', 'uninstall', 'search', 'sysinfo', 'clear'].forEach((alias) => {
        assert.ok(generated.helpText.includes(alias), `la ayuda debe mencionar ${alias}`);
    });
    assert.match(generated.helpText, /gestor se elige solo/);

    // En Windows sí se sabe qué gestor atiende los alias, y se dice.
    const windows = buildInitScript('cmd', {
        platform: 'win32',
        windowsManager: 'winget',
        managerLabel: 'winget',
        appName: 'WinSlim Terminal',
        helpPath: 'C:\\Temp\\help-tab-1.txt',
        scriptAliases: []
    });
    assert.match(windows.content, /doskey ayuda=type "C:\\Temp\\help-tab-1\.txt"/);
    assert.match(windows.helpText, /winget/);

    // Sin carpeta temporal escribible no hay archivo: la ayuda degrada a una
    // línea suelta en vez de dejar de existir.
    const sinArchivo = buildInitScript('bash', { platform: 'linux', scriptAliases: [] });
    assert.equal(sinArchivo.helpText, null);
    assert.match(sinArchivo.content, /ayuda\(\) \{ echo 'Alias fijos:/);
});

test('un script del usuario no puede pisar los alias de paquetes', () => {
    const script = { name: 'install.ps1', ext: '.ps1', type: 'powershell', path: 'C:\\scripts\\install.ps1' };
    const generated = buildInitScript('powershell', {
        platform: 'win32',
        windowsManager: 'winget',
        scriptAliases: [{ aliasName: 'install', script }]
    });
    assert.doesNotMatch(generated.content, /install\.ps1/);
    assert.match(generated.content, /function install \{ winget install/);
});
