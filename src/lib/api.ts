// Puente con el backend. Ocupa el sitio que tenía `electron/preload.js`: el
// resto del frontend no llama nunca a `invoke` ni a `listen` directamente, sino
// a las funciones de aquí, que son las únicas que conocen los nombres de los
// comandos y la forma de sus cargas.
//
// La mayoría de llamadas llevan un `tabId`: cada pestaña tiene su propio pty en
// el backend, y hay que decirle a cuál se refiere cada una.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openPath } from '@tauri-apps/plugin-opener';
import { open, save } from '@tauri-apps/plugin-dialog';

import type {
    ActionResult,
    AppInfo,
    CommandNotFoundEvent,
    CwdChangedEvent,
    DataEvent,
    DownloadResult,
    EnvChangedEvent,
    EnvironmentList,
    ExitEvent,
    FsResult,
    GitRunResult,
    InstallList,
    InstallRunResult,
    InternalCommand,
    Inventory,
    Listing,
    LocalRepository,
    LookupResult,
    OpenDirectoryResult,
    PinResult,
    PreferencesPayload,
    Preferences,
    ProfileTransferResult,
    PluginInfo,
    WindowsIntegrationStatus,
    ProjectsState,
    ReleaseResult,
    ScriptEntry,
    ScriptsPanel,
    TabClosedEvent,
    TabIdEvent,
    TabList,
    TabSummary,
    UpdateResult,
    UpdateProgress,
    UpdateStatus
} from './types';

type InvokeArgs = Record<string, unknown>;

const HIGH_FREQUENCY_COMMANDS = new Set([
    'pty_input',
    'pty_resize',
    'internal_command_parse',
]);

/** Registra una métrica sin volver a instrumentar la propia llamada de log. */
export const recordPerformance = (payload: Record<string, unknown>) =>
    tauriInvoke<void>('log_frontend_performance', { payload }).catch(() => {
        // Las métricas nunca deben bloquear ni romper una interacción.
    });

/** Puente común para medir el tiempo real de cada operación IPC relevante.
 * Las tres rutas de alta frecuencia se dejan fuera para no convertir cada
 * tecla y cada píxel de resize en una línea de log. El resto queda segmentado
 * por comando, con éxito/error y duración backend+IPC. */
async function invokeLogged<T>(command: string, args?: InvokeArgs): Promise<T> {
    if (HIGH_FREQUENCY_COMMANDS.has(command)) {
        return args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args);
    }
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
        const value = args === undefined ? await tauriInvoke<T>(command) : await tauriInvoke<T>(command, args);
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        void recordPerformance({
            metric: `ipc.${command}`,
            kind: 'ipc',
            durationMs: Math.round(Math.max(0, now - startedAt) * 100) / 100,
            status: 'ok',
            details: { command },
        });
        return value;
    } catch (cause) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        void recordPerformance({
            metric: `ipc.${command}`,
            kind: 'ipc',
            durationMs: Math.round(Math.max(0, now - startedAt) * 100) / 100,
            status: 'error',
            details: { command, error: String(cause).slice(0, 300) },
        });
        throw cause;
    }
}

// ---- Pestañas ----

export const listTabs = () => invokeLogged<TabList>('tabs_list');

export const createTab = (envId?: string, paneCount?: number) =>
    invokeLogged<TabSummary | null>('tabs_create', {
        envId: envId ?? null,
        paneCount: paneCount ?? null,
    });

export const closeTab = (tabId: string) => invokeLogged<void>('tabs_close', { tabId });

export const activateTab = (tabId: string) => invokeLogged<void>('tabs_activate', { tabId });

/** Avisa al backend de que ya existe un xterm para esta pestaña, para que
 *  entregue la salida que el pty produjo antes de que estuviera listo. */
export const markTabReady = (tabId: string) => invokeLogged<void>('tabs_ready', { tabId });
export const markFrontendReady = (tabId: string) => invokeLogged<void>('frontend_ready', { tabId });

/** Hace visible la ventana si la carga inicial falla antes de montar un xterm. */
export const revealWindow = () => invokeLogged<void>('frontend_reveal');

// ---- pty ----

export const sendInput = (tabId: string, data: string) => invokeLogged<void>('pty_input', { tabId, data });

export const parseInternalCommand = (line: string) =>
    invokeLogged<InternalCommand | null>('internal_command_parse', { line });

export async function exportProfile(platform = 'linux'): Promise<ProfileTransferResult | null> {
    const windows = platform === 'windows';
    const extension = windows ? 'ps1' : 'sh';
    const name = windows ? 'WinSlimTerminal-Perfil.ps1' : 'LTerminal-Perfil.sh';
    const path = await save({ defaultPath: name, filters: [{ name: 'Script de perfil', extensions: [extension, 'winslim-profile', 'lterminal-profile'] }] });
    return path ? invokeLogged<ProfileTransferResult>('profile_export', { path }) : null;
}

export async function importProfile(): Promise<ProfileTransferResult | null> {
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Perfil portable o script', extensions: ['winslim-profile', 'lterminal-profile', 'sh', 'ps1'] }] });
    return typeof path === 'string' ? invokeLogged<ProfileTransferResult>('profile_import', { path }) : null;
}

export const listPlugins = () => invokeLogged<PluginInfo[]>('plugins_list');
export const setPluginEnabled = (id: string, enabled: boolean) =>
    invokeLogged<PluginInfo[]>('plugins_set_enabled', { id, enabled });
export async function installPlugin(): Promise<PluginInfo[] | null> {
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Manifest de plugin', extensions: ['json'] }] });
    return typeof path === 'string' ? invokeLogged<PluginInfo[]>('plugins_install', { manifestPath: path }) : null;
}
export const removePlugin = (id: string) => invokeLogged<PluginInfo[]>('plugins_remove', { id });
export const getWindowsIntegration = () =>
    invokeLogged<WindowsIntegrationStatus>('windows_integration_status');
export const setWindowsIntegration = (enabled: boolean) =>
    invokeLogged<WindowsIntegrationStatus>('windows_integration_set', { enabled });

export const resize = (tabId: string, cols: number, rows: number) =>
    invokeLogged<void>('pty_resize', { tabId, cols, rows });

export const printBanner = (tabId: string) => invokeLogged<boolean>('pty_print_banner', { tabId });

// ---- Entornos ----

export const listEnvironments = (tabId?: string) =>
    invokeLogged<EnvironmentList>('env_list', { tabId: tabId ?? null });

export const refreshEnvironments = (tabId?: string) =>
    invokeLogged<EnvironmentList>('env_refresh', { tabId: tabId ?? null });

export const switchEnvironment = (tabId: string, envId: string) =>
    invokeLogged<boolean>('env_switch', { tabId, envId });

// ---- Panel de scripts ----
// `categories` son los filtros marcados; sin ellos, el backend usa los de
// fábrica. Las acciones sobre archivos solo aceptan elementos del último
// escaneo; `cdToDirectory` acepta únicamente las rutas de Biblioteca o Ruta
// actual que el backend acaba de exponer.

export const listScripts = (categories?: string[]) =>
    invokeLogged<ScriptsPanel>('scripts_list', { categories: categories ?? null });

/** La carpeta de la pestaña, no la biblioteca. `depth` es cuántos niveles se
 *  bajan; el backend devuelve sus topes y por qué paró si se quedó corto. */
export const listScriptsHere = (tabId: string, categories?: string[], depth?: number) =>
    invokeLogged<ScriptsPanel>('scripts_list_here', {
        tabId,
        categories: categories ?? null,
        depth: depth ?? null
    });

/** Diálogo del sistema para elegir un archivo o una carpeta. */
export const pickTarget = (mode: 'file' | 'folder') =>
    invokeLogged<string | null>('scripts_pick_target', { mode });

export const openScript = (itemPath: string) =>
    invokeLogged<ActionResult>('scripts_open', { itemPath });

export const cdToScript = (tabId: string, itemPath: string) =>
    invokeLogged<void>('scripts_cd', { tabId, itemPath });

/** Cambia la terminal activa a la carpeta que el panel está mostrando. */
export const cdToDirectory = (tabId: string, directory: string) =>
    invokeLogged<ActionResult>('scripts_cd_directory', { tabId, directory });

/** Ancla o desancla un archivo y devuelve únicamente la colección actualizada
 *  de favoritos. Así no se reemplaza accidentalmente la vista Ruta actual. */
export const pinScript = (itemPath: string, pinned: boolean) =>
    invokeLogged<ScriptEntry[]>('scripts_pin', { itemPath, pinned });

/** Lanza el script en la terminal. Si la pestaña activa no habla la familia que
 *  necesita (PowerShell para .ps1, cmd para .bat), el backend busca o abre una
 *  que sí, y lo dice en `tabId`. */
export const runScript = (tabId: string, path: string, asAdmin?: boolean, args?: string) =>
    invokeLogged<ActionResult>('scripts_run', {
        tabId,
        path,
        asAdmin: asAdmin ?? null,
        args: args ?? null
    });

// ---- Explorador de archivos ----
// Igual que en scripts: solo se puede actuar sobre entradas directas de la
// carpeta que el explorador está enseñando para esa pestaña.

export const listDirectory = (tabId: string, dir?: string) =>
    invokeLogged<Listing>('explorer_list', { tabId, dir: dir ?? null });

/** Vuelve a la carpeta donde está la shell de la pestaña. */
export const followTab = (tabId: string) => invokeLogged<Listing>('explorer_follow', { tabId });

export const createEntry = (tabId: string, name: string, kind: 'file' | 'directory') =>
    invokeLogged<FsResult>('explorer_create', { tabId, name, kind });

export const openEntry = (tabId: string, itemPath: string) =>
    invokeLogged<ActionResult>('explorer_open', { tabId, itemPath });

export const renameEntry = (tabId: string, itemPath: string, newName: string) =>
    invokeLogged<FsResult>('explorer_rename', { tabId, itemPath, newName });

/** Copiar o cortar. Lo recuerda el backend, no el frontend, para que la ruta de
 *  origen sea siempre una que se validó contra la carpeta abierta. */
export const clipEntry = (tabId: string, itemPath: string, mode: 'copy' | 'cut') =>
    invokeLogged<ActionResult>('explorer_clip', { tabId, itemPath, mode });

export const pasteEntry = (tabId: string) => invokeLogged<FsResult>('explorer_paste', { tabId });

/** A la papelera del sistema, no un borrado definitivo. */
export const trashEntry = (tabId: string, itemPath: string) =>
    invokeLogged<ActionResult>('explorer_trash', { tabId, itemPath });

export const cdToExplorerDir = (tabId: string) => invokeLogged<ActionResult>('explorer_cd', { tabId });

/** Abre una carpeta en el gestor de archivos del sistema. Si no hay ninguno,
 *  devuelve con qué se puede abrir o instalar. */
export const openDirectory = (tabId: string, itemPath?: string, currentDir = false) =>
    invokeLogged<OpenDirectoryResult>('explorer_open_directory', {
        tabId,
        itemPath: itemPath ?? null,
        currentDir
    });

/** La elección vuelve con el identificador de la tabla de gestores, nunca con
 *  una ruta a un ejecutable. */
export const openDirectoryWith = (
    tabId: string,
    managerId: string,
    itemPath?: string,
    remember?: boolean
) =>
    invokeLogged<OpenDirectoryResult>('explorer_open_directory_with', {
        tabId,
        itemPath: itemPath ?? null,
        managerId,
        remember: remember ?? null
    });

// ---- Proyectos y repositorios de GitHub ----
// Las consultas y las descargas solo se hacen sobre lo que el backend ya ha
// enseñado: un `owner/repo` que no salga de una consulta suya se rechaza, y una
// descarga solo acepta adjuntos de la release que se acaba de pedir.

export const getProjectsState = () => invokeLogged<ProjectsState>('projects_state_get');

/** Los repositorios ya clonados en la carpeta de proyectos, lo más reciente
 *  primero. No consulta a GitHub: funciona sin red. */
export const listDownloadedProjects = () =>
    invokeLogged<LocalRepository[]>('projects_downloaded');

/** Lleva la terminal a la carpeta de un repositorio clonado. */
export const cdToProject = (tabId: string, fullName: string) =>
    invokeLogged<ActionResult>('projects_cd', { tabId, fullName });

/** Acepta un login, `owner/repo` o una URL de github.com. */
export const lookupProject = (rawTarget: string) =>
    invokeLogged<LookupResult>('projects_lookup', { rawTarget });

export const getLatestRelease = (fullName: string) =>
    invokeLogged<ReleaseResult>('projects_release', { fullName });

/** Descarga el adjunto y, si es un comprimido, escribe el comando para
 *  desempaquetarlo en la terminal: se ve qué se ejecuta sobre el disco. */
export const downloadRelease = (tabId: string, fullName: string, assetName: string) =>
    invokeLogged<DownloadResult>('projects_download_release', { tabId, fullName, assetName });

export const pinProject = (kind: 'owner' | 'repo', value: string, pinned: boolean) =>
    invokeLogged<PinResult>('projects_pin', { kind, value, pinned });

export const chooseProjectsFolder = () => invokeLogged<ProjectsState>('projects_choose_folder');

/** Devuelve el mensaje de error, o una cadena vacía si se abrió bien. */
export const openInGithub = (rawTarget: string) =>
    invokeLogged<string>('projects_open_github', { rawTarget });

/** Escribe `git clone` o `git pull` en la terminal, según lo que haya ya en la
 *  carpeta de proyectos. */
export const runProject = (tabId: string, fullName: string) =>
    invokeLogged<GitRunResult>('projects_run', { tabId, fullName });

// ---- Entorno y dependencias adicionales ----

/** El catálogo de acciones que tienen sentido en ESTE sistema, ya traducido y
 *  ordenado por apartados. Usa exclusivamente el inventario en memoria y las
 *  comprobaciones rápidas del PATH para poder pintar el panel al instante. */
export const listInstallActions = () => invokeLogged<InstallList>('install_list');

/** Vuelve a detectarlo todo (WSL, daemon de Docker, adb, binarios del PATH) y
 *  devuelve la lista al día. Tarda segundos, así que el panel la pide DESPUÉS
 *  de haberse pintado con `listInstallActions`, nunca antes. */
export const refreshInstallActions = () => invokeLogged<InstallList>('install_refresh');

/** Escribe la acción en la terminal. No la ejecuta por detrás: el comando se ve
 *  entero en la pestaña, y el usuario puede cancelarlo con Ctrl+C. */
export const runInstallAction = (tabId: string, actionId: string) =>
    invokeLogged<InstallRunResult>('install_run', { tabId, actionId });

// ---- Actualización de la propia aplicación ----

/** Consulta la última release del repositorio de la app y la compara con la
 *  versión que está corriendo. Un fallo de red no es un error: vuelve con el
 *  motivo dentro y sin ofrecer nada. */
export const checkForUpdate = () => invokeLogged<UpdateStatus>('update_check');

/** Descarga la versión nueva DONDE la app está instalada, la aplica y reinicia.
 *  Si va bien no devuelve nada: el proceso muere durante la llamada. */
export const installUpdate = () => invokeLogged<UpdateResult>('update_install');

/** El backend ha encontrado una versión más reciente al arrancar. */
export const onUpdateAvailable = (
    callback: (status: UpdateStatus) => void
): Promise<UnlistenFn> =>
    listen<UpdateStatus>('update-available', (event) => callback(event.payload));

export const onUpdateProgress = (callback: (progress: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>('update-progress', (event) => callback(event.payload));

// ---- Preferencias ----

export const getPreferences = () => invokeLogged<PreferencesPayload>('settings_get');

export const savePreferences = (preferences: Partial<Preferences>) =>
    invokeLogged<PreferencesPayload>('settings_save', { incoming: preferences });

export const resetPreferences = () => invokeLogged<PreferencesPayload>('settings_reset');

// ---- Identidad y registro ----

export const getAppInfo = () => invokeLogged<AppInfo>('app_info');

export const openLogFolder = () => invokeLogged<string | null>('log_open_folder');

export const reportFrontendError = (payload: unknown) =>
    invokeLogged<void>('log_frontend_error', { payload }).catch(() => {
        // Si ni siquiera se puede registrar el error, no hay nada más que hacer.
    });

// ---- Sistema ----
// El portapapeles y "abrir con el sistema" los daba el proceso principal de
// Electron; aquí los dan plugins de Tauri, que ya validan y piden permiso.
//
// Leer cuando no hay texto plano disponible no es un fallo de la aplicación:
// puede ocurrir al pegar con el portapapeles vacío o cuando otra aplicación
// solo ha publicado una imagen/HTML. El plugin lo devuelve como una promesa
// rechazada; si la dejamos escapar, App.svelte lo registra como un error global
// dos veces. Normalizamos ese caso aquí, en el único puente que lo conoce.
export async function writeClipboard(text: string): Promise<boolean> {
    try {
        await writeText(text);
        return true;
    } catch (cause) {
        console.warn('[clipboard] No se pudo escribir texto en el portapapeles', cause);
        return false;
    }
}

export async function readClipboard(): Promise<string | null> {
    try {
        return await readText();
    } catch (cause) {
        const message = String(cause).toLowerCase();
        const expected = message.includes('clipboard') && (
            message.includes('empty') ||
            message.includes('not available') ||
            message.includes('requested format')
        );
        if (!expected) {
            console.warn('[clipboard] No se pudo leer el portapapeles', cause);
        }
        return null;
    }
}
export const openInSystem = (path: string) => openPath(path);

// ---- Eventos ----
// Todos devuelven la función para dejar de escuchar, igual que los `on*` de
// preload.js.

export const onData = (callback: (tabId: string, data: string) => void): Promise<UnlistenFn> =>
    listen<DataEvent>('pty-data', (event) => callback(event.payload.tabId, event.payload.data));

export const onExit = (callback: (tabId: string, code: number | null) => void): Promise<UnlistenFn> =>
    listen<ExitEvent>('pty-exit', (event) => callback(event.payload.tabId, event.payload.code));

/** La shell acaba de ejecutar clear/cls: hay que vaciar de verdad la pestaña
 *  (pantalla + historial), algo que las secuencias que emite ConPTY no
 *  consiguen por sí solas. */
export const onClear = (callback: (tabId: string) => void): Promise<UnlistenFn> =>
    listen<TabIdEvent>('pty-clear', (event) => callback(event.payload.tabId));

/** Confirma que una pestaña se cerró de verdad en el backend, con el id de la
 *  que debería pasar a estar activa. */
export const onTabClosed = (
    callback: (tabId: string, activeTabId: string | null) => void
): Promise<UnlistenFn> =>
    listen<TabClosedEvent>('tab-closed', (event) =>
        callback(event.payload.tabId, event.payload.activeTabId)
    );

/** El entorno de una pestaña ha cambiado de verdad, con la etiqueta real que
 *  devuelve el backend. */
export const onEnvironmentChanged = (
    callback: (event: EnvChangedEvent) => void
): Promise<UnlistenFn> => listen<EnvChangedEvent>('env-changed', (event) => callback(event.payload));

/** La lista de entornos puede crecer sola después del arranque (p. ej. cuando
 *  Docker termina de arrancar y aparecen sus imágenes/contenedores). */
export const onEnvironmentsUpdated = (
    callback: (inventory: Inventory) => void
): Promise<UnlistenFn> => listen<Inventory>('envs-updated', (event) => callback(event.payload));

/** La shell activa respondió "comando no encontrado" para una herramienta
 *  conocida (docker, git, node, python...). */
export const onCommandNotFound = (
    callback: (event: CommandNotFoundEvent) => void
): Promise<UnlistenFn> =>
    listen<CommandNotFoundEvent>('command-not-found', (event) => callback(event.payload));

/** La shell ha cambiado de carpeta; el explorador puede volver a seguir la
 *  pestaña activa sin tener que esperar a que el usuario pulse «Seguir». */
export const onCurrentDirectoryChanged = (
    callback: (event: CwdChangedEvent) => void
): Promise<UnlistenFn> =>
    listen<CwdChangedEvent>('terminal-cwd-changed', (event) => callback(event.payload));
