// main.js - Proceso principal de Electron
// Migración de terminal.hta (mshta + WScript.Shell) a Electron + node-pty,
// con soporte multi-shell (cmd, PowerShell, WSL, bash, zsh, fish, sh),
// múltiples pestañas por ventana (cada una con su propio pty), alias
// traducidos a la sintaxis nativa de cada shell, y comandos extra por
// script detectado (carpeta scripts/ + utilidades VBS de WinSlim + NSudo).

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { identityForPlatform } = require('./main/appIdentity');
const { migrateUserData } = require('./main/userDataMigration');
const APP_IDENTITY = identityForPlatform(process.platform);
app.setName(APP_IDENTITY.name);
if (process.platform === 'linux' && APP_IDENTITY.desktopFile) app.setDesktopName(APP_IDENTITY.desktopFile);
const legacyUserDataPath = app.getPath('userData');
const canonicalUserDataPath = path.join(app.getPath('appData'), APP_IDENTITY.slug);
const userDataMigration = migrateUserData(legacyUserDataPath, canonicalUserDataPath);
app.setPath('userData', canonicalUserDataPath);
const { pathToFileURL } = require('url');
const pty = require('node-pty');
const { detectEnvironments, getDefaultEnvId, isToolInstalled } = require('./main/shellDetect');
const { buildInitScript, buildInitInvocation, transportLoadsHostFiles, CLEAR_MARKER } = require('./main/aliasProfiles');
const { getInstallActions } = require('./main/installActions');
const { detectMissingCommand, resolveToolSuggestion } = require('./main/commandNotFound');
const {
    listScripts, listAllScripts, buildLaunchCommand, buildCdCommand, environmentKindsForScript,
    resolveScriptAliases, nsudoAvailable, NSUDO_PATH, MAX_HERE_SCRIPTS,
    MIN_HERE_DEPTH, MAX_HERE_DEPTH, normalizeHereDepth,
    FILE_FILTERS
} = require('./main/scriptLauncher');
const { isDaemonReady, startDockerDaemon, waitForDaemon } = require('./main/dockerEnv');
const { refreshSystemPath, clearWhichCache } = require('./main/pathEnv');
const { buildBanner } = require('./main/systemInfo');
const settingsStore = require('./main/settings');
const { DEFAULT_PREFERENCES, THEME_PRESETS, FONT_FAMILIES, LANGUAGES, sanitizePreferences } = require('./main/preferences');
const { resolveLanguage, createTranslator, catalogFor, groupKeyFor, translateAction } = require('./main/i18n');
const logger = require('./main/logger');
if (userDataMigration.migrated) {
    logger.info('Datos locales unificados en la ruta estable', {
        from: legacyUserDataPath,
        to: canonicalUserDataPath,
        settingsMerged: userDataMigration.settingsMerged,
        scriptsCopied: userDataMigration.scriptsCopied
    });
}
const { detectCurrentDirectory } = require('./main/currentDir');
const { detectWindowsManager, WINDOWS_MANAGERS } = require('./main/packageAliases');
const { listDirectory, createEntry, renameEntry, pasteEntry, parentDirectory } = require('./main/fileExplorer');
const { suggestViewer, fileManagerChoices, fileManagerById, fileManagerForDesktop } = require('./main/fileViewers');
const { resolveSpawnCwd } = require('./main/spawnCwd');
const { getWslContextAsync } = require('./main/wslEnv');
const {
    parseGithubTarget, parseFullName, createGithubClient, loadCatalog, mergePins,
    repositoryFromFullName, localRepositoryState, countLocalRepositories, buildGitCommand,
    isAllowedAssetUrl, buildExtractCommand,
    isGithubOwner
} = require('./main/githubProjects');

// Por debajo de esto, una sesión que sale con error no se considera terminada
// sino fallida, y su pestaña no se cierra sola (ver ptyProcess.onExit).
const FAILED_SESSION_MS = 3000;
// Tamaño de arranque de la primera sesión, hasta que el renderer mida la
// ventana de verdad y lo corrija.
const DEFAULT_VIEWPORT = Object.freeze({ cols: 80, rows: 24 });
const MAX_PTY_INPUT_CHARS = 4 * 1024 * 1024;
const MAX_SCRIPT_ARGS_CHARS = 8192;
const MAX_CLIPBOARD_CHARS = 8 * 1024 * 1024;
const RENDERER_PATH = path.join(__dirname, 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_PATH).href;

// Arranque de integración para comprobar una build real sin mostrar una
// ventana ni dejar procesos vivos. Se usa después de empaquetar; no cambia
// el comportamiento normal de la aplicación.
const SMOKE_TEST = process.argv.includes('--smoke-test');
const INTEGRATION_TEST = process.argv.includes('--integration-test');
const HEADLESS_TEST = SMOKE_TEST || INTEGRATION_TEST;

logger.banner(`${APP_IDENTITY.name} iniciando`, { platform: process.platform, pid: process.pid });

// Errores que no rompen dentro de un handler (p. ej. fallo de node-pty al
// spawnear, o un rechazo de promesa sin catch) se registran en vez de dejar
// morir la app en silencio.
process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', reason);
});

/**
 * @typedef {{ id: string, ptyProcess: any, envId: string|null, label: string, outputBuffer: string, lastMissingCommand: string|null }} TabState
 * @typedef {{ win: BrowserWindow, tabs: Map<string, TabState>, activeTabId: string|null, envs: any[], pkgManager: string|null }} WindowState
 * @type {Map<number, WindowState>}
 */
const windows = new Map();

// Los entornos disponibles solo cambian si el usuario instala algo nuevo
// (ej. WSL, Git Bash) mientras la app está abierta, así que se cachean y
// solo se vuelven a calcular si el usuario pulsa "refrescar".
let cachedEnvironments = null;
let environmentDetectionPromise = null;
let hereSearchDepth = sanitizePreferences(settingsStore.loadSettings()).scriptsHereDepth;

function selectedHereDepth(rawDepth) {
    if (rawDepth === null || rawDepth === undefined || rawDepth === '') return hereSearchDepth;
    const next = normalizeHereDepth(rawDepth, hereSearchDepth);
    if (next !== hereSearchDepth) {
        hereSearchDepth = next;
        if (!settingsStore.saveSettings({ scriptsHereDepth: hereSearchDepth })) {
            logger.warn('No se pudo persistir la profundidad de búsqueda de Aquí', { depth: hereSearchDepth });
        }
    }
    return hereSearchDepth;
}

async function getEnvironments(forceRefresh) {
    if (cachedEnvironments && !forceRefresh) return cachedEnvironments;
    // Refrescar desde varios paneles a la vez ya no dispara sondeos WSL,
    // Docker y ADB duplicados ni permite que una respuesta antigua gane.
    if (environmentDetectionPromise) return environmentDetectionPromise;
    const startedAt = Date.now();
    environmentDetectionPromise = detectEnvironments()
        .then((fresh) => {
            cachedEnvironments = fresh;
            logger.info('Entornos detectados', {
                elapsedMs: Date.now() - startedAt,
                envs: fresh.envs.map((e) => e.id),
                pkgManager: fresh.pkgManager,
                docker: fresh.docker,
                android: fresh.android
            });
            return fresh;
        })
        .finally(() => { environmentDetectionPromise = null; });
    return environmentDetectionPromise;
}

async function getInitialEnvironments() {
    if (cachedEnvironments) return cachedEnvironments;
    const startedAt = Date.now();
    const quick = await detectEnvironments({ quick: true });
    logger.info('Entornos iniciales rápidos', { elapsedMs: Date.now() - startedAt, envs: quick.envs.map((e) => e.id) });
    return quick;
}

// Reparte una lista de entornos recién detectada a todas las ventanas
// abiertas y avisa al renderer para que refresque su desplegable sin que el
// usuario tenga que pulsar ⟳.
function broadcastEnvironments(fresh) {
    windows.forEach((ws) => {
        ws.envs = fresh.envs;
        ws.pkgManager = fresh.pkgManager;
        if (!ws.win.isDestroyed()) {
            ws.win.webContents.send('envs-updated', fresh.envs.map(publicEnvironment));
        }
    });
}

function publicEnvironment(env) {
    const { id, label, kind, group, transport, shell: shellName, distro, available, note, repl, language } = env;
    return {
        // `groupKey` deja que el renderer traduzca el nombre del grupo sin que
        // los módulos que detectan entornos tengan que conocer el catálogo.
        id, label, kind, group, groupKey: groupKeyFor(group), transport, shell: shellName, distro,
        available: available !== false, note: note || null,
        repl: repl === true, language: language || null
    };
}

// Un REPL (Python, Node, Ruby...) no entiende comandos de shell: escribir un
// `cd` o un `winget install` dentro de él solo produce un error de sintaxis.
// Las acciones que escriben comandos se enrutan a una shell real.
function preferredShellEnvironment(ws, requestedTab) {
    const requestedEnv = requestedTab && ws.envs.find((env) => env.id === requestedTab.envId);
    if (requestedEnv && !requestedEnv.repl && requestedEnv.available !== false) return requestedEnv;
    const priority = process.platform === 'win32'
        ? ['powershell', 'pwsh', 'cmd', 'gitbash']
        : ['bash', 'zsh', 'sh', 'fish'];
    for (const id of priority) {
        const match = ws.envs.find((env) => env.id === id && env.available !== false);
        if (match) return match;
    }
    return ws.envs.find((env) => !env.repl && env.available !== false) || null;
}

// Docker: si está instalado pero el daemon está parado, se arranca solo
// (Docker Desktop en Windows/macOS es una app de usuario, no requiere
// elevación) y, cuando responde, se vuelven a detectar los entornos para
// que las imágenes/contenedores aparezcan sin reiniciar la app. Se puede
// desactivar poniendo "autoStartDocker": false en settings.json.
async function ensureDockerRunning() {
    const preferences = sanitizePreferences(settingsStore.loadSettings());
    if (!preferences.autoStartDocker) {
        logger.info('Arranque automático de Docker desactivado por settings.json');
        return;
    }
    if (!cachedEnvironments || !cachedEnvironments.docker.installed) return;
    if (cachedEnvironments.docker.daemonReady) return;

    const result = startDockerDaemon();
    if (!result.started) {
        logger.warn('No se pudo arrancar Docker automáticamente', result);
        return;
    }
    logger.info('Docker arrancando en segundo plano, esperando al daemon...', result);

    const ready = await waitForDaemon(120000, 4000);
    if (!ready) {
        logger.warn('Docker no respondió a tiempo; usa ⟳ en el selector de entorno cuando termine de arrancar');
        return;
    }
    const fresh = await getEnvironments(true);
    logger.info('Docker listo: entornos actualizados', {
        dockerEnvs: fresh.envs.filter((e) => e.id.startsWith('docker:')).map((e) => e.id)
    });
    broadcastEnvironments(fresh);
}

// ---- Lanzador rápido de scripts: carpeta y utilidades compartidas ----
// Carpeta por defecto: en desarrollo, la carpeta scripts/ ya existente en la
// raíz del proyecto; empaquetada, una carpeta persistente en userData (una
// app portable no tiene garantizado un sitio propio junto al .exe donde
// escribir). El usuario puede cambiarla en cualquier momento desde la UI.
function defaultScriptsFolder() {
    if (!app.isPackaged) {
        return path.join(__dirname, '..', 'scripts');
    }
    return path.join(app.getPath('userData'), 'scripts');
}

let scriptsFolder = settingsStore.loadSettings().scriptsFolder || defaultScriptsFolder();
try {
    fs.mkdirSync(scriptsFolder, { recursive: true });
} catch (e) {
    logger.warn('No se pudo crear la carpeta de scripts', { scriptsFolder, error: e.message });
}

// Catálogo oficial neutro + anclados del usuario. El catálogo se incluye en
// el ASAR y puede rellenarse antes de compilar una distribución WinSlim; las
// preferencias personales permanecen fuera del ejecutable, en settings.json.
// El catálogo se resuelve para ESTA plataforma: WinSlim Terminal y LTerminal
// son dos identidades con anclados de fábrica propios (ver platformOverrides
// en project-catalog.json).
const projectCatalog = loadCatalog(path.join(__dirname, 'config', 'project-catalog.json'), process.platform);
let projectsFolder = settingsStore.loadSettings().projectsFolder
    || path.join(app.getPath('documents'), APP_IDENTITY.projectsFolderName);
const githubClient = createGithubClient((url, options) => net.fetch(url, options), { userAgent: APP_IDENTITY.userAgent });

// NSudo (TrustedInstaller + todos los privilegios) solo se ofrece como
// alias si de verdad existe en esta máquina (es específico del sistema
// personalizado del autor, no algo que todo usuario de la app tenga).
const nsudoPath = nsudoAvailable() ? NSUDO_PATH : null;
if (nsudoPath) logger.info('NSudo detectado, alias "nsudo" habilitado', { path: nsudoPath });

// Gestor de paquetes de Windows que respaldará los alias install/update/
// upgrade/uninstall. Se consulta al crear cada pestaña (which cachea el
// resultado) para que instalar winget con la app abierta se note enseguida.
function windowsPackageManager() {
    if (process.platform !== 'win32') return null;
    return detectWindowsManager(isToolInstalled);
}

// La salida del pty empieza a llegar en cuanto se spawnea, pero el renderer
// puede no estar listo todavia para esa pestaña: en el primer arranque ni
// siquiera se ha cargado el HTML, y en una pestaña nueva el xterm se crea
// despues de que tabs:create devuelva. Sin esto, el banner y el primer
// prompt de la shell se perderian. Se acumulan hasta que el renderer avisa
// (tabs:ready) de que ya puede pintarlos.
//
// El tope evita que el buffer crezca sin limite si el renderer nunca llega
// a estar listo (p. ej. crashea al cargar): se descartan los mensajes mas
// antiguos, conservando los recientes.
const MAX_PENDING_OUTPUT = 500;

function sendToTab(windowState, tab, channel, payload) {
    if (!tab.ready) {
        tab.pendingOutput.push([channel, payload]);
        if (tab.pendingOutput.length > MAX_PENDING_OUTPUT) tab.pendingOutput.shift();
        return;
    }
    if (!windowState.win.isDestroyed()) {
        windowState.win.webContents.send(channel, tab.id, payload);
    }
}

function flushPendingOutput(windowState, tab) {
    tab.ready = true;
    const pending = tab.pendingOutput;
    tab.pendingOutput = [];
    if (windowState.win.isDestroyed()) return;
    pending.forEach(([channel, payload]) => {
        windowState.win.webContents.send(channel, tab.id, payload);
    });
}

// Detecta el marcador de limpieza (ver CLEAR_MARKER en aliasProfiles.js),
// que viaja como cambio de título (OSC 0) fuera del contenido de la
// pantalla. Se saca de la salida antes de mandarla al renderer: es una señal
// interna, no un título que merezca la pena propagar.
//
// No se descarta lo que venga antes: ConPTY emite el marcador AL FINAL del
// volcado, cuando el banner ya se ha pintado. Lo que sobra tras un `cls` no
// está en la pantalla sino en el historial, y de eso se encarga el renderer.
const CLEAR_OSC = new RegExp('\\x1b\\]0;([^\\x07\\x1b]*' + CLEAR_MARKER + '[^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)', 'g');

// Cuánto se retiene esperando el cierre de un OSC partido entre dos lecturas
// del pty. Un título real nunca se acerca a este tamaño; el tope evita
// acumular salida indefinidamente si un ESC] suelto no llega a cerrarse.
const MAX_OSC_CARRY = 512;

function splitOnClearMarker(carry, data) {
    let buf = carry + data;
    let hold = '';

    // ¿La cola es un OSC a medias? Se guarda antes de buscar marcadores para
    // conservar el orden exacto entre texto -> clear -> texto.
    const start = buf.lastIndexOf('\x1b]');
    if (start !== -1 && buf.length - start < MAX_OSC_CARRY) {
        const tail = buf.slice(start);
        if (!tail.includes('\x07') && !tail.includes('\x1b\\')) {
            hold = tail;
            buf = buf.slice(0, start);
        }
    }

    const events = [];
    let cursor = 0;
    CLEAR_OSC.lastIndex = 0;
    let match;
    while ((match = CLEAR_OSC.exec(buf)) !== null) {
        if (match.index > cursor) events.push({ type: 'data', data: buf.slice(cursor, match.index) });
        // El título completo identifica la limpieza concreta: lleva un sufijo
        // aleatorio distinto cada vez, así que repetirlo significa que ConPTY
        // ha reemitido un título antiguo, no que la shell haya limpiado otra vez.
        events.push({ type: 'clear', marker: match[1] });
        cursor = match.index + match[0].length;
    }
    if (cursor < buf.length) events.push({ type: 'data', data: buf.slice(cursor) });
    return { events, hold };
}

// ---- Archivos de sesión (inicialización + banner de cada pestaña) ----
// Van a una carpeta temporal propia por PID: dos instancias de la app
// abiertas a la vez no deben pisarse los archivos ni borrárselos al salir.
let sessionDirPath = null;
function sessionDir() {
    if (!sessionDirPath) {
        sessionDirPath = path.join(app.getPath('temp'), APP_IDENTITY.slug, String(process.pid));
        fs.mkdirSync(sessionDirPath, { recursive: true });
    }
    return sessionDirPath;
}

// El banner lo imprime la SHELL (`type`/`cat`), no la app, y en cmd.exe eso
// significa pasar por la página de códigos OEM de la consola (850 en un
// Windows en español), donde un archivo UTF-8 se vería como galimatías. Se
// reduce a ASCII: se quitan las tildes y los caracteres de dibujo de cajas,
// que es lo único no ASCII que genera systemInfo.js. Las secuencias de color
// son ASCII y se conservan.
function toConsoleAscii(text) {
    return text
        .replace(/[─━]/g, '-')   // ─ ━
        .replace(/[│┃]/g, '|')   // │ ┃
        .replace(/[▶►]/g, '>')   // ▶ ►
        // El punto medio separa etiquetas por toda la app ("Git Bash · bash").
        // Sin esta línea acababa como "?" en la consola, que es justo lo que
        // el resto de la función intenta evitar.
        .replace(/[·•]/g, '-')
        // Descompone las letras acentuadas y quita las tildes sueltas
        // (á -> a), en vez de convertirlas en un signo de interrogación.
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\x00-\x7f]/g, '?');
}

// Escribe el banner y el archivo de inicialización de una pestaña. Devuelve
// la línea corta que hay que teclear en la shell para cargarlo, o null si
// este entorno no lleva inicialización (o si el temporal no es escribible:
// en ese caso la terminal funciona igual, solo se queda sin alias).
function writeSessionFiles(tab, env, scriptAliases) {
    let bannerPath = null;
    let bannerClearPath = null;
    const showBanner = sanitizePreferences(settingsStore.loadSettings()).showSystemBanner;
    const bannerText = showBanner
        ? '\r\n' + buildBanner(env.label, APP_IDENTITY.name, translate)
            + (env.note ? `\x1b[33m${env.note}\x1b[0m\r\n\r\n` : '')
        : '';

    if (showBanner) try {
        // Dos versiones del banner. La normal la usa "sysinfo", que solo
        // imprime. La de limpieza lleva delante un borrado explícito de
        // pantalla e historial: tras un `cls`, ConPTY repinta la línea del
        // prompt anterior, y sin esto quedaba flotando encima del banner.
        bannerPath = path.join(sessionDir(), `banner-${tab.id}.txt`);
        fs.writeFileSync(bannerPath, toConsoleAscii(bannerText), 'utf8');

        bannerClearPath = path.join(sessionDir(), `bannerclear-${tab.id}.txt`);
        fs.writeFileSync(bannerClearPath, '\x1b[H\x1b[2J\x1b[3J' + toConsoleAscii(bannerText), 'utf8');
    } catch (e) {
        logger.warn('No se pudo escribir el banner de la pestaña', { tabId: tab.id, error: e.message });
        bannerPath = null;
        bannerClearPath = null;
    }

    // Docker, ADB y Wine no llegan a los temporales del host: allí el banner
    // lo escribe la app en el xterm y no se intenta cargar inicialización
    // ninguna (ver transportLoadsHostFiles en aliasProfiles.js).
    const loadsHostFiles = transportLoadsHostFiles(env.transport);
    // Ruta de la ayuda de `ayuda`. Se decide antes de generar el script
    // porque el alias tiene que referenciarla, y el contenido llega después:
    // solo buildInitScript sabe qué scripts se han registrado de verdad.
    let helpPath = null;
    if (loadsHostFiles) {
        try {
            helpPath = path.join(sessionDir(), `help-${tab.id}.txt`);
        } catch (e) {
            logger.warn('No se pudo preparar el archivo de ayuda de la pestaña', { tabId: tab.id, error: e.message });
            helpPath = null;
        }
    }
    const windowsManager = windowsPackageManager();
    const script = loadsHostFiles
        ? buildInitScript(env.kind, {
            nsudoPath,
            scriptAliases,
            bannerPath,
            bannerClearPath,
            helpPath,
            transport: env.transport,
            appName: APP_IDENTITY.name,
            envLabel: env.label,
            managerLabel: windowsManager && WINDOWS_MANAGERS[windowsManager]
                ? WINDOWS_MANAGERS[windowsManager].label
                : null,
            t: translate,
            platform: process.platform,
            windowsManager
        })
        : null;
    if (!script) return { initCommand: null, bannerPath, bannerText };

    if (helpPath && script.helpText) {
        try {
            // Solo cmd y Windows PowerShell leen el archivo en la página de
            // códigos de la consola, donde un UTF-8 se ve como galimatías.
            // bash, zsh, fish y WSL lo imprimen bien con `cat`, así que ahí
            // la ayuda conserva sus tildes en vez de quedar en "Sesion".
            const needsAscii = env.kind === 'cmd' || env.kind === 'powershell';
            fs.writeFileSync(helpPath, needsAscii ? toConsoleAscii(script.helpText) : script.helpText, 'utf8');
        } catch (e) {
            // Sin archivo de ayuda la sesión funciona igual: `ayuda` imprimirá
            // el archivo vacío en vez del resumen. No se aborta por esto.
            logger.warn('No se pudo escribir la ayuda de la pestaña', { tabId: tab.id, error: e.message });
        }
    }

    try {
        const initPath = path.join(sessionDir(), `init-${tab.id}.${script.ext}`);
        fs.writeFileSync(initPath, script.content, 'utf8');
        return { initCommand: buildInitInvocation(env.kind, initPath, env.transport), bannerPath, bannerText };
    } catch (e) {
        logger.warn('No se pudo escribir la inicializacion de la pestaña', { tabId: tab.id, error: e.message });
        return { initCommand: null, bannerPath, bannerText };
    }
}

function removeSessionFiles(tabId) {
    if (!sessionDirPath) return;
    try {
        fs.readdirSync(sessionDirPath)
            .filter((name) => name.includes(`-${tabId}.`))
            .forEach((name) => fs.rmSync(path.join(sessionDirPath, name), { force: true }));
    } catch (e) {
        // Carpeta ya borrada o sin permisos: son temporales, no pasa nada.
    }
}

function killTabPty(tab) {
    tab.ptyGeneration = (tab.ptyGeneration || 0) + 1;
    const current = tab.ptyProcess;
    tab.ptyProcess = null;
    if (current) {
        try { current.kill(); } catch (e) { /* ya terminado */ }
    }
}

function spawnPtyForTab(windowState, tab, env, options) {
    const generation = (tab.ptyGeneration || 0) + 1;
    tab.ptyGeneration = generation;
    const homeCwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
    // La pestaña arranca donde estaba el usuario; ver main/spawnCwd.js para
    // los casos en los que heredar la carpeta no es posible.
    const spawnCwd = resolveSpawnCwd(options && options.initialCwd, env, homeCwd);
    // Tamaño de la ventana, no el 80x24 de manual. La shell escribe su banner
    // y su primer prompt en cuanto arranca, antes de que el renderer haya
    // podido medir nada; naciendo con el tamaño real, ese texto ya sale bien
    // colocado y no hay que reflujarlo después. En ConPTY además cada resize
    // es un repintado completo del buffer, así que evitarlo se nota.
    const viewport = windowState.viewport || DEFAULT_VIEWPORT;
    let ptyProcess;
    try {
        ptyProcess = pty.spawn(env.exe, env.args || [], {
            name: 'xterm-256color',
            cols: viewport.cols,
            rows: viewport.rows,
            cwd: spawnCwd,
            env: process.env,
            // Usa la DLL que node-pty distribuye para ConPTY. A diferencia
            // del backend del sistema, no lanza conpty_console_list_agent al
            // cerrar y evita su carrera AttachConsole. beforePack garantiza
            // que la DLL quede junto al módulo reconstruido para Electron.
            ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {})
        });
    } catch (err) {
        logger.error('No se pudo spawnear el pty', { tabId: tab.id, envId: env.id, exe: env.exe, error: err.message });
        tab.ptyProcess = null;
        sendToTab(windowState, tab, 'pty-data', `\r\n\x1b[31m[No se pudo iniciar ${env.label}: ${err.message}]\x1b[0m\r\n`);
        return false;
    }

    tab.ptyProcess = ptyProcess;
    tab.envId = env.id;
    tab.label = env.label;
    tab.markerCarry = '';
    tab.lastClearMarker = null;
    tab.outputBuffer = '';
    tab.cwdOutputBuffer = '';
    tab.lastMissingCommand = null;
    tab.cwd = spawnCwd;
    tab.hereScriptsDir = null;
    tab.hereManual = false;
    // La shell nueva no hereda la pausa que dejó pendiente la anterior.
    tab.awaitingPause = false;

    logger.info('pty spawneado', { tabId: tab.id, envId: env.id, label: env.label, exe: env.exe, generation, cwd: spawnCwd });

    const scriptAliases = resolveScriptAliases(listAllScripts(scriptsFolder), env.kind);
    const { initCommand: initCmd, bannerText } = writeSessionFiles(tab, env, scriptAliases);

    function isCurrentPty() {
        return tab.ptyGeneration === generation && tab.ptyProcess === ptyProcess;
    }

    function handlePtyData(data) {
        if (!data || !isCurrentPty()) return;
        sendToTab(windowState, tab, 'pty-data', data);

        tab.outputBuffer = (tab.outputBuffer + data).slice(-4000);
        tab.cwdOutputBuffer = (tab.cwdOutputBuffer + data).slice(-12000);
        const nextCwd = detectCurrentDirectory(tab.cwdOutputBuffer, env, tab.cwd);
        if (nextCwd && nextCwd !== tab.cwd) tab.hereManual = false;
        tab.cwd = nextCwd;

        const missing = detectMissingCommand(tab.outputBuffer);
        if (missing && missing !== tab.lastMissingCommand) {
            tab.lastMissingCommand = missing;
            const suggestion = resolveToolSuggestion(missing, process.platform, {
                transport: env.transport,
                distro: env.distro
            });
            if (suggestion) {
                logger.info('Comando no encontrado', { tabId: tab.id, ...suggestion });
                sendToTab(windowState, tab, 'command-not-found', suggestion);
            }
        }
    }

    ptyProcess.onData((raw) => {
        if (!isCurrentPty()) return;
        const { events, hold } = splitOnClearMarker(tab.markerCarry, raw);
        tab.markerCarry = hold;
        events.forEach((event) => {
            if (!isCurrentPty()) return;
            if (event.type === 'clear') {
                // Una reemisión del mismo título no es una limpieza nueva.
                // Sin esto, cada proceso hijo que restaura el título de la
                // consola al terminar borraba la salida que acababa de dejar.
                if (event.marker && event.marker === tab.lastClearMarker) return;
                tab.lastClearMarker = event.marker || null;
                // El marcador se emite antes del clear nativo: se elimina la
                // pantalla anterior antes de que ConPTY pinte banner/prompt.
                sendToTab(windowState, tab, 'pty-clear', null);
                tab.outputBuffer = '';
                tab.cwdOutputBuffer = '';
            } else {
                handlePtyData(event.data);
            }
        });
    });

    const startedAt = Date.now();
    ptyProcess.onExit(({ exitCode }) => {
        if (!isCurrentPty()) {
            logger.debug('Salida ignorada de un pty reemplazado', { tabId: tab.id, envId: env.id, exitCode, generation });
            return;
        }
        tab.ptyProcess = null;
        const elapsedMs = Date.now() - startedAt;
        logger.info('pty finalizado', { tabId: tab.id, envId: env.id, exitCode, generation, elapsedMs });

        // Una sesión que se muere nada más nacer y con error no ha llegado a
        // ser usable: casi siempre es un entorno mal configurado (una distro
        // WSL que no arranca, un contenedor que sale al instante, un
        // dispositivo ADB que rechaza la shell). Ahí la pestaña se queda
        // abierta con el código a la vista, porque cerrarla haría desaparecer
        // la única pista de qué ha pasado.
        if (exitCode !== 0 && elapsedMs < FAILED_SESSION_MS) {
            sendToTab(windowState, tab, 'pty-exit', exitCode);
            return;
        }

        // El caso normal: el usuario escribió `exit` (o Ctrl+D). La pestaña se
        // cierra sola, como en cualquier terminal, y con la última se cierra
        // la aplicación.
        closeTab(windowState, tab.id, `la shell terminó con código ${exitCode}`);
    });

    if (initCmd) {
        writeToPty(tab, initCmd + '\r', ptyProcess);
    } else {
        sendToTab(windowState, tab, 'pty-data', bannerText);
    }
    return true;
}

let tabCounter = 0;
function createTab(windowState, env, options) {
    tabCounter += 1;
    const tab = {
        id: 'tab-' + tabCounter,
        ptyProcess: null,
        envId: null,
        label: env.label,
        outputBuffer: '',
        lastMissingCommand: null,
        ptyGeneration: 0,
        cwd: null,
        hereScriptsDir: null,
        hereManual: false,
        // El renderer aun no tiene un xterm para esta pestaña: todo lo que
        // salga del pty se acumula hasta que avise con tabs:ready.
        ready: false,
        pendingOutput: []
    };
    windowState.tabs.set(tab.id, tab);
    windowState.activeTabId = tab.id;
    spawnPtyForTab(windowState, tab, env, options);
    return tab;
}

// Directorio de la pestaña desde la que se pide algo: una pestaña nueva se
// abre donde estaba el usuario, no en su carpeta personal.
function activeTabCwd(windowState) {
    const active = windowState.activeTabId && windowState.tabs.get(windowState.activeTabId);
    return active ? active.cwd : null;
}

function publicTab(tab) {
    return tab ? { id: tab.id, label: tab.label, envId: tab.envId } : null;
}

function findOrCreateTabForEnvironment(windowState, env) {
    const existing = Array.from(windowState.tabs.values()).find((tab) => tab.envId === env.id && tab.ptyProcess);
    if (existing) {
        windowState.activeTabId = existing.id;
        return { tab: existing, created: false };
    }
    return { tab: createTab(windowState, env, { initialCwd: activeTabCwd(windowState) }), created: true };
}

function defaultEnvFor(windowState) {
    const preferredId = sanitizePreferences(settingsStore.loadSettings()).defaultEnvironmentId;
    const preferred = preferredId && windowState.envs.find((env) => env.id === preferredId && env.available !== false);
    if (preferred) return preferred;
    const defaultId = getDefaultEnvId(windowState.envs);
    return windowState.envs.find((e) => e.id === defaultId) || windowState.envs[0] || null;
}

// Icono de la ventana (barra de tareas / alt-tab). En el .exe empaquetado
// Windows ya usa el icono del propio ejecutable, pero en desarrollo y en
// Linux hay que indicarlo explícitamente. Si el archivo no está, se deja el
// icono por defecto de Electron en vez de fallar.
function windowIconPath() {
    const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    const iconPath = path.join(__dirname, 'build', file);
    return fs.existsSync(iconPath) ? iconPath : undefined;
}

async function createWindow() {
    // Solo shells locales rápidas antes de crear la ventana. WSL, Docker y
    // ADB se incorporan en segundo plano, sin congelar la primera pintura.
    const { envs, pkgManager } = await getInitialEnvironments();

    const win = new BrowserWindow({
        show: !HEADLESS_TEST,
        width: 980,
        height: 640,
        minWidth: 480,
        minHeight: 300,
        title: APP_IDENTITY.name,
        icon: windowIconPath(),
        backgroundColor: '#0d0d0d',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // preload.js solo usa contextBridge/ipcRenderer (nada mas de
            // Node), asi que puede correr sandboxed sin perder nada: mas
            // aislamiento del contenido web frente al proceso principal.
            sandbox: true
        }
    });

    // La aplicación no navega ni crea contenido web externo. Bloquear ambas
    // superficies evita que una inyección en el renderer convierta esta
    // terminal privilegiada en un navegador con APIs IPC disponibles.
    win.webContents.on('will-navigate', (event, targetUrl) => {
        if (targetUrl !== RENDERER_URL) {
            event.preventDefault();
            logger.warn('Navegación bloqueada', { targetUrl: String(targetUrl).slice(0, 1000) });
        }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        logger.warn('Nueva ventana bloqueada', { url: String(url).slice(0, 1000) });
        return { action: 'deny' };
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());

    /** @type {WindowState} */
    const windowState = {
        win, tabs: new Map(), activeTabId: null, envs, pkgManager,
        // Tamaño con el que se abrió la ventana la última vez: la primera
        // sesión nace ya con él y no hay que reflujar su banner.
        viewport: (() => {
            const saved = sanitizePreferences(settingsStore.loadSettings());
            return { cols: saved.viewportCols, rows: saved.viewportRows };
        })(),
        installActions: [], allowedFileItems: new Map(), allowedGithubRepos: new Map()
    };
    windows.set(win.id, windowState);

    const defaultEnv = defaultEnvFor(windowState);
    if (defaultEnv) createTab(windowState, defaultEnv);

    if (HEADLESS_TEST) {
        windowState.smokeTimer = setTimeout(() => {
            logger.error('Prueba Electron agotó el tiempo esperando al renderer');
            process.exitCode = 1;
            app.quit();
        }, INTEGRATION_TEST ? 45000 : 20000);
        win.webContents.once('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
            if (isMainFrame === false) return;
            logger.error('Smoke test falló al cargar el renderer', { code, description });
            clearTimeout(windowState.smokeTimer);
            process.exitCode = 1;
            app.quit();
        });
    }

    win.loadFile(RENDERER_PATH);

    win.on('closed', () => {
        const ws = windows.get(win.id);
        if (ws) {
            if (ws.smokeTimer) clearTimeout(ws.smokeTimer);
            ws.tabs.forEach((tab) => {
                killTabPty(tab);
            });
        }
        windows.delete(win.id);
    });
}

app.whenReady().then(async () => {
    // WinSlim no usa cámara, geolocalización, notificaciones ni otros
    // permisos Chromium: política de denegación explícita.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    // El idioma se resuelve antes de crear la ventana: el banner de la primera
    // pestaña ya sale traducido.
    refreshLanguage();
    logger.info('App lista', { platform: process.platform, version: app.getVersion() });
    await createWindow();

    // No se espera (la ventana ya está usable): Docker Desktop puede tardar
    // un minuto largo en arrancar, y cuando esté listo el selector de
    // entornos se actualiza solo.
    if (!HEADLESS_TEST) {
        getEnvironments(false).then((fresh) => {
            broadcastEnvironments(fresh);
            return ensureDockerRunning();
        }).catch((e) => logger.error('Detección completa de entornos falló', e));
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
    // Los archivos de inicialización/banner de esta ejecución ya no le
    // sirven a nadie: se borra la carpeta entera (es la de ESTE pid, así que
    // no se toca la de otra instancia abierta).
    if (sessionDirPath) {
        try { fs.rmSync(sessionDirPath, { recursive: true, force: true }); } catch (e) { /* temporales */ }
    }
    logger.banner(`${APP_IDENTITY.name} cerrada`);
});

function stateFromEvent(event) {
    if (!event || !event.sender || !event.senderFrame) return null;
    // Solo el frame principal local empaquetado puede invocar privilegios.
    // Un iframe inyectado dentro de la misma BrowserWindow no hereda IPC.
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== RENDERER_URL) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    return windows.get(win.id) || null;
}

function tabFromEvent(event, tabId) {
    const ws = stateFromEvent(event);
    if (!ws) return null;
    const tab = ws.tabs.get(tabId);
    if (!tab) return null;
    return { ws, tab };
}

// Idioma activo del proceso principal. Se recalcula al guardar preferencias,
// no en cada llamada: lo consultan sitios calientes como el banner de cada
// pestaña nueva, y leer settings.json ahí no aporta nada.
let translate = createTranslator('es');

function refreshLanguage() {
    const preference = sanitizePreferences(settingsStore.loadSettings()).language;
    const language = resolveLanguage(preference, app.getLocale());
    if (language !== translate.language) {
        translate = createTranslator(language);
        logger.info('Idioma de la interfaz', { preference, language, systemLocale: app.getLocale() });
    }
    return translate;
}

function preferencesState(ws) {
    const preferences = sanitizePreferences(settingsStore.loadSettings());
    return {
        ...preferences,
        languages: LANGUAGES,
        // El renderer recibe el catálogo ya resuelto: no elige idioma ni ve
        // los demás. Cambiarlo en Ajustes devuelve este mismo bloque, así que
        // la interfaz se puede repintar sin reiniciar la aplicación.
        i18n: catalogFor(resolveLanguage(preferences.language, app.getLocale())),
        appIdentity: {
            name: APP_IDENTITY.name,
            slug: APP_IDENTITY.slug,
            platform: process.platform,
            version: app.getVersion()
        },
        credits: {
            developers: projectCatalog.developers.slice(),
            // Perfiles oficiales del catálogo: dueños del proyecto WinSlim,
            // además de desarrolladores.
            owners: projectCatalog.owners.slice()
        },
        themes: THEME_PRESETS,
        fontFamilies: FONT_FAMILIES,
        settingsPath: settingsStore.settingsPath(),
        environments: ws
            ? ws.envs.filter((env) => env.available !== false).map(({ id, label }) => ({ id, label }))
            : []
    };
}

// Preferencias: el proceso principal valida todos los valores antes de
// persistirlos. El renderer nunca puede introducir claves arbitrarias.
ipcMain.handle('settings:get', (event) => preferencesState(stateFromEvent(event)));

ipcMain.handle('settings:save', (event, patch) => {
    const ws = stateFromEvent(event);
    if (!ws || !patch || typeof patch !== 'object') return { ok: false, error: 'Preferencias no válidas.' };
    const preferences = sanitizePreferences({ ...settingsStore.loadSettings(), ...patch });
    if (preferences.defaultEnvironmentId
        && !ws.envs.some((env) => env.id === preferences.defaultEnvironmentId && env.available !== false)) {
        return { ok: false, error: 'El entorno inicial seleccionado ya no está disponible.' };
    }
    const saved = settingsStore.saveSettings(preferences);
    if (!saved) return { ok: false, error: 'No se pudo guardar settings.json. Revisa los logs.' };
    hereSearchDepth = preferences.scriptsHereDepth;
    refreshLanguage();
    logger.info('Preferencias actualizadas', preferences);
    return { ok: true, state: preferencesState(ws) };
});

ipcMain.handle('settings:reset', (event) => {
    const ws = stateFromEvent(event);
    if (!ws) return { ok: false, error: translate('error.invalidWindow', null, 'Ventana no válida.') };
    const saved = settingsStore.saveSettings(DEFAULT_PREFERENCES);
    if (!saved) return { ok: false, error: 'No se pudo restablecer settings.json.' };
    hereSearchDepth = DEFAULT_PREFERENCES.scriptsHereDepth;
    refreshLanguage();
    logger.info('Preferencias restablecidas');
    return { ok: true, state: preferencesState(ws) };
});

// La prueba de humo no da por válida una simple navegación: exige que el
// preload, el renderer y la carga inicial de pestañas hayan terminado.
ipcMain.on('app:renderer-ready', async (event) => {
    const ws = stateFromEvent(event);
    if (!ws || !HEADLESS_TEST) return;
    if (ws.smokeTimer) clearTimeout(ws.smokeTimer);
    if (SMOKE_TEST) {
        logger.info('Smoke test completado: renderer y PTY iniciados');
        setTimeout(() => app.quit(), 800);
        return;
    }
    try {
        const result = await event.sender.executeJavaScript(`(async () => {
            const initial = await window.terminalAPI.listTabs();
            const first = initial.tabs[0];
            if (!first) throw new Error('No existe la pestaña inicial');
            const inventory = await window.terminalAPI.refreshEnvironments(first.id);
            const alternative = inventory.envs.find((env) => env.available !== false && env.id !== first.envId) || inventory.envs[0];
            if (!alternative) throw new Error('No existe un entorno alternativo');
            const second = await window.terminalAPI.createTab(alternative.id);
            if (!second) throw new Error('No se pudo crear la segunda pestaña');
            const switched = await window.terminalAPI.switchEnvironment(second.id, first.envId);
            const components = await window.terminalAPI.listInstallActions();
            return { tabs: (await window.terminalAPI.listTabs()).tabs.length, switched, actions: components.actions.length, components: components.components.length };
        })()`);
        if (!result || result.tabs < 2 || !result.switched || !result.switched.ok || result.components < 1) {
            throw new Error('Resultado de integración incompleto: ' + JSON.stringify(result));
        }
        logger.info('Integración Electron completada', result);
    } catch (error) {
        logger.error('Integración Electron falló', error);
        process.exitCode = 1;
    }
    setTimeout(() => app.quit(), 500);
});

// ---- Pestañas ----
ipcMain.handle('tabs:list', (event) => {
    const ws = stateFromEvent(event);
    if (!ws) return { tabs: [], activeTabId: null };
    return {
        tabs: Array.from(ws.tabs.values()).map(({ id, label, envId }) => ({ id, label, envId })),
        activeTabId: ws.activeTabId
    };
});

ipcMain.handle('tabs:create', (event, requestedEnvId) => {
    const ws = stateFromEvent(event);
    if (!ws) return null;
    const env = typeof requestedEnvId === 'string'
        ? ws.envs.find((candidate) => candidate.id === requestedEnvId && candidate.available !== false)
        : defaultEnvFor(ws);
    if (!env) return null;
    // La pestaña nueva hereda el directorio de la que estaba en uso: abrir WSL
    // desde un cmd situado en C:\proyecto empieza en /mnt/c/proyecto.
    const tab = createTab(ws, env, { initialCwd: activeTabCwd(ws) });
    logger.info('Pestaña creada', { tabId: tab.id, envId: env.id });
    return { id: tab.id, label: tab.label, envId: tab.envId };
});

// Cierre de una pestaña, tanto si lo pide el usuario con la ✕ como si la
// shell termina sola (`exit`, Ctrl+D, o el proceso que se cae). Las dos cosas
// dejan lo mismo: una pestaña sin sesión detrás, que no sirve para nada.
function closeTab(ws, tabId, reason) {
    const tab = ws.tabs.get(tabId);
    if (!tab) return;
    killTabPty(tab);
    ws.tabs.delete(tabId);
    // La carpeta que el explorador estaba enseñando para ESTA pestaña deja de
    // existir con ella. Sin borrarla, el Map crecía con una entrada por cada
    // pestaña abierta y cerrada durante toda la vida de la ventana.
    if (ws.explorerDirs) ws.explorerDirs.delete(tabId);
    removeSessionFiles(tabId);
    logger.info('Pestaña cerrada', { tabId, reason });

    if (ws.tabs.size === 0) {
        // Sin pestañas no queda nada útil que mostrar: se cierra la ventana,
        // igual que la mayoría de terminales con pestañas. No hace falta
        // avisar al renderer: la ventana entera va a desaparecer. Y si era la
        // última ventana, window-all-closed cierra la aplicación.
        ws.win.close();
        return;
    }
    if (ws.activeTabId === tabId) {
        ws.activeTabId = ws.tabs.keys().next().value;
    }
    // El renderer no sabe que la pestaña se cerro hasta que se lo confirmamos
    // (matar el pty no genera por si solo una señal distinguible de "cierre
    // pedido por el usuario" vs. "el proceso simplemente termino").
    if (!ws.win.isDestroyed()) {
        ws.win.webContents.send('tab-closed', tabId, ws.activeTabId);
    }
}

ipcMain.on('tabs:close', (event, tabId) => {
    const found = tabFromEvent(event, tabId);
    if (found) closeTab(found.ws, tabId, 'petición del usuario');
});

ipcMain.on('tabs:activate', (event, tabId) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return;
    found.ws.activeTabId = tabId;
});

// El renderer ya creo el xterm de esta pestaña: se le entrega todo lo que el
// pty haya escrito mientras tanto (banner + primer prompt de la shell).
ipcMain.on('tabs:ready', (event, tabId) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return;
    flushPendingOutput(found.ws, found.tab);
});

// Escribir en un pty cuyo proceso acaba de morir lanza EPIPE, y como ocurre
// dentro de un callback asíncrono de node-pty tumbaría la app entera. Puede
// pasar en carreras normales: el usuario teclea justo cuando la shell sale,
// o un panel lanza un comando en una pestaña que se está cerrando.
function writeToPty(tab, data, ptyProcess) {
    const target = ptyProcess || (tab && tab.ptyProcess);
    if (!target) return false;
    try {
        target.write(data);
        return true;
    } catch (e) {
        logger.warn('No se pudo escribir en el pty (proceso terminado)', { tabId: tab.id, error: e.message });
        return false;
    }
}

// Escribe un comando completo en nombre de un panel (dependencias, scripts,
// proyectos, explorador).
//
// Las acciones del panel terminan en una pausa (`read`, `pause`) para que su
// salida se pueda leer. Mientras esa pausa sigue ahí, la shell no está
// esperando un comando sino una respuesta: el comando siguiente se consumía
// como tal y no llegaba a ejecutarse nunca. Se veía en la propia terminal,
// pegado al mensaje: "Pulsa Enter para volver a la terminal wine cmd /c ver".
// Un Enter previo cierra la pausa pendiente antes de escribir nada.
function writeCommandToPty(tab, command) {
    const prefix = tab.awaitingPause ? '\r' : '';
    tab.awaitingPause = false;
    return writeToPty(tab, prefix + command + '\r');
}

// El tamaño se persiste para la PRÓXIMA ejecución: la primera pestaña se crea
// antes de que exista el renderer, así que sin esto siempre nacería a 80x24 y
// su banner tendría que reflujarse en cuanto la ventana se midiera.
//
// Redimensionar una ventana genera decenas de eventos, así que no se escribe
// en cada uno: se apunta el último y se guarda cuando la cosa se calma.
let pendingViewport = null;
let viewportSaveTimer = null;
function rememberViewport(cols, rows) {
    const saved = sanitizePreferences(settingsStore.loadSettings());
    if (saved.viewportCols === cols && saved.viewportRows === rows) return;
    pendingViewport = { viewportCols: cols, viewportRows: rows };
    if (viewportSaveTimer) return;
    viewportSaveTimer = setTimeout(() => {
        viewportSaveTimer = null;
        const patch = pendingViewport;
        pendingViewport = null;
        if (patch && !settingsStore.saveSettings(patch)) {
            logger.debug('No se pudo recordar el tamaño de la terminal', patch);
        }
    }, 1500);
}

// ---- Entrada del usuario (teclado/pegado) hacia el pty de la pestaña ----
ipcMain.on('pty-input', (event, tabId, data) => {
    const found = tabFromEvent(event, tabId);
    if (found && typeof data === 'string' && data.length <= MAX_PTY_INPUT_CHARS) {
        // El usuario contesta a la pausa por su cuenta la mayoría de las veces.
        if (data.includes('\r') || data.includes('\n')) found.tab.awaitingPause = false;
        writeToPty(found.tab, data);
    }
});

ipcMain.on('pty-resize', (event, tabId, cols, rows) => {
    const found = tabFromEvent(event, tabId);
    const safeCols = Number.isFinite(cols) ? Math.floor(cols) : 0;
    const safeRows = Number.isFinite(rows) ? Math.floor(rows) : 0;
    if (!found || safeCols < 1 || safeCols > 1000 || safeRows < 1 || safeRows > 500) return;

    // El último tamaño medido por el renderer es con el que nacerán las
    // sesiones siguientes de esta ventana (ver spawnPtyForTab). Se guarda
    // aunque el pty ya no esté: sigue siendo el tamaño de la ventana.
    found.ws.viewport = { cols: safeCols, rows: safeRows };
    rememberViewport(safeCols, safeRows);
    if (!found.tab.ptyProcess) return;
    try {
        found.tab.ptyProcess.resize(safeCols, safeRows);
    } catch (e) {
        logger.debug('Resize PTY ignorado durante una transición', { tabId, cols: safeCols, rows: safeRows, error: e.message });
    }
});

// ---- Entornos (shells) ----
ipcMain.handle('env:list', (event, tabId) => {
    const ws = stateFromEvent(event);
    if (!ws) return { envs: [], currentEnvId: null };
    const tab = ws.tabs.get(tabId);
    return {
        envs: ws.envs.map(publicEnvironment),
        currentEnvId: tab ? tab.envId : null
    };
});

ipcMain.handle('env:refresh', async (event, tabId) => {
    const ws = stateFromEvent(event);
    if (!ws) return { envs: [], currentEnvId: null };
    const fresh = await getEnvironments(true);
    broadcastEnvironments(fresh);
    const tab = ws.tabs.get(tabId);
    return {
        envs: fresh.envs.map(publicEnvironment),
        currentEnvId: tab ? tab.envId : null
    };
});

function sendEnvChanged(ws, tabId, env) {
    if (ws.win.isDestroyed()) return;
    ws.win.webContents.send('env-changed', tabId, { id: env.id, label: env.label });
}

ipcMain.handle('env:switch', (event, tabId, envId) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: 'Pestaña no válida.' };
    const { ws, tab } = found;
    const env = ws.envs.find((e) => e.id === envId);
    if (!env || env.available === false) return { ok: false, error: translate('env.unavailable', null, 'El entorno ya no está disponible.') };
    if (tab.envId === env.id && tab.ptyProcess) return { ok: true, currentEnvId: tab.envId };

    logger.info('Cambio de entorno', { tabId, from: tab.envId, to: env.id });
    const previous = ws.envs.find((candidate) => candidate.id === tab.envId);
    // Cambiar de entorno conserva la carpeta: la misma pestaña sigue donde
    // estaba, solo cambia la shell que la atiende.
    const keepCwd = { initialCwd: tab.cwd };
    killTabPty(tab);
    // El aviso va ANTES de arrancar la sesión nueva. El renderer vacía el
    // xterm al recibirlo, y en Docker, ADB y Wine el banner lo escribe
    // spawnPtyForTab directamente en la pestaña: avisando después se borraba
    // justo lo que se acababa de pintar, y esos tres entornos aparecían sin
    // banner mientras el resto lo mostraba. En las shells con archivo de
    // inicialización no se notaba porque el banner llega mucho más tarde, ya
    // impreso por la propia shell.
    sendEnvChanged(ws, tabId, env);
    if (!spawnPtyForTab(ws, tab, env, keepCwd)) {
        if (previous && previous.available !== false) {
            sendEnvChanged(ws, tabId, previous);
            spawnPtyForTab(ws, tab, previous, keepCwd);
        }
        return { ok: false, error: translate('env.switchFailed', { label: env.label }, 'No se pudo iniciar {label}.'), currentEnvId: tab.envId };
    }
    return { ok: true, currentEnvId: env.id };
});

// Decide qué acciones tienen sentido en ESTE sistema ahora mismo:
//   - checkCmd: la herramienta ya está instalada -> se oculta "Instalar X".
//   - requiresCmd: la herramienta no está instalada -> se ocultan sus
//     acciones de actualizar/verificar/usar.
// Así, de cada herramienta solo se ve el botón "Instalar" (antes) o el de
// "Actualizar"/"Ver" (después), nunca los dos.
//
// Cada comprobación lanza un `where`/`which`, así que los resultados se
// memorizan por llamada: varias acciones comparten el mismo comando.
// Arch no empaqueta PowerShell: está en el AUR, al que se llega con un
// asistente externo. Cuál hay instalado decide qué acciones tienen sentido
// ofrecer (ver powerShellActions en installActions.js).
function detectAurHelper() {
    if (process.platform !== 'linux') return null;
    return ['paru', 'yay'].find((helper) => isToolInstalled(helper)) || null;
}

// Contexto del sistema que necesita el catálogo de acciones para no ofrecer
// nada imposible. Se calcula igual desde install:list y desde install:run,
// para que la acción que se ejecuta sea exactamente la que se mostró.
async function installActionsContext() {
    return {
        platform: process.platform,
        wsl: process.platform === 'win32' ? await getWslContextAsync() : null,
        hasSnap: process.platform === 'linux' && isToolInstalled('snap'),
        aurHelper: detectAurHelper(),
        projectsFolder
    };
}

function filterAvailableActions(actions) {
    const checked = new Map();
    const installed = (cmd) => {
        if (!checked.has(cmd)) checked.set(cmd, isToolInstalled(cmd));
        return checked.get(cmd);
    };
    return actions.filter((a) => {
        if (a.checkCmd && installed(a.checkCmd)) return false;
        if (a.requiresCmd && !installed(a.requiresCmd)) return false;
        return true;
    }).map((a) => ({
        // Una acción que ha sobrevivido al filtro ya dice por sí misma en qué
        // estado está su herramienta: si pedía `requiresCmd` es que está
        // instalada, y si pedía `checkCmd` es que no. El panel lo usa para
        // ordenar (lo instalado arriba) sin repetir ni un solo `where`/`which`.
        ...a,
        installed: typeof a.installed === 'boolean'
            ? a.installed
            : (a.requiresCmd ? true : (a.checkCmd ? false : null))
    }));
}

// ---- Entorno y dependencias adicionales ----
ipcMain.handle('install:list', async (event) => {
    const ws = stateFromEvent(event);
    if (!ws) return { actions: [], components: [] };

    // Lo que se instaló desde este mismo panel dejó su carpeta en el PATH
    // persistente, pero no en el que la app heredó al arrancar. Se
    // re-sincroniza aquí para que la lista refleje lo que hay de verdad (el
    // botón "Instalar X" desaparece en cuanto X existe) sin reiniciar la
    // app; y si el PATH cambió, se vuelven a detectar los entornos, porque
    // la herramienta nueva puede aportar entornos propios (dispositivos ADB,
    // contenedores Docker, distros WSL...).
    clearWhichCache();
    const { changed, added } = refreshSystemPath();
    if (changed) {
        logger.info('PATH del proceso actualizado desde el sistema', { added });
        broadcastEnvironments(await getEnvironments(true));
    }

    const context = await installActionsContext();
    const wsl = context.wsl;
    if (wsl && wsl.available) {
        const currentIds = new Set(((cachedEnvironments && cachedEnvironments.envs) || []).map((env) => env.id));
        const hasUndisclosedShell = wsl.installed.some((distro) =>
            (distro.shells || []).some((shellName) =>
                shellName !== distro.shell && !currentIds.has(`wsl:${distro.name}:${shellName}`)));
        if (hasUndisclosedShell) cachedEnvironments = null;
    }
    // El panel representa el estado actual, no la instantánea del arranque:
    // confirma daemon, contenedores y binarios antes de decidir qué ofrecer.
    const current = await getEnvironments(true);
    broadcastEnvironments(current);
    const pkgManager = current.pkgManager || ws.pkgManager || null;
    // El catálogo se genera en español y se traduce aquí, en la frontera con
    // el renderer: las acciones conservan su id, su comando y su orden, que es
    // lo que el resto del sistema usa para identificarlas.
    let actions = filterAvailableActions(getInstallActions({ ...context, pkgManager, t: translate }))
        .map((action) => ({
            ...translateAction(translate.language, action),
            groupKey: groupKeyFor(action.group)
        }));
    if (current.docker && current.docker.daemonReady) {
        actions = actions.filter((action) => !action.id.startsWith('docker-start-'));
    }
    if (ws) ws.installActions = actions;

    // El resumen de arriba del panel enseña lo que ESTE sistema puede tener.
    // WSL solo existe en Windows: en Linux/macOS ocupa su sitio la
    // compatibilidad en sentido contrario (Wine para cmd.exe, PowerShell).
    const t = translate;
    const noInstalado = t('deps.summaryNone', null, 'No instalado');
    const compatibilityChip = () => {
        if (process.platform === 'win32') {
            const count = wsl && wsl.available ? wsl.installed.length : 0;
            return {
                label: t('deps.summaryWsl', null, 'WSL'),
                value: wsl && wsl.available
                    ? t(count === 1 ? 'deps.summaryWslCount' : 'deps.summaryWslCountPlural',
                        { count }, count === 1 ? '{count} distro' : '{count} distros')
                    : noInstalado
            };
        }
        const present = [
            isToolInstalled('wine') ? 'cmd (Wine)' : null,
            isToolInstalled('pwsh') ? 'PowerShell' : null
        ].filter(Boolean);
        return {
            label: t('deps.summaryCompat', null, 'Compatibilidad Windows'),
            value: present.length ? present.join(' + ') : t('deps.summaryCompatNone', null, 'No instalada')
        };
    };

    const dockerChip = () => {
        if (!current.docker || !current.docker.installed) return noInstalado;
        if (!current.docker.daemonReady) return t('deps.summaryDockerStopped', null, 'Instalado, detenido');
        const running = current.docker.containerCount || 0;
        if (!running) return t('deps.summaryDockerReady', null, 'Listo');
        return t('deps.summaryDockerReadyCount', { count: running },
            running === 1 ? 'Listo ({count} activo)' : 'Listo ({count} activos)');
    };

    const languageCount = (current.envs || []).filter((env) => env.repl).length;
    const deviceCount = (current.android && current.android.deviceCount) || 0;
    const components = [
        {
            label: t('deps.summaryShells', null, 'Shells'),
            value: String((current.envs || []).filter((env) => env.group === 'Shells del sistema').length)
        },
        compatibilityChip(),
        { label: t('deps.summaryDocker', null, 'Docker'), value: dockerChip() },
        {
            label: t('deps.summaryAdb', null, 'ADB'),
            value: current.android && current.android.installed
                ? t(deviceCount === 1 ? 'deps.summaryAdbCount' : 'deps.summaryAdbCountPlural',
                    { count: deviceCount }, deviceCount === 1 ? '{count} dispositivo' : '{count} dispositivos')
                : noInstalado
        },
        {
            label: t('deps.summaryGit', null, 'Git'),
            // Con repositorios ya clonados, el resumen dice cuántos hay, igual
            // que Docker dice cuántos contenedores están en marcha.
            value: (() => {
                if (!isToolInstalled('git')) return noInstalado;
                const repos = countLocalRepositories(projectsFolder);
                if (!repos) return t('deps.summaryGitReady', null, 'Listo');
                return t(repos === 1 ? 'deps.summaryGitRepos' : 'deps.summaryGitReposPlural',
                    { count: repos }, repos === 1 ? 'Listo ({count} repo)' : 'Listo ({count} repos)');
            })()
        },
        {
            label: t('deps.summaryLanguages', null, 'Lenguajes'),
            value: languageCount
                ? t('deps.summaryLanguagesCount', { count: languageCount }, '{count} REPL')
                : t('deps.summaryLanguagesNone', null, 'Ninguno')
        }
    ];

    return { actions, components };
});

// Algunas acciones son scripts de PowerShell (cmdlets como
// Add-WindowsCapability, o descargas con Invoke-WebRequest). Hay que
// adaptarlos a la shell activa, y sobre todo evitar que ESA shell expanda
// las variables ($dest, $env:...) antes de pasárselas a PowerShell: en
// PowerShell y en bash, "$var" dentro de comillas dobles se interpola,
// lo que dejaría el script roto. Por eso cada familia usa su propio
// entrecomillado.
function wrapPowerShellCommand(psCommand, kind, transport) {
    // Ya estamos en PowerShell: se ejecuta tal cual, sin envolver nada.
    if (kind === 'powershell') return psCommand;

    // cmd.exe no expande "$", así que las comillas dobles son seguras
    // (los scripts de installActions.js no llevan comillas dobles dentro).
    if (kind === 'cmd') {
        return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCommand}"`;
    }

    // Shells unix sobre Windows (Git Bash, WSL, zsh...): comillas simples,
    // que no interpolan. WSL necesita el sufijo .exe para distinguir el
    // binario de Windows de un comando de Linux.
    const exe = transport === 'wsl' || kind === 'wsl' ? 'powershell.exe' : 'powershell';
    const quoted = kind === 'fish'
        ? "'" + psCommand.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
        : "'" + psCommand.replace(/'/g, `'\\''`) + "'";
    return `${exe} -NoProfile -ExecutionPolicy Bypass -Command ${quoted}`;
}

// Las acciones del panel informan por pantalla (versiones, listados, salida
// del instalador) y muchas terminan devolviendo el prompt al instante. Se
// añade una pausa explícita para que el usuario pueda leer el resultado y
// decida cuándo volver a la terminal.
const PAUSE_MESSAGE = 'Pulsa Enter para volver a la terminal';

function appendPause(command, kind) {
    if (kind === 'cmd') return `${command} & echo. & pause`;
    if (kind === 'powershell') return `${command}; Read-Host '${PAUSE_MESSAGE}' | Out-Null`;
    if (kind === 'fish') return `${command}; read -P '${PAUSE_MESSAGE} ' __wsterm_pause`;
    if (['bash', 'zsh', 'sh', 'ksh', 'wsl'].includes(kind)) {
        return `${command}; printf '\\n${PAUSE_MESSAGE} '; read __wsterm_pause`;
    }
    return command;
}

ipcMain.handle('install:run', async (event, tabId, actionId) => {
    const found = tabFromEvent(event, tabId);
    if (!found || !found.tab.ptyProcess) return { ok: false, error: translate('error.tabGone', null, 'La pestaña ya no está disponible.') };
    const { ws, tab } = found;
    const actions = ws.installActions && ws.installActions.length
        ? ws.installActions
        : getInstallActions({ ...(await installActionsContext()), pkgManager: ws.pkgManager, t: translate });
    const action = actions.find((a) => a.id === actionId);
    if (!action) return { ok: false, error: translate('error.actionGone', null, 'La acción ya no está disponible; refresca el panel.') };

    // Desde un REPL el comando iría al intérprete del lenguaje, no al sistema:
    // se reutiliza (o se abre) una pestaña con una shell de verdad.
    const requestedEnv = ws.envs.find((e) => e.id === tab.envId);
    let selected = { tab, created: false };
    let env = requestedEnv;
    if (!env || env.repl) {
        const shellEnv = preferredShellEnvironment(ws, null);
        if (!shellEnv) return { ok: false, error: translate('error.noShell', null, 'No hay una shell disponible para ejecutar esta acción.') };
        env = shellEnv;
        selected = findOrCreateTabForEnvironment(ws, shellEnv);
    }
    const kind = env ? env.kind : 'cmd';
    const baseCommand = action.shell === 'powershell'
        ? wrapPowerShellCommand(action.command, kind, env && env.transport)
        : action.command;
    const command = appendPause(baseCommand, kind);

    logger.info('Accion de instalacion ejecutada', { tabId: selected.tab.id, actionId: action.id, kind, command });
    // El comando se escribe en la terminal visible: el usuario ve exactamente
    // qué se ejecuta y conserva el control (puede cancelar con Ctrl+C, igual
    // que con cualquier otro comando).
    if (!writeCommandToPty(selected.tab, command)) return { ok: false, error: translate('error.writeFailed', null, 'No se pudo escribir en la terminal activa.') };
    // Esta acción deja la shell esperando un Enter: el próximo comando que
    // escriba un panel tendrá que cerrarlo antes.
    selected.tab.awaitingPause = command !== baseCommand;
    return { ok: true, actionId: action.id, tab: publicTab(selected.tab), created: selected.created };
});

// ---- Proyectos y repositorios GitHub ----
function projectPins() {
    return mergePins(projectCatalog, settingsStore.loadSettings());
}

function rememberGithubRepositories(ws, repositories) {
    repositories.forEach((repo) => {
        if (repo && repo.fullName) ws.allowedGithubRepos.set(repo.fullName.toLowerCase(), repo);
    });
    // Una búsqueda pública puede devolver hasta 100 repositorios. El tope
    // evita conservar indefinidamente perfiles consultados hace mucho.
    if (ws.allowedGithubRepos.size > 500) {
        const recent = Array.from(ws.allowedGithubRepos.entries()).slice(-300);
        ws.allowedGithubRepos = new Map(recent);
    }
}

function publicRepoState(repository) {
    const local = localRepositoryState(projectsFolder, repository);
    return {
        ...repository,
        local: local ? local.repositoryExists : false,
        localConflict: local ? (local.exists && !local.repositoryExists) : false,
        localPath: local ? local.localPath : ''
    };
}

function projectsState(ws) {
    const pins = projectPins();
    const repositories = pins.repositories
        .map(repositoryFromFullName)
        .filter(Boolean)
        .map(publicRepoState);
    rememberGithubRepositories(ws, repositories);
    const officialOwners = new Set(projectCatalog.owners.map((value) => value.toLowerCase()));
    const fixedProfiles = new Set(projectCatalog.fixedProfiles.map((value) => value.toLowerCase()));
    const developers = new Set(projectCatalog.developers.map((value) => value.toLowerCase()));
    return {
        brand: process.platform === 'win32' ? pins.brand : `${APP_IDENTITY.name} · Proyectos`,
        projectsFolder,
        owners: pins.owners.map((login) => ({
            login,
            official: officialOwners.has(login.toLowerCase()),
            developer: developers.has(login.toLowerCase()),
            locked: fixedProfiles.has(login.toLowerCase())
        })),
        repositories: repositories.map((repo) => ({
            ...repo,
            official: projectCatalog.repositories.some((value) => value.toLowerCase() === repo.fullName.toLowerCase())
        }))
    };
}

ipcMain.handle('projects:state', (event) => {
    const ws = stateFromEvent(event);
    return ws ? projectsState(ws) : { brand: 'Proyectos', projectsFolder: '', owners: [], repositories: [], error: translate('error.invalidWindow', null, 'Ventana no válida.') };
});

ipcMain.handle('projects:lookup', async (event, rawTarget) => {
    const ws = stateFromEvent(event);
    if (!ws) return { ok: false, error: translate('error.invalidWindow', null, 'Ventana no válida.') };
    try {
        const result = await githubClient.lookup(rawTarget);
        const pins = projectPins();
        const repositories = result.repositories.map(publicRepoState).map((repo) => ({
            ...repo,
            pinned: pins.repositories.some((value) => value.toLowerCase() === repo.fullName.toLowerCase())
        }));
        rememberGithubRepositories(ws, repositories);
        logger.info('Perfil/repositorio GitHub consultado', {
            target: result.target,
            owner: result.profile ? result.profile.login : (repositories[0] && repositories[0].owner),
            repositories: repositories.length,
            rateRemaining: result.rateLimit && result.rateLimit.remaining
        });
        return {
            ok: true,
            target: result.target,
            profile: result.profile ? {
                ...result.profile,
                pinned: pins.owners.some((value) => value.toLowerCase() === result.profile.login.toLowerCase()),
                official: projectCatalog.owners.some((value) => value.toLowerCase() === result.profile.login.toLowerCase()),
                developer: projectCatalog.developers.some((value) => value.toLowerCase() === result.profile.login.toLowerCase()),
                locked: projectCatalog.fixedProfiles.some((value) => value.toLowerCase() === result.profile.login.toLowerCase())
            } : null,
            repositories,
            rateLimit: result.rateLimit
        };
    } catch (error) {
        logger.warn('Consulta GitHub fallida', { error: error.message, status: error.status || 0 });
        return { ok: false, error: error.message, rateLimit: error.rateLimit || null };
    }
});

/* ---- Releases ----
 *
 * Descargar una release es la vía corta para quien solo quiere USAR la
 * herramienta: nada de clonar el repositorio ni compilarlo. La aplicación se
 * encarga de la descarga (es tráfico de red, no un comando) y deja el
 * desempaquetado en la terminal visible, como el resto de acciones que tocan
 * el disco del usuario.
 */
const MAX_ASSET_BYTES = 512 * 1024 * 1024;

// Las descargas viven aparte de los clones para no mezclar un árbol de git
// con un ZIP desempaquetado. `_releases` no puede chocar con un propietario
// real: un login de GitHub nunca empieza por guion bajo.
function releasesFolderFor(repository, tag) {
    const safeTag = String(tag || 'latest').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'latest';
    return path.join(projectsFolder, '_releases', repository.owner, repository.name, safeTag);
}

function visibleRepository(ws, fullName) {
    if (typeof fullName !== 'string') return null;
    const known = ws.allowedGithubRepos.get(fullName.toLowerCase());
    return known ? repositoryFromFullName(known.fullName) : null;
}

ipcMain.handle('projects:release', async (event, fullName) => {
    const ws = stateFromEvent(event);
    if (!ws) return { ok: false, error: translate('error.invalidWindow', null, 'Ventana no válida.') };
    // Solo repositorios que esta ventana ha visto: el renderer no puede pedir
    // una consulta sobre un nombre cualquiera.
    const repository = visibleRepository(ws, fullName);
    if (!repository) return { ok: false, error: translate('error.repoNotInView', null, 'Ese repositorio no pertenece a la vista actual.') };
    try {
        const result = await githubClient.latestRelease(repository.fullName);
        if (!result.release) {
            logger.info('Repositorio sin releases publicadas', { repo: repository.fullName });
            return { ok: true, release: null, rateLimit: result.rateLimit };
        }
        // Se recuerda la release entera: la descarga posterior solo acepta
        // adjuntos de la que se acaba de enseñar, nunca una URL del renderer.
        ws.lastRelease = { fullName: repository.fullName, release: result.release };
        logger.info('Release consultada', {
            repo: repository.fullName,
            tag: result.release.tag,
            assets: result.release.assets.length
        });
        return { ok: true, release: result.release, rateLimit: result.rateLimit };
    } catch (error) {
        logger.warn('Consulta de release fallida', { repo: repository.fullName, error: error.message });
        return { ok: false, error: error.message, rateLimit: error.rateLimit || null };
    }
});

// Descarga con el `net` de Electron, que respeta la configuración de proxy del
// sistema. El destino lo decide el proceso principal a partir del nombre del
// adjunto (solo su basename), nunca una ruta que venga del renderer.
function downloadAsset(url, destination) {
    return new Promise((resolve) => {
        const request = net.request({ method: 'GET', url, redirect: 'follow' });
        let bytes = 0;
        let finished = false;
        const fail = (message) => {
            if (finished) return;
            finished = true;
            try { fs.rmSync(destination, { force: true }); } catch (e) { }
            resolve({ ok: false, error: message });
        };

        request.on('redirect', (status, method, redirectUrl) => {
            // Un redirect fuera de los hosts de GitHub se corta aquí: seguirlo
            // convertiría la descarga en una petición a un sitio arbitrario.
            if (!isAllowedAssetUrl(redirectUrl)) {
                request.abort();
                fail(translate('release.badRedirect', null, 'La descarga intentó salir de los servidores de GitHub.'));
                return;
            }
            request.followRedirect();
        });

        request.on('response', (response) => {
            if (response.statusCode !== 200) {
                request.abort();
                fail(translate('release.httpError', { status: response.statusCode },
                    'GitHub respondió con el estado {status} al descargar.'));
                return;
            }
            let file;
            try {
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                file = fs.createWriteStream(destination);
            } catch (error) {
                request.abort();
                fail(error.message);
                return;
            }
            response.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_ASSET_BYTES) {
                    request.abort();
                    file.destroy();
                    fail(translate('release.tooBig', null, 'El archivo supera el tamaño máximo admitido.'));
                    return;
                }
                file.write(chunk);
            });
            response.on('end', () => {
                if (finished) return;
                file.end(() => {
                    finished = true;
                    resolve({ ok: true, bytes });
                });
            });
            response.on('error', (error) => { file.destroy(); fail(error.message); });
        });

        request.on('error', (error) => fail(error.message));
        request.end();
    });
}

ipcMain.handle('projects:downloadRelease', async (event, tabId, fullName, assetName) => {
    const found = tabFromEvent(event, tabId);
    const ws = found ? found.ws : stateFromEvent(event);
    if (!ws) return { ok: false, error: translate('error.invalidWindow', null, 'Ventana no válida.') };

    const pending = ws.lastRelease;
    if (!pending || typeof fullName !== 'string' || pending.fullName.toLowerCase() !== fullName.toLowerCase()) {
        return { ok: false, error: translate('release.stale', null, 'Vuelve a consultar la release antes de descargarla.') };
    }
    const asset = pending.release.assets.find((candidate) => candidate.name === assetName);
    if (!asset) return { ok: false, error: translate('release.assetGone', null, 'Ese archivo ya no pertenece a la release mostrada.') };

    const repository = repositoryFromFullName(pending.fullName);
    const folder = releasesFolderFor(repository, pending.release.tag);
    const destination = path.join(folder, path.basename(asset.name));

    logger.info('Descargando adjunto de release', {
        repo: pending.fullName, tag: pending.release.tag, asset: asset.name, destination
    });
    const result = await downloadAsset(asset.downloadUrl, destination);
    if (!result.ok) {
        logger.warn('Descarga de release fallida', { asset: asset.name, error: result.error });
        return result;
    }
    logger.info('Adjunto descargado', { asset: asset.name, bytes: result.bytes });

    // El desempaquetado no lo hace la aplicación por dentro: se escribe en la
    // terminal para que el usuario vea qué se ejecuta sobre su disco, y para
    // que funcione con los formatos reales que publica la gente.
    let extractCommand = null;
    if (asset.archive && found && found.tab) {
        const env = ws.envs.find((candidate) => candidate.id === found.tab.envId);
        const shellEnv = env && !env.repl ? env : preferredShellEnvironment(ws, null);
        if (shellEnv) {
            const selected = findOrCreateTabForEnvironment(ws, shellEnv);
            const target = path.join(folder, 'extraido');
            try { fs.mkdirSync(target, { recursive: true }); } catch (e) { }
            extractCommand = buildExtractCommand(destination, target, shellEnv.kind, {
                transport: shellEnv.transport
            });
            if (extractCommand) {
                writeCommandToPty(selected.tab, extractCommand);
                return {
                    ok: true, path: destination, bytes: result.bytes, extracted: true,
                    tab: publicTab(selected.tab), created: selected.created
                };
            }
        }
    }
    return { ok: true, path: destination, bytes: result.bytes, extracted: false };
});

ipcMain.handle('projects:pin', (event, payload) => {
    const ws = stateFromEvent(event);
    if (!ws || !payload || typeof payload !== 'object') return { ok: false, error: translate('error.invalidRequest', null, 'Solicitud no válida.') };
    const settings = settingsStore.loadSettings();
    const pinned = payload.pinned !== false;
    if (payload.kind === 'owner') {
        const owner = String(payload.value || '');
        if (!isGithubOwner(owner)) return { ok: false, error: 'Perfil no válido.' };
        if (!pinned && projectCatalog.fixedProfiles.some((value) => value.toLowerCase() === owner.toLowerCase())) {
            return { ok: false, error: 'Este perfil es un desarrollador fijo del catálogo.' };
        }
        const values = (Array.isArray(settings.githubPinnedOwners) ? settings.githubPinnedOwners : [])
            .filter(isGithubOwner)
            .filter((value) => value.toLowerCase() !== owner.toLowerCase());
        if (pinned) values.push(owner);
        settingsStore.saveSettings({ githubPinnedOwners: values });
    } else if (payload.kind === 'repo') {
        const parsed = parseFullName(String(payload.value || ''));
        if (!parsed) return { ok: false, error: 'Repositorio no válido.' };
        if (!pinned && projectCatalog.repositories.some((value) => value.toLowerCase() === parsed.fullName.toLowerCase())) {
            return { ok: false, error: 'Este repositorio pertenece al catálogo fijo del proyecto.' };
        }
        const values = (Array.isArray(settings.githubPinnedRepos) ? settings.githubPinnedRepos : [])
            .map(parseFullName).filter(Boolean).map((repo) => repo.fullName)
            .filter((value) => value.toLowerCase() !== parsed.fullName.toLowerCase());
        if (pinned) values.push(parsed.fullName);
        settingsStore.saveSettings({ githubPinnedRepos: values });
    } else {
        return { ok: false, error: 'Tipo de anclado no válido.' };
    }
    return { ok: true, state: projectsState(ws) };
});

ipcMain.handle('projects:chooseFolder', async (event) => {
    const ws = stateFromEvent(event);
    if (!ws) return null;
    const result = await dialog.showOpenDialog(ws.win, {
        defaultPath: projectsFolder,
        properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths[0]) {
        projectsFolder = result.filePaths[0];
        settingsStore.saveSettings({ projectsFolder });
        logger.info('Carpeta de proyectos cambiada');
    }
    return projectsState(ws);
});

ipcMain.handle('projects:openGithub', async (event, rawTarget) => {
    if (!stateFromEvent(event)) return translate('error.invalidWindow', null, 'Ventana no válida.');
    const target = parseGithubTarget(rawTarget);
    if (!target) return 'URL de GitHub no válida.';
    const url = target.kind === 'repo'
        ? `https://github.com/${target.fullName}`
        : `https://github.com/${target.owner}`;
    await shell.openExternal(url);
    return '';
});

function preferredGitEnvironment(ws, requestedTab) {
    const requestedEnv = requestedTab && ws.envs.find((env) => env.id === requestedTab.envId);
    if (requestedEnv && !['docker', 'android'].includes(requestedEnv.transport)) return requestedEnv;
    const priority = ['gitbash', 'pwsh', 'powershell', 'cmd'];
    for (const id of priority) {
        const match = ws.envs.find((env) => env.id === id && env.available !== false);
        if (match) return match;
    }
    return ws.envs.find((env) => !['docker', 'android'].includes(env.transport) && env.available !== false) || null;
}

ipcMain.handle('projects:run', (event, tabId, fullName) => {
    const ws = stateFromEvent(event);
    if (!ws) return { ok: false, error: translate('error.invalidWindow', null, 'Ventana no válida.') };
    const repository = ws.allowedGithubRepos.get(String(fullName || '').toLowerCase());
    if (!repository) return { ok: false, error: 'El repositorio no pertenece a la vista actual.' };
    const requestedTab = ws.tabs.get(tabId);
    const env = preferredGitEnvironment(ws, requestedTab);
    if (!env) return { ok: false, error: 'No hay una shell compatible disponible.' };
    if (env.transport !== 'wsl' && !isToolInstalled('git')) {
        return {
            ok: false,
            error: 'Git no está instalado. Abre Entorno y dependencias para instalarlo.',
            suggestion: { tool: 'git', label: 'Git', actionId: process.platform === 'win32' ? 'winget-git' : null }
        };
    }

    const selected = requestedTab && requestedTab.envId === env.id
        ? { tab: requestedTab, created: false }
        : findOrCreateTabForEnvironment(ws, env);
    const commandInfo = buildGitCommand(repository, projectsFolder, env);
    if (!commandInfo) return { ok: false, error: 'Este entorno no puede trabajar con la carpeta de proyectos.' };
    if (commandInfo.exists && !commandInfo.repositoryExists) {
        return { ok: false, error: 'La carpeta de destino ya existe pero no contiene un repositorio Git. Elige otra carpeta o renómbrala.' };
    }
    if (commandInfo.action === 'clone') {
        try { fs.mkdirSync(path.dirname(commandInfo.localPath), { recursive: true }); }
        catch (error) { return { ok: false, error: 'No se pudo preparar la carpeta de destino.' }; }
    }
    if (!writeCommandToPty(selected.tab, commandInfo.command)) {
        return { ok: false, error: 'La terminal elegida terminó antes de poder enviar el comando Git.' };
    }
    logger.info('Acción GitHub enviada a la terminal', {
        repository: repository.fullName,
        action: commandInfo.action,
        tabId: selected.tab.id,
        envId: env.id
    });
    return {
        ok: true,
        action: commandInfo.action,
        localPath: commandInfo.localPath,
        tab: publicTab(selected.tab),
        created: selected.created
    };
});

// ---- Lanzador rapido de scripts y archivos relacionados ----
function rememberVisibleItems(ws, items) {
    ws.allowedFileItems.clear();
    items.forEach((item) => ws.allowedFileItems.set(item.path, item));
}

function listLibraryForWindow(ws, categories) {
    const scripts = listAllScripts(scriptsFolder, { categories });
    rememberVisibleItems(ws, scripts);
    return { mode: 'library', dir: scriptsFolder, scripts, filters: FILE_FILTERS };
}

ipcMain.handle('scripts:list', (event, categories) => {
    const ws = stateFromEvent(event);
    if (!ws) return { mode: 'library', dir: '', scripts: [], filters: FILE_FILTERS, error: translate('error.invalidWindow', null, 'Ventana no válida.') };
    return listLibraryForWindow(ws, categories);
});

function listHereForTab(ws, tab, categories, requestedDepth) {
    const dir = tab.hereScriptsDir || tab.cwd;
    const depth = selectedHereDepth(requestedDepth);
    if (!dir || !fs.existsSync(dir)) {
        rememberVisibleItems(ws, []);
        return {
            mode: 'here',
            dir: dir || '',
            scripts: [],
            filters: FILE_FILTERS,
            depth,
            minDepth: MIN_HERE_DEPTH,
            maxDepth: MAX_HERE_DEPTH,
            error: 'No se pudo traducir el directorio actual a una carpeta del host. Puedes elegirla manualmente con el botón de carpeta.'
        };
    }
    try {
        if (!fs.statSync(dir).isDirectory()) throw new Error('La ruta actual no es una carpeta');
        tab.hereScriptsDir = dir;
        const startedAt = Date.now();
        const scripts = listScripts(dir, depth, { scope: 'here', categories });
        const scanInfo = scripts.scanInfo || {};
        const visible = scripts.map((script) => ({ ...script, source: 'Aquí' }));
        rememberVisibleItems(ws, visible);
        logger.info('Escaneo de scripts Aquí completado', {
            tabId: tab.id,
            dir,
            depth,
            results: visible.length,
            visitedDirectories: scanInfo.visitedDirectories || 0,
            skippedDirectories: scanInfo.skippedDirectories || 0,
            stopReason: scanInfo.stopReason || null,
            elapsedMs: Date.now() - startedAt
        });
        return {
            mode: 'here',
            dir,
            scripts: visible,
            filters: FILE_FILTERS,
            depth,
            minDepth: MIN_HERE_DEPTH,
            maxDepth: MAX_HERE_DEPTH,
            limited: !!scanInfo.stopReason || scripts.length >= MAX_HERE_SCRIPTS,
            limitReason: scanInfo.stopReason || null,
            skippedDirectories: scanInfo.skippedDirectories || 0
        };
    } catch (e) {
        logger.warn('Escaneo de scripts Aquí fallido', { tabId: tab.id, dir, depth, error: e.message });
        rememberVisibleItems(ws, []);
        return { mode: 'here', dir, scripts: [], filters: FILE_FILTERS, depth, minDepth: MIN_HERE_DEPTH, maxDepth: MAX_HERE_DEPTH, error: e.message };
    }
}

ipcMain.handle('scripts:listHere', (event, tabId, categories, requestedDepth) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { mode: 'here', dir: '', scripts: [], filters: FILE_FILTERS, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    // Si el prompt reveló un cwd nuevo desde la última búsqueda, se usa ese
    // directorio en vez de conservar una selección anterior obsoleta.
    if (!found.tab.hereManual && found.tab.cwd && found.tab.cwd !== found.tab.hereScriptsDir) {
        found.tab.hereScriptsDir = found.tab.cwd;
    }
    return listHereForTab(found.ws, found.tab, categories, requestedDepth);
});

ipcMain.handle('scripts:chooseHereFolder', async (event, tabId, categories, requestedDepth) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { mode: 'here', dir: '', scripts: [], filters: FILE_FILTERS, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    try {
        const result = await dialog.showOpenDialog(found.ws.win, {
            defaultPath: found.tab.hereScriptsDir || found.tab.cwd || undefined,
            properties: ['openDirectory']
        });
        if (!result.canceled && result.filePaths[0]) {
            found.tab.hereScriptsDir = result.filePaths[0];
            found.tab.hereManual = true;
        }
        return listHereForTab(found.ws, found.tab, categories, requestedDepth);
    } catch (e) {
        return { mode: 'here', dir: found.tab.hereScriptsDir || '', scripts: [], filters: FILE_FILTERS, error: e.message };
    }
});

ipcMain.handle('scripts:chooseFolder', async (event, categories) => {
    const ws = stateFromEvent(event);
    if (!ws) return { mode: 'library', dir: '', scripts: [], filters: FILE_FILTERS, error: translate('error.invalidWindow', null, 'Ventana no válida.') };
    try {
        const result = await dialog.showOpenDialog(ws.win, { properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) {
            return listLibraryForWindow(ws, categories);
        }
        scriptsFolder = result.filePaths[0];
        settingsStore.saveSettings({ scriptsFolder });
        logger.info('Carpeta de scripts cambiada', { scriptsFolder });
        return listLibraryForWindow(ws, categories);
    } catch (e) {
        logger.error('Error al elegir carpeta de scripts', { error: e.message });
        return { ...listLibraryForWindow(ws, categories), error: e.message };
    }
});

// Elegir el archivo o la carpeta sobre la que actuará un script. Muchas de
// las utilidades importadas (tomar posesión, desbloquear, escanear...)
// esperan una ruta como argumento y sin ella no hacen nada útil.
ipcMain.handle('scripts:pickTarget', async (event, mode) => {
    const ws = stateFromEvent(event);
    if (!ws) return null;
    try {
        const result = await dialog.showOpenDialog(ws.win, {
            properties: [mode === 'directory' ? 'openDirectory' : 'openFile']
        });
        if (result.canceled || !result.filePaths[0]) return null;
        return result.filePaths[0];
    } catch (e) {
        logger.error('Error al elegir destino para un script', { error: e.message });
        return null;
    }
});

function visibleFileItem(ws, itemPath) {
    if (typeof itemPath !== 'string' || itemPath.length > 32767) return null;
    const item = ws.allowedFileItems.get(itemPath);
    if (!item) return null;
    try {
        if (!fs.statSync(item.path).isFile()) return null;
    } catch (e) {
        return null;
    }
    return item;
}

// Abre un archivo con la aplicación predeterminada del sistema. Si no hay
// ninguna asociada, se devuelve además qué visor haría falta, para que la
// interfaz pueda ofrecer instalarlo (nunca se instala nada sin aceptar).
async function openWithSystem(filePath, extension) {
    const error = await shell.openPath(filePath);
    if (!error) return { ok: true, error: '' };
    const suggestion = suggestViewer(extension || path.extname(filePath), process.platform);
    logger.warn('No se pudo abrir un archivo', { error, suggestedApp: suggestion && suggestion.app });
    return { ok: false, error, suggestion };
}

ipcMain.handle('scripts:open', async (event, itemPath) => {
    const ws = stateFromEvent(event);
    if (!ws) return { ok: false, error: translate('error.invalidWindow', null, 'Ventana no válida.') };
    const item = visibleFileItem(ws, itemPath);
    if (!item || !item.openable) return { ok: false, error: translate('error.notAuthorised', null, 'El archivo no está autorizado para abrirse desde este panel.') };
    const result = await openWithSystem(item.path, item.ext);
    if (result.ok) logger.info('Archivo abierto desde el panel', { name: item.name, category: item.category });
    return result;
});

ipcMain.on('scripts:cd', (event, tabId, itemPath) => {
    const found = tabFromEvent(event, tabId);
    if (!found || !found.tab.ptyProcess) return;
    const item = visibleFileItem(found.ws, itemPath);
    if (!item) return;
    const env = found.ws.envs.find((candidate) => candidate.id === found.tab.envId);
    if (env && env.repl) {
        logger.info('cd ignorado: la pestaña activa es un REPL, no una shell', { tabId, envId: env.id });
        return;
    }
    const command = buildCdCommand(item.path, env ? env.kind : 'cmd', {
        transport: env && env.transport,
        hostRoot: env && env.hostRoot,
        containerRoot: env && env.containerRoot
    });
    if (!command) return;
    logger.info('Cambio de carpeta desde el panel', { tabId, item: item.name, kind: env ? env.kind : 'cmd' });
    writeCommandToPty(found.tab, command);
});

ipcMain.handle('scripts:run', (event, tabId, payload) => {
    const found = tabFromEvent(event, tabId);
    if (!found || !found.tab.ptyProcess) return { ok: false, error: 'La pestaña activa ya no está disponible.' };
    if (!payload || typeof payload !== 'object' || typeof payload.path !== 'string') return { ok: false, error: translate('error.invalidRequest', null, 'Solicitud no válida.') };
    const scriptPath = payload.path;
    const asAdmin = payload.asAdmin === true;
    const args = typeof payload.args === 'string' ? payload.args.slice(0, MAX_SCRIPT_ARGS_CHARS) : '';
    const { ws, tab: requestedTab } = found;
    // Solo se puede actuar sobre un archivo devuelto por el último escaneo
    // visible de esta ventana. La ruta no se acepta directamente del renderer.
    const script = visibleFileItem(ws, scriptPath);
    if (!script || !script.runnable) return { ok: false, error: 'El script ya no pertenece a la vista actual.' };

    const preferredKinds = environmentKindsForScript(script);
    const requestedEnv = ws.envs.find((env) => env.id === requestedTab.envId);
    let env = requestedEnv;
    let selected = { tab: requestedTab, created: false };
    // Un REPL no puede lanzar el script: se busca una shell antes de decidir
    // si además hace falta una familia concreta (PowerShell para .ps1, etc.).
    if (env && env.repl) {
        const shellEnv = preferredShellEnvironment(ws, null);
        if (!shellEnv) return { ok: false, error: 'No hay una shell disponible para lanzar el script.' };
        env = shellEnv;
        selected = findOrCreateTabForEnvironment(ws, shellEnv);
    }
    if (preferredKinds.length && (!env || !preferredKinds.includes(env.kind))) {
        env = null;
        for (const kind of preferredKinds) {
            // `noAutoSelect` deja fuera entornos que hablan la misma familia
            // pero no comparten el sistema de archivos del host: el cmd.exe de
            // Wine es kind 'cmd', y elegirlo solo por eso mandaría un `cd` con
            // una ruta POSIX que dentro de Wine no existe. Sigue disponible en
            // el selector para quien lo elija a mano.
            env = ws.envs.find((candidate) => candidate.kind === kind
                && candidate.available !== false
                && !candidate.noAutoSelect);
            if (env) break;
        }
        if (!env) {
            const required = preferredKinds[0];
            return {
                ok: false,
                error: `No hay una shell ${required} compatible. Puedes instalarla desde Entorno y dependencias.`,
                missingShell: required
            };
        }
        selected = findOrCreateTabForEnvironment(ws, env);
    }
    const kind = env ? env.kind : 'cmd';
    const command = buildLaunchCommand(script, kind, !!asAdmin, args, {
        transport: env && env.transport,
        hostRoot: env && env.hostRoot,
        containerRoot: env && env.containerRoot
    });
    if (!command) return { ok: false, error: `El script no puede ejecutarse dentro de ${env ? env.label : 'este entorno'}.` };
    // No guardar argumentos: pueden contener tokens, contraseñas o rutas
    // sensibles. Para diagnóstico basta saber si había argumentos y tamaño.
    logger.info('Script lanzado', {
        tabId: selected.tab.id,
        script: script.name,
        kind,
        asAdmin: !!asAdmin,
        hasArgs: args.length > 0,
        argsLength: args.length
    });
    if (!writeCommandToPty(selected.tab, command)) {
        return { ok: false, error: 'La terminal compatible terminó antes de poder enviar el script.' };
    }
    return { ok: true, tab: publicTab(selected.tab), created: selected.created, environmentChanged: selected.tab.id !== requestedTab.id };
});

// ---- Explorador de archivos lateral ----
// La carpeta mostrada arranca en el directorio actual de la pestaña (deducido
// del prompt, ya traducido a una ruta del host) y a partir de ahí la navega el
// usuario. Cada ventana recuerda qué carpeta está enseñando: crear o abrir algo
// solo se admite dentro de ESA carpeta, nunca en una ruta suelta del renderer.
function explorerStateFor(ws, tab) {
    if (!ws.explorerDirs) ws.explorerDirs = new Map();
    return ws.explorerDirs.get(tab.id) || null;
}

function explorerResponse(ws, tab, directory) {
    const result = listDirectory(directory);
    if (result.ok) {
        if (!ws.explorerDirs) ws.explorerDirs = new Map();
        ws.explorerDirs.set(tab.id, result.dir);
    }
    return { ...result, tabId: tab.id, followsTab: !tab.explorerPinned };
}

// Carpeta que toca mostrar: la que el usuario haya fijado navegando, o el cwd
// de la pestaña mientras no haya navegado a otro sitio.
function explorerDirectoryFor(ws, tab) {
    if (tab.explorerPinned) return explorerStateFor(ws, tab) || tab.cwd;
    return tab.cwd || explorerStateFor(ws, tab);
}

ipcMain.handle('explorer:list', (event, tabId, requestedDir) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.'), dir: '', entries: [] };
    const { ws, tab } = found;
    if (typeof requestedDir === 'string' && requestedDir) {
        // Solo se acepta navegar a la carpeta superior o a una subcarpeta que
        // el propio listado anterior mostró.
        const current = explorerStateFor(ws, tab);
        const allowed = requestedDir === parentDirectory(current)
            || (current && listDirectory(current).entries || [])
                .some((entry) => entry.kind === 'directory' && entry.path === requestedDir);
        if (!allowed) return { ok: false, error: translate('error.folderNotInView', null, 'Esa carpeta no pertenece a la vista actual.'), dir: current || '', entries: [] };
        tab.explorerPinned = true;
        return explorerResponse(ws, tab, requestedDir);
    }
    return explorerResponse(ws, tab, explorerDirectoryFor(ws, tab));
});

// Vuelve a seguir el directorio de la terminal, tras haber navegado a mano.
ipcMain.handle('explorer:follow', (event, tabId) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.'), dir: '', entries: [] };
    found.tab.explorerPinned = false;
    return explorerResponse(found.ws, found.tab, found.tab.cwd || explorerStateFor(found.ws, found.tab));
});

ipcMain.handle('explorer:create', (event, tabId, name, kind) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    const { ws, tab } = found;
    const directory = explorerStateFor(ws, tab);
    if (!directory) return { ok: false, error: translate('error.noFolderOpen', null, 'Todavía no hay una carpeta abierta en el explorador.') };
    const created = createEntry(directory, name, kind === 'directory' ? 'directory' : 'file');
    if (!created.ok) return created;
    logger.info('Creado desde el explorador', { tabId, kind, directory });
    return { ...created, listing: explorerResponse(ws, tab, directory) };
});

// Toda operación destructiva del explorador (renombrar, mover, borrar) parte
// de aquí: la ruta que manda el renderer solo vale si el listado de la carpeta
// que se está viendo AHORA la contiene. Así ni una ruta inventada ni una
// entrada que ya desapareció pueden acabar en una llamada al sistema de
// archivos, y el usuario solo puede tocar lo que tiene delante.
function explorerEntryFor(ws, tab, itemPath, kind) {
    const directory = explorerStateFor(ws, tab);
    if (!directory) return null;
    const entry = (listDirectory(directory).entries || [])
        .find((candidate) => candidate.path === itemPath && (!kind || candidate.kind === kind));
    return entry ? { directory, entry } : null;
}

ipcMain.handle('explorer:open', async (event, tabId, itemPath) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    const target = explorerEntryFor(found.ws, found.tab, itemPath, 'file');
    if (!target) return { ok: false, error: 'El archivo no pertenece a la vista actual.' };
    return openWithSystem(target.entry.path, path.extname(target.entry.name));
});

// Carpeta a la que se puede pedir "abrir en el explorador del sistema": la
// que el panel está enseñando, o una subcarpeta de su listado actual. Igual
// que el resto del explorador, nunca una ruta suelta del renderer.
function explorerDirectoryTarget(ws, tab, itemPath) {
    const directory = explorerStateFor(ws, tab);
    if (!directory) return null;
    if (!itemPath || itemPath === directory) return directory;
    const target = explorerEntryFor(ws, tab, itemPath, 'directory');
    return target ? target.entry.path : null;
}

// Lanza un gestor concreto de la tabla de fileViewers.js. `spawn` con la ruta
// como argumento suelto (nunca una línea de shell) y desligado del proceso: la
// ventana del gestor no debe morir al cerrar la terminal ni heredar sus
// tuberías.
function launchFileManager(manager, directory) {
    try {
        const child = spawn(manager.cmd, [directory], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false
        });
        child.on('error', (error) => {
            logger.warn('El gestor de archivos no arrancó', { manager: manager.id, error: error.message });
        });
        child.unref();
        return true;
    } catch (error) {
        logger.warn('No se pudo lanzar el gestor de archivos', { manager: manager.id, error: error.message });
        return false;
    }
}

// Qué gestores hay para elegir, para cuando no se ha podido abrir la carpeta.
function fileManagerOptions() {
    return fileManagerChoices(process.platform, isToolInstalled);
}

// Abre una carpeta con el gestor de archivos del sistema. Si el usuario ya
// eligió uno antes se respeta; si no, se deja decidir al sistema
// (shell.openPath -> Explorador, Finder, xdg-open). Cuando no hay ninguno
// registrado —típico en Linux sin escritorio completo— no se da por perdido:
// se devuelve la lista de los que hay instalados y de los que se pueden
// instalar, para que la interfaz pregunte.
async function openDirectoryWithSystem(directory) {
    const preferredId = sanitizePreferences(settingsStore.loadSettings()).fileManagerId;
    const preferred = preferredId ? fileManagerById(process.platform, preferredId) : null;
    if (preferred && isToolInstalled(preferred.cmd)) {
        if (launchFileManager(preferred, directory)) {
            logger.info('Carpeta abierta con el gestor elegido', { manager: preferred.id });
            return { ok: true, error: '' };
        }
    }

    // En Linux NO se delega en el sistema mientras haya un gestor gráfico
    // instalado. `shell.openPath` acaba en xdg-open, que resuelve
    // inode/directory con las asociaciones del usuario, y en muchos
    // escritorios eso apunta a un emulador de terminal: pedir "abrir carpeta"
    // abría una terminal. Además xdg-open devuelve éxito al lanzarlo, así que
    // ni siquiera se podía detectar para preguntar.
    if (process.platform === 'linux') {
        const managers = fileManagerOptions();
        // El gestor del escritorio en uso es el que el usuario reconoce como
        // suyo; si no se puede deducir y solo hay uno instalado, tampoco hay
        // nada que preguntar.
        const automatico = fileManagerForDesktop(process.env.XDG_CURRENT_DESKTOP, isToolInstalled)
            || (managers.installed.length === 1 ? fileManagerById('linux', managers.installed[0].id) : null);
        if (automatico && launchFileManager(automatico, directory)) {
            logger.info('Carpeta abierta con el gestor del escritorio', {
                manager: automatico.id,
                desktop: process.env.XDG_CURRENT_DESKTOP || null
            });
            return { ok: true, error: '' };
        }
        // Varios gestores y ningún criterio para elegir, o ninguno instalado:
        // se pregunta. Delegar en xdg-open aquí es más probable que abra algo
        // inesperado que la carpeta.
        logger.info('Sin gestor de archivos evidente: se preguntará al usuario', {
            installed: managers.installed.map((manager) => manager.id)
        });
        return { ok: false, error: '', managers };
    }

    const error = await shell.openPath(directory);
    if (!error) return { ok: true, error: '' };

    const managers = fileManagerOptions();
    logger.warn('No se pudo abrir la carpeta con el gestor del sistema', {
        error,
        installed: managers.installed.map((manager) => manager.id)
    });
    return { ok: false, error, managers };
}

ipcMain.handle('explorer:openDirectory', async (event, tabId, itemPath) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    const directory = explorerDirectoryTarget(found.ws, found.tab, itemPath);
    if (!directory) return { ok: false, error: translate('error.folderNotInView', null, 'Esa carpeta no pertenece a la vista actual.') };
    return openDirectoryWithSystem(directory);
});

// Abrir con un gestor concreto, elegido por el usuario en el aviso anterior.
// El renderer manda un identificador de la tabla, nunca un ejecutable: la
// ruta del programa la decide siempre el proceso principal.
ipcMain.handle('explorer:openDirectoryWith', (event, tabId, itemPath, managerId, remember) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    const directory = explorerDirectoryTarget(found.ws, found.tab, itemPath);
    if (!directory) return { ok: false, error: translate('error.folderNotInView', null, 'Esa carpeta no pertenece a la vista actual.') };
    const manager = fileManagerById(process.platform, managerId);
    if (!manager || !isToolInstalled(manager.cmd)) {
        return { ok: false, error: translate('fileManager.gone', null, 'Ese gestor de archivos ya no está disponible.'), managers: fileManagerOptions() };
    }
    if (!launchFileManager(manager, directory)) {
        return { ok: false, error: translate('fileManager.launchFailed', { app: manager.app }, 'No se pudo iniciar {app}.'), managers: fileManagerOptions() };
    }
    // Recordarlo evita volver a preguntar cada vez. Se puede cambiar desde
    // Ajustes, que es donde vive el resto de la configuración persistente.
    if (remember === true && !settingsStore.saveSettings({ fileManagerId: manager.id })) {
        logger.warn('No se pudo recordar el gestor de archivos elegido', { manager: manager.id });
    }
    logger.info('Carpeta abierta con un gestor elegido a mano', { manager: manager.id, remembered: remember === true });
    return { ok: true };
});

ipcMain.handle('explorer:rename', (event, tabId, itemPath, newName) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    const { ws, tab } = found;
    const target = explorerEntryFor(ws, tab, itemPath);
    if (!target) return { ok: false, error: translate('error.notInView', null, 'Ese elemento ya no está en la carpeta abierta.') };
    const result = renameEntry(target.directory, target.entry.path, newName);
    if (!result.ok) return result;
    logger.info('Renombrado desde el explorador', { tabId, directory: target.directory, kind: target.entry.kind });
    return { ...result, listing: explorerResponse(ws, tab, target.directory) };
});

// Copiar/cortar no toca el disco: solo apunta QUÉ se va a pegar. Se guarda en
// el estado de la ventana y no en el renderer para que la ruta que llega a
// explorer:paste sea siempre una que el proceso principal ya validó contra el
// listado real, nunca una cadena venida de la interfaz.
ipcMain.handle('explorer:clip', (event, tabId, itemPath, mode) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    const { ws, tab } = found;
    const target = explorerEntryFor(ws, tab, itemPath);
    if (!target) return { ok: false, error: translate('error.notInView', null, 'Ese elemento ya no está en la carpeta abierta.') };
    ws.explorerClipboard = {
        path: target.entry.path,
        name: target.entry.name,
        kind: target.entry.kind,
        move: mode === 'cut'
    };
    return { ok: true, name: target.entry.name, move: mode === 'cut' };
});

ipcMain.handle('explorer:paste', (event, tabId) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    const { ws, tab } = found;
    const clip = ws.explorerClipboard;
    if (!clip) return { ok: false, error: translate('error.nothingCopied', null, 'No hay nada copiado.') };
    const directory = explorerStateFor(ws, tab);
    if (!directory) return { ok: false, error: translate('error.noFolderOpen', null, 'Todavía no hay una carpeta abierta en el explorador.') };

    const result = pasteEntry(clip.path, directory, clip.move);
    if (!result.ok) return result;
    // Cortar es de un solo uso: dejarlo en el portapapeles invitaría a pegar
    // otra vez algo que ya no está en su sitio.
    if (clip.move) ws.explorerClipboard = null;
    logger.info('Pegado desde el explorador', { tabId, directory, move: clip.move, renamed: !!result.renamed });
    return { ...result, move: !!clip.move, listing: explorerResponse(ws, tab, directory) };
});

// A la papelera del sistema, nunca borrado directo: una pulsación de más en un
// panel lateral no puede costar un archivo. shell.trashItem usa la papelera
// real de cada plataforma (Recycle Bin, Trash, XDG).
ipcMain.handle('explorer:trash', async (event, tabId, itemPath) => {
    const found = tabFromEvent(event, tabId);
    if (!found) return { ok: false, error: translate('error.noTab', null, 'No hay una pestaña activa.') };
    const { ws, tab } = found;
    const target = explorerEntryFor(ws, tab, itemPath);
    if (!target) return { ok: false, error: translate('error.notInView', null, 'Ese elemento ya no está en la carpeta abierta.') };
    if (ws.explorerClipboard && ws.explorerClipboard.path === target.entry.path) ws.explorerClipboard = null;
    try {
        await shell.trashItem(target.entry.path);
    } catch (error) {
        logger.warn('No se pudo enviar a la papelera', { tabId, error: error.message });
        return {
            ok: false,
            error: translate('error.trashFailed', { error: error.message },
                'No se pudo enviar a la papelera: {error}.'
                + ' Algunos sistemas de archivos (unidades de red, montajes externos) no tienen papelera.')
        };
    }
    logger.info('Enviado a la papelera desde el explorador', { tabId, kind: target.entry.kind });
    return { ok: true, listing: explorerResponse(ws, tab, target.directory) };
});

// Lleva la terminal a la carpeta que está mostrando el explorador.
ipcMain.handle('explorer:cd', (event, tabId) => {
    const found = tabFromEvent(event, tabId);
    if (!found || !found.tab.ptyProcess) return { ok: false, error: translate('error.tabGone', null, 'La pestaña ya no está disponible.') };
    const { ws, tab } = found;
    const directory = explorerStateFor(ws, tab);
    if (!directory) return { ok: false, error: 'No hay una carpeta que abrir.' };
    const env = ws.envs.find((candidate) => candidate.id === tab.envId);
    if (env && env.repl) return { ok: false, error: translate('error.replNotShell', null, 'La pestaña activa es un REPL, no una shell.') };
    // `directory: true`: la ruta ya es la carpeta que el panel está mostrando,
    // no un archivo dentro de ella.
    const command = buildCdCommand(directory, env ? env.kind : 'cmd', {
        directory: true,
        transport: env && env.transport,
        hostRoot: env && env.hostRoot,
        containerRoot: env && env.containerRoot
    });
    if (!command) return { ok: false, error: 'Este entorno no puede abrir esa carpeta.' };
    if (!writeCommandToPty(tab, command)) return { ok: false, error: 'No se pudo escribir en la terminal.' };
    return { ok: true };
});

// ---- Portapapeles ----
// El renderer corre en sandbox: navigator.clipboard exigiría permisos y
// gestos de usuario que xterm no siempre propaga. El portapapeles del SO se
// maneja aquí, que es donde Electron lo expone sin condiciones.
ipcMain.on('clipboard:write', (event, text) => {
    if (!stateFromEvent(event)) return;
    if (typeof text === 'string' && text.length > 0 && text.length <= MAX_CLIPBOARD_CHARS) clipboard.writeText(text);
});

ipcMain.handle('clipboard:read', (event) => stateFromEvent(event) ? clipboard.readText() : '');

// ---- Logs ----
ipcMain.on('log:renderer-error', (event, payload) => {
    if (!stateFromEvent(event)) return;
    const safe = payload && typeof payload === 'object'
        ? {
            message: String(payload.message || '').slice(0, 2000),
            source: String(payload.source || '').slice(0, 1000),
            line: Number(payload.line) || 0,
            column: Number(payload.column) || 0,
            stack: String(payload.stack || '').slice(0, 8000)
        }
        : { message: String(payload || '').slice(0, 2000) };
    logger.error('Error en renderer', safe);
});

ipcMain.handle('log:open-folder', (event) => {
    return stateFromEvent(event) ? shell.openPath(logger.getLogDir()) : translate('error.invalidWindow', null, 'Ventana no válida.');
});
