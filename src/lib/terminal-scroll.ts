/** Convierte las unidades DOM de rueda a píxeles CSS para el scroll horizontal. */
export function normalizeWheelDelta(
    delta: number,
    deltaMode: number,
    lineHeight: number,
    pageWidth: number,
): number {
    if (!Number.isFinite(delta) || delta === 0) return 0;

    if (deltaMode === 1) {
        const safeLineHeight = Number.isFinite(lineHeight) ? Math.max(1, lineHeight) : 16;
        return delta * safeLineHeight;
    }
    if (deltaMode === 2) {
        const safePageWidth = Number.isFinite(pageWidth) ? Math.max(1, pageWidth) : 1;
        return delta * safePageWidth;
    }
    // DOM_DELTA_PIXEL and unknown values are already pixel-like units.
    return delta;
}
