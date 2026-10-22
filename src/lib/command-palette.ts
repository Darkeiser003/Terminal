// Paleta de comandos: registro de entradas y filtrado.
//
// No inventa acciones ni un lenguaje de configuración. Cada entrada describe
// algo que la aplicación ya sabe hacer —un atajo de `shortcuts.ts`, un botón de
// la barra, el selector de entornos, un comando interno `:` o una acción fijada
// de LTools— y `App.svelte` la ejecuta con el mismo manejador que ya usaba ese
// atajo, botón o comando. Lo que solo existe dentro de una terminal (la salida
// de `:help`, `:terminal list`…) se teclea en ella por la ruta normal de
// entrada, así que el interceptor de `:` y la resincronización con ConPTY son
// los de una orden escrita a mano.
//
// El módulo es puro (solo importa tipos) para poder probarlo en Node con
// `scripts/test-frontend-logic.mjs`.

import type { ShortcutPreferenceKey } from './shortcuts';
import type { Environment, LToolsAction, Preferences } from './types';

export type PaletteGroupId =
    | 'panels'
    | 'terminal'
    | 'tabs'
    | 'environments'
    | 'appearance'
    | 'internal'
    | 'ltools';

/** Orden en que se pintan los grupos cuando no hay búsqueda. */
export const PALETTE_GROUPS: ReadonlyArray<{ id: PaletteGroupId; labelKey: string; fallback: string }> = [
    { id: 'panels', labelKey: 'palette.group.panels', fallback: 'Paneles' },
    { id: 'terminal', labelKey: 'palette.group.terminal', fallback: 'Terminal' },
    { id: 'tabs', labelKey: 'palette.group.tabs', fallback: 'Pestañas y división' },
    { id: 'environments', labelKey: 'palette.group.environments', fallback: 'Shells y entornos' },
    { id: 'appearance', labelKey: 'palette.group.appearance', fallback: 'Apariencia e idioma' },
    { id: 'internal', labelKey: 'palette.group.internal', fallback: 'Comandos internos (:)' },
    { id: 'ltools', labelKey: 'palette.group.ltools', fallback: 'Acciones fijadas de LTools' },
];

/** Acciones que `App.svelte` ya atiende para los atajos y los botones. */
export type PaletteAppAction =
    | 'openSettings'
    | 'openScripts'
    | 'openProjects'
    | 'openDependencies'
    | 'toggleExplorer'
    | 'closePanel'
    | 'explorerFollow'
    | 'explorerCd'
    | 'openSystemExplorer'
    | 'searchTerminal'
    | 'clearTerminal'
    | 'toggleTerminalOnly'
    | 'newTab'
    | 'cyclePanes'
    | 'nextTab'
    | 'previousTab'
    | 'refreshEnvironments';

export type PaletteAction =
    | { kind: 'app'; action: PaletteAppAction }
    /** `app.setPaneCount`, el mismo que usa `:panes 1|2|3|4`. */
    | { kind: 'panes'; count: number }
    /** `app.switchEnvironment`, el mismo que el selector de la barra. */
    | { kind: 'environment'; envId: string }
    /** `app.createTab(envId)`, el mismo que `:repl` y los favoritos ★. */
    | { kind: 'newTabIn'; envId: string }
    | { kind: 'theme'; themeId: string }
    | { kind: 'font'; fontId: string }
    | { kind: 'language'; languageId: string }
    /** Se teclea en la terminal activa y lo resuelve su interceptor de `:`. */
    | { kind: 'internal'; line: string }
    /** `api.runLToolsAction`, como el botón de la Biblioteca; las que cambian
     *  el sistema se confirman antes. */
    | { kind: 'ltools'; actionId: string; needsConfirmation: boolean };

export interface PaletteEntry {
    /** Estable entre aperturas: lo usan el E2E y `aria-activedescendant`. */
    id: string;
    group: PaletteGroupId;
    label: string;
    detail: string;
    /** Equivalente escrito en la terminal (`:config`, `:theme ocean`), si existe. */
    command: string;
    /** Texto extra para la búsqueda: sinónimos, identificadores, el grupo. */
    keywords: string[];
    /** Atajo asignado en Ajustes, ya formateado; vacío si no tiene. */
    shortcut: string;
    action: PaletteAction;
    /** Se ve pero no se ejecuta; el motivo se muestra al elegirla. */
    disabledReason: string;
    /** La opción vigente (entorno, tema, fuente, idioma o rejilla actuales). */
    current: boolean;
}

export type Translate = (key: string, fallback: string) => string;

/** Lo que de la acción fijada necesita la paleta, ya resuelto con los
 *  helpers de `ltools-selection.ts` que comparte con la Biblioteca. */
export type PalettePinnedAction = Pick<LToolsAction, 'id' | 'description'> & {
    /** Nombre desambiguado contra el catálogo (`ltoolsActionLabel`). */
    displayLabel: string;
    /** Grupo y operación (`ltoolsActionMeta`). */
    meta: string;
    /** `ltoolsActionNeedsConfirmation`. */
    needsConfirmation: boolean;
};

export interface PaletteContext {
    t: Translate;
    preferences: Preferences | null;
    environments: Environment[];
    activeEnvId: string | null;
    hasActiveTab: boolean;
    /** La pestaña activa es un REPL o un asistente: no es una shell. */
    activeIsRepl: boolean;
    tabCount: number;
    paneCount: number;
    themes: ReadonlyArray<{ id: string; label: string }>;
    fonts: ReadonlyArray<{ id: string; label: string }>;
    languages: ReadonlyArray<{ id: string; label: string }>;
    /** Solo las fijadas en la Biblioteca y solo si LTools está activado. */
    ltoolsActions: ReadonlyArray<PalettePinnedAction>;
}

interface AppActionDefinition {
    action: PaletteAppAction;
    group: PaletteGroupId;
    labelKey: string;
    fallback: string;
    shortcut?: ShortcutPreferenceKey;
    command?: string;
    keywords?: string[];
}

/** Las acciones de App, en el orden en que se ven sin búsqueda. Los
 *  sinónimos van sin traducir a propósito (ids y nombres de órdenes): la
 *  etiqueta traducida ya cubre el idioma activo. */
export const PALETTE_APP_ACTIONS: ReadonlyArray<AppActionDefinition> = [
    { action: 'openSettings', group: 'panels', labelKey: 'palette.action.openSettings', fallback: 'Abrir Ajustes', shortcut: 'shortcutOpenSettings', command: ':config', keywords: ['settings', 'preferences', ':settings'] },
    { action: 'openScripts', group: 'panels', labelKey: 'palette.action.openScripts', fallback: 'Abrir la Biblioteca', shortcut: 'shortcutOpenScripts', command: ':panel scripts', keywords: ['scripts', 'library', ':ltools', ':tools'] },
    { action: 'openProjects', group: 'panels', labelKey: 'palette.action.openProjects', fallback: 'Abrir Proyectos', shortcut: 'shortcutOpenProjects', command: ':panel projects', keywords: ['projects', 'git', 'github'] },
    { action: 'openDependencies', group: 'panels', labelKey: 'palette.action.openDependencies', fallback: 'Abrir Entorno y dependencias', shortcut: 'shortcutOpenDependencies', command: ':panel deps', keywords: ['deps', 'dependencies', 'install'] },
    { action: 'toggleExplorer', group: 'panels', labelKey: 'palette.action.toggleExplorer', fallback: 'Mostrar u ocultar el explorador de archivos', shortcut: 'shortcutToggleExplorer', command: ':panel explorer', keywords: ['explorer', 'files'] },
    { action: 'explorerFollow', group: 'panels', labelKey: 'palette.action.explorerFollow', fallback: 'Explorador: seguir la carpeta de la terminal', shortcut: 'shortcutExplorerFollow', keywords: ['explorer', 'follow', 'cwd'] },
    { action: 'explorerCd', group: 'panels', labelKey: 'palette.action.explorerCd', fallback: 'Explorador: llevar la terminal a su carpeta', shortcut: 'shortcutExplorerCd', keywords: ['explorer', 'cd'] },
    { action: 'openSystemExplorer', group: 'panels', labelKey: 'palette.action.openSystemExplorer', fallback: 'Abrir la carpeta actual en el explorador del sistema', shortcut: 'shortcutOpenSystemExplorer', command: ':explorer-here', keywords: [':open-here', ':reveal-here', 'folder'] },
    { action: 'closePanel', group: 'panels', labelKey: 'palette.action.closePanel', fallback: 'Cerrar los paneles', shortcut: 'shortcutClosePanel', command: ':panel close', keywords: ['close'] },
    { action: 'searchTerminal', group: 'terminal', labelKey: 'palette.action.searchTerminal', fallback: 'Buscar en el historial de la terminal', shortcut: 'shortcutSearchTerminal', keywords: ['search', 'find', 'scrollback'] },
    { action: 'clearTerminal', group: 'terminal', labelKey: 'palette.action.clearTerminal', fallback: 'Limpiar la terminal (clear)', shortcut: 'shortcutClearTerminal', command: 'clear', keywords: ['clear', 'cls'] },
    { action: 'toggleTerminalOnly', group: 'terminal', labelKey: 'palette.action.toggleTerminalOnly', fallback: 'Alternar el modo de terminal limpia', shortcut: 'shortcutToggleTerminalOnly', keywords: ['clean', 'fullscreen', 'terminal-only'] },
    { action: 'newTab', group: 'tabs', labelKey: 'palette.action.newTab', fallback: 'Nueva pestaña', shortcut: 'shortcutNewTab', keywords: ['tab', 'new'] },
    { action: 'cyclePanes', group: 'tabs', labelKey: 'palette.action.cyclePanes', fallback: 'Dividir: añadir una terminal a la vista', shortcut: 'shortcutCyclePanes', command: ':panes cycle', keywords: ['split', 'panes', ':layout', ':grid'] },
    { action: 'nextTab', group: 'tabs', labelKey: 'palette.action.nextTab', fallback: 'Pestaña siguiente', shortcut: 'shortcutNextTab', keywords: ['tab', 'next'] },
    { action: 'previousTab', group: 'tabs', labelKey: 'palette.action.previousTab', fallback: 'Pestaña anterior', shortcut: 'shortcutPreviousTab', keywords: ['tab', 'previous'] },
    { action: 'refreshEnvironments', group: 'environments', labelKey: 'palette.action.refreshEnvironments', fallback: 'Volver a detectar entornos', shortcut: 'shortcutRefreshEnvironments', command: ':reload', keywords: ['reload', 'refresh', 'detect'] },
];

/** Comandos `:` que solo informan dentro de la terminal (o cambian algo
 *  escribiendo su confirmación allí). Los que equivalen a una acción de la
 *  app ya aparecen arriba con su comando como pista. */
export const PALETTE_INTERNAL_COMMANDS: ReadonlyArray<{ line: string; descriptionKey: string; fallback: string }> = [
    { line: ':help', descriptionKey: 'palette.internal.help', fallback: 'Ayuda completa de esta shell' },
    { line: ':help internos', descriptionKey: 'palette.internal.helpInternal', fallback: 'Ayuda de los comandos internos' },
    { line: ':alias', descriptionKey: 'palette.internal.alias', fallback: 'Alias disponibles en esta shell' },
    { line: ':shell list', descriptionKey: 'palette.internal.shellList', fallback: 'Lista las shells y entornos detectados' },
    { line: ':shell current', descriptionKey: 'palette.internal.shellCurrent', fallback: 'Muestra la shell de esta pestaña' },
    { line: ':theme list', descriptionKey: 'palette.internal.themeList', fallback: 'Lista los temas' },
    { line: ':font list', descriptionKey: 'palette.internal.fontList', fallback: 'Lista las fuentes de terminal' },
    { line: ':language list', descriptionKey: 'palette.internal.languageList', fallback: 'Lista los idiomas' },
    { line: ':terminal list', descriptionKey: 'palette.internal.terminalList', fallback: 'Parámetros actuales de la terminal' },
    { line: ':banner list', descriptionKey: 'palette.internal.bannerList', fallback: 'Campos visibles del fastfetch' },
    { line: ':banner preset compact', descriptionKey: 'palette.internal.bannerCompact', fallback: 'Fastfetch esencial' },
    { line: ':banner preset full', descriptionKey: 'palette.internal.bannerFull', fallback: 'Fastfetch completo' },
];

const PANEL_VISIBILITY: Partial<Record<PaletteAppAction, keyof Preferences>> = {
    openScripts: 'showScriptsPanel',
    openProjects: 'showProjectsPanel',
    openDependencies: 'showDependenciesPanel',
    toggleExplorer: 'showExplorerPanel',
    explorerFollow: 'showExplorerPanel',
    explorerCd: 'showExplorerPanel',
};

/** Acciones que necesitan una pestaña viva. */
const NEEDS_TAB: ReadonlySet<PaletteAppAction> = new Set([
    'searchTerminal', 'clearTerminal', 'openSystemExplorer', 'explorerCd', 'explorerFollow',
]);

/** Acciones que escriben una orden en la terminal y por tanto exigen shell. */
const NEEDS_SHELL: ReadonlySet<PaletteAppAction> = new Set(['clearTerminal']);

const MODIFIER_LABELS: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
const KEY_LABELS: Record<string, string> = {
    backslash: '\\', space: 'Space', escape: 'Esc', enter: 'Enter', tab: 'Tab', delete: 'Del',
    arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', pageup: 'PgUp', pagedown: 'PgDn',
    home: 'Home', end: 'End', insert: 'Ins', minus: '-', equal: '=', bracketleft: '[',
    bracketright: ']', semicolon: ';', quote: "'", backquote: '`', comma: ',', period: '.', slash: '/',
};

/** `ctrl+shift+backslash` → `Ctrl+Shift+\`. Acepta también lo guardado a
 *  mano con otra capitalización; un valor vacío sigue vacío. */
export function formatShortcut(raw: string | undefined | null): string {
    const parts = String(raw ?? '').split('+').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return '';
    return parts.map((part, index) => {
        const lower = part.toLowerCase();
        if (index < parts.length - 1) return MODIFIER_LABELS[lower === 'control' ? 'ctrl' : lower] ?? part;
        return KEY_LABELS[lower] ?? (lower.length === 1 ? lower.toUpperCase() : lower.charAt(0).toUpperCase() + lower.slice(1));
    }).join('+');
}

/** Mismo criterio que el selector de la barra (`Toolbar.svelte`). */
export function environmentGroupLabel(group: string, t: Translate): string {
    if (group === 'Shells del sistema' || group === 'Shells') return t('group.system', 'Shells del sistema');
    if (group.startsWith('Lenguajes')) return t('group.languages', 'Lenguajes · intérprete interactivo');
    if (group === 'Inteligencia artificial') return t('group.ai', 'Inteligencia artificial');
    if (group.startsWith('WSL')) return t('group.wsl', 'WSL · distribuciones Linux');
    if (group.startsWith('Docker')) return t('group.docker', 'Docker · contenedores e imágenes');
    if (group.startsWith('Android')) return t('group.android', 'Android · dispositivos ADB');
    return group;
}

export function environmentLabel(label: string, t: Translate): string {
    return label
        .replace('(sin comprobar)', t('env.unverified', '(sin comprobar)'))
        .replace('(no instalada)', t('env.notInstalled', '(no instalada)'));
}

function fill(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

function entry(partial: Omit<PaletteEntry, 'detail' | 'command' | 'keywords' | 'shortcut' | 'disabledReason' | 'current'>
    & Partial<PaletteEntry>): PaletteEntry {
    return {
        detail: '',
        command: '',
        keywords: [],
        shortcut: '',
        disabledReason: '',
        current: false,
        ...partial,
    };
}

/** Construye todas las entradas a partir del estado actual de la app. */
export function buildPaletteEntries(context: PaletteContext): PaletteEntry[] {
    const { t, preferences } = context;
    const groupLabel = (id: PaletteGroupId) => {
        const group = PALETTE_GROUPS.find((candidate) => candidate.id === id);
        return group ? t(group.labelKey, group.fallback) : id;
    };
    const noTab = t('palette.disabled.noTab', 'No hay ninguna pestaña activa.');
    const shellOnly = t('palette.disabled.shellOnly', 'Solo en una pestaña de shell; la activa es un intérprete o un asistente.');
    const entries: PaletteEntry[] = [];

    for (const definition of PALETTE_APP_ACTIONS) {
        const visibility = PANEL_VISIBILITY[definition.action];
        let disabledReason = '';
        if (visibility && preferences?.[visibility] === false) {
            disabledReason = t('palette.disabled.hiddenPanel', 'Está oculto en Ajustes › Comportamiento.');
        } else if (NEEDS_TAB.has(definition.action) && !context.hasActiveTab) {
            disabledReason = noTab;
        } else if (NEEDS_SHELL.has(definition.action) && context.activeIsRepl) {
            disabledReason = shellOnly;
        } else if ((definition.action === 'nextTab' || definition.action === 'previousTab') && context.tabCount < 2) {
            disabledReason = t('palette.disabled.singleTab', 'Solo hay una pestaña abierta.');
        }
        entries.push(entry({
            id: `app:${definition.action}`,
            group: definition.group,
            label: t(definition.labelKey, definition.fallback),
            command: definition.command ?? '',
            keywords: [...(definition.keywords ?? []), groupLabel(definition.group)],
            shortcut: definition.shortcut ? formatShortcut(preferences?.[definition.shortcut]) : '',
            action: { kind: 'app', action: definition.action },
            disabledReason,
            current: definition.action === 'toggleTerminalOnly' && preferences?.terminalOnlyMode === true,
        }));
    }

    for (let count = 1; count <= 4; count += 1) {
        entries.push(entry({
            id: `panes:${count}`,
            group: 'tabs',
            label: count === 1
                ? t('palette.action.panesOne', 'Ver una sola terminal')
                : fill(t('palette.action.panes', 'Ver {count} terminales a la vez'), { count }),
            command: `:panes ${count}`,
            keywords: [':layout', ':grid', 'split', groupLabel('tabs')],
            action: { kind: 'panes', count },
            current: context.paneCount === count,
        }));
    }

    const unavailable = t('palette.disabled.unavailable', 'No está disponible todavía.');
    for (const environment of context.environments) {
        const name = environmentLabel(environment.label, t);
        const group = environmentGroupLabel(environment.group, t);
        const isCurrent = environment.id === context.activeEnvId;
        const keywords = [environment.id, environment.shell ?? '', environment.language ?? '', environment.distro ?? '', group, groupLabel('environments')]
            .filter(Boolean);
        entries.push(entry({
            id: `env:${environment.id}`,
            group: 'environments',
            label: fill(t('palette.action.switchEnvironment', 'Cambiar esta pestaña a {name}'), { name }),
            detail: group,
            command: environment.repl ? '' : `:shell ${environment.id}`,
            keywords,
            action: { kind: 'environment', envId: environment.id },
            current: isCurrent,
            disabledReason: !context.hasActiveTab
                ? noTab
                : !environment.available
                    ? (environment.note?.trim() || unavailable)
                    : isCurrent
                        ? t('palette.disabled.currentEnvironment', 'Es el entorno de esta pestaña.')
                        : '',
        }));
        if (environment.repl && environment.available) {
            entries.push(entry({
                id: `repl:${environment.id}`,
                group: 'environments',
                label: fill(t('palette.action.openRepl', 'Abrir {name} en una pestaña nueva'), { name }),
                detail: group,
                command: `:repl ${environment.language ?? environment.id.replace(/^.*:/, '')}`,
                keywords,
                action: { kind: 'newTabIn', envId: environment.id },
            }));
        }
    }

    const themeId = preferences?.themeId;
    for (const theme of [...context.themes, ...(preferences?.customThemes ?? [])]) {
        entries.push(entry({
            id: `theme:${theme.id}`,
            group: 'appearance',
            label: fill(t('palette.action.theme', 'Tema: {name}'), { name: theme.label }),
            command: `:theme ${theme.id}`,
            keywords: ['theme', theme.id, groupLabel('appearance')],
            action: { kind: 'theme', themeId: theme.id },
            current: theme.id === themeId,
        }));
    }
    for (const font of context.fonts) {
        entries.push(entry({
            id: `font:${font.id}`,
            group: 'appearance',
            label: fill(t('palette.action.font', 'Fuente de la terminal: {name}'), { name: font.label }),
            command: `:font ${font.id}`,
            keywords: ['font', font.id, groupLabel('appearance')],
            action: { kind: 'font', fontId: font.id },
            current: font.id === preferences?.terminalFontFamily,
        }));
    }
    for (const language of context.languages) {
        entries.push(entry({
            id: `language:${language.id}`,
            group: 'appearance',
            label: fill(t('palette.action.language', 'Idioma: {name}'), { name: language.label }),
            command: `:language ${language.id}`,
            keywords: ['language', language.id, groupLabel('appearance')],
            action: { kind: 'language', languageId: language.id },
            current: language.id === preferences?.language,
        }));
    }

    for (const command of PALETTE_INTERNAL_COMMANDS) {
        entries.push(entry({
            id: `internal:${command.line}`,
            group: 'internal',
            label: command.line,
            detail: t(command.descriptionKey, command.fallback),
            command: command.line,
            keywords: [groupLabel('internal')],
            action: { kind: 'internal', line: command.line },
            disabledReason: !context.hasActiveTab ? noTab : context.activeIsRepl ? shellOnly : '',
        }));
    }

    for (const action of context.ltoolsActions) {
        entries.push(entry({
            id: `ltools:${action.id}`,
            group: 'ltools',
            label: action.displayLabel,
            detail: action.description || action.meta,
            keywords: ['ltools', 'tools', action.id, action.meta, groupLabel('ltools')],
            action: { kind: 'ltools', actionId: action.id, needsConfirmation: action.needsConfirmation },
            disabledReason: context.hasActiveTab ? '' : noTab,
        }));
    }
    return entries;
}

/** Una línea `:` válida para teclearla tal cual: ASCII imprimible y una sola
 *  línea, igual que lo que el espejo de entrada de TerminalPane reconoce. El
 *  verbo lo valida después el parser Rust (`internal_command_parse`). */
export function isTypableInternalLine(text: string): boolean {
    return /^:[\x21-\x7e][\x20-\x7e]{0,199}$/u.test(text.trim());
}

/** Quita mayúsculas y diacríticos: «pestana» encuentra «pestaña». */
export function foldPaletteText(text: string, fold: (value: string) => string = (value) => value.toLowerCase()): string {
    return fold(text).normalize('NFD').replace(/\p{M}+/gu, '');
}

function isSubsequence(needle: string, haystack: string): boolean {
    let index = 0;
    for (const character of haystack) {
        if (character === needle[index]) index += 1;
        if (index === needle.length) return true;
    }
    return needle.length === 0;
}

function scoreEntry(entryValue: PaletteEntry, query: string, tokens: string[], fold: (value: string) => string): number {
    const label = foldPaletteText(entryValue.label, fold);
    const command = foldPaletteText(entryValue.command, fold);
    const rest = foldPaletteText([entryValue.detail, ...entryValue.keywords].join(' '), fold);
    const words = label.split(/[\s·:,()/-]+/u).filter(Boolean);
    let score = 0;
    for (const token of tokens) {
        if (words.some((word) => word.startsWith(token))) score += 20;
        else if (label.includes(token)) score += 12;
        else if (command.includes(token)) score += 10;
        else if (rest.includes(token)) score += 5;
        else return -1;
    }
    if (label.startsWith(query)) score += 60;
    if (command && command.startsWith(query)) score += 50;
    if (label === query || command === query) score += 40;
    return score;
}

/** Filtra y ordena. Sin búsqueda conserva el orden del registro; con ella,
 *  cada palabra debe aparecer en la etiqueta, el comando, el detalle o los
 *  sinónimos, y gana lo que empieza por lo escrito. Si ninguna entrada
 *  contiene todas las palabras, se admite la etiqueta como subsecuencia
 *  («nvpst» → «Nueva pestaña»). Las deshabilitadas van detrás. */
export function filterPaletteEntries(
    entries: ReadonlyArray<PaletteEntry>,
    query: string,
    fold?: (value: string) => string,
): PaletteEntry[] {
    const folded = foldPaletteText(query.trim(), fold);
    if (!folded) return [...entries];
    const tokens = folded.split(/\s+/u).filter(Boolean);
    const scored = entries
        .map((candidate, index) => ({ candidate, index, score: scoreEntry(candidate, folded, tokens, fold ?? ((value) => value.toLowerCase())) }))
        .filter((item) => item.score >= 0);
    const ranked = scored.length
        ? scored
        : entries
            .map((candidate, index) => ({ candidate, index, score: isSubsequence(folded.replace(/\s+/gu, ''), foldPaletteText(candidate.label, fold).replace(/\s+/gu, '')) ? 1 : -1 }))
            .filter((item) => item.score >= 0);
    return ranked
        .sort((left, right) => {
            const disabled = Number(Boolean(left.candidate.disabledReason)) - Number(Boolean(right.candidate.disabledReason));
            return disabled || right.score - left.score || left.index - right.index;
        })
        .map((item) => item.candidate);
}

/** Resultado visible: si lo escrito es una línea `:` que no coincide con
 *  ninguna entrada, primero se ofrece ejecutarla tal cual en la terminal. */
export function paletteResults(
    entries: ReadonlyArray<PaletteEntry>,
    query: string,
    context: Pick<PaletteContext, 't' | 'hasActiveTab' | 'activeIsRepl'>,
    fold?: (value: string) => string,
): PaletteEntry[] {
    const filtered = filterPaletteEntries(entries, query, fold);
    const line = query.trim().replace(/\s+/gu, ' ');
    if (!isTypableInternalLine(line)) return filtered;
    const normalized = foldPaletteText(line, fold);
    if (entries.some((candidate) => candidate.command && foldPaletteText(candidate.command, fold) === normalized)) return filtered;
    const raw = entry({
        id: 'internal:raw',
        group: 'internal',
        label: line,
        detail: context.t('palette.runInternal', 'Ejecutar este comando interno en la terminal activa'),
        command: line,
        action: { kind: 'internal', line },
        disabledReason: !context.hasActiveTab
            ? context.t('palette.disabled.noTab', 'No hay ninguna pestaña activa.')
            : context.activeIsRepl
                ? context.t('palette.disabled.shellOnly', 'Solo en una pestaña de shell; la activa es un intérprete o un asistente.')
                : '',
    });
    return [raw, ...filtered];
}

/** Índice siguiente al pulsar una tecla de navegación en la lista, o `null`
 *  si la tecla no es de navegación. La lista da la vuelta con las flechas. */
export function nextPaletteIndex(current: number, key: string, count: number, pageSize = 8): number | null {
    if (count <= 0) return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End' || key === 'PageDown' || key === 'PageUp' ? -1 : null;
    const at = current < 0 ? -1 : Math.min(current, count - 1);
    switch (key) {
        case 'ArrowDown': return at + 1 >= count ? 0 : at + 1;
        case 'ArrowUp': return at <= 0 ? count - 1 : at - 1;
        case 'Home': return 0;
        case 'End': return count - 1;
        case 'PageDown': return Math.min(count - 1, Math.max(0, at) + pageSize);
        case 'PageUp': return Math.max(0, at - pageSize);
        default: return null;
    }
}
