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
