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
    'shortcutPaneLeft',
    'shortcutPaneRight',
    'shortcutPaneUp',
    'shortcutPaneDown',
] as const;

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
    if (!(/^[a-z0-9]$/.test(key) || ['tab', 'backslash', 'enter', 'space', 'escape', 'delete', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key))) return '';
    return `${MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)).join('+')}+${key}`;
}

function eventKey(event: KeyboardEvent): string {
    if (event.code === 'Backslash') return 'backslash';
    if (event.code === 'Space') return 'space';
    if (event.code === 'Escape') return 'escape';
    if (event.code === 'Enter') return 'enter';
    if (event.code === 'Tab') return 'tab';
    return canonicalKey(event.key);
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
