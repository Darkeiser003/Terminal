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
