// Los xterm vivos, por pestaña.
//
// Los eventos del pty llegan a un único sitio (App.svelte se suscribe una vez,
// no un componente por pestaña) y hay que encaminarlos al xterm correcto. Un
// registro plano es más simple que pasar callbacks hacia arriba, y además
// permite que la salida que llegue justo entre el `close` de una pestaña y la
// destrucción de su componente no vaya a parar a ninguna parte.

import type { IBuffer, Terminal } from '@xterm/xterm';

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

/** Estado de un xterm para diagnosticar desde las herramientas de desarrollo
 *  o el E2E (como `__wtPendingIpc`): desplazamiento, tamaño del búfer y si su
 *  renderer está en pausa (xterm deja de pintar mientras cree que no se ve). */
function terminalState(tabId: string) {
    const term = terminals.get(tabId);
    if (!term) return null;
    const buffer = term.buffer.active;
    // Internos de xterm 6, solo para leerlos: el renderer y el elemento de
    // scroll de su Viewport, que recorta las posiciones con sus dimensiones.
    const core = (term as unknown as {
        _core?: {
            _renderService?: { _isPaused?: boolean; _needsFullRefresh?: boolean; dimensions?: { css?: { canvas?: { height?: number }; cell?: { height?: number } } } };
            _viewport?: { _latestYDisp?: number; _scrollableElement?: { getScrollDimensions?: () => { height: number; scrollHeight: number }; getScrollPosition?: () => { scrollTop: number } } };
            _bufferService?: { isUserScrolling?: boolean };
        };
    })._core;
    const renderService = core?._renderService;
    const scrollable = core?._viewport?._scrollableElement;
    const dimensions = scrollable?.getScrollDimensions?.();
    return {
        rows: term.rows,
        cols: term.cols,
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        length: buffer.length,
        cursorY: buffer.cursorY,
        renderPaused: renderService?._isPaused ?? null,
        needsFullRefresh: renderService?._needsFullRefresh ?? null,
        canvasHeight: renderService?.dimensions?.css?.canvas?.height ?? null,
        cellHeight: renderService?.dimensions?.css?.cell?.height ?? null,
        scrollHeight: dimensions?.scrollHeight ?? null,
        scrollAreaHeight: dimensions?.height ?? null,
        scrollTop: scrollable?.getScrollPosition?.().scrollTop ?? null,
        latestYDisp: core?._viewport?._latestYDisp ?? null,
        userScrolling: core?._bufferService?.isUserScrolling ?? null,
        connected: term.element?.isConnected ?? false,
    };
}
/** Cada línea en la suya y las filas de una línea partida unidas. */
export function bufferText(buffer: Pick<IBuffer, 'length' | 'getLine'>, from = 0, to = buffer.length - 1): string {
    let text = '';
    for (let row = from; row <= to; row += 1) {
        const line = buffer.getLine(row);
        if (line) text += `${row === from || line.isWrapped ? '' : '\n'}${line.translateToString(true)}`;
    }
    return text;
}

/** Nombre propuesto al guardar la salida: el de la pestaña sin los caracteres
 *  que Windows no admite en un archivo, y la fecha para no pisar otro anterior. */
export function outputFileName(title: string, date: Date): string {
    const clean = title.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/[ .]+$/, '').trim();
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `${clean || 'terminal'}-${stamp}.txt`;
}

/** Texto de un xterm con el historial. xterm 6 no desplaza el DOM, así que
 *  recorrerlo por la pantalla costaba al E2E decenas de pasos de rueda. */
function terminalText(tabId: string): string | null {
    const term = terminals.get(tabId);
    return term ? bufferText(term.buffer.active) : null;
}
if (typeof window !== 'undefined') {
    const diagnostics = window as unknown as { __wtTerminalState?: typeof terminalState; __wtTerminalText?: typeof terminalText };
    diagnostics.__wtTerminalState = terminalState;
    diagnostics.__wtTerminalText = terminalText;
}

/** Por qué una pestaña no aceptó una orden de la paleta de comandos. */
export type TerminalLineRejection = 'not-ready' | 'busy' | 'draft';

/** Lo que la paleta de comandos puede pedir a una pestaña sin escribir en su
 *  xterm. Cada TerminalPane registra sus propias funciones al montarse. */
export interface TerminalControls {
    openSearch(): void;
    /** Guarda el historial en el archivo que se elija en el diálogo nativo. */
    saveOutput(): Promise<void>;
    /** Copia lo que escribió la última orden (hace falta que la shell la marque). */
    copyLastOutput(): void;
    /** Lleva la vista al prompt de la orden anterior o siguiente. */
    jumpToCommand(direction: 'previous' | 'next'): void;
    /** Teclea `line` y Enter por la misma ruta que el teclado: el interceptor
     *  de `:` y la shell la reciben igual que una orden escrita a mano, y el
     *  eco lo sigue pintando ConPTY. Si la terminal no está en un prompt
     *  vacío no escribe nada y devuelve el motivo. */
    submitLine(line: string): TerminalLineRejection | null;
    /** Como `submitLine`, pero sin Intro: la orden queda escrita en el prompt. */
    insertLine(line: string): TerminalLineRejection | null;
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
