// Los xterm vivos, por pestaña.
//
// Los eventos del pty llegan a un único sitio (App.svelte se suscribe una vez,
// no un componente por pestaña) y hay que encaminarlos al xterm correcto. Un
// registro plano es más simple que pasar callbacks hacia arriba, y además
// permite que la salida que llegue justo entre el `close` de una pestaña y la
// destrucción de su componente no vaya a parar a ninguna parte.

import type { Terminal } from '@xterm/xterm';

const terminals = new Map<string, Terminal>();

export function registerTerminal(tabId: string, term: Terminal): void {
    terminals.set(tabId, term);
}

export function unregisterTerminal(tabId: string): void {
    terminals.delete(tabId);
}

export function getTerminal(tabId: string): Terminal | undefined {
    return terminals.get(tabId);
}

/** Por qué una pestaña no aceptó una orden de la paleta de comandos. */
export type TerminalLineRejection = 'not-ready' | 'busy' | 'draft';

/** Lo que la paleta de comandos puede pedir a una pestaña sin escribir en su
 *  xterm. Cada TerminalPane registra sus propias funciones al montarse. */
export interface TerminalControls {
    openSearch(): void;
    /** Teclea `line` y Enter por la misma ruta que el teclado: el interceptor
     *  de `:` y la shell la reciben igual que una orden escrita a mano, y el
     *  eco lo sigue pintando ConPTY. Si la terminal no está en un prompt
     *  vacío no escribe nada y devuelve el motivo. */
    submitLine(line: string): TerminalLineRejection | null;
}

const controls = new Map<string, TerminalControls>();

export function registerTerminalControls(tabId: string, value: TerminalControls): void {
    controls.set(tabId, value);
}

export function unregisterTerminalControls(tabId: string): void {
    controls.delete(tabId);
}

export function getTerminalControls(tabId: string): TerminalControls | undefined {
    return controls.get(tabId);
}
