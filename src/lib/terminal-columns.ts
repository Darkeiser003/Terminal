export interface TerminalRowWidth {
    columns: number;
    isWrapped: boolean;
}

export interface TerminalBufferCell {
    getChars(): string;
    getWidth(): number;
}

export interface TerminalBufferLine {
    length: number;
    getCell(index: number): TerminalBufferCell | undefined;
}

/** Recogniza prompts comunes para no confundir el eco del comando con salida. */
export function isShellInputLine(text: string): boolean {
    // cmd no añade un espacio después de `>`: el eco real puede empezar
    // inmediatamente por `powershell`, `echo`, etc. Reconocer ese prompt
    // completo evita medir las continuaciones de la orden como salida y
    // ensanchar la matriz durante una barra corta.
    if (/^[A-Za-z]:[\\/][^>\r\n]*>/u.test(text)) return true;
    return /^(?:~\s+)?(?:[\w.-]+@[\w.-]+(?::[^#$]*)?[#$]|❯|➜|[$#]|PS\s+[^>]*>)(?:\s|$)/u.test(text);
}

/**
 * Calcula las columnas mínimas que necesita la rejilla en este momento:
 * el viewport, el contenido lógico que sigue visible y cualquier reserva
 * explícita para la línea que el usuario está editando. El scrollback que ya
 * no se ve no participa, de modo que una ayuda larga no deja la PTY ancha.
 */
export function requiredTerminalColumns(
    viewportColumns: number,
    visibleContentColumns: number,
    minimumColumns = 0,
    maxColumns = 2048,
): number {
    const integer = (value: number, fallback: number) => Number.isFinite(value) ? Math.floor(value) : fallback;
    const safeMaxColumns = Math.max(1, integer(maxColumns, 2048));
    const safeViewportColumns = Math.max(1, Math.min(safeMaxColumns, integer(viewportColumns, 1)));
    const safeContentColumns = Math.max(0, Math.min(safeMaxColumns, integer(visibleContentColumns, 0)));
    const safeMinimumColumns = Math.max(0, Math.min(safeMaxColumns, integer(minimumColumns, 0)));

    return Math.max(safeViewportColumns, safeContentColumns, safeMinimumColumns);
}

/**
 * Reserva las columnas necesarias para la línea que se está editando y para
 * el margen que el llamador pida. El margen corto sirve para teclas normales;
 * una línea pegada puede pasar su longitud completa como `lookahead` cuando
 * necesita llegar al Enter sin que ConPTY la reenvuelva. La reserva se libera
 * al terminar la salida, así que no convierte el scrollback en ancho fijo.
 */
export function inputReservationColumns(
    cursorColumn: number,
    inputLength: number,
    lookahead = 4,
    maxColumns = 2048,
): number {
    const integer = (value: number, fallback: number) => Number.isFinite(value) ? Math.floor(value) : fallback;
    const safeMaxColumns = Math.max(1, integer(maxColumns, 2048));
    const safeCursorColumn = Math.max(0, Math.min(safeMaxColumns, integer(cursorColumn, 0)));
    const safeInputLength = Math.max(0, integer(inputLength, 0));
    const safeLookahead = Math.max(0, integer(lookahead, 4));
    return Math.min(safeMaxColumns, safeCursorColumn + Math.min(safeInputLength, safeLookahead) + 2);
}

/**
 * Devuelve las columnas ocupadas por el contenido visible de una fila.
 * `String.length` cuenta unidades UTF-16, no celdas de terminal: por ejemplo,
 * un carácter CJK ocupa dos columnas aunque su longitud sea uno. Se ignoran
 * espacios finales como en `translateToString(true)` y se limita la lectura a
 * las columnas actuales, ya que xterm puede conservar celdas tras un resize.
 */
export function occupiedTerminalColumns(
    line: TerminalBufferLine,
    currentColumns: number,
    maxColumns = 2048,
): number {
    const integer = (value: number, fallback: number) => Number.isFinite(value) ? Math.floor(value) : fallback;
    const safeMaxColumns = Math.max(0, integer(maxColumns, 2048));
    const safeCurrentColumns = Math.max(0, integer(currentColumns, 0));
    const limit = Math.min(safeMaxColumns, safeCurrentColumns, Math.max(0, integer(line.length, 0)));
    let occupied = 0;

    for (let column = 0; column < limit; column += 1) {
        const cell = line.getCell(column);
        if (!cell) continue;
        const chars = cell.getChars();
        if (!chars || /^\s+$/u.test(chars)) continue;
        const width = Math.max(0, integer(cell.getWidth(), 0));
        if (width === 0) continue;
        occupied = Math.min(limit, column + width);
    }
    return occupied;
}

/** El texto de un bloque de salida, sin secuencias de escape ni controles. */
export function withoutTerminalControls(data: string): string {
    return data
        // OSC y las cadenas DCS, SOS, PM y APC (los datos de Sixel también).
        .replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)/gu, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
        // Los demás escapes son ESC, intermedios y un carácter final. Quitando
        // solo el ESC, el `ESC >` con el que zsh restaura el teclado tras cada
        // orden contaba como un `>` detrás de cientos de espacios de la misma
        // línea, y salía una barra horizontal vacía.
        .replace(/\x1b[ -/]*[0-~]/gu, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '');
}

/** La línea lógica que un bloque de salida deja a medias para el siguiente. */
export interface OutputLineCarry {
    /** Columnas escritas, espacios incluidos. */
    columns: number;
    /** Hasta dónde llega el último carácter que no es un espacio. */
    ink: number;
}

export const EMPTY_OUTPUT_LINE: OutputLineCarry = { columns: 0, ink: 0 };

/**
 * La línea más ancha de un bloque de salida tal como llega de la PTY,
 * contando la que dejó a medias el bloque anterior. Los espacios finales no
 * ocupan: zsh (`PROMPT_SP`) rellena la fila entera antes de cada prompt, y si
 * ConPTY partía esos espacios en dos bloques, el segundo los contaba y salía
 * una barra horizontal vacía. Los movimientos del cursor sí cuentan:
 * zsh-syntax-highlighting repinta lo tecleado volviendo atrás (`CSI n D`) y
 * saltando al final (`CSI n C`), y si se quitaban sin mover la columna, cada
 * repintado sumaba la línea otra vez y también salía la barra.
 */
export function measureOutputChunk(
    data: string,
    carry: OutputLineCarry,
    limit: number,
): { longest: number; carry: OutputLineCarry } {
    let { columns, ink } = carry;
    let longest = ink;
    // OSC y las cadenas DCS, SOS, PM y APC no se ven ni mueven el cursor.
    const text = data.replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)/gu, '');
    const tokens = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b[ -/]*[0-~]|([\r\n])|(\x08)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|([^\x00-\x08\x0a-\x1f\x7f\x1b]+)/gu;
    for (const [, params, final, newline, backspace, printable] of text.matchAll(tokens)) {
        if (printable !== undefined) {
            const printed = Array.from(printable.trimEnd()).length;
            if (printed > 0) ink = Math.max(ink, columns + printed);
            columns += Array.from(printable).length;
        } else if (newline !== undefined) {
            columns = 0;
            ink = 0;
        } else if (backspace !== undefined) {
            columns = Math.max(0, columns - 1);
        } else if (final !== undefined) {
            const [first, second] = (params ?? '').split(';').map((value) => Number.parseInt(value, 10));
            const count = Number.isFinite(first) && first > 0 ? first : 1;
            if (final === 'D') columns = Math.max(0, columns - count);
            else if (final === 'C') columns += count;
            else if (final === 'G' || final === '`') columns = count - 1;
            else if (final === 'H' || final === 'f') {
                // Otra fila: lo que ya tenga se midió cuando se escribió.
                columns = (Number.isFinite(second) && second > 0 ? second : 1) - 1;
                ink = 0;
            } else if (final === 'A' || final === 'B' || final === 'd') ink = 0;
            else if (final === 'E' || final === 'F') {
                columns = 0;
                ink = 0;
            }
        }
        longest = Math.max(longest, ink);
        if (longest >= limit) return { longest: limit, carry: EMPTY_OUTPUT_LINE };
    }
    return { longest: Math.min(limit, longest), carry: { columns, ink } };
}

/**
 * Mide el ancho lógico máximo que realmente se ve en la ventana de xterm.
 * Las filas blandamente envueltas se reconstruyen como una sola línea, pero
 * el scrollback lejano no puede mantener la PTY artificialmente ancha.
 */
export function longestVisibleLogicalLineWidth(
    rowCount: number,
    firstVisibleRow: number,
    visibleRowCount: number,
    getRow: (index: number) => TerminalRowWidth | undefined,
    maxColumns = 2048,
): number {
    const integer = (value: number, fallback: number) => Number.isFinite(value) ? Math.floor(value) : fallback;
    const safeRowCount = Math.max(0, integer(rowCount, 0));
    const safeMaxColumns = Math.max(1, integer(maxColumns, 2048));
    const start = Math.max(0, Math.min(safeRowCount, integer(firstVisibleRow, 0)));
    const end = Math.max(start, Math.min(safeRowCount, start + Math.max(0, integer(visibleRowCount, 0))));
    const measuredStarts = new Set<number>();
    let longest = 0;

    for (let visible = start; visible < end; visible += 1) {
        let lineStart = visible;
        while (lineStart > 0 && getRow(lineStart)?.isWrapped) lineStart -= 1;
        if (measuredStarts.has(lineStart)) continue;
        measuredStarts.add(lineStart);

        let width = 0;
        let row = lineStart;
        while (row < safeRowCount) {
            const current = getRow(row);
            width = Math.min(safeMaxColumns, width + Math.max(0, integer(current?.columns ?? 0, 0)));
            const next = getRow(row + 1);
            if (!next?.isWrapped || width >= safeMaxColumns) break;
            row += 1;
        }
        longest = Math.max(longest, width);
        if (longest >= safeMaxColumns) return safeMaxColumns;
    }
    return longest;
}
