const test = require('node:test');
const assert = require('node:assert/strict');
const { getInstallActions, GROUP_ORDER } = require('../main/installActions');
const { resolveToolSuggestion } = require('../main/commandNotFound');

test('las acciones Windows se pueden ejecutar desde PowerShell 5', () => {
    const actions = getInstallActions({ platform: 'win32', pkgManager: null, wsl: null });
    const byId = new Map(actions.map((action) => [action.id, action]));
    ['docker-check', 'docker-list', 'adb-authorize'].forEach((id) => {
        assert.equal(byId.get(id).shell, 'powershell');
        assert.doesNotMatch(byId.get(id).command, /&&/);
    });
    actions.filter((action) => action.id.startsWith('winget-')).forEach((action) => {
        assert.equal(action.shell, 'powershell', action.id);
    });
});

test('Linux oculta instaladores de herramientas presentes y ofrece compatibilidad explícita', () => {
    const actions = getInstallActions({ platform: 'linux', pkgManager: 'apt', wsl: null });
    const byId = new Map(actions.map((action) => [action.id, action]));
    assert.equal(byId.get('pkg-docker').checkCmd, 'docker');
    assert.equal(byId.get('pkg-node').checkCmd, 'node');
    assert.equal(byId.get('pkg-python').checkCmd, 'python3');
    assert.equal(byId.get('pkg-wine').checkCmd, 'wine');
    assert.equal(byId.get('pkg-pwsh').group, 'Compatibilidad Windows');
    // La sugerencia automática de "pwsh: orden no encontrada" tiene que seguir
    // apuntando a una acción que exista en el catálogo.
    assert.equal(resolveToolSuggestion('pwsh', 'linux').actionId, 'pkg-pwsh');
});

// El fallo real: en CachyOS el panel escribía `sudo pacman -S --noconfirm
// powershell` y pacman respondía "no se ha encontrado el paquete". PowerShell
// no está en los repositorios oficiales de ninguna distribución grande, así
// que ese comando no puede ofrecerse en ningún caso.
test('nunca se ofrece instalar PowerShell desde el gestor de la distribución', () => {
    const combinaciones = [];
    ['apt', 'dnf', 'pacman', 'zypper'].forEach((pkgManager) => {
        [false, true].forEach((hasSnap) => {
            [null, 'paru', 'yay'].forEach((aurHelper) => {
                combinaciones.push({ platform: 'linux', pkgManager, hasSnap, aurHelper, wsl: null });
            });
        });
    });

    combinaciones.forEach((opciones) => {
        const contexto = `${opciones.pkgManager} snap=${opciones.hasSnap} aur=${opciones.aurHelper}`;
        const pwsh = getInstallActions(opciones).filter((action) => /^pkg-pwsh/.test(action.id));
        pwsh.forEach((action) => {
            // `powershell-bin` sí es legítimo: es el paquete del AUR, y una vez
            // instalado se desinstala con pacman como cualquier otro.
            assert.doesNotMatch(
                action.command,
                /(apt|dnf|zypper|pacman)[^|;&]*\bpowershell\b(?!-)/,
                `${contexto}: ${action.id} pide powershell al gestor de la distribución`
            );
        });
        // Siempre hay un primer paso accionable, y siempre se llama pkg-pwsh.
        const primary = pwsh.find((action) => action.id === 'pkg-pwsh');
        assert.ok(primary, `${contexto}: sin acción primaria`);
        assert.ok(primary.hint, `${contexto}: la acción primaria no explica por qué`);
    });
});

test('cada vía de PowerShell en Linux usa el origen que existe en el sistema', () => {
    const conAur = new Map(getInstallActions({ platform: 'linux', pkgManager: 'pacman', aurHelper: 'paru', wsl: null })
        .map((action) => [action.id, action]));
    assert.match(conAur.get('pkg-pwsh').command, /^paru -S --noconfirm powershell-bin$/);
    assert.equal(conAur.get('pkg-pwsh').checkCmd, 'pwsh');
    // El asistente del AUR nunca se invoca con sudo: makepkg se niega a
    // ejecutarse como root y la instalación fallaría al final del proceso.
    assert.doesNotMatch(conAur.get('pkg-pwsh').command, /^sudo/);
    assert.match(conAur.get('pkg-pwsh-update').command, /paru/);

    const conSnap = new Map(getInstallActions({ platform: 'linux', pkgManager: 'apt', hasSnap: true, wsl: null })
        .map((action) => [action.id, action]));
    assert.match(conSnap.get('pkg-pwsh').command, /^sudo snap install powershell --classic$/);
    assert.equal(conSnap.get('pkg-pwsh').checkCmd, 'pwsh');
    assert.match(conSnap.get('pkg-pwsh-uninstall').command, /snap remove/);

    // Sin AUR ni Snap la acción primaria instala el requisito, no PowerShell:
    // por eso comprueba `snap` y no `pwsh`.
    const sinNada = new Map(getInstallActions({ platform: 'linux', pkgManager: 'pacman', wsl: null })
        .map((action) => [action.id, action]));
    assert.equal(sinNada.get('pkg-pwsh').checkCmd, 'snap');
    assert.match(sinNada.get('pkg-pwsh').command, /snapd/);
    // Y en Arch se ofrece además el camino por el AUR.
    assert.ok(sinNada.get('pkg-paru'));
    // Actualizar/desinstalar no se inventan un origen que aquí no existe.
    assert.equal(sinNada.get('pkg-pwsh-update'), undefined);
    assert.equal(sinNada.get('pkg-pwsh-uninstall'), undefined);
});

// Wine sí está empaquetado, pero en Arch vive en multilib, que viene
// desactivado de fábrica: sin avisar, el usuario ve el mismo "paquete no
// encontrado" y no sabe que le falta habilitar un repositorio.
test('el aviso de Wine en Arch menciona multilib', () => {
    const arch = getInstallActions({ platform: 'linux', pkgManager: 'pacman', wsl: null })
        .find((action) => action.id === 'pkg-wine');
    assert.match(arch.hint, /multilib/);

    const debian = getInstallActions({ platform: 'linux', pkgManager: 'apt', wsl: null })
        .find((action) => action.id === 'pkg-wine');
    assert.doesNotMatch(debian.hint, /multilib/);
});

// Cada herramienta vive en UN solo apartado. Antes "pkg-docker-uninstall" y
// "pkg-adb-uninstall" caían en "Sistema y herramientas" por empezar por
// "pkg-", y Docker se gestionaba desde dos sitios distintos del panel.
test('ninguna herramienta con apartado propio se cuela en Sistema y herramientas', () => {
    ['linux', 'darwin', 'win32'].forEach((platform) => {
        const actions = getInstallActions({ platform, pkgManager: 'pacman', wsl: null });
        actions
            .filter((action) => action.group === 'Sistema y herramientas')
            .forEach((action) => {
                assert.doesNotMatch(action.id, /(^|-)(docker|adb|ssh)(-|$)/, `${platform}: ${action.id}`);
            });
        // Y todo lo de Docker/ADB/SSH está agrupado bajo un plegable, no suelto.
        actions
            .filter((action) => /(^|-)(docker|adb|ssh)(-|$)/.test(action.id))
            .forEach((action) => {
                assert.ok(action.subgroup, `${platform}: ${action.id} sin subgrupo`);
            });
    });
});

test('bash y sh ofrecen acciones aunque vengan preinstalados', () => {
    const actions = getInstallActions({ platform: 'linux', pkgManager: 'pacman', wsl: null });
    const byId = new Map(actions.map((action) => [action.id, action]));

    ['pkg-bash-update', 'pkg-bash-uninstall', 'pkg-bash-version'].forEach((id) => {
        assert.equal(byId.get(id).requiresCmd, 'bash', id);
        assert.equal(byId.get(id).group, 'Shells', id);
    });
    // Desinstalar bash se lo lleva medio sistema por delante: el comando NO
    // puede llevar la confirmación automática que sí llevan los demás.
    assert.doesNotMatch(byId.get('pkg-bash-uninstall').command, /--noconfirm|-y\b/);
    assert.ok(byId.get('pkg-bash-uninstall').hint);

    // sh no es un paquete, es un enlace: solo se puede ofrecer averiguar
    // cuál es y de dónde sale.
    assert.equal(byId.get('sh-version').group, 'Shells');
    assert.equal(byId.get('sh-version').requiresCmd, 'sh');
});

test('WSL ocupa un único apartado con un plegable por distribución', () => {
    const wsl = {
        available: true,
        installed: [{ name: 'Ubuntu', shell: 'bash', shells: ['bash'], tools: ['git'], packageManager: 'apt' }],
        online: [{ name: 'Debian', friendlyName: 'Debian GNU/Linux' }]
    };
    const actions = getInstallActions({ platform: 'win32', pkgManager: null, wsl });
    const wslActions = actions.filter((action) => action.id.startsWith('wsl-'));

    assert.ok(wslActions.length > 0);
    wslActions.forEach((action) => {
        assert.equal(action.group, 'WSL', action.id);
        assert.ok(action.subgroup, `${action.id} sin subgrupo`);
    });
    const subgroups = new Set(wslActions.map((action) => action.subgroup));
    assert.ok(subgroups.has('Ubuntu · bash'));
    assert.ok(subgroups.has('Distribuciones disponibles'));
    // Lo ya instalado en la distro no se vuelve a ofrecer.
    assert.equal(actions.find((action) => action.id === 'wsl-ubuntu-git'), undefined);
    assert.ok(actions.find((action) => action.id === 'wsl-ubuntu-zsh'));
});

test('los apartados salen siempre en el mismo orden', () => {
    ['linux', 'darwin', 'win32'].forEach((platform) => {
        const groups = [];
        getInstallActions({ platform, pkgManager: 'apt', wsl: null }).forEach((action) => {
            if (groups[groups.length - 1] !== action.group) groups.push(action.group);
        });
        // Cada apartado aparece una sola vez (no se parte en varios tramos)...
        assert.equal(new Set(groups).size, groups.length, `${platform}: ${groups.join(' | ')}`);
        // ...y en el orden declarado.
        const ranks = groups.map((name) => GROUP_ORDER.indexOf(name));
        assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${platform}: ${groups.join(' | ')}`);
        assert.ok(!ranks.includes(-1), `${platform}: apartado fuera de GROUP_ORDER`);
    });
});
