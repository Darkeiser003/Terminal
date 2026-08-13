// Puente con el backend. Ocupa el sitio que tenía `electron/preload.js`: el
// resto del frontend no llama nunca a `invoke` ni a `listen` directamente, sino
// a las funciones de aquí, que son las únicas que conocen los nombres de los
// comandos y la forma de sus cargas.
//
// La mayoría de llamadas llevan un `tabId`: cada pestaña tiene su propio pty en
// el backend, y hay que decirle a cuál se refiere cada una.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openPath } from '@tauri-apps/plugin-opener';
import { open, save } from '@tauri-apps/plugin-dialog';

import type {
    ActionResult,
    AppInfo,
    CommandNotFoundEvent,
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

// ---- Pestañas ----

export const listTabs = () => invoke<TabList>('tabs_list');

export const createTab = (envId?: string) =>
    invoke<TabSummary | null>('tabs_create', { envId: envId ?? null });

export const closeTab = (tabId: string) => invoke<void>('tabs_close', { tabId });

export const activateTab = (tabId: string) => invoke<void>('tabs_activate', { tabId });

/** Avisa al backend de que ya existe un xterm para esta pestaña, para que
 *  entregue la salida que el pty produjo antes de que estuviera listo. */
export const markTabReady = (tabId: string) => invoke<void>('tabs_ready', { tabId });
export const markFrontendReady = (tabId: string) => invoke<void>('frontend_ready', { tabId });

// ---- pty ----

export const sendInput = (tabId: string, data: string) => invoke<void>('pty_input', { tabId, data });

export const parseInternalCommand = (line: string) =>
    invoke<InternalCommand | null>('internal_command_parse', { line });

export async function exportProfile(): Promise<ProfileTransferResult | null> {
    const path = await save({ defaultPath: 'LTerminal.winslim-profile', filters: [{ name: 'Perfil de terminal', extensions: ['winslim-profile'] }] });
    return path ? invoke<ProfileTransferResult>('profile_export', { path }) : null;
}

export async function importProfile(): Promise<ProfileTransferResult | null> {
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Perfil de terminal', extensions: ['winslim-profile'] }] });
    return typeof path === 'string' ? invoke<ProfileTransferResult>('profile_import', { path }) : null;
}

export const listPlugins = () => invoke<PluginInfo[]>('plugins_list');
export const setPluginEnabled = (id: string, enabled: boolean) =>
    invoke<PluginInfo[]>('plugins_set_enabled', { id, enabled });
export async function installPlugin(): Promise<PluginInfo[] | null> {
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Manifest de plugin', extensions: ['json'] }] });
    return typeof path === 'string' ? invoke<PluginInfo[]>('plugins_install', { manifestPath: path }) : null;
}
export const removePlugin = (id: string) => invoke<PluginInfo[]>('plugins_remove', { id });
export const getWindowsIntegration = () =>
    invoke<WindowsIntegrationStatus>('windows_integration_status');
export const setWindowsIntegration = (enabled: boolean) =>
    invoke<WindowsIntegrationStatus>('windows_integration_set', { enabled });

export const resize = (tabId: string, cols: number, rows: number) =>
    invoke<void>('pty_resize', { tabId, cols, rows });

// ---- Entornos ----

export const listEnvironments = (tabId?: string) =>
    invoke<EnvironmentList>('env_list', { tabId: tabId ?? null });

export const refreshEnvironments = (tabId?: string) =>
    invoke<EnvironmentList>('env_refresh', { tabId: tabId ?? null });

export const switchEnvironment = (tabId: string, envId: string) =>
    invoke<boolean>('env_switch', { tabId, envId });

// ---- Panel de scripts ----
// `categories` son los filtros marcados; sin ellos, el backend usa los de
// fábrica. Ninguna de estas llamadas acepta una ruta que no haya salido de un
// escaneo anterior: el backend guarda la lista de lo que enseñó y rechaza lo
// que no esté en ella.

export const listScripts = (categories?: string[]) =>
    invoke<ScriptsPanel>('scripts_list', { categories: categories ?? null });

/** La carpeta de la pestaña, no la biblioteca. `depth` es cuántos niveles se
 *  bajan; el backend devuelve sus topes y por qué paró si se quedó corto. */
export const listScriptsHere = (tabId: string, categories?: string[], depth?: number) =>
    invoke<ScriptsPanel>('scripts_list_here', {
        tabId,
        categories: categories ?? null,
        depth: depth ?? null
    });

export const chooseScriptsFolder = (categories?: string[]) =>
    invoke<ScriptsPanel>('scripts_choose_folder', { categories: categories ?? null });

export const chooseHereFolder = (tabId: string, categories?: string[], depth?: number) =>
    invoke<ScriptsPanel>('scripts_choose_here_folder', {
        tabId,
        categories: categories ?? null,
        depth: depth ?? null
    });

/** Diálogo del sistema para elegir un archivo o una carpeta. */
export const pickTarget = (mode: 'file' | 'folder') =>
    invoke<string | null>('scripts_pick_target', { mode });

export const openScript = (itemPath: string) =>
    invoke<ActionResult>('scripts_open', { itemPath });

export const cdToScript = (tabId: string, itemPath: string) =>
    invoke<void>('scripts_cd', { tabId, itemPath });

/** Ancla o desancla un archivo y devuelve únicamente la colección actualizada
 *  de favoritos. Así no se reemplaza accidentalmente la vista Ruta actual. */
export const pinScript = (itemPath: string, pinned: boolean) =>
    invoke<ScriptEntry[]>('scripts_pin', { itemPath, pinned });

/** Lanza el script en la terminal. Si la pestaña activa no habla la familia que
 *  necesita (PowerShell para .ps1, cmd para .bat), el backend busca o abre una
 *  que sí, y lo dice en `tabId`. */
export const runScript = (tabId: string, path: string, asAdmin?: boolean, args?: string) =>
    invoke<ActionResult>('scripts_run', {
        tabId,
        path,
        asAdmin: asAdmin ?? null,
        args: args ?? null
    });

// ---- Explorador de archivos ----
// Igual que en scripts: solo se puede actuar sobre entradas directas de la
// carpeta que el explorador está enseñando para esa pestaña.

export const listDirectory = (tabId: string, dir?: string) =>
    invoke<Listing>('explorer_list', { tabId, dir: dir ?? null });

/** Vuelve a la carpeta donde está la shell de la pestaña. */
export const followTab = (tabId: string) => invoke<Listing>('explorer_follow', { tabId });

export const createEntry = (tabId: string, name: string, kind: 'file' | 'directory') =>
    invoke<FsResult>('explorer_create', { tabId, name, kind });

export const openEntry = (tabId: string, itemPath: string) =>
    invoke<ActionResult>('explorer_open', { tabId, itemPath });

export const renameEntry = (tabId: string, itemPath: string, newName: string) =>
    invoke<FsResult>('explorer_rename', { tabId, itemPath, newName });

/** Copiar o cortar. Lo recuerda el backend, no el frontend, para que la ruta de
 *  origen sea siempre una que se validó contra la carpeta abierta. */
export const clipEntry = (tabId: string, itemPath: string, mode: 'copy' | 'cut') =>
    invoke<ActionResult>('explorer_clip', { tabId, itemPath, mode });

export const pasteEntry = (tabId: string) => invoke<FsResult>('explorer_paste', { tabId });

/** A la papelera del sistema, no un borrado definitivo. */
export const trashEntry = (tabId: string, itemPath: string) =>
    invoke<ActionResult>('explorer_trash', { tabId, itemPath });

export const cdToExplorerDir = (tabId: string) => invoke<ActionResult>('explorer_cd', { tabId });

/** Abre una carpeta en el gestor de archivos del sistema. Si no hay ninguno,
 *  devuelve con qué se puede abrir o instalar. */
export const openDirectory = (tabId: string, itemPath?: string) =>
    invoke<OpenDirectoryResult>('explorer_open_directory', { tabId, itemPath: itemPath ?? null });

/** La elección vuelve con el identificador de la tabla de gestores, nunca con
 *  una ruta a un ejecutable. */
export const openDirectoryWith = (
    tabId: string,
    managerId: string,
    itemPath?: string,
    remember?: boolean
) =>
    invoke<OpenDirectoryResult>('explorer_open_directory_with', {
        tabId,
        itemPath: itemPath ?? null,
        managerId,
        remember: remember ?? null
    });

// ---- Proyectos y repositorios de GitHub ----
// Las consultas y las descargas solo se hacen sobre lo que el backend ya ha
// enseñado: un `owner/repo` que no salga de una consulta suya se rechaza, y una
// descarga solo acepta adjuntos de la release que se acaba de pedir.

export const getProjectsState = () => invoke<ProjectsState>('projects_state_get');

/** Los repositorios ya clonados en la carpeta de proyectos, lo más reciente
 *  primero. No consulta a GitHub: funciona sin red. */
export const listDownloadedProjects = () =>
    invoke<LocalRepository[]>('projects_downloaded');

/** Lleva la terminal a la carpeta de un repositorio clonado. */
export const cdToProject = (tabId: string, fullName: string) =>
    invoke<ActionResult>('projects_cd', { tabId, fullName });

/** Acepta un login, `owner/repo` o una URL de github.com. */
export const lookupProject = (rawTarget: string) =>
    invoke<LookupResult>('projects_lookup', { rawTarget });

export const getLatestRelease = (fullName: string) =>
    invoke<ReleaseResult>('projects_release', { fullName });

/** Descarga el adjunto y, si es un comprimido, escribe el comando para
 *  desempaquetarlo en la terminal: se ve qué se ejecuta sobre el disco. */
export const downloadRelease = (tabId: string, fullName: string, assetName: string) =>
    invoke<DownloadResult>('projects_download_release', { tabId, fullName, assetName });

export const pinProject = (kind: 'owner' | 'repo', value: string, pinned: boolean) =>
    invoke<PinResult>('projects_pin', { kind, value, pinned });

export const chooseProjectsFolder = () => invoke<ProjectsState>('projects_choose_folder');

/** Devuelve el mensaje de error, o una cadena vacía si se abrió bien. */
export const openInGithub = (rawTarget: string) =>
    invoke<string>('projects_open_github', { rawTarget });

/** Escribe `git clone` o `git pull` en la terminal, según lo que haya ya en la
 *  carpeta de proyectos. */
export const runProject = (tabId: string, fullName: string) =>
    invoke<GitRunResult>('projects_run', { tabId, fullName });

// ---- Entorno y dependencias adicionales ----

/** El catálogo de acciones que tienen sentido en ESTE sistema, ya traducido y
 *  ordenado por apartados, más el resumen de arriba del panel. Vuelve a
 *  detectar los entornos por el camino: una herramienta recién instalada
 *  aparece sin reiniciar la app. */
export const listInstallActions = () => invoke<InstallList>('install_list');

/** Vuelve a detectarlo todo (WSL, daemon de Docker, adb, binarios del PATH) y
 *  devuelve la lista al día. Tarda segundos, así que el panel la pide DESPUÉS
 *  de haberse pintado con `listInstallActions`, nunca antes. */
export const refreshInstallActions = () => invoke<InstallList>('install_refresh');

/** Escribe la acción en la terminal. No la ejecuta por detrás: el comando se ve
 *  entero en la pestaña, y el usuario puede cancelarlo con Ctrl+C. */
export const runInstallAction = (tabId: string, actionId: string) =>
    invoke<InstallRunResult>('install_run', { tabId, actionId });

// ---- Actualización de la propia aplicación ----

/** Consulta la última release del repositorio de la app y la compara con la
 *  versión que está corriendo. Un fallo de red no es un error: vuelve con el
 *  motivo dentro y sin ofrecer nada. */
export const checkForUpdate = () => invoke<UpdateStatus>('update_check');

/** Descarga la versión nueva DONDE la app está instalada, la aplica y reinicia.
 *  Si va bien no devuelve nada: el proceso muere durante la llamada. */
export const installUpdate = () => invoke<UpdateResult>('update_install');

/** El backend ha encontrado una versión más reciente al arrancar. */
export const onUpdateAvailable = (
    callback: (status: UpdateStatus) => void
): Promise<UnlistenFn> =>
    listen<UpdateStatus>('update-available', (event) => callback(event.payload));

export const onUpdateProgress = (callback: (progress: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>('update-progress', (event) => callback(event.payload));

// ---- Preferencias ----

export const getPreferences = () => invoke<PreferencesPayload>('settings_get');

export const savePreferences = (preferences: Partial<Preferences>) =>
    invoke<PreferencesPayload>('settings_save', { incoming: preferences });

export const resetPreferences = () => invoke<PreferencesPayload>('settings_reset');

// ---- Identidad y registro ----

export const getAppInfo = () => invoke<AppInfo>('app_info');

export const openLogFolder = () => invoke<string | null>('log_open_folder');

export const reportFrontendError = (payload: unknown) =>
    invoke<void>('log_frontend_error', { payload }).catch(() => {
        // Si ni siquiera se puede registrar el error, no hay nada más que hacer.
    });

// ---- Sistema ----
// El portapapeles y "abrir con el sistema" los daba el proceso principal de
// Electron; aquí los dan plugins de Tauri, que ya validan y piden permiso.

export const writeClipboard = (text: string) => writeText(text);
export const readClipboard = () => readText();
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
