/** Contrato único para los atajos editables de la aplicación.
 *
 * Los nombres se guardan como `Ctrl+Shift+Backslash`, pero la tecla física se
 * compara también con `KeyboardEvent.code`. Esto evita que el atajo de división
 * dependa de si el teclado entrega `\\` o `|` al pulsar Shift.
 */

export const SHORTCUT_PREFERENCE_KEYS = [
    'shortcutNewTab',
    'shortcutNextTab',
    'shortcutPreviousTab',
    'shortcutCyclePanes',
    'shortcutToggleExplorer',
    'shortcutToggleTerminalOnly',
    'shortcutPaneLeft',
    'shortcutPaneRight',
    'shortcutPaneUp',
    'shortcutPaneDown',
    'shortcutOpenSettings',
    'shortcutOpenProjects',
    'shortcutOpenScripts',
    'shortcutOpenDependencies',
    'shortcutClosePanel',
    'shortcutRefreshEnvironments',
    'shortcutExplorerFollow',
    'shortcutExplorerCd',
    'shortcutClearTerminal',
    'shortcutOpenSystemExplorer',
] as const;

export type ShortcutPreferenceKey = (typeof SHORTCUT_PREFERENCE_KEYS)[number];

/** Acciones que se pueden grabar en Ajustes. Las claves de traducción son
 *  compartidas con los botones existentes para que el catálogo siga siendo
 *  único, también cuando el usuario cambia de idioma. */
export const SHORTCUT_DEFINITIONS: ReadonlyArray<{
    key: ShortcutPreferenceKey;
    labelKey: string;
    fallback: string;
}> = [
    { key: 'shortcutNewTab', labelKey: 'settings.shortcutNewTab', fallback: 'Nueva pestaña' },
    { key: 'shortcutNextTab', labelKey: 'settings.shortcutNextTab', fallback: 'Pestaña siguiente' },
    { key: 'shortcutPreviousTab', labelKey: 'settings.shortcutPreviousTab', fallback: 'Pestaña anterior' },
    { key: 'shortcutCyclePanes', labelKey: 'settings.shortcutCyclePanes', fallback: 'Dividir terminales' },
    { key: 'shortcutToggleExplorer', labelKey: 'settings.shortcutToggleExplorer', fallback: 'Mostrar explorador' },
    { key: 'shortcutToggleTerminalOnly', labelKey: 'settings.shortcutToggleTerminalOnly', fallback: 'Modo terminal limpia' },
    { key: 'shortcutPaneLeft', labelKey: 'settings.shortcutPaneLeft', fallback: 'Foco a la izquierda' },
    { key: 'shortcutPaneRight', labelKey: 'settings.shortcutPaneRight', fallback: 'Foco a la derecha' },
    { key: 'shortcutPaneUp', labelKey: 'settings.shortcutPaneUp', fallback: 'Foco arriba' },
    { key: 'shortcutPaneDown', labelKey: 'settings.shortcutPaneDown', fallback: 'Foco abajo' },
    { key: 'shortcutOpenSettings', labelKey: 'toolbar.settings', fallback: 'Abrir ajustes' },
    { key: 'shortcutOpenProjects', labelKey: 'toolbar.projects', fallback: 'Abrir proyectos' },
    { key: 'shortcutOpenScripts', labelKey: 'toolbar.scripts', fallback: 'Abrir biblioteca' },
    { key: 'shortcutOpenDependencies', labelKey: 'toolbar.deps', fallback: 'Abrir entorno y dependencias' },
    { key: 'shortcutClosePanel', labelKey: 'common.close', fallback: 'Cerrar panel' },
    { key: 'shortcutRefreshEnvironments', labelKey: 'toolbar.envRefresh', fallback: 'Volver a detectar entornos' },
    { key: 'shortcutExplorerFollow', labelKey: 'explorer.follow', fallback: 'Seguir la ruta de la terminal' },
    { key: 'shortcutExplorerCd', labelKey: 'explorer.cd', fallback: 'Llevar la terminal a esta carpeta' },
    { key: 'shortcutClearTerminal', labelKey: 'help.clear', fallback: 'Limpiar terminal' },
    { key: 'shortcutOpenSystemExplorer', labelKey: 'explorer.openInSystem', fallback: 'Abrir en el explorador del sistema' },
];

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;
const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
    ctrl: 'ctrl',
    control: 'ctrl',
    alt: 'alt',
    option: 'alt',
    shift: 'shift',
    meta: 'meta',
    cmd: 'meta',
    command: 'meta',
    win: 'meta',
    super: 'meta',
};

const KEY_ALIASES: Record<string, string> = {
    esc: 'escape',
    return: 'enter',
    del: 'delete',
    left: 'arrowleft',
    right: 'arrowright',
    up: 'arrowup',
    down: 'arrowdown',
};

const SPECIAL_KEYS = [
    'tab', 'backslash', 'enter', 'space', 'escape', 'delete',
    'arrowleft', 'arrowright', 'arrowup', 'arrowdown',
    'home', 'end', 'pageup', 'pagedown', 'insert',
    'minus', 'equal', 'bracketleft', 'bracketright', 'semicolon',
    'quote', 'backquote', 'comma', 'period', 'slash',
];

const CODE_KEY_ALIASES: Record<string, string> = {
    Backquote: 'backquote',
    Minus: 'minus',
    Equal: 'equal',
    BracketLeft: 'bracketleft',
    BracketRight: 'bracketright',
    Semicolon: 'semicolon',
    Quote: 'quote',
    Comma: 'comma',
    Period: 'period',
    Slash: 'slash',
    Home: 'home',
    End: 'end',
    PageUp: 'pageup',
    PageDown: 'pagedown',
    Insert: 'insert',
};

function canonicalKey(raw: string): string {
    const key = raw.trim().toLowerCase();
    return KEY_ALIASES[key] ?? key;
}

/** Devuelve una representación estable, o cadena vacía si no es un atajo. */
export function normalizeShortcut(raw: string): string {
    const parts = raw.split('+').map((part) => part.trim().toLowerCase());
    if (parts.length < 2 || parts.length > 4 || parts.some((part) => !part)) return '';
    const key = canonicalKey(parts.at(-1) ?? '');
    const modifiers = parts.slice(0, -1).map((part) => MODIFIER_ALIASES[part]);
    if (modifiers.some((part) => !part) || new Set(modifiers).size !== modifiers.length) return '';
    if (!(/^[a-z0-9]$/.test(key) || /^f(?:[1-9]|1[0-2])$/.test(key) || SPECIAL_KEYS.includes(key))) return '';
    return `${MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)).join('+')}+${key}`;
}

function eventKey(event: KeyboardEvent): string {
    if (event.code === 'Backslash') return 'backslash';
    if (event.code === 'Space') return 'space';
    if (event.code === 'Escape') return 'escape';
    if (event.code === 'Enter') return 'enter';
    if (event.code === 'Tab') return 'tab';
    if (CODE_KEY_ALIASES[event.code]) return CODE_KEY_ALIASES[event.code];
    if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
    if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) return event.code.toLowerCase();
    return canonicalKey(event.key);
}

/** Convierte una pulsación en el formato que entiende `matchesShortcut`.
 *  Exigir al menos una tecla modificadora evita secuestrar letras, espacio o
 *  flechas que la shell necesita para editar la línea. */
export function shortcutFromEvent(event: KeyboardEvent): string {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return '';
    const key = eventKey(event);
    const modifiers = [
        event.ctrlKey ? 'ctrl' : '',
        event.altKey ? 'alt' : '',
        event.shiftKey ? 'shift' : '',
        event.metaKey ? 'meta' : '',
    ].filter(Boolean);
    if (!modifiers.length) return '';
    return normalizeShortcut([...modifiers, key].join('+'));
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
    const normalized = normalizeShortcut(shortcut);
    if (!normalized) return false;
    const parts = normalized.split('+');
    const expectedKey = parts.at(-1);
    return eventKey(event) === expectedKey
        && event.ctrlKey === parts.includes('ctrl')
        && event.altKey === parts.includes('alt')
        && event.shiftKey === parts.includes('shift')
        && event.metaKey === parts.includes('meta');
}
