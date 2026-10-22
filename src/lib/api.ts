// Puente con el backend. Ocupa el sitio que tenía `electron/preload.js`: el
// resto del frontend no llama nunca a `invoke` ni a `listen` directamente, sino
// a las funciones de aquí, que son las únicas que conocen los nombres de los
// comandos y la forma de sus cargas.
//
// La mayoría de llamadas llevan un `tabId`: cada pestaña tiene su propio pty en
// el backend, y hay que decirle a cuál se refiere cada una.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openPath } from '@tauri-apps/plugin-opener';
import { open, save } from '@tauri-apps/plugin-dialog';

import type {
    ActionResult,
    AppInfo,
    GhAsset,
    GhIssue,
    GhMergeMethod,
    GhPull,
    GhRelease,
    GhReleaseDraft,
    GhRepoDetails,
    GhRepoEdit,
    GhRepositoryChange,
    GhResult,
    GhRun,
    GhStatus,
    GhTerminalAction,
    GitBranchAction,
    GitTerminalAction,
    LocalGitStatus,
    OwnRepository,
    CommandNotFoundEvent,
    CommandResizeEvent,
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
    LToolsActionList,
    InternalCommand,
    Inventory,
    Listing,
    LocalRepository,
    LookupResult,
    OpenDirectoryResult,
    PinResult,
    PackageUpdateStatus,
    PathIntegrationStatus,
    ToolchainStoreLocation,
    ToolchainStoreStatus,
    ShellAssistStatus,
    PreferencesPayload,
    Preferences,
    ProfileTransferResult,
    PluginInfo,
    WindowsIntegrationStatus,
    ProjectsState,
    ReleaseResult,
    ScriptEntry,
    ScriptsPanel,
    SemanticZoneEvent,
    TabClosedEvent,
    TabIdEvent,
    TabList,
    TabSummary,
    TerminalLinkResult,
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

// `invoke` es asíncrono y varias pulsaciones pueden llegar al runtime nativo
// al mismo tiempo cuando se escribe rápido. El PTY, en cambio, necesita
// recibirlas en el orden exacto en que xterm las produjo; especialmente un
// espacio no debe adelantarse o quedarse detrás de la siguiente letra.
const inputQueues = new Map<string, Promise<void>>();
// Una pestaña conserva su id cuando cambia de entorno. Las pulsaciones que ya
// estaban en vuelo no deben acabar en la shell nueva; el contador invalida esas
// promesas sin intentar cancelar una llamada IPC que ya esté dentro de Tauri.
const inputEpochs = new Map<string, number>();

/** Registra una métrica sin volver a instrumentar la propia llamada de log. */
export const recordPerformance = (payload: Record<string, unknown>) =>
    tauriInvoke<void>('log_frontend_performance', { payload }).catch(() => {
        // Las métricas nunca deben bloquear ni romper una interacción.
    });

/** Llamadas IPC en vuelo (comando y momento de inicio). Un comando que no
 * vuelve no deja rastro en el log, porque la métrica se escribe al terminar;
 * esta lista permite ver desde las herramientas de desarrollo o el E2E
 * (`window.__wtPendingIpc()`) qué llamadas siguen esperando. */
const pendingIpc = new Map<number, { command: string; startedAt: number }>();
let nextIpcId = 0;

export function pendingIpcCalls(): { command: string; ageMs: number }[] {
    const now = Date.now();
    return [...pendingIpc.values()].map(({ command, startedAt }) => ({ command, ageMs: now - startedAt }));
}

if (typeof window !== 'undefined') {
    (window as unknown as { __wtPendingIpc?: typeof pendingIpcCalls }).__wtPendingIpc = pendingIpcCalls;
}

/** Puente común para medir el tiempo real de cada operación IPC relevante.
 * Las tres rutas de alta frecuencia se dejan fuera para no convertir cada
 * tecla y cada píxel de resize en una línea de log. El resto queda segmentado
 * por comando, con éxito/error y duración backend+IPC. */
async function invokeLogged<T>(command: string, args?: InvokeArgs): Promise<T> {
    if (HIGH_FREQUENCY_COMMANDS.has(command)) {
        return args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args);
    }
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ipcId = ++nextIpcId;
    pendingIpc.set(ipcId, { command, startedAt: Date.now() });
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
    } finally {
        pendingIpc.delete(ipcId);
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
/** Devuelve false mientras la PTY de esta pestaña aún está arrancando. */
export const markFrontendReady = (tabId: string) => tauriInvoke<boolean>('frontend_ready', { tabId });

/** Hace visible la ventana si la carga inicial falla antes de montar un xterm. */
export const revealWindow = () => invokeLogged<void>('frontend_reveal');

/** Aplica el tamaño inicial elegido en Ajustes sin cambiar la decoración nativa. */
export async function setWindowMaximized(maximized: boolean): Promise<void> {
    const window = getCurrentWindow();
    if (maximized) await window.maximize();
    else await window.unmaximize();
}

/** Oculta o restaura el marco nativo de la ventana para el modo terminal limpio. */
export async function setWindowDecorations(visible: boolean): Promise<void> {
    await getCurrentWindow().setDecorations(visible);
}

// ---- pty ----

export function sendInput(tabId: string, data: string): Promise<void> {
    const previous = inputQueues.get(tabId) ?? Promise.resolve();
    const epoch = inputEpochs.get(tabId) ?? 0;
    const next = previous
        .catch(() => undefined)
        .then(() => {
            if ((inputEpochs.get(tabId) ?? 0) !== epoch) return undefined;
            return invokeLogged<void>('pty_input', { tabId, data });
        });
    inputQueues.set(tabId, next);
    void next.then(
        () => {
            if (inputQueues.get(tabId) === next) inputQueues.delete(tabId);
        },
        () => {
            if (inputQueues.get(tabId) === next) inputQueues.delete(tabId);
        },
    );
    return next;
}

/** Invalida entrada pendiente al reemplazar o cerrar una sesión PTY. */
export function invalidateInput(tabId: string): void {
    inputEpochs.set(tabId, (inputEpochs.get(tabId) ?? 0) + 1);
    inputQueues.delete(tabId);
}

export const parseInternalCommand = (line: string) =>
    invokeLogged<InternalCommand | null>('internal_command_parse', { line });

export async function exportProfile(platform = 'linux'): Promise<ProfileTransferResult | null> {
    const windows = platform === 'windows';
    const extension = windows ? 'ps1' : 'sh';
    const name = windows ? 'WTerminal-Perfil.ps1' : 'LTerminal-Perfil.sh';
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
/** Elige una imagen para el banner; `null` si se cancela. */
export async function pickBannerImage(): Promise<string | null> {
    const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Imagen', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'] }],
    });
    return typeof path === 'string' ? path : null;
}
/** Imagen propia del banner como URL `data:` (validada por el backend). */
export const readBannerImage = (path: string) => invokeLogged<string>('banner_image_read', { path });
/** Pone o quita la marca de compatibilidad RUNASADMIN de este ejecutable. */
export const setRunAsAdminFlag = (enabled: boolean) =>
    invokeLogged<WindowsIntegrationStatus>('windows_run_as_admin_set', { enabled });
/** Relanza WTerminal como administrador (UAC) y cierra esta copia. */
export const restartAsAdmin = () => invokeLogged<void>('app_restart_as_admin');
/** Relanza WTerminal sin permisos de administrador (token del Explorador) y
 *  cierra esta copia. */
export const restartUnelevated = () => invokeLogged<void>('app_restart_unelevated');
export const getPathIntegration = () =>
    invokeLogged<PathIntegrationStatus>('path_integration_status');
export const setPathIntegration = (enabled: boolean) =>
    invokeLogged<PathIntegrationStatus>('path_integration_set', { enabled });

/** Carpeta propia de cachés de lenguajes y el espacio que ocupan. */
export const getToolchainStore = () =>
    invokeLogged<ToolchainStoreStatus>('toolchain_store_status');
/** Espacio de ubicaciones conocidas fuera de la carpeta propia. Puede tardar
 *  decenas de segundos la primera vez; el backend lo reutiliza unos minutos y
 *  `refresh` fuerza otra medición. */
export const getToolchainExternalSizes = (refresh = false) =>
    invokeLogged<ToolchainStoreLocation[]>('toolchain_store_external_sizes', { refresh });
/** Qué herramienta da sugerencias y colores a cada shell y si está instalada.
 *  `refresh` hace el inventario detallado de WSL (segundos); sin él solo se
 *  usa lo que ya esté en caché. */
export const getShellAssistStatus = (refresh = false) =>
    invokeLogged<ShellAssistStatus>('shell_assist_status', { refresh });
/** Abre un enlace pulsado con Ctrl+clic en la salida de la terminal. El
 *  backend vuelve a validarlo (solo http, https y file) y decide qué hacer:
 *  navegador, carpeta o mostrar el archivo en su carpeta. */
export const openTerminalLink = (url: string) =>
    invokeLogged<TerminalLinkResult>('terminal_open_link', { url });
/** Vacía solo las cachés propias; devuelve los bytes liberados. */
export const clearToolchainCaches = () =>
    invokeLogged<number>('toolchain_store_clear_caches');

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

// «Mi GitHub»: cuenta y repositorios a través de GitHub CLI (`gh`).
export const githubCliStatus = () => invokeLogged<GhStatus>('github_cli_status');
export const githubCliRepositories = () => invokeLogged<OwnRepository[]>('github_cli_repositories');
/** Iniciar o cerrar sesión, o pedir el permiso de borrar, en una pestaña nueva. */
export const githubCliTerminal = (tabId: string, action: GhTerminalAction) =>
    invokeLogged<GitRunResult>('github_cli_terminal', { tabId, action });
export const githubCliCreate = (name: string, description: string, isPrivate: boolean, readme: boolean) =>
    invokeLogged<GhResult>('github_cli_create', { name, description, private: isPrivate, readme });
export const githubCliChange = (fullName: string, change: GhRepositoryChange) =>
    invokeLogged<GhResult>('github_cli_change', { fullName, change });
export const githubCliRename = (fullName: string, newName: string) =>
    invokeLogged<GhResult>('github_cli_rename', { fullName, newName });
export const githubCliDelete = (fullName: string, confirmation: string) =>
    invokeLogged<GhResult>('github_cli_delete', { fullName, confirmation });

// «Mi GitHub» ampliado: gestión de un repositorio de la cuenta con `gh` y git
// en su copia local. El backend solo actúa sobre repositorios del listado.
export const githubRepoDetails = (fullName: string) =>
    invokeLogged<GhRepoDetails>('github_repo_details', { fullName });
export const githubRepoEdit = (fullName: string, change: GhRepoEdit) =>
    invokeLogged<GhResult>('github_repo_edit', { fullName, change });
export const githubReleases = (fullName: string) => invokeLogged<GhRelease[]>('github_releases', { fullName });
export const githubReleaseAssets = (fullName: string, tag: string) =>
    invokeLogged<GhAsset[]>('github_release_assets', { fullName, tag });
export const githubReleaseCreate = (fullName: string, draft: GhReleaseDraft) =>
    invokeLogged<GhResult>('github_release_create', { fullName, draft });
export const githubReleaseUpload = (fullName: string, tag: string, files: string[]) =>
    invokeLogged<GhResult>('github_release_upload', { fullName, tag, files });
export const githubReleasePublish = (fullName: string, tag: string) =>
    invokeLogged<GhResult>('github_release_publish', { fullName, tag });
export const githubReleaseDelete = (fullName: string, tag: string, confirmation: string, cleanupTag: boolean) =>
    invokeLogged<GhResult>('github_release_delete', { fullName, tag, confirmation, cleanupTag });
export const githubReleaseDeleteAsset = (fullName: string, tag: string, asset: string) =>
    invokeLogged<GhResult>('github_release_delete_asset', { fullName, tag, asset });
export const githubPulls = (fullName: string) => invokeLogged<GhPull[]>('github_pulls', { fullName });
export const githubPullCreate = (fullName: string, head: string, base: string, title: string, body: string, draft: boolean) =>
    invokeLogged<GhResult>('github_pull_create', { fullName, head, base, title, body, draft });
export const githubPullMerge = (fullName: string, number: number, method: GhMergeMethod, deleteBranch: boolean) =>
    invokeLogged<GhResult>('github_pull_merge', { fullName, number, method, deleteBranch });
export const githubIssues = (fullName: string) => invokeLogged<GhIssue[]>('github_issues', { fullName });
export const githubIssueCreate = (fullName: string, title: string, body: string) =>
    invokeLogged<GhResult>('github_issue_create', { fullName, title, body });
export const githubIssueClose = (fullName: string, number: number) =>
    invokeLogged<GhResult>('github_issue_close', { fullName, number });
export const githubRuns = (fullName: string) => invokeLogged<GhRun[]>('github_runs', { fullName });
export const githubRunRerun = (fullName: string, id: number) =>
    invokeLogged<GhResult>('github_run_rerun', { fullName, id });
export const gitLocalStatus = (fullName: string) => invokeLogged<LocalGitStatus>('git_local_status', { fullName });
export const gitLocalCommit = (fullName: string, message: string) =>
    invokeLogged<GhResult>('git_local_commit', { fullName, message });
export const gitLocalBranch = (fullName: string, action: GitBranchAction, name: string) =>
    invokeLogged<GhResult>('git_local_branch', { fullName, action, name });
/** Push, pull o publicar la rama actual: en una pestaña nueva y visible. */
export const githubGitTerminal = (tabId: string, fullName: string, action: GitTerminalAction) =>
    invokeLogged<GitRunResult>('github_git_terminal', { tabId, fullName, action });
/** Archivos para adjuntar a una release (rutas absolutas). */
export async function pickReleaseFiles(): Promise<string[]> {
    const picked = await open({ multiple: true, directory: false });
    if (Array.isArray(picked)) return picked.filter((path): path is string => typeof path === 'string');
    return typeof picked === 'string' ? [picked] : [];
}

// ---- Entorno y dependencias adicionales ----

/** Compatibilidad con el puente antiguo; el panel usa `loadInstallCatalog`. */
export const listInstallActions = () => invokeLogged<InstallList>('install_list');

/** Construye solo la estructura del panel; no ejecuta detecciones. */
export const loadInstallCatalog = () => invokeLogged<InstallList>('install_catalog');

/** Comprueba una herramienta concreta cuando el usuario la abre. */
export const checkInstallAction = (actionId: string) =>
    invokeLogged<InstallList>('install_check', { actionId });

/** Vuelve a detectar todo (WSL, daemon de Docker, adb y binarios del PATH) de
 *  forma explícita y devuelve la lista al día. */
export const refreshInstallActions = () => invokeLogged<InstallList>('install_refresh');

/** Escribe la acción en la terminal. No la ejecuta por detrás: el comando se ve
 *  entero en la pestaña, y el usuario puede cancelarlo con Ctrl+C. */
export const runInstallAction = (tabId: string, actionId: string) =>
    invokeLogged<InstallRunResult>('install_run', { tabId, actionId });

/** Lee el catálogo ltools-actions-v1 del CLI instalado, sin instalar ni
 * ejecutar nada. Si no existe, devuelve `available: false`. */
export const listLToolsActions = (language?: string) =>
    invokeLogged<LToolsActionList>('ltools_actions_list', { language });

/** Revalida el catálogo y escribe la acción elegida en una shell visible. */
export const runLToolsAction = (tabId: string, actionId: string) =>
    invokeLogged<InstallRunResult>('ltools_action_run', { tabId, actionId });

// ---- Actualización de la propia aplicación ----

/** Consulta la última release del repositorio de la app y la compara con la
 *  versión que está corriendo. Un fallo de red no es un error: vuelve con el
 *  motivo dentro y sin ofrecer nada. */
export const checkForUpdate = () => invokeLogged<UpdateStatus>('update_check');

/** Comprobación automática tras montar la interfaz; las copias de desarrollo
 *  vuelven de inmediato y no consultan la red. */
export const checkForUpdateOnStartup = () =>
    invokeLogged<UpdateStatus>('update_check_on_startup');

/** Busca actualizaciones de aplicaciones con el gestor nativo, sin instalarlas. */
export const checkPackageUpdatesOnStartup = () =>
    invokeLogged<PackageUpdateStatus>('package_updates_check');

/** Descarga la versión nueva DONDE la app está instalada, la aplica y reinicia.
 *  Si va bien no devuelve nada: el proceso muere durante la llamada. */
export const installUpdate = () => invokeLogged<UpdateResult>('update_install');

export const onUpdateProgress = (callback: (progress: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>('update-progress', (event) => callback(event.payload));

// ---- Preferencias ----

export const getPreferences = () => invokeLogged<PreferencesPayload>('settings_get');

export const savePreferences = (preferences: Partial<Preferences>) =>
    invokeLogged<PreferencesPayload>('settings_save', { incoming: preferences });

export const resetPreferences = () => invokeLogged<PreferencesPayload>('settings_reset');

// ---- Identidad y registro ----

export const getAppInfo = () => invokeLogged<AppInfo>('app_info');

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

/** Un panel ha ampliado la ConPTY antes de escribir un comando largo. */
export const onCommandResize = (
    callback: (event: CommandResizeEvent) => void,
): Promise<UnlistenFn> =>
    listen<CommandResizeEvent>('pty-command-resize', (event) => callback(event.payload));

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

/** Metadatos OSC 133. La salida visible no se altera; el consumidor puede
 * usarlos para seleccionar prompts y bloques de salida cuando la shell los
 * emite. */
export const onSemanticZone = (
    callback: (event: SemanticZoneEvent) => void,
): Promise<UnlistenFn> =>
    listen<SemanticZoneEvent>('terminal-semantic-zone', (event) => callback(event.payload));
