// Qué restablece cada casilla del diálogo de «Restablecer» (13-11, Romen:
// «el botón de restablecer pedirá una confirmación, explicando que restablece
// TODO… con casillas por categorías, los 3 apartados de ajustes y sus
// subapartados, informando de qué hace y del peligro de cada acción»).
//
// Antes, un clic lo devolvía todo a fábrica sin preguntar: el 13-11 eso movió
// la carpeta propia a la de fábrica y rompió aider, llm e IPython. Cada
// preferencia está en exactamente un apartado (lo comprueba
// `scripts/test-frontend-logic.mjs` contra `default_settings.toml`).

export type ResetTab = 'appearance' | 'terminal' | 'behavior';

/** `safe`: solo cambia cómo se ve. `caution`: cambia cómo se comporta, sin
 *  perder nada tuyo. `danger`: borra algo tuyo o rompe lo que dependía de él. */
export type ResetRisk = 'safe' | 'caution' | 'danger';

export interface ResetGroup {
    id: string;
    tab: ResetTab;
    risk: ResetRisk;
    /** Clave de texto del nombre y de la explicación (`settings.reset.<id>` y
     *  `settings.reset.<id>Hint`), con el texto en español de reserva. */
    label: string;
    hint: string;
    keys: readonly string[];
}

const SHORTCUTS = [
    'shortcutCommandPalette', 'shortcutNewTab', 'shortcutNextTab', 'shortcutPreviousTab', 'shortcutCyclePanes',
    'shortcutToggleExplorer', 'shortcutToggleTerminalOnly', 'shortcutPaneLeft', 'shortcutPaneRight', 'shortcutPaneUp',
    'shortcutPaneDown', 'shortcutOpenSettings', 'shortcutOpenProjects', 'shortcutOpenScripts', 'shortcutOpenDependencies',
    'shortcutClosePanel', 'shortcutRefreshEnvironments', 'shortcutExplorerFollow', 'shortcutExplorerCd',
    'shortcutClearTerminal', 'shortcutSearchTerminal', 'shortcutSearchHistory', 'shortcutPreviousCommand',
    'shortcutNextCommand', 'shortcutUiScaleUp', 'shortcutUiScaleDown', 'shortcutUiScaleReset', 'shortcutOpenSystemExplorer',
    'shortcutCloseTab', 'shortcutRenameTab', 'shortcutCopyLastOutput', 'shortcutSaveTerminalOutput', 'shortcutTerminalFontUp',
    'shortcutTerminalFontDown', 'shortcutTerminalFontReset', 'shortcutToggleAgentChat',
] as const;

export const RESET_GROUPS: readonly ResetGroup[] = [
    // ---- Apariencia ----
    {
        id: 'theme', tab: 'appearance', risk: 'safe',
        label: 'Tema y colores',
        hint: 'Vuelve al tema de fábrica y quita los colores que cambiaste a mano (interfaz, terminal y los 16 colores ANSI).',
        keys: ['themeId', 'themeRecolorAll', 'accentColor', 'uiBackgroundColor', 'uiSurfaceColor', 'uiSurfaceAltColor', 'uiBorderColor',
            'uiTextColor', 'uiMutedColor', 'terminalSelectionColor', 'fastfetchColor', 'terminalCursorColor', 'terminalBackground',
            'terminalForeground', 'terminalAnsiColors'],
    },
    {
        id: 'customThemes', tab: 'appearance', risk: 'danger',
        label: 'Temas propios',
        hint: 'Borra los temas que creaste. No se pueden recuperar: si quieres guardarlos, exporta antes un perfil.',
        keys: ['customThemes'],
    },
    {
        id: 'scale', tab: 'appearance', risk: 'safe',
        label: 'Tamaño y densidad',
        hint: 'El tamaño de la interfaz vuelve al 100 % y la densidad a la de fábrica.',
        keys: ['uiDensity', 'uiScale'],
    },
    // ---- Terminal ----
    {
        id: 'text', tab: 'terminal', risk: 'safe',
        label: 'Texto y cursor',
        hint: 'Fuente, tamaño, interlineado, grosor, márgenes y forma del cursor.',
        keys: ['terminalFontCustom', 'terminalFontFamily', 'terminalFontSize', 'terminalLineHeight', 'terminalLetterSpacing',
            'terminalCursorStyle', 'terminalFontWeight', 'terminalPadding', 'terminalCursorBlink'],
    },
    {
        id: 'scroll', tab: 'terminal', risk: 'caution',
        label: 'Desplazamiento, historial y copiar',
        hint: 'Las líneas que guarda cada pestaña, lo que avanza la rueda y copiar al seleccionar. Si tenías un historial más largo, a partir de ahora se guardan menos líneas.',
        keys: ['terminalScrollback', 'terminalScrollSensitivity', 'copyOnSelect'],
    },
    {
        id: 'commands', tab: 'terminal', risk: 'caution',
        label: 'Órdenes, enlaces y Python',
        hint: 'Las marcas de cada orden, cómo se abren los enlaces, el ancho de Python y escribir de una vez las órdenes de las acciones.',
        keys: ['terminalCommandMarks', 'terminalLinks', 'terminalLinksConfirm', 'pythonReplVisibleWidth', 'actionCommandsAtOnce'],
    },
    {
        id: 'ai', tab: 'terminal', risk: 'caution',
        label: 'IA y chat',
        hint: 'El chat lateral, el consejero, la memoria y si los agentes pueden editar archivos u omitir permisos. No borra las claves de API guardadas.',
        keys: ['aiKeyOffer', 'agentChat', 'agentChatAdvisor', 'showAgentChatButton', 'agentChatRemember', 'agentChatCanEdit', 'agentChatAllowBypass', 'agentChatGuide', 'agentTabGuide', 'agentControl'],
    },
    {
        id: 'banner', tab: 'terminal', risk: 'caution',
        label: 'Banner',
        hint: 'Qué enseña el banner y su imagen. Si pusiste una imagen propia, deja de usarse (el archivo no se borra).',
        keys: ['showSystemBanner', 'clearReprintBanner', 'bannerHiddenItems', 'bannerImage', 'bannerImageColumns', 'bannerImagePath'],
    },
    {
        id: 'assist', tab: 'terminal', risk: 'caution',
        label: 'Sugerencias y colores de la shell',
        hint: 'Clink, PSReadLine, ble.sh y los plugins de zsh vuelven a estar como vienen, con sus colores. Afecta a las pestañas nuevas.',
        keys: ['shellAssist', 'offerShellAssist', 'shellAssistCmd', 'shellAssistPowershell', 'shellAssistBash', 'shellAssistZsh',
            'shellAssistSuggestionColor', 'shellAssistSuggestionItalic', 'shellAssistSyntax', 'shellAssistCommandColor',
            'shellAssistArgumentColor', 'shellAssistErrorColor', 'shellAssistListView'],
    },
    // ---- Comportamiento ----
    {
        id: 'startup', tab: 'behavior', risk: 'caution',
        label: 'Inicio, idioma y paneles',
        hint: 'El idioma vuelve al del sistema, la shell de inicio a la de fábrica y se olvidan tus REPL favoritos y el gestor de archivos elegido.',
        keys: ['language', 'defaultEnvironmentId', 'defaultScriptEnvironmentId', 'scriptsHereDepth', 'autoStartDocker',
            'exclusiveAccordionGroups', 'autoOpenFirstGroup', 'startMaximized', 'favoriteReplIds', 'fileManagerId',
            'viewportCols', 'viewportRows'],
    },
    {
        id: 'interface', tab: 'behavior', risk: 'safe',
        label: 'Secciones visibles e interfaz',
        hint: 'Vuelven a verse los paneles, botones y barras que ocultaste, y el modo de bajo consumo se apaga.',
        keys: ['showDependenciesPanel', 'showProjectsPanel', 'showScriptsPanel', 'showExplorerPanel', 'showQuickActions',
            'showTabBar', 'showEnvironmentSelector', 'showRefreshButton', 'showLanguageButton', 'terminalOnlyMode',
            'showTerminalOnlyGuide', 'lowPowerMode', 'lowPowerSuggest', 'suggestRepositoryImport'],
    },
    {
        id: 'privacy', tab: 'behavior', risk: 'caution',
        label: 'Privacidad y red',
        hint: 'Vuelve a buscar actualizaciones al arrancar (consulta GitHub) y la sesión de GitHub vuelve a su modo de fábrica.',
        keys: ['checkUpdatesOnStartup', 'checkPackageUpdatesOnStartup', 'webview2Missing', 'githubSessionMode'],
    },
    {
        id: 'shortcuts', tab: 'behavior', risk: 'danger',
        label: 'Atajos de teclado',
        hint: 'Pierdes los atajos que grabaste: todos vuelven a los de fábrica.',
        keys: SHORTCUTS,
    },
    {
        id: 'aliases', tab: 'behavior', risk: 'danger',
        label: 'Alias manuales',
        hint: 'Borra tus alias. No se pueden recuperar: si quieres guardarlos, exporta antes un perfil.',
        keys: ['manualAliasesText'],
    },
    {
        id: 'environments', tab: 'behavior', risk: 'caution',
        label: 'Entornos habilitados',
        hint: 'Vuelven a ofrecerse las shells, REPL y distros que ocultaste.',
        keys: ['hiddenEnvironmentIds'],
    },
    {
        id: 'store', tab: 'behavior', risk: 'danger',
        label: 'Carpeta propia (entornos y descargas)',
        hint: 'Vuelve a la carpeta de fábrica. Lo instalado en la tuya deja de encontrarse (por ejemplo aider, llm o IPython instalados con pip) y cambia lo que se publica en tu PATH. No mueve ni borra archivos.',
        keys: ['toolchainStoreEnabled', 'toolchainStoreDir', 'toolchainStoreDownloads', 'toolchainStoreAiModels',
            'toolchainStoreTools', 'toolchainStoreReplHistory', 'toolchainStoreToolchains', 'toolchainStorePrograms',
            'toolchainStoreProjects', 'toolchainStoreConfig', 'toolchainStorePlugins', 'toolchainStoreCategoryDirs',
            'toolchainStoreDisabled'],
    },
    {
        id: 'admin', tab: 'behavior', risk: 'caution',
        label: 'Permisos de administrador',
        hint: 'WTerminal deja de arrancar como administrador y las pestañas nuevas dejan de abrirse elevadas, si lo tenías así.',
        keys: ['startAsAdmin', 'terminalAdminByDefault', 'offerGsudo'],
    },
    {
        id: 'ltools', tab: 'behavior', risk: 'safe',
        label: 'Acciones de LTools',
        hint: 'La integración experimental con LTools vuelve a apagarse.',
        keys: ['ltoolsEnabled'],
    },
];

export const RESET_TABS: readonly ResetTab[] = ['appearance', 'terminal', 'behavior'];

/** Las preferencias que restablecen estos apartados, sin repetir. */
export function keysForGroups(ids: Iterable<string>): string[] {
    const wanted = new Set(ids);
    const keys = new Set<string>();
    for (const group of RESET_GROUPS) {
        if (wanted.has(group.id)) for (const key of group.keys) keys.add(key);
    }
    return [...keys];
}

/** Los apartados peligrosos entre los elegidos (el diálogo los resume). */
export function dangerousGroups(ids: Iterable<string>): ResetGroup[] {
    const wanted = new Set(ids);
    return RESET_GROUPS.filter((group) => group.risk === 'danger' && wanted.has(group.id));
}

/** Estado de la casilla de una pestaña: todas, ninguna o algunas. */
export function tabState(tab: ResetTab, ids: ReadonlySet<string>): 'all' | 'none' | 'some' {
    const groups = RESET_GROUPS.filter((group) => group.tab === tab);
    const chosen = groups.filter((group) => ids.has(group.id)).length;
    return chosen === 0 ? 'none' : chosen === groups.length ? 'all' : 'some';
}
