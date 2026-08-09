// Los tipos que cruzan la frontera con Rust. Cada uno corresponde a un
// `Serialize` del backend; los nombres son camelCase porque así viajaban ya en
// la versión Electron y así los serializa serde (`rename_all = "camelCase"`).

export type ShellKind = 'cmd' | 'powershell' | 'bash' | 'zsh' | 'fish' | 'sh' | 'repl' | 'android';
export type Transport = 'native' | 'msys' | 'wsl' | 'docker' | 'android' | 'wine';

export interface Environment {
    id: string;
    label: string;
    kind: ShellKind;
    transport: Transport;
    exe: string;
    args: string[];
    group: string;
    shell?: string;
    distro?: string;
    /** Aviso que se pinta en amarillo bajo el banner de la pestaña. */
    note?: string;
    initialHostCwd?: string;
    hostHome?: string;
    hostRoot?: string;
    containerRoot?: string;
    /** Se ve en el selector pero no se puede abrir todavía (un móvil sin
     *  autorizar, por ejemplo). El motivo está en `note`. */
    available: boolean;
    /** No se elige nunca automáticamente, solo a mano desde el selector. */
    noAutoSelect?: boolean;
    /** Es un intérprete de lenguaje, no una shell. */
    repl?: boolean;
    language?: string;
}

export interface EnvironmentList {
    envs: Environment[];
    activeEnvId: string | null;
}

/** Lo que el backend sabe del sistema además de la lista de entornos. Llega
 *  con `envs-updated`, cuando termina la detección completa. */
export interface Inventory {
    envs: Environment[];
    languageCount: number;
    dockerInstalled: boolean;
    dockerDaemonReady: boolean;
    dockerContainerCount: number;
    dockerImageCount: number;
    androidInstalled: boolean;
    androidDeviceCount: number;
    /** El gestor de paquetes del sistema (apt, dnf, pacman, zypper, brew), o
     *  null en Windows, donde todo va por winget. */
    pkgManager: string | null;
}

export interface TabSummary {
    id: string;
    label: string;
    envId: string | null;
}

export interface TabList {
    tabs: TabSummary[];
    activeTabId: string | null;
}

export interface ThemePalette {
    background: string;
    surface: string;
    surfaceAlt: string;
    border: string;
    text: string;
    muted: string;
    accent: string;
    accentSoft: string;
    terminalBackground: string;
    terminalForeground: string;
    selection: string;
}

export interface ThemePreset {
    id: string;
    label: string;
    description: string;
    palette: ThemePalette;
}

export interface FontFamily {
    id: string;
    label: string;
    css: string;
}

export interface LanguageOption {
    id: string;
    label: string;
    englishLabel: string;
}

export interface Preferences {
    language: string;
    scriptsHereDepth: number;
    autoStartDocker: boolean;
    exclusiveAccordionGroups: boolean;
    autoOpenFirstGroup: boolean;
    showSystemBanner: boolean;
    themeId: string;
    accentColor: string;
    fastfetchColor: string;
    terminalBackground: string;
    terminalForeground: string;
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalLineHeight: number;
    terminalLetterSpacing: number;
    terminalCursorStyle: 'block' | 'underline' | 'bar' | 'beam' | 'underline-thick';
    terminalFontWeight: 'normal' | 'bold';
    terminalPadding: number;
    terminalScrollback: number;
    terminalCursorBlink: boolean;
    terminalScrollSensitivity: number;
    copyOnSelect: boolean;
    uiDensity: 'compact' | 'comfortable';
    defaultEnvironmentId: string;
    fileManagerId: string;
    viewportCols: number;
    viewportRows: number;
    defaultScriptEnvironmentId: string;
}

export interface TranslationCatalog {
    language: string;
    strings: Record<string, string>;
}

export interface PreferencesPayload {
    preferences: Preferences;
    defaults: Preferences;
    themes: ThemePreset[];
    fonts: FontFamily[];
    languages: LanguageOption[];
    catalog: TranslationCatalog;
}

export interface AppInfo {
    name: string;
    slug: string;
    version: string;
    platform: string;
    /** Créditos definidos en el catálogo de distribución, no en el código. */
    developers: string[];
    /** Perfiles oficiales del catálogo: dueños del proyecto. */
    owners: string[];
    /** Dónde vive `settings.json`. */
    settingsPath: string;
}

// ---- Panel de scripts ----

/** Cómo se ejecuta (o se abre) un archivo. No es lo mismo que su extensión: un
 *  archivo sin extensión con shebang `#!/bin/bash` es `shell`. */
export type ScriptType =
    | 'powershell' | 'batch' | 'shell' | 'fish' | 'python' | 'node'
    | 'vbscript' | 'ruby' | 'php' | 'perl' | 'lua' | 'rscript'
    | 'program' | 'html' | 'image' | 'audio' | 'video' | 'other';

/** El grupo con el que el panel filtra. Varios tipos comparten categoría: Ruby,
 *  PHP, Perl, Lua y R caben todos en "otros scripts". */
export type FileCategory =
    | 'batch' | 'powershell' | 'shell' | 'fish' | 'python' | 'node'
    | 'vbscript' | 'other-script' | 'program' | 'html' | 'image' | 'audio' | 'video';

export interface ScriptEntry {
    name: string;
    ext: string;
    type: ScriptType;
    category: FileCategory;
    interpreter?: string;
    /** Se lanza (un script); si no, solo se abre con el visor del sistema. */
    runnable: boolean;
    openable: boolean;
    instruction: string;
    path: string;
    /** Subcarpeta relativa a la raíz escaneada, para agrupar por carpetas en
     *  vez de volcar una lista plana enorme. */
    relDir: string;
    source: string;
    /** Aviso para los scripts sensibles conocidos. */
    hint?: string;
}

export interface FilterOption {
    id: string;
    label: string;
    default: boolean;
}

/** Por qué se paró un escaneo antes de terminar. */
export type ScanStopReason = 'directories' | 'time' | 'results';

export interface ScanInfo {
    depth: number;
    visitedDirectories: number;
    /** Carpetas que no se pudieron leer (permisos, unidad desconectada). */
    skippedDirectories: number;
    stopReason?: ScanStopReason;
}

export interface ScriptsPanel {
    /** `library` (la carpeta de scripts) o `here` (la de la pestaña). */
    mode: 'library' | 'here';
    dir: string;
    scripts: ScriptEntry[];
    filters: FilterOption[];
    /** Solo en modo «Aquí»: hasta dónde se ha bajado. */
    depth?: number;
    minDepth: number;
    maxDepth: number;
    scan?: ScanInfo;
    error?: string;
    /** Los anclados, con su carpeta y su tipo. Van aparte porque se ven
     *  siempre: no dependen del modo del panel ni de los filtros activos. */
    pinned: ScriptEntry[];
}

/** Resultado de una acción de panel que escribe en la terminal o toca un
 *  archivo. `suggestion` aparece cuando el sistema no supo abrir algo. */
export interface ActionResult {
    ok: boolean;
    error?: string;
    suggestion?: ViewerSuggestion;
    command?: string;
    tabId?: string;
}

/** Qué visor haría falta instalar para abrir un tipo de archivo. `actionId` es
 *  una acción real del panel de dependencias. */
export interface ViewerSuggestion {
    category: string;
    categoryLabel: string;
    app: string;
    actionId: string;
}

// ---- Explorador de archivos ----

export interface ExplorerEntry {
    name: string;
    path: string;
    kind: 'directory' | 'file';
    /** Es un enlace simbólico: al entrar se puede acabar en otra parte. */
    link: boolean;
    hidden: boolean;
    size: number;
    /** Milisegundos desde la época. */
    modified: number;
}

export interface Listing {
    ok: boolean;
    dir: string;
    parent?: string;
    entries: ExplorerEntry[];
    /** La carpeta tiene más entradas de las que caben. */
    truncated: boolean;
    error?: string;
}

export interface FsResult {
    ok: boolean;
    path?: string;
    name?: string;
    /** Al pegar, el nombre cambió para no pisar nada. */
    renamed?: boolean;
    error?: string;
}

export interface InstalledManager {
    id: string;
    app: string;
    cmd: string;
}

export interface InstallableManager {
    id: string;
    app: string;
    actionId: string;
}

export interface ManagerChoices {
    installed: InstalledManager[];
    installable: InstallableManager[];
}

export interface OpenDirectoryResult {
    ok: boolean;
    error?: string;
    /** Con qué gestores se puede abrir, cuando el sistema no supo hacerlo. */
    choices?: ManagerChoices;
}

// ---- Panel de Proyectos ----

export interface Repository {
    owner: string;
    name: string;
    fullName: string;
    description: string;
    language: string;
    stars: number;
    forks: number;
    archived: boolean;
    fork: boolean;
    updatedAt: string;
    htmlUrl: string;
    cloneUrl: string;
}

export interface PublicRepository extends Repository {
    /** Está clonado en la carpeta de proyectos. */
    local: boolean;
    /** La carpeta de destino existe pero no es un repositorio: clonar ahí
     *  fallaría, y el panel lo avisa en vez de ofrecer un comando condenado. */
    localConflict: boolean;
    localPath: string;
    /** Pertenece al catálogo de fábrica. */
    official: boolean;
    /** Lo ha anclado el usuario (solo en el resultado de una búsqueda). */
    pinned?: boolean;
}

export interface Profile {
    login: string;
    name: string;
    bio: string;
    /** `User` u `Organization`. */
    type: string;
    publicRepos: number;
    followers: number;
    htmlUrl: string;
}

export interface PublicProfile extends Profile {
    pinned: boolean;
    official: boolean;
    developer: boolean;
    /** No se puede desanclar: viene fijo con el catálogo. */
    locked: boolean;
}

export interface ProjectOwner {
    login: string;
    official: boolean;
    developer: boolean;
    locked: boolean;
}

export interface ProjectsState {
    brand: string;
    projectsFolder: string;
    owners: ProjectOwner[];
    repositories: PublicRepository[];
}

/** Un repositorio que YA está clonado en el disco. Se descubre recorriendo la
 *  carpeta de proyectos, sin consultar a GitHub: la sección funciona sin red. */
export interface LocalRepository {
    owner: string;
    name: string;
    fullName: string;
    path: string;
    /** Milisegundos desde la época de la última modificación. */
    modified: number;
}

/** Lo que queda del límite de consultas públicas de GitHub. */
export interface RateLimit {
    remaining: number | null;
    resetAt: string | null;
}

export interface LookupResult {
    ok: boolean;
    error?: string;
    target?: 'owner' | 'repo';
    profile?: PublicProfile;
    repositories: PublicRepository[];
    rateLimit?: RateLimit;
}

export interface ReleaseAsset {
    name: string;
    downloadUrl: string;
    size: number;
    downloads: number;
    /** Con qué herramienta se desempaqueta, o ausente si no hay nada que
     *  extraer (un .exe, un .AppImage, un binario suelto). */
    archive?: string;
}

export interface Release {
    tag: string;
    name: string;
    publishedAt: string;
    htmlUrl: string;
    prerelease: boolean;
    /** El código fuente siempre está disponible aunque no haya adjuntos. */
    sourceZip: string;
    assets: ReleaseAsset[];
}

export interface ReleaseResult {
    ok: boolean;
    error?: string;
    /** Ausente con `ok: true` = el repositorio no tiene releases publicadas,
     *  que no es un error. */
    release?: Release;
    rateLimit?: RateLimit;
}

export interface DownloadResult {
    ok: boolean;
    error?: string;
    path?: string;
    bytes: number;
    /** Se ha escrito el comando de desempaquetado en una terminal. */
    extracted: boolean;
    tabId?: string;
    created: boolean;
}

export interface PinResult {
    ok: boolean;
    error?: string;
    state?: ProjectsState;
}

export interface GitRunResult {
    ok: boolean;
    error?: string;
    /** Qué herramienta habría que instalar para que esto funcionara. */
    suggestion?: ToolSuggestion;
    action?: 'clone' | 'pull';
    localPath?: string;
    tabId?: string;
    created: boolean;
}

// ---- Panel de entorno y dependencias ----

/** Una acción del panel. `command` viaja solo para poder enseñarlo: lo que se
 *  ejecuta se pide por `id`, y el backend usa el comando que él generó. */
export interface InstallAction {
    id: string;
    label: string;
    shortLabel: string | null;
    command: string;
    /** Apartado de primer nivel, en español; `groupKey` es su traducción. */
    group: string;
    groupKey: string | null;
    /** Plegable de segundo nivel: todas las acciones de una herramienta. */
    subgroup: string | null;
    verb: string | null;
    hint: string | null;
    /** `powershell` si el comando necesita esa shell; el backend lo adapta a la
     *  de la pestaña antes de escribirlo. */
    shell: string | null;
    checkCmd: string | null;
    requiresCmd: string | null;
    /** Si la herramienta está instalada, para poner lo instalado arriba. `null`
     *  cuando la acción no dice nada del estado (actualizar todo con winget). */
    installed: boolean | null;
}

/** Un dato del resumen de arriba del panel ("Docker: Listo (2 activos)"). */
export interface InstallComponent {
    label: string;
    value: string;
}

export interface InstallList {
    actions: InstallAction[];
    components: InstallComponent[];
}

export interface InstallRunResult {
    ok: boolean;
    error?: string;
    actionId?: string;
    /** Dónde se escribió el comando, que puede no ser la pestaña que lo pidió:
     *  desde un REPL se busca o se abre una shell de verdad. */
    tabId?: string;
    created: boolean;
}

// ---- Actualización de la propia aplicación ----

export interface UpdateStatus {
    currentVersion: string;
    /** La última publicada, si se llegó a consultar. */
    latestVersion?: string;
    available: boolean;
    /** `false` en una compilación de desarrollo, que no se actualiza sola. */
    canSelfUpdate: boolean;
    /** Dónde está instalada, que es donde va a aterrizar la actualización. */
    installPath?: string;
    error?: string;
}

export interface UpdateResult {
    ok: boolean;
    error?: string;
    version?: string;
}

// ---- Cargas de los eventos que emite el backend ----

export interface DataEvent {
    tabId: string;
    data: string;
}

export interface ExitEvent {
    tabId: string;
    code: number | null;
}

export interface TabIdEvent {
    tabId: string;
}

export interface TabClosedEvent {
    tabId: string;
    activeTabId: string | null;
}

/** La shell dijo que no conoce un comando de una herramienta que la app sabe
 *  instalar. `actionId` es la acción del panel de dependencias, o null si en
 *  este sistema no hay instalación automática. */
export interface ToolSuggestion {
    tool: string;
    label: string;
    actionId: string | null;
}

export interface CommandNotFoundEvent {
    tabId: string;
    suggestion: ToolSuggestion;
}

export interface EnvChangedEvent {
    tabId: string;
    id: string;
    label: string;
}
