// main/packageAliases.js
// Alias "install", "update", "upgrade", "uninstall" y "remove" traducidos al
// gestor de paquetes REAL del entorno de cada pestaña, para que el mismo
// vocabulario funcione en cmd, PowerShell, Git Bash, WSL, Linux y macOS.
//
// Dos estrategias, según lo que se pueda saber:
//   - Windows: el gestor (winget/choco/scoop) se resuelve en el proceso
//     principal al crear la pestaña, porque cmd no permite encadenar
//     condicionales dentro de una macro doskey de forma legible.
//   - Unix (bash/zsh/sh/fish y todo lo que corre dentro de WSL): la elección
//     se hace EN LA PROPIA SHELL al invocar el alias. Así una distro WSL que
//     todavía no se había sondeado, o un contenedor, siguen resolviendo su
//     gestor correcto sin que la app tenga que adivinarlo.
//
// Como el resto de la aplicación, estos alias solo escriben un comando
// normal: se ve lo que se ejecuta y se puede cancelar con Ctrl+C.

// Cada acción es el comando SIN los paquetes; los argumentos del usuario se
// añaden detrás (doskey $*, PowerShell @args, "$@" en Unix, $argv en fish).
const WINDOWS_MANAGERS = {
    winget: {
        label: 'winget',
        install: 'winget install --accept-source-agreements --accept-package-agreements',
        update: 'winget upgrade --accept-source-agreements --accept-package-agreements',
        upgradeAll: 'winget upgrade --all --include-unknown --accept-source-agreements --accept-package-agreements',
        uninstall: 'winget uninstall',
        search: 'winget search --accept-source-agreements'
    },
    choco: {
        label: 'Chocolatey',
        install: 'choco install -y',
        update: 'choco upgrade -y',
        upgradeAll: 'choco upgrade all -y',
        uninstall: 'choco uninstall -y',
        search: 'choco search'
    },
    scoop: {
        label: 'Scoop',
        install: 'scoop install',
        update: 'scoop update',
        upgradeAll: 'scoop update *',
        uninstall: 'scoop uninstall',
        search: 'scoop search'
    }
};

const WINDOWS_MANAGER_ORDER = ['winget', 'choco', 'scoop'];

// Orden de preferencia al detectar dentro de una shell Unix. `priv` indica si
// la operación necesita privilegios: Homebrew se rompe si se ejecuta con
// sudo, y dentro de muchos contenedores ya se es root.
//
// `search` es la excepción a `priv`: consultar el catálogo de paquetes es de
// solo lectura y pedir la contraseña de sudo para buscar es absurdo (además
// de que apt lo desaconseja expresamente). Ver NO_PRIV_ACTIONS.
const UNIX_MANAGERS = [
    {
        probe: 'apt', priv: true,
        install: 'apt install -y',
        update: 'apt install -y --only-upgrade',
        upgradeAll: 'apt update && __wsterm_priv apt upgrade -y',
        uninstall: 'apt remove -y',
        search: 'apt-cache search'
    },
    {
        probe: 'dnf', priv: true,
        install: 'dnf install -y',
        update: 'dnf upgrade -y',
        upgradeAll: 'dnf upgrade -y',
        uninstall: 'dnf remove -y',
        search: 'dnf search'
    },
    {
        probe: 'pacman', priv: true,
        install: 'pacman -S --noconfirm',
        update: 'pacman -S --noconfirm',
        upgradeAll: 'pacman -Syu --noconfirm',
        uninstall: 'pacman -Rs --noconfirm',
        search: 'pacman -Ss'
    },
    {
        probe: 'zypper', priv: true,
        install: 'zypper install -y',
        update: 'zypper update -y',
        upgradeAll: 'zypper update -y',
        uninstall: 'zypper remove -y',
        search: 'zypper search'
    },
    {
        probe: 'apk', priv: true,
        install: 'apk add',
        update: 'apk upgrade',
        upgradeAll: 'apk update && __wsterm_priv apk upgrade',
        uninstall: 'apk del',
        search: 'apk search'
    },
    {
        probe: 'brew', priv: false,
        install: 'brew install',
        update: 'brew upgrade',
        upgradeAll: 'brew update && brew upgrade',
        uninstall: 'brew uninstall',
        search: 'brew search'
    }
];

// Acciones que nunca se elevan aunque el gestor sea de los que piden root.
const NO_PRIV_ACTIONS = new Set(['search']);

function needsPrivileges(manager, action) {
    return manager.priv === true && !NO_PRIV_ACTIONS.has(action);
}

const NO_MANAGER_MESSAGE = 'No se detecto un gestor de paquetes compatible (apt, dnf, pacman, zypper, apk o brew).';
const NO_WINDOWS_MANAGER_MESSAGE = 'No se detecto winget, Chocolatey ni Scoop. Instala App Installer desde Microsoft Store o usa el panel Entorno y dependencias.';

// Envoltorio de privilegios: si ya se es root se ejecuta directo (contenedores
// y muchas distros WSL), si hay sudo se usa, y si no hay ninguna de las dos se
// explica en vez de fallar con un "command not found" opaco.
const POSIX_PRIV = "__wsterm_priv() { if [ \"$(id -u)\" = \"0\" ]; then \"$@\"; "
    + 'elif command -v sudo >/dev/null 2>&1; then sudo "$@"; '
    + "else echo 'Se necesitan privilegios de administrador y sudo no esta disponible.' >&2; return 1; fi; }";

const FISH_PRIV = 'function __wsterm_priv; if test (id -u) = 0; $argv; '
    + 'else if command -v sudo >/dev/null 2>&1; sudo $argv; '
    + "else; echo 'Se necesitan privilegios de administrador y sudo no esta disponible.' >&2; return 1; end; end";

function posixBranches(action, argsExpression) {
    return UNIX_MANAGERS.map((manager) => {
        const prefix = needsPrivileges(manager, action) ? '__wsterm_priv ' : '';
        return `if command -v ${manager.probe} >/dev/null 2>&1; then ${prefix}${manager[action]} ${argsExpression}`;
    }).join('; el');
}

function posixFunction(name, action, argsExpression) {
    return `${name}() { ${posixBranches(action, argsExpression)}; `
        + `else echo '${NO_MANAGER_MESSAGE}' >&2; return 1; fi; }`;
}

// Cadena if/else de fish sin envolver en función, para poder anidarla dentro
// de otra (por ejemplo "update" cuando sí recibe paquetes).
function fishBranches(action, argsExpression) {
    const branches = UNIX_MANAGERS.map((manager) => {
        const prefix = needsPrivileges(manager, action) ? '__wsterm_priv ' : '';
        // fish no encadena con "&&": su equivalente exacto es "; and".
        const command = manager[action].replace(/ && __wsterm_priv /g, '; and __wsterm_priv ').replace(/ && /g, '; and ');
        return `if command -v ${manager.probe} >/dev/null 2>&1; ${prefix}${command} ${argsExpression}`;
    }).join('; else ');
    return `${branches}; else; echo '${NO_MANAGER_MESSAGE}' >&2; return 1; end`;
}

function fishFunction(name, action, argsExpression) {
    return `function ${name}; ${fishBranches(action, argsExpression)}; end`;
}

// En Unix "install" es además un binario de coreutils (install -m 755 ...).
// Si el primer argumento es una opción se delega en el programa real: nadie
// pierde una herramienta del sistema por ganar un alias.
function posixInstallGuard() {
    return 'case "${1:-}" in -*) command install "$@"; return $?;; esac; ';
}

function unixLines() {
    return [
        POSIX_PRIV,
        `install() { ${posixInstallGuard()}${posixBranches('install', '"$@"')}; else echo '${NO_MANAGER_MESSAGE}' >&2; return 1; fi; }`,
        posixFunction('uninstall', 'uninstall', '"$@"'),
        'remove() { uninstall "$@"; }',
        posixFunction('upgrade', 'upgradeAll', ''),
        // Sin argumentos, "update" actualiza todo el sistema; con ellos, solo
        // los paquetes indicados.
        `update() { if [ "$#" -eq 0 ]; then upgrade; else ${posixBranches('update', '"$@"')}; else echo '${NO_MANAGER_MESSAGE}' >&2; return 1; fi; fi; }`,
        posixFunction('search', 'search', '"$@"')
    ];
}

function fishLines() {
    return [
        FISH_PRIV,
        "function install; if string match -q -- '-*' \"$argv[1]\"; command install $argv; return $status; end; "
            + fishBranches('install', '$argv') + '; end',
        fishFunction('uninstall', 'uninstall', '$argv'),
        'function remove; uninstall $argv; end',
        fishFunction('upgrade', 'upgradeAll', ''),
        'function update; if test (count $argv) -eq 0; upgrade; else; '
            + fishBranches('update', '$argv') + '; end; end',
        fishFunction('search', 'search', '$argv')
    ];
}

function windowsLines(kind, managerId) {
    const manager = WINDOWS_MANAGERS[managerId] || null;
    const message = NO_WINDOWS_MANAGER_MESSAGE;

    if (kind === 'cmd') {
        if (!manager) {
            return PACKAGE_ALIAS_NAMES.map((name) => `doskey ${name}=echo ${message}`);
        }
        return [
            `doskey install=${manager.install} $*`,
            `doskey update=${manager.update} $*`,
            `doskey upgrade=${manager.upgradeAll} $*`,
            `doskey uninstall=${manager.uninstall} $*`,
            `doskey remove=${manager.uninstall} $*`,
            `doskey search=${manager.search} $*`
        ];
    }

    if (!manager) {
        return PACKAGE_ALIAS_NAMES
            .map((name) => `function ${name} { Write-Host '${message}' -ForegroundColor Yellow }`);
    }
    return [
        `function install { ${manager.install} @args }`,
        // Sin argumentos "update" equivale a actualizar todo, igual que en Unix.
        `function update { if ($args.Count -eq 0) { ${manager.upgradeAll} } else { ${manager.update} @args } }`,
        `function upgrade { ${manager.upgradeAll} @args }`,
        `function uninstall { ${manager.uninstall} @args }`,
        'function remove { uninstall @args }',
        `function search { ${manager.search} @args }`
    ];
}

// PowerShell fuera de Windows (pwsh en Linux/macOS): el gestor se resuelve en
// la propia sesión con Get-Command, sin depender de la detección del host.
function powershellUnixLines() {
    function chain(action, argsExpression) {
        const branches = UNIX_MANAGERS.map((manager) => {
            const command = needsPrivileges(manager, action)
                ? `sudo ${manager[action]}`.replace(/ && __wsterm_priv /g, ' ; sudo ')
                : manager[action];
            return `if (Get-Command ${manager.probe} -ErrorAction SilentlyContinue) { ${command} ${argsExpression} }`;
        }).join(' else');
        return `${branches} else { Write-Host '${NO_MANAGER_MESSAGE}' -ForegroundColor Yellow }`;
    }
    return [
        `function install { ${chain('install', '@args')} }`,
        `function update { if ($args.Count -eq 0) { upgrade } else { ${chain('update', '@args')} } }`,
        `function upgrade { ${chain('upgradeAll', '')} }`,
        `function uninstall { ${chain('uninstall', '@args')} }`,
        'function remove { uninstall @args }',
        `function search { ${chain('search', '@args')} }`
    ];
}

// Nombres que estos alias ocupan: aliasProfiles los reserva para que ningún
// script del usuario los pise sin querer.
const PACKAGE_ALIAS_NAMES = ['install', 'update', 'upgrade', 'uninstall', 'remove', 'search'];

function detectWindowsManager(isInstalled) {
    if (typeof isInstalled !== 'function') return null;
    return WINDOWS_MANAGER_ORDER.find((candidate) => isInstalled(candidate)) || null;
}

// options: { platform, windowsManager, transport }
function buildPackageAliasLines(kind, options) {
    const opts = options || {};
    const platform = opts.platform || process.platform;
    // Dentro de WSL manda el gestor de la distro, no el de Windows, aunque el
    // proceso principal corra en win32.
    const insideWindows = platform === 'win32' && opts.transport !== 'wsl';

    if (kind === 'cmd') return windowsLines('cmd', opts.windowsManager);
    if (kind === 'powershell') {
        return insideWindows
            ? windowsLines('powershell', opts.windowsManager)
            : powershellUnixLines();
    }
    if (kind === 'fish') return fishLines();
    if (['bash', 'zsh', 'sh', 'ksh', 'wsl'].includes(kind)) return unixLines();
    return [];
}

module.exports = {
    buildPackageAliasLines,
    detectWindowsManager,
    PACKAGE_ALIAS_NAMES,
    WINDOWS_MANAGERS,
    UNIX_MANAGERS
};
