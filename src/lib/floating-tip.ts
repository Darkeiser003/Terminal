/** Rectángulo en coordenadas de la ventana, como `getBoundingClientRect`. */
export interface ViewportRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Posición de una tarjeta flotante con `position: fixed`. */
export interface FloatingTipPlacement {
    left: number;
    top: number;
    width: number;
    /** Se abre encima de la fila: el CSS la sube su propia altura. */
    above: boolean;
}

export interface FloatingTipOptions {
    /** Distancia mínima a los bordes del contenedor. */
    margin?: number;
    /** Separación entre la fila y la tarjeta. */
    gap?: number;
    minWidth?: number;
    maxWidth?: number;
    /** Altura que se supone antes de medir la tarjeta real. */
    expectedHeight?: number;
}

/**
 * Coloca la tarjeta junto a la fila `anchor`, dentro de `bounds` (el panel),
 * en coordenadas de la ventana. Un elemento `position: fixed` se resuelve
 * respecto a la ventana: `container-type` no crea bloque contenedor para él
 * (solo `transform`, `filter` o `contain: layout` lo harían), así que unas
 * coordenadas relativas al panel la dibujaban desplazada fuera de él.
 * Debajo de la fila si caben unos `expectedHeight` píxeles; si no, encima.
 */
export function placeFloatingTip(anchor: ViewportRect, bounds: ViewportRect, options: FloatingTipOptions = {}): FloatingTipPlacement {
    const { margin = 8, gap = 4, minWidth = 200, maxWidth = 360, expectedHeight = 170 } = options;
    const width = Math.max(minWidth, Math.min(maxWidth, bounds.right - bounds.left - 2 * margin));
    const left = Math.min(Math.max(bounds.left + margin, anchor.left), bounds.right - width - margin);
    const below = anchor.bottom + gap;
    const above = below + expectedHeight > bounds.bottom;
    return { left, top: above ? anchor.top - gap : below, width, above };
}

/**
 * Desplazamiento que mete la tarjeta ya pintada (`tip`, medida en la
 * ventana) dentro de `bounds`. Al medir el resultado real también corrige
 * un bloque contenedor inesperado o una altura distinta de la supuesta. Si
 * la tarjeta es más grande que el contenedor, manda el borde superior o
 * izquierdo, de modo que la vuelta siguiente ya no la mueve.
 */
export function fitFloatingTip(tip: ViewportRect, bounds: ViewportRect, margin = 8): { dx: number; dy: number } {
    const axis = (start: number, end: number, min: number, max: number): number => {
        const overflowStart = min - start;
        if (overflowStart > 0) return overflowStart;
        const overflowEnd = end - max;
        return overflowEnd > 0 ? -Math.min(overflowEnd, -overflowStart) : 0;
    };
    return {
        dx: axis(tip.left, tip.right, bounds.left + margin, bounds.right - margin),
        dy: axis(tip.top, tip.bottom, bounds.top + margin, bounds.bottom - margin),
    };
}
