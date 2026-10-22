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

/** Marca semántica OSC 133 recibida desde una shell compatible. */
export interface SemanticZoneEvent {
    tabId: string;
    kind: 'prompt-start' | 'prompt-end' | 'input-start' | 'input-end';
    payload: string | null;
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

/** Tema guardado por el usuario («Guardar como tema»). */
export interface CustomTheme {
    id: string;
    label: string;
    palette: ThemePalette;
    /** 16 colores ANSI, o vacío para usar los de la terminal. */
    ansi: string[];
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
    clearReprintBanner: boolean;
    bannerHiddenItems: string;
    /** Imagen a la izquierda del banner (el logo de la app si no hay otra). */
    bannerImage: boolean;
    /** Columnas de la imagen, sin la separación (8–40). */
    bannerImageColumns: number;
    /** Imagen propia (ruta absoluta); vacío = el logo de la app. */
    bannerImagePath: string;
    showDependenciesPanel: boolean;
    showProjectsPanel: boolean;
    showScriptsPanel: boolean;
    showQuickActions: boolean;
    /** Integración experimental de LTools; desactivada de fábrica. */
    ltoolsEnabled: boolean;
    showExplorerPanel: boolean;
    showTabBar: boolean;
    showEnvironmentSelector: boolean;
    showRefreshButton: boolean;
    showLanguageButton: boolean;
    terminalOnlyMode: boolean;
    showTerminalOnlyGuide: boolean;
    startMaximized: boolean;
    startAsAdmin: boolean;
    manualAliasesText: string;
    favoriteReplIds: string;
    hiddenEnvironmentIds: string;
    shortcutCommandPalette: string;
    shortcutNewTab: string;
    shortcutNextTab: string;
    shortcutPreviousTab: string;
    shortcutCyclePanes: string;
    shortcutToggleExplorer: string;
    shortcutToggleTerminalOnly: string;
    shortcutPaneLeft: string;
    shortcutPaneRight: string;
    shortcutPaneUp: string;
    shortcutPaneDown: string;
    shortcutOpenSettings: string;
    shortcutOpenProjects: string;
    shortcutOpenScripts: string;
    shortcutOpenDependencies: string;
    shortcutClosePanel: string;
    shortcutRefreshEnvironments: string;
    shortcutExplorerFollow: string;
    shortcutExplorerCd: string;
    shortcutClearTerminal: string;
    shortcutSearchTerminal: string;
    shortcutOpenSystemExplorer: string;
    themeId: string;
    accentColor: string;
    uiBackgroundColor: string;
    uiSurfaceColor: string;
    uiSurfaceAltColor: string;
    uiBorderColor: string;
    uiTextColor: string;
    uiMutedColor: string;
    terminalSelectionColor: string;
    fastfetchColor: string;
    terminalCursorColor: string;
    terminalBackground: string;
    terminalForeground: string;
    /** El tema recolorea toda la interfaz y no solo el acento. */
    themeRecolorAll: boolean;
    customThemes: CustomTheme[];
    /** 16 colores ANSI (negro… blanco brillante); vacío = los de xterm. */
    terminalAnsiColors: string[];
    /** Fuente instalada escrita a mano, delante de la familia elegida. */
    terminalFontCustom: string;
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalLineHeight: number;
    terminalLetterSpacing: number;
    terminalCursorStyle: 'block' | 'underline' | 'bar' | 'beam' | 'underline-thick';
    terminalFontWeight: 'light' | 'normal' | 'medium' | 'semibold' | 'bold';
    terminalPadding: number;
    terminalScrollback: number;
    terminalCursorBlink: boolean;
    /** Enlaces clicables (Ctrl+clic) en la salida de la terminal. */
    terminalLinks: boolean;
    /** Confirmar con el destino a la vista antes de abrir un enlace. */
    terminalLinksConfirm: boolean;
    terminalScrollSensitivity: number;
    copyOnSelect: boolean;
    uiDensity: 'compact' | 'comfortable';
    defaultEnvironmentId: string;
    terminalAdminByDefault: boolean;
    toolchainStoreEnabled: boolean;
    /** Categorías de la carpeta propia además de las cachés. */
    toolchainStoreDownloads: boolean;
    toolchainStoreAiModels: boolean;
    toolchainStoreTools: boolean;
    toolchainStoreReplHistory: boolean;
    shellAssist: boolean;
    shellAssistCmd: boolean;
    shellAssistPowershell: boolean;
    shellAssistBash: boolean;
    shellAssistZsh: boolean;
    /** Aspecto de las sugerencias: un color vacío deja el de cada herramienta. */
    shellAssistSuggestionColor: string;
    shellAssistSuggestionItalic: boolean;
    shellAssistSyntax: boolean;
    shellAssistCommandColor: string;
    shellAssistArgumentColor: string;
    shellAssistErrorColor: string;
    shellAssistListView: boolean;
    toolchainStoreDir: string;
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

export interface ProfileTransferResult {
    ok: boolean;
    error?: string;
    preferences?: PreferencesPayload;
}

export interface PluginInfo {
    id: string;
    name: string;
    version: string;
    description: string;
    enabled: boolean;
    technologyCount: number;
    error?: string;
}

export interface WindowsIntegrationStatus {
    supported: boolean;
    contextMenuRegistered: boolean;
    protocolRegistered: boolean;
    appPathRegistered: boolean;
    nsudoAvailable: boolean;
    nsudoPath?: string;
    modernDefaultTerminalSupported: boolean;
    note: string;
    /** WTerminal se ejecuta como administrador. */
    elevated: boolean;
    /** Cómo se abre NSudo sin ser administrador. */
    nsudoLauncher: 'direct' | 'gsudo' | 'windows-sudo' | 'needs-admin';
    gsudoPath?: string;
    windowsSudo: 'missing' | 'disabled' | 'new-window' | 'input-disabled' | 'inline';
    /** El ejecutable lleva la marca RUNASADMIN (escudo en el icono). */
    runAsAdminFlag: boolean;
}

export interface PathIntegrationStatus {
    supported: boolean;
    enabled: boolean;
    command: string;
    location: string | null;
    note: string;
}

/** Estado de las sugerencias y colores de cada shell (`terminal::shell_assist`). */
export interface ShellAssistComponent {
    label: string;
    /** Distro WSL en la que se comprobó; null = este sistema. */
    distro: string | null;
    /** null = no se sabe (distro sin inventario detallado). */
    installed: boolean | null;
    /** Texto para el buscador de Entorno y dependencias. */
    search: string;
}

export interface ShellAssistShell {
    shell: 'cmd' | 'powershell' | 'bash' | 'zsh';
    components: ShellAssistComponent[];
}

export interface ShellAssistStatus {
    shells: ShellAssistShell[];
}

/** Respuesta de `terminal_open_link` (`terminal::links::LinkOpenResult`). */
export interface TerminalLinkResult {
    ok: boolean;
    /** `browser`, `directory` (carpeta abierta) o `reveal` (archivo mostrado en su carpeta). */
    action?: 'browser' | 'directory' | 'reveal';
    /** Código del rechazo (`scheme`, `credentials`, `not-found`…), `disabled` u `open-failed`. */
    error?: string;
    /** En E2E se registra la petición en vez de abrirla. */
    simulated: boolean;
}

/** Una caché que WTerminal centraliza (`config::toolchain_store`). */
/** Para qué sirve una carpeta y si se puede borrar
 *  (`config::toolchain_store::LocationInfo`). */
export interface StorageLocationInfo {
    purpose: string;
    deletion: string;
    safety: 'safe' | 'regenerates' | 'caution' | 'keep';
}

export interface ToolchainStoreCache {
    id: string;
    name: string;
    variable: string;
    path: string;
    bytes: number;
    /** El usuario ya define la variable: se usa su carpeta, no la propia. */
    userDefined: boolean;
    /** Dónde está lo medido: la carpeta propia, la variable del usuario o la
     *  ubicación de siempre de la herramienta (sin centralizar). */
    location: 'own' | 'user' | 'system';
    /** Categoría de la carpeta propia (ver `toolchain_store::Category`). */
    category: ToolchainStoreCategory;
    /** La categoría está activa y se aplica a las terminales nuevas. */
    active: boolean;
    info: StorageLocationInfo;
}

export type ToolchainStoreCategory = 'caches' | 'downloads' | 'aiModels' | 'tools' | 'replHistory';

/** Carpeta de WTerminal (`app`) o de otra herramienta (`external`); solo se
 *  mide y se explica. */
export interface ToolchainStoreLocation {
    id: string;
    label: string;
    path: string;
    bytes: number;
    group: 'app' | 'external';
    info: StorageLocationInfo;
}

export interface ToolchainStoreStatus {
    enabled: boolean;
    root: string;
    defaultRoot: string;
    caches: ToolchainStoreCache[];
    cacheBytes: number;
}

export interface InternalCommand {
    action: 'config' | 'reload' | 'repl' | 'shell' | 'alias' | 'help' | 'banner' | 'quickActions' | 'ltools' | 'panel' | 'theme' | 'font' | 'language' | 'terminal' | 'panes' | 'openDirectory' | 'darkeiser003' | 'christianlg97';
    argument?: string;
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
    /** Creadores y responsables de la dirección del proyecto. */
    projectLeads: string[];
    collaborators: { login: string; role: string }[];
    /** Dónde vive `settings.json`. */
    settingsPath: string;
    /** Si la ventana actual usa un token elevado. */
    processElevated: boolean;
}

// ---- Panel de scripts ----

/** Cómo se ejecuta (o se abre) un archivo. No es lo mismo que su extensión: un
 *  archivo sin extensión con shebang `#!/bin/bash` es `shell`. */
export type ScriptType =
    | 'powershell' | 'batch' | 'shell' | 'fish' | 'python' | 'node'
    | 'vbscript' | 'ruby' | 'php' | 'perl' | 'lua' | 'rscript' | 'sql'
    | 'autohotkey' | 'registry' | 'linuxpackage'
    | 'program' | 'html' | 'image' | 'audio' | 'video' | 'other';

/** El grupo con el que el panel filtra. Varios tipos comparten categoría: Ruby,
 *  PHP, Perl, Lua y R caben todos en "otros scripts". */
export type FileCategory =
    | 'batch' | 'powershell' | 'shell' | 'fish' | 'python' | 'node'
    | 'vbscript' | 'other-script' | 'autohotkey' | 'registry' | 'linux-package'
    | 'program' | 'html' | 'image' | 'audio' | 'video' | 'database';

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
    /** Los anclados, con su carpeta y su tipo. En Ruta actual permiten marcar
     *  las estrellas; la sección completa solo se muestra en Favoritos. */
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
    projectLead: boolean;
    /** No se puede desanclar: viene fijo con el catálogo. */
    locked: boolean;
}

export interface ProjectOwner {
    login: string;
    official: boolean;
    developer: boolean;
    projectLead: boolean;
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

/** «Mi GitHub»: la sesión de GitHub CLI (`gh`). WTerminal no guarda tokens. */
export interface GhStatus {
    installed: boolean;
    path?: string | null;
    version?: string | null;
    loggedIn: boolean;
    account?: string | null;
    /** Un fallo que no es «sin sesión» (red, versión rara de `gh`…). */
    error?: string | null;
}

/** Un repositorio de la cuenta de `gh`, con su estado en el disco. */
export interface OwnRepository extends PublicRepository {
    private: boolean;
}

export interface GhResult {
    ok: boolean;
    message: string;
    url?: string | null;
    /** Falta el permiso `delete_repo`: el panel ofrece pedirlo. */
    needsDeleteScope: boolean;
}

export type GhRepositoryChange = 'make-public' | 'make-private' | 'archive' | 'unarchive';

/** «Mi GitHub» ampliado (`projects/gh_manage.rs`, `projects/git_local.rs`). */
export interface GhRepoDetails {
    description: string;
    homepage: string;
    topics: string[];
    defaultBranch: string;
    issues: boolean;
    wiki: boolean;
}

export interface GhRepoEdit extends GhRepoDetails {
    /** Los temas que tenía al abrir el formulario. */
    currentTopics: string[];
}

export interface GhRelease {
    tag: string;
    name: string;
    draft: boolean;
    prerelease: boolean;
    latest: boolean;
    publishedAt: string;
}

export interface GhAsset {
    name: string;
    size: number;
    downloads: number;
}

export interface GhReleaseDraft {
    tag: string;
    title: string;
    notes: string;
    generateNotes: boolean;
    draft: boolean;
    prerelease: boolean;
    target: string;
    files: string[];
}

export interface GhPull {
    number: number;
    title: string;
    head: string;
    base: string;
    draft: boolean;
    url: string;
}

export interface GhIssue {
    number: number;
    title: string;
    url: string;
}

export interface GhRun {
    id: number;
    title: string;
    workflow: string;
    branch: string;
    status: string;
    conclusion: string;
    createdAt: string;
    url: string;
}

export type GhMergeMethod = 'merge' | 'squash' | 'rebase';

export interface LocalGitStatus {
    branch: string;
    upstream: string | null;
    ahead: number;
    behind: number;
    files: { code: string; path: string }[];
    truncated: boolean;
    branches: string[];
}

export type GitBranchAction = 'create' | 'switch' | 'delete';
export type GitTerminalAction = 'push' | 'pull' | 'publish';
export type GhTerminalAction = 'login' | 'logout' | 'grant-delete';

export interface GitRunResult {
    ok: boolean;
    error?: string;
    /** Qué herramienta habría que instalar para que esto funcionara. */
    suggestion?: ToolSuggestion;
    action?: 'clone' | 'pull' | GhTerminalAction | GitTerminalAction;
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
    /** Descripción breve del programa que encabeza el plegable. */
    subgroupDescription: string | null;
    /** Nombre concreto del framework dentro del ecosistema padre. */
    subgroupItem: string | null;
    /** Para qué sirve el programa; separado de requisitos y origen. */
    description: string | null;
    verb: string | null;
    /** Cierre específico para acciones que no son una instalación. */
    done: string | null;
    hint: string | null;
    /** `powershell` si el comando necesita esa shell; el backend lo adapta a la
     *  de la pestaña antes de escribirlo. */
    shell: string | null;
    checkCmd: string | null;
    requiresCmd: string | null;
    /** Si la herramienta está instalada, para poner lo instalado arriba. `null`
     *  cuando la acción no dice nada del estado (actualizar todo con winget). */
    installed: boolean | null;
    /** La sonda no concluyó (por ejemplo, timeout). No se debe tratar como
     * "no instalada" ni permitir una instalación duplicada. */
    detectionStatus: 'unknown' | null;
}

export interface InstallList {
    actions: InstallAction[];
    /** El backend solo marca completo cuando terminó la pasada global. */
    complete?: boolean;
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

/** Acción declarativa publicada por LTools. `args` es argv, nunca una cadena
 * que LTerminal deba dividir o interpretar como shell. */
export interface LToolsAction {
    id: string;
    actionKey: string;
    scope: string;
    operation: string;
    label: string;
    shortLabel: string | null;
    group: string;
    description: string;
    command: string;
    executable: string;
    args: string[];
    aliases: string[];
    shell: string;
    workingDirectory: string;
    terminal: boolean;
    interactive: boolean;
    requiresAdmin: boolean;
    confirmation: string;
    safe: boolean;
    supports: string[];
    target: string;
    targetPolicy: string;
    mutating: boolean;
    profile: string;
    requirementsAvailable: boolean;
    /** Preferencia opcional del catálogo para proponer este botón. */
    quick: boolean;
}

export interface LToolsActionList {
    available: boolean;
    executable?: string;
    version?: string;
    actions: LToolsAction[];
    error?: string;
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

/** Actualizaciones detectadas por el gestor nativo; solo informa, no instala. */
export interface PackageUpdateStatus {
    available: boolean;
    manager?: string;
}

export interface UpdateProgress {
    stage: 'download' | 'extract' | 'complete';
    bytes: number;
    total?: number;
    percent?: number;
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

/** Geometría solicitada por una acción de panel antes de escribir su comando. */
export interface CommandResizeEvent {
    tabId: string;
    cols: number;
    rows: number;
    reason?: string;
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

/** La shell ha revelado un directorio de trabajo nuevo en su prompt. */
export interface CwdChangedEvent {
    tabId: string;
    cwd: string;
}
