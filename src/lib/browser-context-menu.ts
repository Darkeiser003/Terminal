// Menú del clic derecho del navegador interno (21-11, Romen: «al hacer clic
// derecho en ciertas zonas sale ese mensaje de html, ¿podemos quitarlo?»).
//
// WebView2 enseña su propio menú («Atrás», «Actualizar», «Guardar como»,
// «Imprimir», «Más herramientas») donde la app no pone uno suyo: la barra de
// pestañas vacía, los márgenes, los paneles. Nada de eso tiene sentido en una
// aplicación de escritorio y «Atrás»/«Actualizar» pueden recargar la interfaz.
//
// Se deja solo donde ayuda: en un campo de texto (cortar, copiar, pegar) y
// sobre texto seleccionado (copiar). Los menús propios de la app (terminal,
// pestañas, explorador) llaman antes a `preventDefault` y no llegan aquí.

/** Lo justo de un elemento para decidir, sin depender del DOM real. */
export interface ContextMenuTarget {
    tagName?: string;
    isContentEditable?: boolean;
    type?: string;
    readOnly?: boolean;
    disabled?: boolean;
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number']);

/** `true`: se deja el menú del navegador (campo de texto o texto seleccionado). */
export function keepsBrowserContextMenu(target: ContextMenuTarget | null, selectedText: string): boolean {
    if (selectedText.trim().length > 0) return true;
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = (target.tagName ?? '').toUpperCase();
    if (tag === 'TEXTAREA') return !target.disabled;
    if (tag === 'INPUT') {
        return !target.disabled && TEXT_INPUT_TYPES.has((target.type ?? '').toLowerCase());
    }
    return false;
}

/** Instala el filtro en la ventana. Devuelve cómo quitarlo. */
export function installBrowserContextMenuFilter(win: Window = window): () => void {
    const onContextMenu = (event: MouseEvent) => {
        if (event.defaultPrevented) return;
        const target = event.target instanceof Element ? (event.target as HTMLElement & ContextMenuTarget) : null;
        // El textarea invisible de xterm no es un campo del usuario (la
        // terminal pone su propio menú; esto es solo por si acaso).
        const editable = target?.closest<HTMLElement>(
            'input, textarea:not(.xterm-helper-textarea), [contenteditable=""], [contenteditable="true"]',
        ) ?? null;
        const selected = win.getSelection()?.toString() ?? '';
        if (keepsBrowserContextMenu(editable as (HTMLElement & ContextMenuTarget) | null, selected)) return;
        event.preventDefault();
    };
    // En burbuja: los menús propios ya han decidido cuando llega aquí.
    win.addEventListener('contextmenu', onContextMenu);
    return () => win.removeEventListener('contextmenu', onContextMenu);
}
