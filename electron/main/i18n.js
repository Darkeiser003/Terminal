// main/i18n.js
// Catálogo de traducciones de la aplicación.
//
// No depende de Electron a propósito: el proceso principal lo usa para las
// etiquetas que genera (panel de dependencias, banner, errores que viajan por
// IPC), el renderer recibe su propio catálogo por preload, y las pruebas
// pueden comprobarlo entero sin arrancar nada.
//
// Reglas del catálogo:
//   - la clave es estable y en inglés; el idioma de referencia es el español,
//     que es en el que se escribió la aplicación;
//   - los parámetros van entre llaves: t('tabs.closed', { code: 1 });
//   - lo que NO se traduce: nombres propios (Docker, PowerShell, Nautilus),
//     rutas, comandos y salida de la terminal. Traducir un comando lo rompe.
//
// Añadir un idioma es añadir una entrada a CATALOGS con las mismas claves:
// las que falten caen al español, así que un idioma incompleto degrada a
// texto entendible en vez de a una clave cruda en pantalla.

const FALLBACK_LANGUAGE = 'es';

// Idiomas que se ofrecen en Ajustes. `auto` no es un catálogo: es "el del
// sistema", que se resuelve al arrancar y cuando cambian las preferencias.
const LANGUAGES = Object.freeze([
    Object.freeze({ id: 'auto', label: 'Automático (sistema)', englishLabel: 'Automatic (system)' }),
    Object.freeze({ id: 'es', label: 'Español', englishLabel: 'Spanish' }),
    Object.freeze({ id: 'en', label: 'English', englishLabel: 'English' })
]);

const CATALOGS = {
    // El español es el idioma de referencia y casi todas sus cadenas viven en
    // el código (index.html, renderer.js, installActions.js), que es de donde
    // las toma el respaldo de translate(). La excepción son las etiquetas que
    // se generan por molde: no existen escritas en ninguna parte, así que su
    // versión española tiene que estar aquí.
    es: {
        'action.install': 'Instalar {tool} ({source})',
        'action.installShort': 'Instalar con {source}',
        'action.update': 'Actualizar {tool}',
        'action.updateShort': 'Actualizar a la última versión',
        'action.uninstall': 'Desinstalar {tool}',
        'action.uninstallShort': 'Desinstalar del sistema',
        'action.version': 'Ver versión de {tool}',
        'action.versionShort': 'Ver versión instalada',
        'action.check': 'Comprobar si {tool} está instalado',
        'action.checkShort': 'Comprobar si está instalado',
        'banner.hardware': 'Hardware',
        'banner.software': 'Software',
        'banner.uptimeAge': 'Uptime / Edad / Fecha',
        'banner.pc': 'PC',
        'banner.cpu': 'CPU',
        'banner.gpu': 'GPU',
        'banner.osAge': 'Edad del SO',
        'banner.datetime': 'Fecha y hora',
        'banner.user': 'Usuario',
        'banner.system': 'Sistema',
        'banner.edition': 'Edición',
        'banner.unknown': 'desconocido',
        'banner.kernel': 'Kernel',
        'banner.environment': 'Entorno',
        'banner.memory': 'Memoria',
        'banner.uptime': 'Uptime',
        'banner.cores': '{count} núcleos'
    },
    en: {
        // ---- Barra superior y pestañas ----
        'toolbar.env': 'Environment',
        'toolbar.envRefresh': 'Detect environments again',
        'toolbar.deps': 'Environment and dependencies',
        'toolbar.projects': 'Projects',
        'toolbar.scripts': 'Scripts',
        'toolbar.settings': 'Settings',
        'toolbar.settingsTitle': 'Customise appearance and behaviour',
        'toolbar.logs': 'Logs',
        'toolbar.logsTitle': 'Open the folder with the application logs',
        'tabs.close': 'Close tab',
        'tabs.newTitle': 'New tab in the current environment (Ctrl+Shift+T)',
        'tabs.splitTitle': 'Split the view between two terminals',
        'tabs.explorerTitle': 'Show or hide the file explorer (Ctrl+Shift+E)',
        'tabs.exited': '[Process finished with code {code}]',
        'tabs.loadingPrefix': 'Loading: ',
        'tabs.someEnv': 'environment',
        'tabs.splitBackTitle': 'Back to a single session (Ctrl+Shift+\\)',
        'tabs.splitAddTitle': 'Add another session to the view, up to {max} (Ctrl+Shift+\\)',

        // ---- Menú contextual de la terminal ----
        'menu.copy': 'Copy',
        'menu.paste': 'Paste',
        'menu.cutInput': 'Cut input',
        'menu.deleteInput': 'Delete input',

        // ---- Explorador de archivos ----
        'explorer.up': 'Go up one directory',
        'explorer.follow': 'Go back to the terminal directory',
        'explorer.refresh': 'Read the folder again',
        'explorer.cd': 'Take the terminal to this folder',
        'explorer.newFolder': 'New folder',
        'explorer.newFile': 'New file',
        'explorer.addFolder': '+ Folder',
        'explorer.addFolderTitle': 'Create a folder here',
        'explorer.addFile': '+ File',
        'explorer.addFileTitle': 'Create an empty file here',
        'explorer.delete': 'Delete',
        'explorer.open': 'Open',
        'explorer.openFolder': 'Open folder',
        'explorer.enterFolder': 'Enter the folder',
        'explorer.rename': 'Rename',
        'explorer.copyPath': 'Copy path',
        'explorer.cut': 'Cut',
        'explorer.paste': 'Paste',
        'explorer.pasteNamed': 'Paste "{name}"',
        'explorer.trash': 'Delete (to the recycle bin)',
        'explorer.empty': 'Empty folder.',
        'explorer.truncated': 'Very large folder: only the first results are shown.',
        'explorer.newName': 'New name',
        'explorer.create': 'Create',
        'explorer.confirmTrash': 'Send "{name}" to the recycle bin',
        'explorer.trashed': '"{name}" is in the recycle bin.',
        'explorer.copied': 'Copied: {name}',
        'explorer.cutDone': 'Cut: {name}',
        'explorer.pastedRenamed': 'There was already an item with that name: pasted as "{name}".',
        'explorer.errorPaste': 'Could not paste.',
        'explorer.errorCopy': 'Could not copy.',
        'explorer.errorDelete': 'Could not delete.',
        'explorer.errorOpenFolder': 'Could not open the folder.',
        'explorer.openedWith': 'Folder opened with {app}.',

        // ---- Gestores de archivos ----
        'fileManager.chooseInstalled': 'The system has no default file manager. Which one should open the folder?'
            + ' It will be remembered next time (resetting the settings asks again).',
        'fileManager.chooseInstall': 'There is no file manager installed to open folders. Install one?',
        'fileManager.openWith': 'Open with {app}',
        'fileManager.install': 'Install {app}',
        'fileManager.gone': 'That file manager is no longer available.',
        'fileManager.launchFailed': 'Could not start {app}.',

        // ---- Avisos y sugerencias ----
        'suggestion.dismiss': 'Dismiss',
        'suggestion.installFailed': 'Could not prepare the installation.',
        'suggestion.noViewer': 'There is no application to open this {category} file. Install {app}?',
        'suggestion.install': 'Install {app}',
        'suggestion.notFound': "'{tool}' was not found. Install {label}?",
        'suggestion.noAutoInstall': 'There is no automatic installation for this yet.',

        // ---- Panel de entorno y dependencias ----
        'deps.header': 'Environment and components',
        'deps.allReady': 'Everything detected is ready; there are no pending installations.',
        'deps.onlyApplicable': 'Only actions that apply to this system are shown.',
        'deps.preparing': 'Preparing…',
        'deps.actionFailed': 'The action could not be prepared.',
        'deps.detectFailed': 'The environment could not be detected: {error}',
        'deps.summaryNone': 'Not installed',
        'deps.summaryShells': 'Shells',
        'deps.summaryCompat': 'Windows compatibility',
        'deps.summaryCompatNone': 'Not installed',
        'deps.summaryWsl': 'WSL',
        'deps.summaryWslCount': '{count} distro',
        'deps.summaryWslCountPlural': '{count} distros',
        'deps.summaryDocker': 'Docker',
        'deps.summaryDockerReady': 'Ready',
        'deps.summaryDockerReadyCount': 'Ready ({count} running)',
        'deps.summaryDockerStopped': 'Installed, stopped',
        'deps.summaryAdb': 'ADB',
        'deps.summaryAdbCount': '{count} device',
        'deps.summaryAdbCountPlural': '{count} devices',
        'deps.summaryGit': 'Git',
        'deps.summaryGitReady': 'Ready',
        'deps.summaryGitRepos': 'Ready ({count} repo)',
        'deps.summaryGitReposPlural': 'Ready ({count} repos)',
        'deps.summaryLanguages': 'Languages',
        'deps.summaryLanguagesCount': '{count} REPL',
        'deps.summaryLanguagesNone': 'None',

        // ---- Apartados del panel ----
        'group.updates': 'Updates',
        'group.shells': 'Shells',
        'group.tools': 'System and tools',
        'group.languages': 'Languages',
        'group.viewers': 'File viewers',
        'group.windowsCompat': 'Windows compatibility',
        'group.wsl': 'WSL',
        'group.docker': 'Docker',
        'group.android': 'Android · ADB',
        'group.network': 'Network and remote access',

        // ---- Verbos de las acciones ----
        'verb.install': 'Install',
        'verb.update': 'Update',
        'verb.uninstall': 'Uninstall',
        'verb.version': 'Version',
        'verb.verify': 'Verify',
        'verb.view': 'View',
        'verb.start': 'Start',
        'verb.restart': 'Restart',

        // ---- Etiquetas generadas de las acciones ----
        // Son la mayor parte del panel: una herramienta cualquiera aporta
        // cuatro acciones con estos mismos moldes. Los nombres propios
        // (Docker, winget, pacman) llegan como parámetro y no se traducen.
        'action.install': 'Install {tool} ({source})',
        'action.installShort': 'Install with {source}',
        'action.update': 'Update {tool}',
        'action.updateShort': 'Update to the latest version',
        'action.uninstall': 'Uninstall {tool}',
        'action.uninstallShort': 'Uninstall from the system',
        'action.version': 'Show {tool} version',
        'action.versionShort': 'Show installed version',
        'action.check': 'Check whether {tool} is installed',
        'action.checkShort': 'Check whether it is installed',

        // ---- Acciones sueltas del catálogo (por identificador) ----
        // Las que no salen de un molde: se traducen por su id estable, sin
        // tocar installActions.js ni el orden del panel.
        'action.winget-upgrade.label': 'Update everything with winget',
        'action.git-pull-projects.label': 'Update cloned repositories (git pull)',
        'action.pkg-update.label': 'Update system packages',
        'action.brew-update.label': 'Update packages (brew)',
        'action.brew-install.label': 'Install Homebrew',

        'action.wsl-list.label': 'Show installed distributions',
        'action.wsl-list.shortLabel': 'Show installed distributions',
        'action.wsl-update.label': 'Update the WSL kernel',
        'action.wsl-update.shortLabel': 'Update the WSL kernel',

        'action.sh-version.label': 'Show which shell provides sh',
        'action.sh-version.shortLabel': 'Show version and where it comes from',

        'action.pkg-pwsh.label': 'Install snapd, required for PowerShell ({source})',
        'action.pkg-pwsh.shortLabel': 'Install snapd with {source}',
        'action.pkg-paru.label': 'Install paru, the AUR helper',
        'action.pkg-paru.shortLabel': 'Install the AUR helper',
        'action.pkg-pwsh-version.label': 'Show PowerShell version',
        'action.pkg-pwsh-version.shortLabel': 'Show installed version',
        'action.pkg-pwsh-update.label': 'Update PowerShell (Snap)',
        'action.pkg-pwsh-update.shortLabel': 'Update to the latest version',
        'action.pkg-pwsh-uninstall.label': 'Uninstall PowerShell (Snap)',
        'action.pkg-pwsh-uninstall.shortLabel': 'Uninstall from the system',

        'action.pkg-wine.label': 'Install CMD/VBS compatibility with Wine ({source})',
        'action.pkg-wine.shortLabel': 'Install with {source}',
        'action.wine-check.label': 'Check the Wine-provided CMD',
        'action.wine-check.shortLabel': 'Check that CMD responds',
        'action.pkg-wine-update.label': 'Update Wine',
        'action.pkg-wine-update.shortLabel': 'Update to the latest version',
        'action.pkg-wine-uninstall.label': 'Uninstall Wine',
        'action.pkg-wine-uninstall.shortLabel': 'Uninstall from the system',

        'action.docker-list.label': 'Show Docker images and containers',
        'action.docker-list.shortLabel': 'Show images and containers',
        'action.docker-start-win.label': 'Start Docker Desktop',
        'action.docker-start-win.shortLabel': 'Start Docker Desktop',
        'action.docker-start-linux.label': 'Start the Docker service',
        'action.docker-start-linux.shortLabel': 'Start the service',
        'action.pkg-docker.label': 'Install Docker ({source})',
        'action.pkg-docker.shortLabel': 'Install with {source}',
        'action.pkg-docker-update.label': 'Update Docker',
        'action.pkg-docker-update.shortLabel': 'Update to the latest version',
        'action.pkg-docker-uninstall.label': 'Uninstall Docker',
        'action.pkg-docker-uninstall.shortLabel': 'Uninstall from the system',
        'action.pkg-docker-version.label': 'Show Docker version',
        'action.pkg-docker-version.shortLabel': 'Show installed version',
        'action.brew-docker.label': 'Install Docker Desktop (brew)',
        'action.brew-docker.shortLabel': 'Install with brew',
        'action.brew-docker-uninstall.label': 'Uninstall Docker Desktop (brew)',
        'action.brew-docker-uninstall.shortLabel': 'Uninstall from the system',
        'action.brew-docker-version.label': 'Show Docker version',
        'action.brew-docker-version.shortLabel': 'Show installed version',

        'action.adb-install.label': 'Install ADB / Android Platform Tools',
        'action.adb-install.shortLabel': 'Install (official Google download)',
        'action.adb-update.label': 'Update ADB to the latest version',
        'action.adb-update.shortLabel': 'Update to the latest version',
        'action.adb-check.label': 'Show connected ADB devices',
        'action.adb-check.shortLabel': 'Show connected devices',
        'action.adb-version.label': 'Show ADB version',
        'action.adb-version.shortLabel': 'Show installed version',
        'action.adb-uninstall.label': 'Uninstall ADB / Android Platform Tools',
        'action.adb-uninstall.shortLabel': 'Uninstall from the system',
        'action.adb-authorize.label': 'Restart ADB and ask for authorisation again',
        'action.adb-authorize.shortLabel': 'Restart and ask for authorisation again',
        'action.pkg-adb.label': 'Install ADB / Android Platform Tools ({source})',
        'action.pkg-adb.shortLabel': 'Install with {source}',
        'action.pkg-adb-update.label': 'Update ADB to the latest version ({source})',
        'action.pkg-adb-update.shortLabel': 'Update to the latest version',
        'action.pkg-adb-uninstall.label': 'Uninstall ADB',
        'action.pkg-adb-uninstall.shortLabel': 'Uninstall from the system',

        'action.winget-ssh.label': 'Install SSH client (OpenSSH)',
        'action.winget-ssh.shortLabel': 'Install as a Windows capability',
        'action.winget-ssh-uninstall.label': 'Uninstall SSH client (OpenSSH)',
        'action.winget-ssh-uninstall.shortLabel': 'Uninstall from the system',
        'action.ssh-check.label': 'Show installed SSH version',
        'action.ssh-check.shortLabel': 'Show installed version',
        'action.pkg-ssh.label': 'Install SSH client ({source})',
        'action.pkg-ssh.shortLabel': 'Install with {source}',
        'action.pkg-ssh-update.label': 'Update SSH client',
        'action.pkg-ssh-update.shortLabel': 'Update to the latest version',
        'action.pkg-ssh-uninstall.label': 'Uninstall SSH client',
        'action.pkg-ssh-uninstall.shortLabel': 'Uninstall from the system',

        // ---- Nombres de herramienta con coletilla descriptiva ----
        // Solo se traduce la coletilla: "VLC" es VLC en todas partes.
        'tool.viewerImage': 'ImageGlass (images, SVG)',
        'tool.viewerImageLinux': 'Eye of GNOME (images)',
        'tool.viewerMedia': 'VLC (audio and video)',
        'tool.viewerMediaWin': 'VLC (audio and video)',
        'tool.viewerDocument': 'Evince (PDF)',
        'tool.viewerDocumentWin': 'SumatraPDF (PDF and books)',
        'tool.viewerArchive': 'p7zip (archives)',
        'tool.viewerArchiveWin': '7-Zip (archives)',
        'tool.viewerCode': 'Visual Studio Code (code and text)',
        'tool.nautilus': 'Files / Nautilus (GNOME)',
        'tool.thunar': 'Thunar (Xfce, lightweight)',
        'tool.java': 'Java (JDK)',
        'tool.nodeLts': 'Node.js LTS',
        'tool.nodeNpm': 'Node.js + npm',
        'tool.gitBash': 'Git + Git Bash',

        // ---- Selector de entorno ----
        'env.groupShells': 'System shells',
        'env.groupLanguages': 'Interactive interpreters',
        'env.groupDockerContainers': 'Docker containers',
        'env.groupDockerImages': 'Docker images',
        'env.groupAndroid': 'Android (ADB)',
        'env.groupOther': 'Other',
        'env.currentGone': 'Current environment (no longer detected)',
        'env.switchFailed': 'Could not start {label}.',
        'env.unavailable': 'That environment is no longer available.',

        // ---- Banner de sesión ----
        'banner.hardware': 'Hardware',
        'banner.software': 'Software',
        'banner.uptimeAge': 'Uptime / Age / DT',
        'banner.pc': 'PC',
        'banner.cpu': 'CPU',
        'banner.gpu': 'GPU',
        'banner.osAge': 'OS Age',
        'banner.datetime': 'DateTime',
        'banner.user': 'User',
        'banner.system': 'System',
        'banner.edition': 'Edition',
        'banner.unknown': 'unknown',
        'banner.kernel': 'Kernel',
        'banner.environment': 'Environment',
        'banner.memory': 'Memory',
        'banner.uptime': 'Uptime',
        'banner.cores': '{count} cores',

        // ---- Ajustes ----
        'settings.title': 'Preferences',
        'settings.subtitle': 'Customise the interface without changing the system.',
        'settings.sections': 'Preference sections',
        'settings.themeHint': 'All dark, tuned for long reading sessions. One of them is high-contrast.',
        'settings.textCursor': 'Text and cursor',
        'settings.textCursorHint': 'Applied to every open tab.',
        'settings.startupPanels': 'Startup and panels',
        'settings.startupPanelsHint': 'Only changes how the application behaves.',
        'settings.developers': 'Developers',
        'settings.developersHint': 'Credits defined in the distribution catalogue.',
        'settings.localConfig': 'Local configuration',
        'settings.appearance': 'Appearance',
        'settings.terminal': 'Terminal',
        'settings.behavior': 'Behaviour',
        'settings.about': 'About',
        'settings.language': 'Language',
        'settings.languageHint': 'Applies to the whole interface. It does not change the output of the commands you run.',
        'settings.theme': 'Theme',
        'settings.accent': 'Accent',
        'settings.terminalBg': 'Terminal background',
        'settings.terminalFg': 'Terminal text',
        'settings.density': 'Interface density',
        'settings.densityComfortable': 'Comfortable',
        'settings.densityCompact': 'Compact',
        'settings.font': 'Font',
        'settings.fontSize': 'Size',
        'settings.lineHeight': 'Line height',
        'settings.letterSpacing': 'Letter spacing',
        'settings.cursor': 'Cursor',
        'settings.cursorBlock': 'Block',
        'settings.cursorBar': 'Bar',
        'settings.cursorUnderline': 'Underline',
        'settings.cursorBeam': 'Thick bar',
        'settings.cursorUnderlineThick': 'Thick underline',
        'settings.padding': 'Inner margin',
        'settings.scrollback': 'Scrollback lines',
        'settings.fontWeight': 'Weight',
        'settings.fontWeightNormal': 'Normal',
        'settings.fontWeightBold': 'Bold',
        'settings.scrollSensitivity': 'Wheel speed',
        'settings.cursorBlink': 'Blinking cursor',
        'settings.cursorBlinkHint': 'Makes the typing point easier to spot.',
        'settings.copyOnSelect': 'Copy on select',
        'settings.copyOnSelectHint': 'Releasing the mouse sends the selection to the clipboard.',
        'settings.showBanner': 'Show system information',
        'settings.showBannerHint': 'Banner shown when a new session starts.',
        'settings.startupEnv': 'Environment at startup',
        'settings.hereDepth': 'Depth of "Here"',
        'settings.autoDocker': 'Start Docker automatically',
        'settings.autoDockerHint': 'Only when it is installed and the daemon does not respond.',
        'settings.exclusiveGroups': 'One list open at a time',
        'settings.exclusiveGroupsHint': 'Opening a list closes the previous one in the same panel.',
        'settings.autoOpenFirst': 'Open the first list automatically',
        'settings.autoOpenFirstHint': 'By default all of them start closed.',
        'settings.save': 'Save',
        'settings.reset': 'Restore defaults',
        'settings.savedNote': 'Saved. The startup environment and Docker apply on the next launch.',
        'settings.resetDone': 'Default preferences restored.',
        'settings.saveFailed': 'Preferences could not be saved.',
        'settings.resetFailed': 'Preferences could not be restored.',
        'settings.developersPending': 'To be completed.',
        'settings.roleOwner': 'Developer · WinSlim',
        'settings.roleDeveloper': 'Developer',
        'settings.openProfile': 'Open {url}',
        'settings.file': 'File',
        'settings.languageAuto': 'Automatic (system)',
        'settings.envAuto': 'Automatic, based on the system',

        // ---- Proyectos ----
        'projects.pinned': 'Pinned',
        'projects.explore': 'Explore GitHub',
        'projects.chooseFolder': 'Choose a local folder for repositories',
        'projects.refresh': 'Refresh view',
        'projects.queryPlaceholder': 'user, owner/repo or GitHub URL',
        'projects.search': 'Search',
        'projects.pin': 'Pin',
        'projects.pinProfile': 'Pin profile',
        'projects.unpin': 'Unpin',
        'projects.updateSource': 'Update source',
        'projects.updateRelease': 'Update release',
        'projects.updateReleaseTitle': 'Downloads the file from the latest release that matches this system and extracts it. It does not use the source code.',
        'projects.updatingFromRelease': 'Updating from release {tag}: {asset}',
        'projects.noPlatformAsset': 'The latest release attaches no file for this system. Open it with “Release” and pick one.',
        'projects.clone': 'Clone',
        'projects.developer': 'Developer',
        'projects.official': 'Project',
        'projects.local': 'local',
        'projects.folderBusy': 'folder in use',
        'projects.archived': 'Archived',
        'projects.publicRepo': 'Public repository',
        'projects.viewRepos': 'View repos',
        'projects.noPins': 'No profiles or repositories pinned yet. Add them from Explore GitHub.',
        'projects.pinsNote': 'Catalogue developers are fixed; the rest of the pins are stored in settings.json.',
        'projects.pinFailed': 'The pin could not be updated.',
        'projects.querying': 'Querying the public GitHub API…',
        'projects.queryFailed': 'GitHub could not be queried.',
        'projects.noPublicRepos': 'This profile has no public repositories.',
        'projects.searchHint': 'Search for a profile to see its repositories, or paste the URL of a specific repository.',
        'projects.profileMeta': '{repos} public repos · {followers} followers',
        'projects.filterPlaceholder': 'Filter by name, owner or language',
        'projects.filterCount': '{shown} of {total} pins',
        'projects.noFilterMatch': 'No pin matches “{query}”.',
        'projects.repoCount': '{count} repository',
        'projects.repoCountPlural': '{count} repositories',
        'projects.rateRemaining': 'public queries left: {count}',
        'projects.preparingClone': 'Preparing clone of {repo}…',
        'projects.preparingUpdate': 'Preparing update of {repo}…',
        'projects.gitFailed': 'Git could not be prepared.',

        // ---- Releases ----
        'projects.release': 'Release',
        'projects.releaseTitle': 'Show the latest published version and its files',
        'projects.releaseLoading': 'Checking the latest release…',
        'projects.releaseFailed': 'The release could not be checked.',
        'projects.noRelease': 'This repository has no published release.',
        'projects.prerelease': 'pre-release',
        'projects.noAssets': 'The release attaches no files: only the source code, which you get by cloning.',
        'projects.download': 'Download',
        'projects.downloadExtract': 'Download and extract',
        'projects.downloading': 'Downloading…',
        'projects.downloadFailed': 'The file could not be downloaded.',
        'projects.downloaded': 'Downloaded to {path}.',
        'projects.downloadedExtracting': 'Downloaded to {path}. The command to extract it is in the terminal.',

        // Mensajes de descarga que vienen del proceso principal.
        'release.badRedirect': 'The download tried to leave the GitHub servers.',
        'release.httpError': 'GitHub responded with status {status} while downloading.',
        'release.tooBig': 'The file is larger than the maximum allowed.',
        'release.stale': 'Check the release again before downloading it.',
        'release.assetGone': 'That file no longer belongs to the release shown.',
        'error.repoNotInView': 'That repository does not belong to the current view.',

        // ---- Scripts ----
        'scripts.library': 'Library',
        'scripts.libraryTitle': 'Persistent scripts folder and system utilities',
        'scripts.here': 'Here',
        'scripts.hereTitle': 'Search the current folder of the tab and its subfolders',
        'scripts.chooseFolder': 'Choose a folder for this view',
        'scripts.refresh': 'Search again',
        'scripts.levels': 'Levels',
        'scripts.fileTypes': 'File types',
        'scripts.depthTitle': 'Maximum subfolder depth. The scan keeps its safety limits.',
        'scripts.typesDefaults': 'Scripts',
        'scripts.typesAll': 'All',
        'scripts.typesNone': 'None',
        'scripts.run': 'Run',
        'scripts.runTitle': 'Writes the command in the active tab',
        'scripts.adminTitle': 'Run with elevated permissions (UAC / sudo)',
        'scripts.argsTitle': 'Add arguments (file or folder to act on)',
        'scripts.argsPlaceholder': 'Arguments (e.g. "C:\\path\\file.txt")',
        'scripts.pickFile': 'File…',
        'scripts.pickFileTitle': 'Choose a file and use it as an argument',
        'scripts.pickFolder': 'Folder…',
        'scripts.pickFolderTitle': 'Choose a folder and use it as an argument',
        'scripts.cdTitle': 'Move the terminal to the folder holding this file',
        'scripts.filterPlaceholder': 'Filter by name, folder or extension',
        'scripts.filterCount': '{shown} of {total} files',
        'scripts.noFilterMatch': 'No file matches “{query}”.',
        'scripts.noneInScope': 'There are no files of the selected types in this scope.',
        'scripts.noTypeSelected': 'Select at least one file type.',
        'scripts.libraryNote': 'Persistent library. Only runnable scripts are registered as aliases; media and HTML never create aliases.',
        'scripts.hereNote': 'Up to {depth} levels and only the ticked types. Dependencies, build artefacts and code with no runnable intent are skipped. "Here" creates no aliases.',
        'scripts.hereLimited': 'The result limit was reached. Dependencies and artefacts are skipped; narrow the folder or the selected types.',

        // ---- Controles compartidos por varios paneles ----
        'common.clearFilter': 'Clear filter',

        // ---- Alias "ayuda" impreso dentro de cada sesión ----
        'help.title': 'commands added to this session ({shell})',
        'help.packages': 'Packages',
        'help.packagesManager': 'the same words in every shell; here {manager} handles them',
        'help.packagesAuto': 'the same words in every shell; the manager is picked when you run it',
        'help.install': 'Installs a package.',
        'help.update': 'With no arguments it updates the whole system.',
        'help.upgrade': 'Updates the whole system.',
        'help.uninstall': 'Uninstalls. "remove" does the same.',
        'help.search': 'Searches a package by name. It never asks for privileges.',
        'help.session': 'Session',
        'help.clear': 'Clears screen and scrollback and repaints the banner.',
        'help.sysinfo': 'Prints the system information again.',
        'help.help': 'This help.',
        'help.nsudo': 'Runs as TrustedInstaller, with every privilege.',
        'help.vocabulary': 'Vocabulary translated to this shell',
        'help.scripts': 'Library scripts',
        'help.noScripts': 'None detected. Pick a folder in the Scripts > Library panel.',

        // ---- Errores del proceso principal ----
        'error.noTab': 'There is no active tab.',
        'error.tabGone': 'The tab is no longer available.',
        'error.notInView': 'That item is no longer in the open folder.',
        'error.folderNotInView': 'That folder does not belong to the current view.',
        'error.noFolderOpen': 'There is no folder open in the explorer yet.',
        'error.nothingCopied': 'Nothing has been copied.',
        'error.invalidWindow': 'Invalid window.',
        'error.invalidRequest': 'Invalid request.',
        'error.notAuthorised': 'The file is not authorised to be opened from this panel.',
        'error.replNotShell': 'The active tab is an interpreter, not a shell.',
        'error.noShell': 'There is no shell available to run this action.',
        'error.actionGone': 'That action is no longer available; refresh the panel.',
        'error.writeFailed': 'Could not write to the active terminal.',
        'error.trashFailed': 'Could not send to the recycle bin: {error}.'
            + ' Some file systems (network drives, external mounts) have no recycle bin.'
    }
};

// Los apartados del panel de dependencias y los grupos del selector de
// entorno se generan en español en los módulos que los producen
// (installActions.js, shellDetect.js, dockerEnv.js...) y se usan además como
// clave de ordenación. En vez de obligar a esos módulos a conocer el catálogo,
// el proceso principal les añade aquí su clave antes de mandarlos al renderer.
const GROUP_KEYS = {
    // Panel de entorno y dependencias
    'Actualizaciones': 'group.updates',
    'Shells': 'group.shells',
    'Sistema y herramientas': 'group.tools',
    'Lenguajes': 'group.languages',
    'Visores de archivos': 'group.viewers',
    'Compatibilidad Windows': 'group.windowsCompat',
    'WSL': 'group.wsl',
    'Docker': 'group.docker',
    'Android · ADB': 'group.android',
    'Red y acceso remoto': 'group.network',
    // Selector de entorno
    'Shells del sistema': 'env.groupShells',
    'Lenguajes · intérprete interactivo': 'env.groupLanguages',
    'Docker · contenedores en ejecución': 'env.groupDockerContainers',
    'Docker · imágenes (contenedor nuevo)': 'env.groupDockerImages',
    'Android (ADB)': 'env.groupAndroid'
};

function groupKeyFor(name) {
    return Object.prototype.hasOwnProperty.call(GROUP_KEYS, name) ? GROUP_KEYS[name] : null;
}

// Los verbos de las acciones son un vocabulario cerrado que genera la propia
// aplicación (installActions.js), no texto libre: se traducen en la frontera,
// al mandar el catálogo al renderer, sin que ese módulo tenga que conocer los
// idiomas. Lo que no esté aquí se queda como está.
const VERB_KEYS = {
    'Instalar': 'verb.install',
    'Actualizar': 'verb.update',
    'Desinstalar': 'verb.uninstall',
    'Versión': 'verb.version',
    'Verificar': 'verb.verify',
    'Ver': 'verb.view',
    'Iniciar': 'verb.start',
    'Reiniciar': 'verb.restart'
};

function verbKeyFor(verb) {
    return Object.prototype.hasOwnProperty.call(VERB_KEYS, verb) ? VERB_KEYS[verb] : null;
}

// Traducción de una acción concreta del panel. Las claves se derivan de su
// identificador estable (`pkg-pwsh` -> `action.pkg-pwsh.label`), de modo que
// traducir una acción no obliga a tocar installActions.js ni a reordenar
// nada. Lo que no esté traducido se queda en español, que es el idioma en el
// que está escrito el catálogo.
function translateAction(language, action) {
    const traducido = { ...action };
    ['label', 'shortLabel', 'hint'].forEach((campo) => {
        if (!action[campo]) return;
        const clave = `action.${action.id}.${campo}`;
        const texto = translate(language, clave, null, action[campo]);
        if (texto === clave) return;
        // Un texto con parámetros sin resolver ({source}, {distro}...) es de
        // los que installActions.js ya tradujo al generarlo, que es donde
        // existen esos datos. Volver a traducirlo aquí, sin ellos, dejaría el
        // hueco a la vista.
        if (/\{\w+\}/.test(texto)) return;
        traducido[campo] = texto;
    });
    if (action.verb) {
        const clave = verbKeyFor(action.verb);
        if (clave) traducido.verb = translate(language, clave, null, action.verb);
    }
    if (action.subgroup) {
        const clave = `action.subgroup.${action.subgroup}`;
        traducido.subgroup = translate(language, clave, null, action.subgroup);
    }
    return traducido;
}

// Idioma efectivo. `auto` mira el locale del sistema y se queda con el primer
// tramo ("en-GB" -> "en"); cualquier idioma que no esté en el catálogo cae al
// de referencia en vez de dejar la interfaz a medias.
function resolveLanguage(preference, systemLocale) {
    if (preference && preference !== 'auto') {
        return CATALOGS[preference] ? preference : FALLBACK_LANGUAGE;
    }
    const base = String(systemLocale || '').toLowerCase().split(/[-_]/)[0];
    return CATALOGS[base] ? base : FALLBACK_LANGUAGE;
}

function interpolate(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) =>
        (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
}

// `fallback` es el texto en español que está escrito en el propio código: así
// el idioma de referencia no necesita catálogo y una clave sin traducir se ve
// en español, nunca como "settings.language".
function translate(language, key, params, fallback) {
    const catalog = CATALOGS[language] || CATALOGS[FALLBACK_LANGUAGE];
    const text = catalog[key] || CATALOGS[FALLBACK_LANGUAGE][key] || fallback || key;
    return interpolate(text, params);
}

function createTranslator(language) {
    const resolved = CATALOGS[language] ? language : FALLBACK_LANGUAGE;
    const t = (key, params, fallback) => translate(resolved, key, params, fallback);
    t.language = resolved;
    return t;
}

// Catálogo que se le pasa al renderer: solo el idioma activo, ya resuelto.
// El renderer no decide el idioma ni ve los demás catálogos.
function catalogFor(language) {
    const resolved = CATALOGS[language] ? language : FALLBACK_LANGUAGE;
    return { language: resolved, strings: { ...CATALOGS[resolved] } };
}

module.exports = {
    LANGUAGES,
    FALLBACK_LANGUAGE,
    CATALOGS,
    GROUP_KEYS,
    VERB_KEYS,
    groupKeyFor,
    verbKeyFor,
    translateAction,
    resolveLanguage,
    translate,
    createTranslator,
    catalogFor
};
