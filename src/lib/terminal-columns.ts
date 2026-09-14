export interface TerminalRowWidth {
    columns: number;
    isWrapped: boolean;
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
