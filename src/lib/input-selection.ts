/**
 * Cortar o borrar una selección de la línea que se está escribiendo.
 *
 * xterm selecciona celdas de la pantalla, pero quien edita la línea es la
 * shell (cmd, PSReadLine, readline, el REPL) con su propio cursor. Para quitar
 * lo seleccionado se le mandan las teclas que pulsaría el usuario: flechas
 * hasta el final de la selección y un retroceso por carácter. Se cuentan
 * caracteres, no celdas, para que un emoji o un carácter CJK (dos celdas) no
 * desplace la edición.
 *
 * Solo se edita si la selección cae dentro de lo escrito tras el prompt (por
 * ejemplo `Hola, soy Romen` dentro de `echo "Hola, soy Romen"`) o si uno de
 * sus extremos toca el cursor (programas sin prompt reconocible, como nano):
 * así una selección del historial nunca se convierte en cientos de retrocesos.
 */

import type { TerminalBufferLine } from './terminal-columns';

/** Posición en el búfer: columna (0, celdas) y fila absoluta (0). */
export interface BufferPoint {
    x: number;
    y: number;
}

/** Tope de teclas por edición, como el de la selección editable anterior. */
export const MAX_EDIT_KEYS = 4096;

export function comparePoints(a: BufferPoint, b: BufferPoint): number {
    return a.y - b.y || a.x - b.x;
}

/**
 * Dónde empieza lo escrito tras un prompt conocido (índice en el texto de la
 * línea), o `null` si la línea no empieza por un prompt reconocible. Son los
 * mismos prompts que reconoce `isShellInputLine`: cmd (`C:\ruta>`), PowerShell
 * (`PS C:\ruta> `), bash/zsh (`usuario@equipo:~$ `, `$ `, `# `) y los de
 * starship u oh-my-zsh (`❯ `, `➜ `).
 */
export function promptInputStart(text: string): number | null {
    const cmd = /^[A-Za-z]:[\\/][^>\r\n]*>/u.exec(text);
    if (cmd) return cmd[0].length;
    const shell = /^(?:~\s+)?(?:[\w.-]+@[\w.-]+(?::[^#$]*)?[#$]|❯|➜|[$#]|PS\s+[^>]*>)(?:\s|$)/u.exec(text);
    return shell ? shell[0].length : null;
}

/** Columna (en celdas) del carácter número `index` del texto de una línea.
 *  La mitad derecha de un carácter ancho no cuenta como carácter. */
export function columnAtTextIndex(line: TerminalBufferLine, index: number): number {
    let consumed = 0;
    for (let x = 0; x < line.length; x += 1) {
        const cell = line.getCell(x);
        if (!cell) break;
        if (cell.getWidth() === 0) continue;
        if (consumed >= index) return x;
        consumed += (cell.getChars() || ' ').length;
    }
    return line.length;
}

/** Columna siguiente a la última celda con texto (0 si la línea está vacía). */
export function contentEndColumn(line: TerminalBufferLine): number {
    for (let x = line.length - 1; x >= 0; x -= 1) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars();
        if (chars && chars !== ' ') return x + Math.max(1, cell.getWidth());
    }
    return 0;
}

export interface InputSelectionContext {
    /** Selección de xterm: `start` incluida, `end` excluida. */
    start: BufferPoint;
    end: BufferPoint;
    cursor: BufferPoint;
    /** La celda del cursor está en blanco (el cursor está tras lo escrito). */
    cursorCellBlank: boolean;
    /** Comienzo de lo escrito tras el prompt; `null` si no se sabe. */
    inputStart: BufferPoint | null;
    /** Fin de lo escrito: la última celda con texto de la línea o el cursor. */
    inputEnd: BufferPoint;
    /** Texto entre dos puntos del búfer (`from` < `to`), con un salto entre
     *  filas que no sean continuación de la anterior. */
    textBetween(from: BufferPoint, to: BufferPoint): string;
}

export interface InputSelectionEdit {
    /** Lo seleccionado (lo que «Cortar» copia). */
    text: string;
    /** Teclas para la shell: flechas hasta el final y un retroceso por carácter. */
    input: string;
}

export function inputSelectionEdit(context: InputSelectionContext): InputSelectionEdit | null {
    let start = context.start;
    let end = context.end;
    if (comparePoints(start, end) > 0) [start, end] = [end, start];
    const { cursor, inputStart, inputEnd } = context;
    // Seleccionar hasta la celda del cursor, en blanco tras lo escrito, es
    // seleccionar hasta el cursor.
    if (context.cursorCellBlank && end.y === cursor.y && end.x === cursor.x + 1) end = cursor;
    if (comparePoints(start, end) >= 0) return null;
    const touchesCursor = comparePoints(start, cursor) === 0 || comparePoints(end, cursor) === 0;
    const insideInput = inputStart !== null
        && comparePoints(start, inputStart) >= 0
        && comparePoints(end, inputEnd) <= 0;
    if (!touchesCursor && !insideInput) return null;
    const text = context.textBetween(start, end);
    const removed = Array.from(text).length;
    if (removed === 0 || removed > MAX_EDIT_KEYS) return null;
    let moves = '';
    const order = comparePoints(end, cursor);
    if (order !== 0) {
        const steps = Array.from(order < 0 ? context.textBetween(end, cursor) : context.textBetween(cursor, end)).length;
        if (steps > MAX_EDIT_KEYS) return null;
        moves = (order < 0 ? '\u001b[D' : '\u001b[C').repeat(steps);
    }
    return { text, input: moves + '\u007f'.repeat(removed) };
}

/** Lo seleccionado como texto de búsqueda: la primera línea con contenido,
 *  sin espacios a los lados y como mucho 200 caracteres. */
export function selectionSearchText(selection: string): string {
    const line = selection.split(/\r?\n/u).find((candidate) => candidate.trim()) ?? '';
    return Array.from(line.trim()).slice(0, 200).join('');
}
