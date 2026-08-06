// main/installActions.js
// Catálogo de acciones de "entorno y dependencias adicionales" según el
// sistema operativo. Cada acción simplemente escribe el comando indicado en
// la terminal activa: el usuario ve exactamente qué se va a ejecutar y
// mantiene el control total (puede cancelar con Ctrl+C, como cualquier otro
// comando). No se ejecuta nada oculto ni con permisos elevados por detrás.
//
// Dos campos controlan cuándo se ve cada acción en el panel (ver
// filterAvailableActions en main.js):
//   checkCmd    -> se OCULTA si ese comando ya está instalado ("Instalar X"
//                  no tiene sentido cuando X ya está).
//   requiresCmd -> se MUESTRA solo si ese comando está instalado (acciones
//                  de actualizar/verificar/usar una herramienta que aún no
//                  existe en el sistema).
// Así, para cada herramienta, solo se ofrece "Instalar" antes y
// "Actualizar"/"Ver" después, nunca las dos cosas a la vez.

// Orden en el que se pintan los apartados del panel. Es fijo a propósito:
// depende solo de qué apartados existen en este sistema, no del orden en que
// se hayan ido añadiendo acciones al catálogo. Lo que no esté aquí va al
// final, alfabéticamente.
// Solo para el traductor de reserva de más abajo; i18n.js no depende de este
// módulo, así que la dependencia va en un único sentido.
const { CATALOGS, FALLBACK_LANGUAGE } = require('./i18n');

const GROUP_ORDER = [
    'Actualizaciones',
    'Shells',
    'Sistema y herramientas',
    'Lenguajes',
    'Visores de archivos',
    'Compatibilidad Windows',
    'WSL',
    'Docker',
    'Android · ADB',
    'Red y acceso remoto'
];

// Nombres de los subgrupos (el plegable de segundo nivel: todas las acciones
// de UNA herramienta juntas). Se centralizan porque varias plataformas
// tienen que coincidir exactamente para no partir la misma herramienta en dos.
const ADB_SUBGROUP = 'ADB · Android Platform Tools';
const SSH_SUBGROUP = 'SSH (OpenSSH)';
const ADB_GROUP = 'Android · ADB';
const SSH_GROUP = 'Red y acceso remoto';
const DOCKER_GROUP = 'Docker';

// Disponible en los tres SO con la misma sintaxis: solo lee, no instala
// nada, así que sirve para verificar el estado de Docker sin riesgo.
const DOCKER_CHECK_ACTION = {
    id: 'docker-check',
    label: 'Verificar Docker (version + daemon)',
    shortLabel: 'Verificar versión y daemon',
    command: 'docker --version && docker info',
    verb: 'Verificar',
    requiresCmd: 'docker',
    group: DOCKER_GROUP
};

// Ver qué imágenes/contenedores hay: son justo los que la app convierte en
// entornos del selector, así que sirve para entender qué va a aparecer ahí.
const DOCKER_LIST_ACTION = {
    id: 'docker-list',
    label: 'Ver imágenes y contenedores Docker',
    shortLabel: 'Ver imágenes y contenedores',
    command: 'docker image ls && docker ps -a',
    verb: 'Ver',
    requiresCmd: 'docker',
    group: DOCKER_GROUP
};

// Instalación de ADB en Windows desde la descarga oficial de Google.
//
// Por qué no winget: el paquete Google.PlatformTools apunta a una URL que
// Google reescribe con cada release SIN cambiar el número de versión, así
// que el hash del manifiesto queda obsoleto y winget aborta con "el hash del
// instalador no coincide" — y encima se niega a permitir saltárselo cuando
// se ejecuta como administrador. La descarga directa desde el dominio
// oficial de Google evita el problema y siempre trae la última versión.
//
// IMPORTANTE: este script se escribe tal cual (shell: 'powershell', ver
// wrapPowerShellCommand en main.js), así que no puede contener comillas
// DOBLES: se envuelve entre comillas dobles al invocarlo desde cmd.exe.
const ADB_INSTALL_PS = [
    // adb.exe bloquea su propio archivo mientras el servidor está vivo.
    "Get-Process adb -ErrorAction SilentlyContinue | Stop-Process -Force",
    "$dest = Join-Path $env:LOCALAPPDATA 'Android'",
    "$zip = Join-Path $env:TEMP 'platform-tools-latest.zip'",
    "New-Item -ItemType Directory -Force -Path $dest | Out-Null",
    "Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile $zip",
    "Expand-Archive -Path $zip -DestinationPath $dest -Force",
    "Remove-Item $zip -Force",
    "$tools = Join-Path $dest 'platform-tools'",
    // PATH persistente del USUARIO (no el de máquina): no requiere permisos
    // de administrador y basta para que adb funcione desde cualquier ruta.
    // Si el valor no existe todavía, GetEnvironmentVariable devuelve null y
    // concatenar dejaría un ';' inicial: por eso el operador de coalescencia
    // manual con un if.
    "$userPath = [Environment]::GetEnvironmentVariable('Path','User')",
    "if (-not $userPath) { $userPath = '' }",
    "if (($userPath -split ';') -notcontains $tools) { $nuevo = if ($userPath) { $userPath.TrimEnd(';') + ';' + $tools } else { $tools }; [Environment]::SetEnvironmentVariable('Path', $nuevo, 'User') }",
    // ...y también en la sesión actual, para que quien lance esto desde una
    // pestaña de PowerShell pueda usar adb ahí mismo, sin abrir otra.
    "if (($env:Path -split ';') -notcontains $tools) { $env:Path = $env:Path.TrimEnd(';') + ';' + $tools }",
    "& (Join-Path $tools 'adb.exe') version",
    "Write-Host ('ADB instalado en ' + $tools + ' y anadido al PATH - abre una pestana nueva para usar adb desde cualquier ruta') -ForegroundColor Green"
].join('; ');

function safeId(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---- Catálogo de herramientas con ciclo de vida completo ----
// Cada entrada genera cuatro acciones: instalar (solo si falta), y actualizar,
// desinstalar y ver versión (solo si ya está). El id de la acción de instalar
// se conserva tal cual porque commandNotFound.js apunta a él para sugerir la
// instalación cuando la shell responde "comando no encontrado".
//
// `cmd` es el ejecutable que decide si la herramienta está presente; `verify`
// es el comando que muestra la versión instalada.
const WINDOWS_TOOLS = [
    { key: 'pwsh', label: 'PowerShell 7', cmd: 'pwsh', installId: 'winget-pwsh', pkg: 'Microsoft.PowerShell', verify: 'pwsh -v', group: 'Shells' },
    { key: 'git', labelKey: 'tool.gitBash', label: 'Git + Git Bash', cmd: 'git', installId: 'winget-git', pkg: 'Git.Git', verify: 'git --version', group: 'Sistema y herramientas' },
    { key: 'wt', label: 'Windows Terminal', cmd: 'wt', installId: 'winget-wt', pkg: 'Microsoft.WindowsTerminal', verify: null, group: 'Sistema y herramientas' },
    { key: 'node', labelKey: 'tool.nodeLts', label: 'Node.js LTS', cmd: 'node', installId: 'winget-node', pkg: 'OpenJS.NodeJS.LTS', verify: 'node -v; npm -v', group: 'Lenguajes' },
    { key: 'python', label: 'Python', cmd: 'python', installId: 'winget-python', pkg: 'Python.Python.3.12', verify: 'python --version', group: 'Lenguajes' },
    { key: 'ruby', label: 'Ruby', cmd: 'ruby', installId: 'winget-ruby', pkg: 'RubyInstallerTeam.Ruby.3.3', verify: 'ruby -v', group: 'Lenguajes' },
    { key: 'java', labelKey: 'tool.java', label: 'Java (JDK)', cmd: 'java', installId: 'winget-java', pkg: 'EclipseAdoptium.Temurin.21.JDK', verify: 'java -version', group: 'Lenguajes', hint: 'Instala un JDK completo: incluye jshell, que es el REPL que aparece en el selector de entorno.' },
    { key: 'php', label: 'PHP', cmd: 'php', installId: 'winget-php', pkg: 'PHP.PHP.8.3', verify: 'php -v', group: 'Lenguajes' },
    { key: 'go', label: 'Go', cmd: 'go', installId: 'winget-go', pkg: 'GoLang.Go', verify: 'go version', group: 'Lenguajes' },
    { key: 'rust', label: 'Rust (rustup)', cmd: 'rustc', installId: 'winget-rust', pkg: 'Rustlang.Rustup', verify: 'rustc --version; cargo --version', group: 'Lenguajes' },
    { key: 'perl', label: 'Perl', cmd: 'perl', installId: 'winget-perl', pkg: 'StrawberryPerl.StrawberryPerl', verify: 'perl -v', group: 'Lenguajes' },
    { key: 'lua', label: 'Lua', cmd: 'lua', installId: 'winget-lua', pkg: 'DEVCOM.Lua', verify: 'lua -v', group: 'Lenguajes' },
    { key: 'deno', label: 'Deno', cmd: 'deno', installId: 'winget-deno', pkg: 'DenoLand.Deno', verify: 'deno --version', group: 'Lenguajes' },
    { key: 'docker', label: 'Docker Desktop', cmd: 'docker', installId: 'winget-docker', pkg: 'Docker.DockerDesktop', verify: 'docker --version', group: 'Docker', hint: 'Requiere WSL2 y normalmente pide reiniciar Windows antes de poder usarse.' }
];

// Visores propuestos cuando el sistema no sabe abrir un archivo (ver
// fileViewers.js). Aparecen también en el panel para poder instalarlos sin
// esperar a que algo falle. Los ids los referencia fileViewers.js.
const VIEWER_TOOLS = {
    win32: [
        // Aplicaciones de escritorio: no dejan ejecutable en el PATH, así que
        // no se puede detectar si están instaladas (noDetect).
        { id: 'viewer-image', labelKey: 'tool.viewerImage', label: 'ImageGlass (imágenes, SVG)', pkg: 'DuongDieuPhap.ImageGlass', noDetect: true },
        { id: 'viewer-media', labelKey: 'tool.viewerMediaWin', label: 'VLC (audio y vídeo)', pkg: 'VideoLAN.VLC', noDetect: true },
        { id: 'viewer-document', labelKey: 'tool.viewerDocumentWin', label: 'SumatraPDF (PDF y libros)', pkg: 'SumatraPDF.SumatraPDF', noDetect: true },
        { id: 'viewer-archive', labelKey: 'tool.viewerArchiveWin', label: '7-Zip (comprimidos)', pkg: '7zip.7zip', noDetect: true },
        // VS Code sí añade `code` al PATH durante su instalación.
        { id: 'viewer-code', labelKey: 'tool.viewerCode', label: 'Visual Studio Code (código y texto)', cmd: 'code', pkg: 'Microsoft.VisualStudioCode', verify: 'code --version' }
    ],
    linux: [
        { id: 'viewer-image', labelKey: 'tool.viewerImageLinux', label: 'Eye of GNOME (imágenes)', cmd: 'eog', pkgs: { default: 'eog' }, verify: null },
        { id: 'viewer-media', labelKey: 'tool.viewerMedia', label: 'VLC (audio y vídeo)', cmd: 'vlc', pkgs: { default: 'vlc' }, verify: 'vlc --version' },
        { id: 'viewer-document', labelKey: 'tool.viewerDocument', label: 'Evince (PDF)', cmd: 'evince', pkgs: { default: 'evince' }, verify: null },
        { id: 'viewer-archive', labelKey: 'tool.viewerArchive', label: 'p7zip (comprimidos)', cmd: '7z', pkgs: { default: 'p7zip', apt: 'p7zip-full' }, verify: '7z i' },
        { id: 'viewer-code', labelKey: 'tool.viewerCode', label: 'Visual Studio Code (código y texto)', cmd: 'code', pkgs: { default: 'code' }, verify: 'code --version', hint: 'Muchas distribuciones necesitan el repositorio de Microsoft o el paquete Snap (sudo snap install code --classic).' }
    ],
    darwin: [
        { id: 'viewer-media', labelKey: 'tool.viewerMedia', label: 'VLC (audio y vídeo)', cmd: 'vlc', pkg: '--cask vlc', verify: null },
        { id: 'viewer-archive', labelKey: 'tool.viewerArchive', label: 'p7zip (comprimidos)', cmd: '7z', pkg: 'p7zip', verify: '7z i' },
        { id: 'viewer-code', labelKey: 'tool.viewerCode', label: 'Visual Studio Code (código y texto)', cmd: 'code', pkg: '--cask visual-studio-code', verify: 'code --version' }
    ]
};

const VIEWER_GROUP = 'Visores de archivos';

// Gestores de archivos gráficos. Solo hacen falta en Linux: Windows y macOS
// traen el suyo y nunca se puede quedar el sistema sin ninguno. Se ofrecen
// tres, uno por escritorio mayoritario, y no los seis que la app reconoce:
// para abrir una carpeta basta con tener uno, y seis instaladores en el panel
// convierten una elección simple en una lista que hay que leer entera.
// Los ids coinciden con los `actionId` de FILE_MANAGERS en fileViewers.js.
const FILE_MANAGER_TOOLS = [
    { id: 'viewer-files-nautilus', labelKey: 'tool.nautilus', label: 'Archivos / Nautilus (GNOME)', cmd: 'nautilus', pkgs: { default: 'nautilus' }, verify: 'nautilus --version' },
    { id: 'viewer-files-dolphin', label: 'Dolphin (KDE)', cmd: 'dolphin', pkgs: { default: 'dolphin' }, verify: 'dolphin --version' },
    { id: 'viewer-files-thunar', labelKey: 'tool.thunar', label: 'Thunar (Xfce, ligero)', cmd: 'thunar', pkgs: { default: 'thunar' }, verify: 'thunar --version' }
];

// Traductor de reserva para cuando este catálogo se pide sin uno (las pruebas,
// y cualquier llamada que no pase por el proceso principal). Usa el idioma de
// referencia del propio catálogo de traducciones, en vez de una segunda copia
// de las mismas cadenas que acabaría desincronizándose. Misma firma que el
// traductor de i18n.js, respaldo incluido, así los dos son intercambiables.
function defaultActionTexts(key, params, fallback) {
    const texto = CATALOGS[FALLBACK_LANGUAGE][key] || fallback || key;
    if (!params) return texto;
    return texto.replace(/\{(\w+)\}/g, (match, name) =>
        (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
}

// `noDetect` es para aplicaciones de escritorio que no dejan ningún ejecutable
// en el PATH (ImageGlass, VLC, SumatraPDF...). Ahí no se puede saber si están
// instaladas mirando el sistema, así que se ofrecen siempre las cuatro
// acciones y la de "versión" pregunta directamente a winget, en vez de fingir
// una detección que daría siempre "no instalado".
function windowsToolActions(tool, t) {
    const pkg = tool.pkg;
    const installId = tool.installId || tool.id;
    const detect = tool.noDetect ? null : tool.cmd;
    // Nombres como "VLC (audio y vídeo)" llevan una coletilla descriptiva que
    // sí se traduce; el nombre propio de dentro, no.
    tool = tool.labelKey ? { ...tool, label: t(tool.labelKey, null, tool.label) } : tool;
    // `subgroup` agrupa en el panel las cuatro acciones de una misma
    // herramienta; `shortLabel` es cómo se lee dentro de ese subgrupo, donde
    // repetir el nombre en cada línea sobra.
    const subgroup = tool.label;
    const actions = [{
        id: installId,
        label: t('action.install', { tool: tool.label, source: 'winget' }),
        shortLabel: t('action.installShort', { source: 'winget' }),
        subgroup,
        command: `winget install --id ${pkg} -e`,
        shell: 'powershell',
        group: tool.group,
        checkCmd: detect,
        hint: tool.hint
    }, {
        id: `${installId}-update`,
        label: t('action.update', { tool: tool.label }),
        shortLabel: t('action.updateShort'),
        subgroup,
        command: `winget upgrade --id ${pkg} -e`,
        shell: 'powershell',
        group: tool.group,
        verb: 'Actualizar',
        requiresCmd: detect
    }, {
        id: `${installId}-uninstall`,
        label: t('action.uninstall', { tool: tool.label }),
        shortLabel: t('action.uninstallShort'),
        subgroup,
        command: `winget uninstall --id ${pkg} -e`,
        shell: 'powershell',
        group: tool.group,
        verb: 'Desinstalar',
        requiresCmd: detect,
        hint: 'Elimina la herramienta del sistema. El comando se escribe en la terminal: revísalo antes de confirmarlo.'
    }];
    const verify = tool.verify || (tool.noDetect ? `winget list --id ${pkg} -e` : null);
    if (verify) {
        actions.push({
            id: `${installId}-version`,
            label: tool.noDetect
                ? t('action.check', { tool: tool.label })
                : t('action.version', { tool: tool.label }),
            shortLabel: tool.noDetect ? t('action.checkShort') : t('action.versionShort'),
            subgroup,
            command: verify,
            shell: 'powershell',
            group: tool.group,
            verb: tool.noDetect ? 'Comprobar' : 'Versión',
            requiresCmd: detect
        });
    }
    return actions;
}

function psSingle(value) {
    return "'" + String(value || '').replace(/'/g, "''") + "'";
}

function wslPackageInstall(distroName, packageManager, packages) {
    const prefix = `wsl.exe -d ${psSingle(distroName)} --`;
    const commands = {
        apt: `${prefix} sudo apt update; if ($LASTEXITCODE -eq 0) { ${prefix} sudo apt install -y ${packages} }`,
        dnf: `${prefix} sudo dnf install -y ${packages}`,
        pacman: `${prefix} sudo pacman -S --noconfirm ${packages}`,
        zypper: `${prefix} sudo zypper install -y ${packages}`
    };
    return commands[packageManager] || null;
}

function wslPackageUpdate(distroName, packageManager) {
    const prefix = `wsl.exe -d ${psSingle(distroName)} --`;
    const commands = {
        apt: `${prefix} sudo apt update; if ($LASTEXITCODE -eq 0) { ${prefix} sudo apt upgrade -y }`,
        dnf: `${prefix} sudo dnf upgrade -y`,
        pacman: `${prefix} sudo pacman -Syu --noconfirm`,
        zypper: `${prefix} sudo zypper update -y`
    };
    return commands[packageManager] || null;
}

// Todo WSL vive bajo un único apartado "WSL"; dentro, cada bloque (la
// plataforma, el catálogo de distribuciones y cada distro instalada) es un
// subgrupo plegable. Antes cada bloque era un apartado de primer nivel y en
// un Windows con dos o tres distros el panel se convertía en una lista
// interminable de cabeceras "WSL · ...".
const WSL_GROUP = 'WSL';

function wslActions(wsl) {
    const actions = [];
    if (!wsl || !wsl.available) {
        actions.push({
            id: 'wsl-install-base',
            label: 'Activar WSL',
            shortLabel: 'Activar la plataforma WSL',
            command: 'wsl.exe --install --no-distribution',
            shell: 'powershell',
            group: WSL_GROUP,
            subgroup: 'WSL (plataforma)',
            hint: 'Instala únicamente la plataforma WSL. Después podrás elegir la distribución desde este panel; puede pedir reinicio.'
        });
        return actions;
    }

    actions.push({
        id: 'wsl-list',
        // wsl.exe escribe en UTF-16LE por defecto y la consola lo interpreta
        // con su página de códigos: el listado llegaba vacío o ilegible.
        // WSL_UTF8=1 (WSL 0.64+) hace que emita UTF-8 normal.
        label: 'Ver distribuciones instaladas',
        shortLabel: 'Ver distribuciones instaladas',
        command: '$env:WSL_UTF8=1; wsl.exe --list --verbose',
        shell: 'powershell',
        group: WSL_GROUP,
        subgroup: 'WSL (plataforma)',
        verb: 'Ver',
        installed: true
    }, {
        id: 'wsl-update',
        label: 'Actualizar el núcleo de WSL',
        shortLabel: 'Actualizar el núcleo de WSL',
        command: 'wsl.exe --update',
        shell: 'powershell',
        group: WSL_GROUP,
        subgroup: 'WSL (plataforma)',
        verb: 'Actualizar',
        installed: true
    });

    const installedNames = new Set((wsl.installed || []).map((d) => d.name.toLowerCase()));
    (wsl.online || []).forEach((distro) => {
        if (installedNames.has(distro.name.toLowerCase())) return;
        actions.push({
            id: 'wsl-distro-' + safeId(distro.name),
            label: `Instalar ${distro.friendlyName || distro.name}`,
            shortLabel: `Instalar ${distro.friendlyName || distro.name}`,
            command: `wsl.exe --install -d ${psSingle(distro.name)}`,
            shell: 'powershell',
            group: WSL_GROUP,
            subgroup: 'Distribuciones disponibles',
            installed: false,
            hint: `Nombre WSL: ${distro.name}. Windows puede pedir reinicio o la creación del usuario Linux.`
        });
    });

    (wsl.installed || []).forEach((distro) => {
        const subgroup = `${distro.name} · ${distro.shell}${distro.probeError ? ' (sin comprobar)' : ''}`;
        const group = WSL_GROUP;
        // Si la distro no respondió no se inventan instalaciones pendientes:
        // podrían estar ya presentes. El selector la conserva y el usuario
        // puede refrescar cuando WSL vuelva a estar disponible.
        if (distro.probeError) return;

        // Lo que se puede instalar DENTRO de la distro. `present` mira el
        // inventario que trajo la sonda: si ya está, no se ofrece.
        const candidates = [
            { key: 'bash', label: 'bash', pkg: 'bash', present: (distro.shells || []).includes('bash'), shellHint: true },
            { key: 'zsh', label: 'zsh', pkg: 'zsh', present: (distro.shells || []).includes('zsh'), shellHint: true },
            { key: 'fish', label: 'fish', pkg: 'fish', present: (distro.shells || []).includes('fish'), shellHint: true },
            { key: 'node', label: 'Node.js + npm', pkg: 'nodejs npm', present: (distro.tools || []).includes('node') },
            { key: 'git', label: 'Git', pkg: 'git', present: (distro.tools || []).includes('git') },
            {
                key: 'python',
                label: 'Python',
                pkg: distro.packageManager === 'pacman' ? 'python' : 'python3',
                present: (distro.tools || []).includes('python3')
            }
        ];

        candidates.forEach((candidate) => {
            if (candidate.present) return;
            const install = wslPackageInstall(distro.name, distro.packageManager, candidate.pkg);
            if (!install) return;
            actions.push({
                id: `wsl-${safeId(distro.name)}-${candidate.key}`,
                label: `Instalar ${candidate.label} en ${distro.name}`,
                shortLabel: `Instalar ${candidate.label}`,
                command: install,
                shell: 'powershell',
                group,
                subgroup,
                installed: false,
                hint: candidate.shellHint
                    ? `Se instala solo dentro de ${distro.name}. Para convertirlo en shell predeterminada usa chsh -s $(command -v ${candidate.key}).`
                    : `Se instala solo dentro de ${distro.name}.`
            });
        });

        const update = wslPackageUpdate(distro.name, distro.packageManager);
        if (update) {
            actions.push({
                id: `wsl-${safeId(distro.name)}-update`,
                label: `Actualizar paquetes de ${distro.name}`,
                shortLabel: 'Actualizar paquetes de la distro',
                command: update,
                shell: 'powershell',
                group,
                subgroup,
                verb: 'Actualizar',
                installed: true
            });
        }
    });

    return actions;
}

// Actualización con git de los repositorios que la app ha clonado en la
// carpeta de proyectos (<carpeta>/<propietario>/<repositorio>). Solo hace
// pull --ff-only: nunca reescribe historia ni descarta cambios locales, y un
// repositorio con trabajo sin guardar simplemente informa y se salta.
function gitPullProjectsAction(projectsFolder) {
    const folder = psSingle(projectsFolder || '');
    return {
        id: 'git-pull-projects',
        label: 'Actualizar repositorios clonados (git pull)',
        command: `if (Test-Path ${folder}) { `
            + `Get-ChildItem -Path ${folder} -Directory -Recurse -Depth 1 `
            + `| Where-Object { Test-Path (Join-Path $_.FullName '.git') } `
            + `| ForEach-Object { Write-Host ('== ' + $_.FullName) -ForegroundColor Cyan; git -C $_.FullName pull --ff-only } `
            + `} else { Write-Host 'Todavia no hay repositorios clonados en la carpeta de proyectos.' -ForegroundColor Yellow }`,
        shell: 'powershell',
        group: 'Actualizaciones',
        verb: 'Actualizar',
        requiresCmd: 'git',
        hint: 'Recorre la carpeta de proyectos y hace pull --ff-only en cada repositorio Git. Los que tengan cambios locales o divergentes se saltan con su aviso.'
    };
}

// Equivalente POSIX del anterior, para macOS y Linux. Igual que el resto de
// acciones de esas plataformas, asume una shell tipo bash/zsh/sh.
function gitPullProjectsPosixAction(projectsFolder) {
    const folder = "'" + String(projectsFolder || '').replace(/'/g, `'\\''`) + "'";
    return {
        id: 'git-pull-projects',
        label: 'Actualizar repositorios clonados (git pull)',
        command: `for repo in ${folder}/*/*/.git; do [ -d "$repo" ] || continue; `
            + 'dir="${repo%/.git}"; echo "== $dir"; git -C "$dir" pull --ff-only; done',
        group: 'Actualizaciones',
        verb: 'Actualizar',
        requiresCmd: 'git',
        hint: 'Recorre la carpeta de proyectos y hace pull --ff-only en cada repositorio Git. Los que tengan cambios locales o divergentes se saltan con su aviso.'
    };
}

// Mete un bloque de acciones sueltas en el mismo apartado y plegable. El
// spread va DESPUÉS para que una acción con grupo propio conserve el suyo.
function inSubgroup(group, subgroup, actions) {
    return actions.map((action) => ({ group, subgroup, ...action }));
}

function windowsActions(wsl, projectsFolder, t) {
    return [
        ...WINDOWS_TOOLS.flatMap((tool) => windowsToolActions(tool, t)),
        ...VIEWER_TOOLS.win32.flatMap((tool) => windowsToolActions({ ...tool, group: VIEWER_GROUP }, t)),
        // Mismo subgrupo que la herramienta 'docker' de WINDOWS_TOOLS: así
        // instalar, actualizar, verificar y arrancar Docker caen todas bajo
        // un único plegable en vez de repartirse por el panel.
        ...inSubgroup(DOCKER_GROUP, 'Docker Desktop', [
            {
                ...DOCKER_CHECK_ACTION,
                command: 'docker --version; if ($LASTEXITCODE -eq 0) { docker info }',
                shell: 'powershell'
            },
            {
                ...DOCKER_LIST_ACTION,
                command: 'docker image ls; if ($LASTEXITCODE -eq 0) { docker ps -a }',
                shell: 'powershell'
            },
            {
                id: 'docker-start-win',
                label: 'Iniciar Docker Desktop',
                shortLabel: 'Iniciar Docker Desktop',
                command: "Start-Process (Join-Path $env:ProgramFiles 'Docker\\Docker\\Docker Desktop.exe')",
                shell: 'powershell',
                hint: 'La app ya intenta arrancarlo sola al abrirse; esto es por si quieres forzarlo.',
                verb: 'Iniciar',
                requiresCmd: 'docker'
            }
        ]),
        ...inSubgroup(ADB_GROUP, ADB_SUBGROUP, [
            {
                id: 'adb-install',
                label: 'Instalar ADB / Android Platform Tools',
                shortLabel: 'Instalar (descarga oficial de Google)',
                command: ADB_INSTALL_PS,
                shell: 'powershell',
                hint: 'Descarga oficial de Google (no usa winget: su paquete de platform-tools suele fallar por hash desactualizado). Instala en %LOCALAPPDATA%\\Android y lo añade al PATH del usuario: abre una pestaña nueva para usar "adb" desde cualquier ruta.',
                checkCmd: 'adb'
            },
            {
                id: 'adb-update',
                label: 'Actualizar ADB a la última versión',
                shortLabel: 'Actualizar a la última versión',
                command: ADB_INSTALL_PS,
                shell: 'powershell',
                hint: 'Vuelve a descargar la última versión oficial y sobrescribe la actual.',
                verb: 'Actualizar',
                requiresCmd: 'adb'
            },
            { id: 'adb-check', label: 'Ver dispositivos ADB conectados', shortLabel: 'Ver dispositivos conectados', command: 'adb devices', verb: 'Ver', requiresCmd: 'adb' },
            { id: 'adb-version', label: 'Ver versión de ADB', shortLabel: 'Ver versión instalada', command: 'adb version', verb: 'Versión', requiresCmd: 'adb' },
            {
                id: 'adb-uninstall',
                label: 'Desinstalar ADB / Android Platform Tools',
                shortLabel: 'Desinstalar del sistema',
                // Solo deshace lo que instaló la acción de esta app: la carpeta en
                // %LOCALAPPDATA%\Android\platform-tools y su entrada en el PATH del
                // usuario. Una instalación de Android Studio no se toca.
                command: [
                    "Get-Process adb -ErrorAction SilentlyContinue | Stop-Process -Force",
                    "$tools = Join-Path $env:LOCALAPPDATA 'Android\\platform-tools'",
                    "if (Test-Path $tools) { Remove-Item -Recurse -Force $tools; Write-Host ('Eliminado ' + $tools) -ForegroundColor Green } else { Write-Host 'No hay una instalacion propia de platform-tools en LOCALAPPDATA.' -ForegroundColor Yellow }",
                    "$userPath = [Environment]::GetEnvironmentVariable('Path','User')",
                    "if ($userPath) { $limpio = ($userPath -split ';' | Where-Object { $_ -and $_ -ne $tools }) -join ';'; [Environment]::SetEnvironmentVariable('Path', $limpio, 'User') }"
                ].join('; '),
                shell: 'powershell',
                verb: 'Desinstalar',
                requiresCmd: 'adb',
                hint: 'Borra la carpeta que instaló esta app y limpia su entrada del PATH de usuario. Si instalaste ADB con Android Studio, elimínalo desde su gestor de SDK.'
            },
            {
                id: 'adb-authorize',
                label: 'Reiniciar ADB y volver a pedir autorización',
                shortLabel: 'Reiniciar y volver a pedir autorización',
                command: 'adb kill-server; if ($LASTEXITCODE -eq 0) { adb devices }',
                shell: 'powershell',
                verb: 'Reiniciar',
                hint: 'Para un dispositivo que aparece como "unauthorized": desbloquea la pantalla del móvil y acepta el diálogo de depuración USB que saldrá al reiniciar el servidor.',
                requiresCmd: 'adb'
            }
        ]),
        ...inSubgroup(SSH_GROUP, SSH_SUBGROUP, [
            {
                id: 'winget-ssh',
                label: 'Instalar cliente SSH (OpenSSH)',
                shortLabel: 'Instalar como capacidad de Windows',
                command: 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0',
                shell: 'powershell',
                hint: 'En Windows 10 (1809+)/11 casi siempre ya viene instalado.',
                checkCmd: 'ssh'
            },
            { id: 'ssh-check', label: 'Ver versión de SSH instalada', shortLabel: 'Ver versión instalada', command: 'ssh -V', verb: 'Versión', requiresCmd: 'ssh' },
            {
                id: 'winget-ssh-uninstall',
                label: 'Desinstalar cliente SSH (OpenSSH)',
                shortLabel: 'Desinstalar del sistema',
                command: 'Remove-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0',
                shell: 'powershell',
                verb: 'Desinstalar',
                requiresCmd: 'ssh',
                hint: 'OpenSSH es una capacidad opcional de Windows; quitarla requiere permisos de administrador.'
            }
        ]),
        {
            id: 'winget-upgrade',
            label: 'Actualizar todo con winget',
            // --include-unknown alcanza también a los programas cuya versión
            // instalada winget no puede leer, que si no quedaban fuera.
            command: 'winget upgrade --all --include-unknown',
            shell: 'powershell',
            verb: 'Actualizar'
        },
        gitPullProjectsAction(projectsFolder),
        ...wslActions(wsl)
    ];
}

function macActions(projectsFolder, t) {
    return [
        gitPullProjectsPosixAction(projectsFolder),
        {
            id: 'brew-install',
            label: 'Instalar Homebrew',
            command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
            hint: 'Descarga y ejecuta el instalador oficial de Homebrew.',
            checkCmd: 'brew'
        },
        ...MAC_TOOLS.concat(VIEWER_TOOLS.darwin.map((tool) => ({ ...tool, group: VIEWER_GROUP })))
            .flatMap((tool) => toolLifecycleActions(
                tool,
                tool.pkg,
                { install: 'brew install', updateOne: 'brew upgrade', remove: 'brew uninstall' },
                'brew',
                t
            )),
        ...inSubgroup(DOCKER_GROUP, 'Docker Desktop', [
            {
                id: 'brew-docker',
                label: 'Instalar Docker Desktop (brew)',
                shortLabel: 'Instalar con brew',
                command: 'brew install --cask docker',
                hint: 'Tras instalar hay que abrir Docker.app al menos una vez para arrancar el daemon.',
                checkCmd: 'docker'
            },
            {
                id: 'brew-docker-uninstall',
                label: 'Desinstalar Docker Desktop (brew)',
                shortLabel: 'Desinstalar del sistema',
                command: 'brew uninstall --cask docker',
                verb: 'Desinstalar',
                requiresCmd: 'docker',
                hint: 'Elimina la aplicación. Las imágenes y volúmenes de ~/Library/Containers no se borran.'
            },
            { id: 'brew-docker-version', label: 'Ver versión de Docker', shortLabel: 'Ver versión instalada', command: 'docker --version', verb: 'Versión', requiresCmd: 'docker' },
            DOCKER_CHECK_ACTION,
            DOCKER_LIST_ACTION,
            { id: 'docker-start-mac', label: 'Iniciar Docker Desktop', shortLabel: 'Iniciar Docker Desktop', command: 'open -a Docker', verb: 'Iniciar', requiresCmd: 'docker' }
        ]),
        ...inSubgroup(ADB_GROUP, ADB_SUBGROUP, [
            { id: 'brew-adb', label: 'Instalar ADB / Android Platform Tools (brew)', shortLabel: 'Instalar con brew', command: 'brew install android-platform-tools', checkCmd: 'adb' },
            { id: 'brew-adb-update', label: 'Actualizar ADB a la última versión (brew)', shortLabel: 'Actualizar a la última versión', command: 'brew upgrade android-platform-tools', verb: 'Actualizar', requiresCmd: 'adb' },
            { id: 'brew-adb-uninstall', label: 'Desinstalar ADB (brew)', shortLabel: 'Desinstalar del sistema', command: 'brew uninstall android-platform-tools', verb: 'Desinstalar', requiresCmd: 'adb' },
            { id: 'adb-check', label: 'Ver dispositivos ADB conectados', shortLabel: 'Ver dispositivos conectados', command: 'adb devices', verb: 'Ver', requiresCmd: 'adb' },
            { id: 'adb-version', label: 'Ver versión de ADB', shortLabel: 'Ver versión instalada', command: 'adb version', verb: 'Versión', requiresCmd: 'adb' }
        ]),
        ...inSubgroup(SSH_GROUP, SSH_SUBGROUP, [
            { id: 'brew-ssh', label: 'Instalar cliente SSH (brew)', shortLabel: 'Instalar con brew', command: 'brew install openssh', hint: 'macOS trae SSH preinstalado casi siempre.', checkCmd: 'ssh' },
            { id: 'brew-ssh-uninstall', label: 'Desinstalar cliente SSH (brew)', shortLabel: 'Desinstalar del sistema', command: 'brew uninstall openssh', verb: 'Desinstalar', requiresCmd: 'ssh', hint: 'Solo quita el OpenSSH instalado con brew; el que trae macOS de serie sigue ahí.' },
            { id: 'ssh-check', label: 'Ver versión de SSH instalada', shortLabel: 'Ver versión instalada', command: 'ssh -V', verb: 'Versión', requiresCmd: 'ssh' }
        ]),
        posixShAction(),
        { id: 'brew-update', label: 'Actualizar paquetes (brew)', command: 'brew update && brew upgrade', verb: 'Actualizar' }
    ];
}

// `sh` no es un paquete: es un enlace al intérprete POSIX que haya elegido la
// distribución (bash en Arch y macOS, dash en Debian/Ubuntu). Por eso aquí no
// hay instalar/actualizar/desinstalar que ofrecer sin mentir — se actualiza y
// se quita con el paquete que lo proporciona — y lo útil es justo poder ver
// cuál es ese paquete. El comando lo resuelve en el momento.
function posixShAction() {
    return {
        id: 'sh-version',
        label: 'Ver qué shell proporciona sh',
        shortLabel: 'Ver versión y de dónde sale',
        subgroup: 'sh',
        group: 'Shells',
        verb: 'Versión',
        requiresCmd: 'sh',
        command: 'command -v sh; readlink -f "$(command -v sh)"; sh --version 2>/dev/null || echo "(sh POSIX, sin --version)"',
        hint: 'sh es un enlace al intérprete POSIX del sistema (bash o dash según la distribución). Se actualiza y se desinstala junto al paquete que lo proporciona, no por separado.'
    };
}

// `removeCore` es el desinstalar SIN respuesta automática, para paquetes de
// los que cuelga medio sistema (bash). El comando se escribe en la terminal
// igual que los demás, pero ahí el gestor va a preguntar y a listar lo que se
// llevaría por delante en vez de darlo por aceptado.
const LINUX_PKG_COMMANDS = {
    apt: {
        install: 'sudo apt install -y',
        update: 'sudo apt update && sudo apt upgrade -y',
        updateOne: 'sudo apt install -y --only-upgrade',
        remove: 'sudo apt remove -y',
        removeCore: 'sudo apt remove'
    },
    dnf: {
        install: 'sudo dnf install -y',
        update: 'sudo dnf upgrade -y',
        updateOne: 'sudo dnf upgrade -y',
        remove: 'sudo dnf remove -y',
        removeCore: 'sudo dnf remove'
    },
    pacman: {
        install: 'sudo pacman -S --noconfirm',
        update: 'sudo pacman -Syu --noconfirm',
        updateOne: 'sudo pacman -S --noconfirm',
        remove: 'sudo pacman -Rs --noconfirm',
        removeCore: 'sudo pacman -Rs'
    },
    zypper: {
        install: 'sudo zypper install -y',
        update: 'sudo zypper update -y',
        updateOne: 'sudo zypper update -y',
        remove: 'sudo zypper remove -y',
        removeCore: 'sudo zypper remove'
    }
};

// Herramientas y lenguajes con ciclo de vida completo en Linux. `pkgs` indica
// el nombre del paquete por gestor, con `default` como respaldo.
const LINUX_TOOLS = [
    // bash está siempre instalado, pero eso no quita que se quiera ver su
    // versión o actualizarlo: sin esta entrada el apartado Shells solo
    // ofrecía acciones de las shells que NO estaban. `core` marca que medio
    // sistema depende de él y su desinstalación no se automatiza.
    { id: 'pkg-bash', label: 'bash', cmd: 'bash', pkgs: { default: 'bash' }, verify: 'bash --version', group: 'Shells', core: true },
    { id: 'pkg-zsh', label: 'zsh', cmd: 'zsh', pkgs: { default: 'zsh' }, verify: 'zsh --version', group: 'Shells' },
    { id: 'pkg-fish', label: 'fish', cmd: 'fish', pkgs: { default: 'fish' }, verify: 'fish --version', group: 'Shells' },
    { id: 'pkg-git', label: 'Git', cmd: 'git', pkgs: { default: 'git' }, verify: 'git --version', group: 'Sistema y herramientas' },
    { id: 'pkg-node', labelKey: 'tool.nodeNpm', label: 'Node.js + npm', cmd: 'node', pkgs: { default: 'nodejs npm' }, verify: 'node -v; npm -v', group: 'Lenguajes' },
    { id: 'pkg-python', label: 'Python', cmd: 'python3', pkgs: { default: 'python3', pacman: 'python' }, verify: 'python3 --version', group: 'Lenguajes' },
    { id: 'pkg-ruby', label: 'Ruby', cmd: 'ruby', pkgs: { default: 'ruby', apt: 'ruby-full' }, verify: 'ruby -v', group: 'Lenguajes' },
    { id: 'pkg-java', labelKey: 'tool.java', label: 'Java (JDK)', cmd: 'java', pkgs: { default: 'java-openjdk-devel', apt: 'default-jdk', dnf: 'java-latest-openjdk-devel', pacman: 'jdk-openjdk' }, verify: 'java -version', group: 'Lenguajes', hint: 'El JDK incluye jshell, el REPL de Java que aparece en el selector de entorno.' },
    { id: 'pkg-php', label: 'PHP', cmd: 'php', pkgs: { default: 'php-cli', pacman: 'php', zypper: 'php8' }, verify: 'php -v', group: 'Lenguajes' },
    { id: 'pkg-go', label: 'Go', cmd: 'go', pkgs: { default: 'golang', pacman: 'go', zypper: 'go' }, verify: 'go version', group: 'Lenguajes' },
    { id: 'pkg-rust', label: 'Rust', cmd: 'rustc', pkgs: { default: 'rust cargo', apt: 'rustc cargo', pacman: 'rust' }, verify: 'rustc --version; cargo --version', group: 'Lenguajes' },
    { id: 'pkg-perl', label: 'Perl', cmd: 'perl', pkgs: { default: 'perl' }, verify: 'perl -v', group: 'Lenguajes' },
    { id: 'pkg-lua', label: 'Lua', cmd: 'lua', pkgs: { default: 'lua', apt: 'lua5.4', zypper: 'lua54' }, verify: 'lua -v', group: 'Lenguajes' }
];

// macOS: mismo ciclo de vida sobre Homebrew. Los identificadores de instalar
// se conservan porque commandNotFound.js los referencia.
const MAC_TOOLS = [
    // macOS trae bash 3.2 de 2007 por licencia; brew instala uno actual.
    { id: 'brew-bash', label: 'bash', cmd: 'bash', pkg: 'bash', verify: 'bash --version', group: 'Shells', core: true },
    { id: 'brew-zsh', label: 'zsh', cmd: 'zsh', pkg: 'zsh', verify: 'zsh --version', group: 'Shells' },
    { id: 'brew-fish', label: 'fish', cmd: 'fish', pkg: 'fish', verify: 'fish --version', group: 'Shells' },
    { id: 'brew-git', label: 'Git', cmd: 'git', pkg: 'git', verify: 'git --version', group: 'Sistema y herramientas' },
    { id: 'brew-node', label: 'Node.js', cmd: 'node', pkg: 'node', verify: 'node -v; npm -v', group: 'Lenguajes' },
    { id: 'brew-python', label: 'Python', cmd: 'python3', pkg: 'python', verify: 'python3 --version', group: 'Lenguajes' },
    { id: 'brew-ruby', label: 'Ruby', cmd: 'ruby', pkg: 'ruby', verify: 'ruby -v', group: 'Lenguajes' },
    { id: 'brew-java', labelKey: 'tool.java', label: 'Java (JDK)', cmd: 'java', pkg: 'openjdk', verify: 'java -version', group: 'Lenguajes' },
    { id: 'brew-php', label: 'PHP', cmd: 'php', pkg: 'php', verify: 'php -v', group: 'Lenguajes' },
    { id: 'brew-go', label: 'Go', cmd: 'go', pkg: 'go', verify: 'go version', group: 'Lenguajes' },
    { id: 'brew-rust', label: 'Rust', cmd: 'rustc', pkg: 'rust', verify: 'rustc --version; cargo --version', group: 'Lenguajes' },
    { id: 'brew-perl', label: 'Perl', cmd: 'perl', pkg: 'perl', verify: 'perl -v', group: 'Lenguajes' },
    { id: 'brew-lua', label: 'Lua', cmd: 'lua', pkg: 'lua', verify: 'lua -v', group: 'Lenguajes' },
    { id: 'brew-deno', label: 'Deno', cmd: 'deno', pkg: 'deno', verify: 'deno --version', group: 'Lenguajes' }
];

// Instalar / actualizar / desinstalar / ver versión a partir de una entrada de
// las tablas anteriores. Compartido por Linux y macOS.
function toolLifecycleActions(tool, packageName, commands, suffix, t) {
    tool = tool.labelKey ? { ...tool, label: t(tool.labelKey, null, tool.label) } : tool;
    const subgroup = tool.label;
    const actions = [{
        id: tool.id,
        label: t('action.install', { tool: tool.label, source: suffix }),
        shortLabel: t('action.installShort', { source: suffix }),
        subgroup,
        command: `${commands.install} ${packageName}`,
        group: tool.group,
        checkCmd: tool.cmd,
        hint: tool.hint
    }, {
        id: `${tool.id}-update`,
        label: t('action.update', { tool: tool.label }),
        shortLabel: t('action.updateShort'),
        subgroup,
        command: `${commands.updateOne} ${packageName}`,
        group: tool.group,
        verb: 'Actualizar',
        requiresCmd: tool.cmd
    }, {
        id: `${tool.id}-uninstall`,
        label: t('action.uninstall', { tool: tool.label }),
        shortLabel: t('action.uninstallShort'),
        subgroup,
        command: `${(tool.core && commands.removeCore) || commands.remove} ${packageName}`,
        group: tool.group,
        verb: 'Desinstalar',
        requiresCmd: tool.cmd,
        hint: tool.core
            ? `Muchísimos paquetes y scripts del sistema dependen de ${tool.label}: el gestor va a pedir confirmación y a listar todo lo que se llevaría por delante. Léelo antes de aceptar.`
            : 'Elimina el paquete del sistema. El comando se escribe en la terminal: revísalo antes de confirmarlo.'
    }];
    if (tool.verify) {
        actions.push({
            id: `${tool.id}-version`,
            label: t('action.version', { tool: tool.label }),
            shortLabel: t('action.versionShort'),
            subgroup,
            command: tool.verify,
            group: tool.group,
            verb: 'Versión',
            requiresCmd: tool.cmd
        });
    }
    return actions;
}

// Nombres de paquete que cambian de una distro a otra. Los lenguajes y las
// shells llevan los suyos en LINUX_TOOLS; aquí quedan solo los de las
// herramientas que no pasan por toolLifecycleActions.
const LINUX_DOCKER_PKG = { apt: 'docker.io', dnf: 'docker', pacman: 'docker', zypper: 'docker' };
const LINUX_ADB_PKG = { apt: 'android-tools-adb', dnf: 'android-tools', pacman: 'android-tools', zypper: 'android-tools' };
const LINUX_SSH_PKG = { apt: 'openssh-client', dnf: 'openssh-clients', pacman: 'openssh', zypper: 'openssh-clients' };

// PowerShell NO está en los repositorios oficiales de ninguna distribución
// grande: Microsoft lo publica por su cuenta (repo propio, Snap o tarball), y
// en Arch vive en el AUR. Escribir `pacman -S powershell` o `apt install
// powershell` en la terminal solo produce "no se ha encontrado el paquete",
// que es exactamente lo que veía el usuario. Así que las acciones se generan
// a partir de lo que ESTE sistema puede usar de verdad, y si no hay ninguna
// vía disponible se ofrece primero el requisito (snapd) en vez de un comando
// condenado a fallar.
//
// `aurHelper` es 'paru' o 'yay' si alguno está instalado. Se invocan SIN sudo
// a propósito: piden ellos la contraseña cuando toca y makepkg se niega a
// ejecutarse como root.
function powerShellActions(pm, hasSnap, aurHelper, t) {
    const aur = pm === 'pacman' && aurHelper ? aurHelper : null;
    const installers = [];

    if (aur) {
        installers.push({
            id: 'pkg-pwsh-aur',
            label: `Instalar PowerShell (AUR · ${aur})`,
            shortLabel: `Instalar desde el AUR con ${aur}`,
            command: `${aur} -S --noconfirm powershell-bin`,
            checkCmd: 'pwsh',
            hint: 'powershell-bin son los binarios oficiales de Microsoft empaquetados para Arch. '
                + 'El asistente del AUR no se ejecuta como root: pedirá la contraseña cuando la necesite.'
        });
    }
    if (hasSnap) {
        installers.push({
            id: 'pkg-pwsh-snap',
            label: 'Instalar PowerShell (Snap oficial)',
            shortLabel: 'Instalar desde Snap',
            command: 'sudo snap install powershell --classic',
            checkCmd: 'pwsh',
            hint: 'Instala el paquete estable de PowerShell publicado en Snap. PowerShell aparecerá como entorno al refrescar.'
        });
    }
    // Ninguna vía directa disponible. En vez de escribir un comando que se sabe
    // que va a fallar, se ofrece el requisito que sí está en los repositorios
    // oficiales de todas las distribuciones.
    if (!installers.length) {
        installers.push({
            id: 'pkg-pwsh-snapd',
            label: t('action.pkg-pwsh.label', { source: pm }, 'Instalar snapd, requisito para PowerShell ({source})'),
            shortLabel: t('action.pkg-pwsh.shortLabel', { source: pm }, 'Instalar snapd con {source}'),
            command: SNAPD_INSTALL[pm] || `${LINUX_PKG_COMMANDS[pm].install} snapd`,
            checkCmd: 'snap',
            hint: 'Microsoft no publica PowerShell en los repositorios de las distribuciones'
                + (pm === 'pacman' ? ' (en Arch vive en el AUR)' : '')
                + ', así que "'
                + `${LINUX_PKG_COMMANDS[pm].install} powershell" solo responde que el paquete no existe. `
                + 'Snap es la vía soportada: instala snapd, refresca este panel y aparecerá "Instalar PowerShell (Snap oficial)".'
        });
        if (pm === 'pacman') {
            installers.push({
                id: 'pkg-paru',
                label: 'Instalar paru, asistente del AUR',
                shortLabel: 'Instalar el asistente del AUR',
                command: 'sudo pacman -S --needed --noconfirm base-devel git'
                    + ' && git clone https://aur.archlinux.org/paru-bin.git /tmp/paru-bin'
                    + ' && cd /tmp/paru-bin && makepkg -si',
                checkCmd: 'paru',
                hint: 'Alternativa a snapd en Arch: paru da acceso al AUR, donde está powershell-bin. Clona el '
                    + 'repositorio del propio asistente y lo compila con makepkg; revisa el comando antes de aceptarlo.'
            });
        }
    }

    // El primero de la lista es la vía recomendada en ESTE sistema y conserva
    // el id estable `pkg-pwsh`: es al que apunta la sugerencia automática de
    // commandNotFound.js cuando la shell responde "pwsh: orden no encontrada".
    installers[0] = { ...installers[0], id: 'pkg-pwsh' };

    // Actualizar y desinstalar solo por una vía que exista aquí. Sin AUR ni
    // Snap no se ofrece ninguna: no hay forma de saber de dónde salió el pwsh
    // instalado, y adivinarlo con el gestor de la distribución reproduciría el
    // mismo "paquete no encontrado".
    const lifecycle = [];
    if (aur) {
        lifecycle.push(
            { id: 'pkg-pwsh-update', label: `Actualizar PowerShell (AUR · ${aur})`, shortLabel: 'Actualizar a la última versión', command: `${aur} -S --noconfirm powershell-bin`, verb: 'Actualizar', requiresCmd: 'pwsh' },
            { id: 'pkg-pwsh-uninstall', label: 'Desinstalar PowerShell', shortLabel: 'Desinstalar del sistema', command: 'sudo pacman -Rs --noconfirm powershell-bin', verb: 'Desinstalar', requiresCmd: 'pwsh' }
        );
    } else if (hasSnap) {
        lifecycle.push(
            { id: 'pkg-pwsh-update', label: 'Actualizar PowerShell (Snap)', shortLabel: 'Actualizar a la última versión', command: 'sudo snap refresh powershell', verb: 'Actualizar', requiresCmd: 'pwsh' },
            { id: 'pkg-pwsh-uninstall', label: 'Desinstalar PowerShell (Snap)', shortLabel: 'Desinstalar del sistema', command: 'sudo snap remove powershell', verb: 'Desinstalar', requiresCmd: 'pwsh' }
        );
    }

    return [
        ...installers,
        ...lifecycle,
        { id: 'pkg-pwsh-version', label: 'Ver versión de PowerShell', shortLabel: 'Ver versión instalada', command: 'pwsh -v', verb: 'Versión', requiresCmd: 'pwsh' }
    ];
}

// snapd no siempre basta con instalarlo: en las distribuciones donde no viene
// activado hay que arrancar su socket para que `snap install` funcione.
const SNAPD_INSTALL = {
    apt: 'sudo apt install -y snapd',
    dnf: 'sudo dnf install -y snapd && sudo systemctl enable --now snapd.socket && sudo ln -sf /var/lib/snapd/snap /snap',
    pacman: 'sudo pacman -S --noconfirm snapd && sudo systemctl enable --now snapd.socket && sudo ln -sf /var/lib/snapd/snap /snap',
    zypper: 'sudo zypper install -y snapd && sudo systemctl enable --now snapd'
};

// Wine en Arch está en el repositorio multilib, que viene desactivado en una
// instalación estándar: sin habilitarlo, pacman responde que el paquete no
// existe igual que con PowerShell.
const WINE_HINTS = {
    pacman: 'Wine aporta cmd/wscript compatibles, pero no sustituye Windows. En Arch está en el repositorio '
        + 'multilib: si pacman dice que no encuentra el paquete, descomenta la sección [multilib] de '
        + '/etc/pacman.conf, ejecuta "sudo pacman -Sy" y vuelve a intentarlo.',
    default: 'Wine aporta cmd/wscript compatibles, pero no sustituye Windows y algunos .cmd/.vbs dependientes '
        + 'del sistema no funcionarán. Al terminar, "cmd.exe · Wine" aparece como entorno en el selector.'
};

function linuxActions(pkgManager, hasSnap, projectsFolder, aurHelper, t) {
    const pm = LINUX_PKG_COMMANDS[pkgManager] ? pkgManager : 'apt';
    const { install, update } = LINUX_PKG_COMMANDS[pm];
    const commands = LINUX_PKG_COMMANDS[pm];
    return [
        gitPullProjectsPosixAction(projectsFolder),
        ...LINUX_TOOLS
            .concat(VIEWER_TOOLS.linux.map((tool) => ({ ...tool, group: VIEWER_GROUP })))
            .concat(FILE_MANAGER_TOOLS.map((tool) => ({ ...tool, group: VIEWER_GROUP })))
            .flatMap((tool) => toolLifecycleActions(
                tool,
                tool.pkgs[pm] || tool.pkgs.default,
                commands,
                pm,
                t
            )),
        posixShAction(),
        // En Linux "Compatibilidad Windows" es lo que en Windows es WSL: la
        // forma de ejecutar lo del otro sistema. PowerShell y Wine son dos
        // herramientas distintas, así que cada una lleva su propio plegable.
        ...inSubgroup('Compatibilidad Windows', 'PowerShell', powerShellActions(pm, hasSnap, aurHelper, t)),
        ...inSubgroup('Compatibilidad Windows', 'Wine · cmd.exe y VBS', [
            {
                id: 'pkg-wine',
                label: t('action.pkg-wine.label', { source: pm }, 'Instalar compatibilidad CMD/VBS con Wine ({source})'),
                shortLabel: t('action.installShort', { source: pm }),
                command: `${install} wine`,
                checkCmd: 'wine',
                hint: WINE_HINTS[pm] || WINE_HINTS.default
            },
            {
                id: 'wine-check',
                label: 'Comprobar CMD compatible de Wine',
                shortLabel: 'Comprobar que el CMD responde',
                command: 'wine cmd /c ver',
                verb: 'Verificar',
                requiresCmd: 'wine'
            },
            { id: 'pkg-wine-update', label: 'Actualizar Wine', shortLabel: 'Actualizar a la última versión', command: `${commands.updateOne} wine`, verb: 'Actualizar', requiresCmd: 'wine' },
            { id: 'pkg-wine-uninstall', label: 'Desinstalar Wine', shortLabel: 'Desinstalar del sistema', command: `${commands.remove} wine`, verb: 'Desinstalar', requiresCmd: 'wine', hint: 'El prefijo con los programas instalados (~/.wine) no se borra.' }
        ]),
        ...inSubgroup(DOCKER_GROUP, 'Docker', [
            {
                id: 'pkg-docker',
                label: t('action.pkg-docker.label', { source: pm }, 'Instalar Docker ({source})'),
                shortLabel: t('action.installShort', { source: pm }),
                command: `${install} ${LINUX_DOCKER_PKG[pm]} && sudo systemctl enable --now docker`,
                checkCmd: 'docker',
                hint: `Para usar docker sin sudo: sudo usermod -aG docker $USER (requiere cerrar sesión y volver a entrar).`
            },
            { id: 'pkg-docker-update', label: 'Actualizar Docker', shortLabel: 'Actualizar a la última versión', command: `${commands.updateOne} ${LINUX_DOCKER_PKG[pm]}`, verb: 'Actualizar', requiresCmd: 'docker' },
            {
                id: 'pkg-docker-uninstall',
                label: 'Desinstalar Docker',
                shortLabel: 'Desinstalar del sistema',
                command: `sudo systemctl disable --now docker; ${commands.remove} ${LINUX_DOCKER_PKG[pm]}`,
                verb: 'Desinstalar',
                requiresCmd: 'docker',
                hint: 'Detiene el servicio y elimina el paquete. Las imágenes y volúmenes en /var/lib/docker no se borran.'
            },
            { id: 'pkg-docker-version', label: 'Ver versión de Docker', shortLabel: 'Ver versión instalada', command: 'docker --version', verb: 'Versión', requiresCmd: 'docker' },
            DOCKER_CHECK_ACTION,
            DOCKER_LIST_ACTION,
            {
                id: 'docker-start-linux',
                label: 'Iniciar servicio Docker',
                shortLabel: 'Iniciar el servicio',
                command: 'sudo systemctl start docker',
                hint: 'En Linux el daemon es un servicio del sistema: requiere sudo, por eso la app no lo arranca sola.',
                verb: 'Iniciar',
                requiresCmd: 'docker'
            }
        ]),
        ...inSubgroup(ADB_GROUP, ADB_SUBGROUP, [
            { id: 'pkg-adb', label: t('action.pkg-adb.label', { source: pm }, 'Instalar ADB / Android Platform Tools ({source})'), shortLabel: t('action.installShort', { source: pm }), command: `${install} ${LINUX_ADB_PKG[pm]}`, checkCmd: 'adb' },
            { id: 'pkg-adb-update', label: t('action.pkg-adb-update.label', { source: pm }, 'Actualizar ADB a la última versión ({source})'), shortLabel: t('action.updateShort'), command: `${commands.updateOne} ${LINUX_ADB_PKG[pm]}`, verb: 'Actualizar', requiresCmd: 'adb' },
            { id: 'pkg-adb-uninstall', label: 'Desinstalar ADB', shortLabel: 'Desinstalar del sistema', command: `${commands.remove} ${LINUX_ADB_PKG[pm]}`, verb: 'Desinstalar', requiresCmd: 'adb' },
            { id: 'adb-check', label: 'Ver dispositivos ADB conectados', shortLabel: 'Ver dispositivos conectados', command: 'adb devices', verb: 'Ver', requiresCmd: 'adb' },
            { id: 'adb-version', label: 'Ver versión de ADB', shortLabel: 'Ver versión instalada', command: 'adb version', verb: 'Versión', requiresCmd: 'adb' }
        ]),
        ...inSubgroup(SSH_GROUP, SSH_SUBGROUP, [
            { id: 'pkg-ssh', label: t('action.pkg-ssh.label', { source: pm }, 'Instalar cliente SSH ({source})'), shortLabel: t('action.installShort', { source: pm }), command: `${install} ${LINUX_SSH_PKG[pm]}`, checkCmd: 'ssh' },
            { id: 'pkg-ssh-update', label: 'Actualizar cliente SSH', shortLabel: 'Actualizar a la última versión', command: `${commands.updateOne} ${LINUX_SSH_PKG[pm]}`, verb: 'Actualizar', requiresCmd: 'ssh' },
            { id: 'pkg-ssh-uninstall', label: 'Desinstalar cliente SSH', shortLabel: 'Desinstalar del sistema', command: `${commands.remove} ${LINUX_SSH_PKG[pm]}`, verb: 'Desinstalar', requiresCmd: 'ssh' },
            { id: 'ssh-check', label: 'Ver versión de SSH instalada', shortLabel: 'Ver versión instalada', command: 'ssh -V', verb: 'Versión', requiresCmd: 'ssh' }
        ]),
        { id: 'pkg-update', label: 'Actualizar paquetes del sistema', command: update, verb: 'Actualizar' }
    ];
}

// Red de seguridad para las acciones sueltas que no declaran apartado. Antes
// comparaba con startsWith y las de id "pkg-docker-*" / "pkg-adb-*" caían en
// "Sistema y herramientas": Docker aparecía a la vez ahí y en su propio
// apartado. Ahora el nombre de la herramienta se busca en cualquier tramo del
// id, no solo al principio.
function defaultGroup(action) {
    if (action.group) return action;
    const parts = String(action.id || '').split('-');
    const has = (name) => parts.includes(name);
    let group = 'Sistema y herramientas';
    if (has('docker')) group = DOCKER_GROUP;
    else if (has('adb')) group = ADB_GROUP;
    else if (has('ssh')) group = SSH_GROUP;
    else if (has('update') || has('upgrade') || has('pull')) group = 'Actualizaciones';
    return { ...action, group };
}

// El panel se pinta en el orden en que llegan las acciones, así que el orden
// de los apartados se decide aquí y no depende de en qué punto del catálogo
// esté escrita cada acción. Dentro de cada apartado se respeta el orden
// original: el renderer es quien coloca lo instalado antes que lo pendiente.
function sortByGroup(actions) {
    const rank = (name) => {
        const index = GROUP_ORDER.indexOf(name);
        return index === -1 ? GROUP_ORDER.length : index;
    };
    return actions
        .map((action, index) => ({ action, index }))
        .sort((a, b) => {
            const byRank = rank(a.action.group) - rank(b.action.group);
            if (byRank) return byRank;
            // Dos apartados fuera del orden fijo: alfabético, para que al
            // menos sea estable y previsible.
            if (a.action.group !== b.action.group) {
                return String(a.action.group).localeCompare(String(b.action.group), 'es');
            }
            return a.index - b.index;
        })
        .map((entry) => entry.action);
}

// `t` traduce las etiquetas que se generan por patrón ("Instalar X (winget)",
// "Actualizar a la última versión"...), que son la mayoría del catálogo. Es
// opcional: sin traductor se usan los textos en español, que es el idioma en
// el que está escrito este archivo, y las pruebas pueden llamarlo sin montar
// nada de i18n.
function getInstallActions({ platform, pkgManager, wsl, hasSnap, aurHelper, projectsFolder, t }) {
    const traducir = typeof t === 'function' ? t : defaultActionTexts;
    const actions = platform === 'win32'
        ? windowsActions(wsl, projectsFolder, traducir)
        : platform === 'darwin'
            ? macActions(projectsFolder, traducir)
            : linuxActions(pkgManager, !!hasSnap, projectsFolder, aurHelper || null, traducir);
    return sortByGroup(actions.map(defaultGroup));
}

module.exports = { getInstallActions, GROUP_ORDER };
