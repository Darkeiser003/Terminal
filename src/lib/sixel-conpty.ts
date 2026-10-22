/**
 * Imágenes Sixel alineadas con ConPTY.
 *
 * ConPTY deja pasar el Sixel hasta xterm, pero también lo interpreta para
 * mover su propio cursor, y lo hace como un VT340: cada celda mide 10×20
 * píxeles virtuales y cada píxel Sixel ocupa `aspecto` píxeles de alto (2:1
 * si la imagen no dice otra cosa). Tras una imagen de 60 píxeles, ConPTY ha
 * bajado seis filas. El complemento de imágenes de xterm usa la celda real
 * (unos 8×21 px) y habría bajado dos: a partir de ahí cada uno está en una
 * fila distinta y el eco de la orden siguiente sale despegado del prompt.
 *
 * Windows Terminal lo resuelve escalando la imagen a esa celda virtual. Aquí
 * se hace lo mismo justo antes de que el complemento la coloque: la imagen
 * ocupa la caja de celdas que ha contado ConPTY, se dibuja sin deformarse
 * dentro de ella y el cursor de xterm acaba en la misma fila que el de ConPTY.
 */

import type { Terminal } from '@xterm/xterm';

/** Celda virtual del VT340 que usa ConPTY para medir imágenes Sixel. */
export const VT340_CELL = { width: 10, height: 20 } as const;

export interface CellSize {
    width: number;
    height: number;
}

export interface SixelBox {
    /** Columnas y filas que reserva ConPTY. */
    cols: number;
    rows: number;
    /** Lienzo que se entrega al complemento: ocupa exactamente esas celdas. */
    boxWidth: number;
    boxHeight: number;
    /** Tamaño al que se dibuja la imagen dentro de la caja, sin deformarla. */
    drawWidth: number;
    drawHeight: number;
}

/**
 * Alto de cada píxel Sixel respecto a su ancho. Los atributos de trama
 * (`"Pan;Pad;Ph;Pv`) mandan; si no están, lo decide el primer parámetro del
 * DCS según la tabla de DEC.
 */
export function sixelPixelAspect(p1: number | undefined, data: string): number {
    const raster = /^"(\d+);(\d+)/u.exec(data);
    if (raster) {
        const numerator = Number(raster[1]);
        const denominator = Number(raster[2]);
        if (numerator > 0 && denominator > 0) return numerator / denominator;
    }
    switch (p1 ?? 0) {
        case 2:
            return 5;
        case 3:
        case 4:
            return 3;
        case 7:
        case 8:
        case 9:
            return 1;
        default:
            return 2;
    }
}

/**
 * Caja de celdas que reserva ConPTY para una imagen de `width`×`height`
 * píxeles Sixel. ConPTY deja el cursor en la fila donde empezaría la banda
 * siguiente (`floor(v)` filas más abajo); el complemento de xterm lo deja en
 * la última fila de la imagen (`filas - 1`). Por eso la caja mide
 * `floor(v) + 1` filas: así ambos acaban en la misma.
 */
export function conptySixelBox(width: number, height: number, aspect: number, cell: CellSize): SixelBox {
    const virtualRows = (height * aspect) / VT340_CELL.height;
    const rows = Math.floor(virtualRows) + 1;
    const cols = Math.max(1, Math.ceil(width / VT340_CELL.width));
    // `floor` mantiene `ceil(caja / celda)` en el número exacto de celdas aunque
    // la celda mida una fracción de píxel.
    const boxWidth = Math.max(1, Math.floor(cols * cell.width));
    const boxHeight = Math.max(1, Math.floor(rows * cell.height));
    // El píxel de dispositivo del VT340 es cuadrado: una sola escala que cabe
    // en la caja conserva las proporciones de la imagen.
    const devicePixel = Math.min(cell.width / VT340_CELL.width, cell.height / VT340_CELL.height);
    return {
        cols,
        rows,
        boxWidth,
        boxHeight,
        drawWidth: Math.max(1, Math.min(boxWidth, width * devicePixel)),
        drawHeight: Math.max(1, Math.min(boxHeight, height * aspect * devicePixel)),
    };
}

interface ImageAddonInternals {
    _storage?: { addImage(image: HTMLCanvasElement | ImageBitmap): void };
    _renderer?: { cellSize: CellSize };
}

/**
 * Engancha el complemento de imágenes para que cada Sixel ocupe las celdas que
 * cuenta ConPTY. Devuelve la función que deshace el enganche. Si la versión del
 * complemento no expone lo necesario no hace nada: la imagen se verá igual,
 * pero sin esta corrección.
 */
export function alignSixelWithConpty(term: Terminal, imageAddon: object): () => void {
    const internals = imageAddon as ImageAddonInternals;
    const storage = internals._storage;
    if (!storage || typeof storage.addImage !== 'function') return () => {};
    let pendingAspect: number | null = null;
    // Se registra después del complemento, así que se ejecuta antes que él y
    // devuelve `false` para no consumir la secuencia.
    const observer = term.parser.registerDcsHandler({ final: 'q' }, (data, params) => {
        const first = params[0];
        pendingAspect = sixelPixelAspect(typeof first === 'number' ? first : undefined, data);
        return false;
    });
    const original = storage.addImage.bind(storage);
    storage.addImage = (image) => {
        const aspect = pendingAspect ?? 2;
        pendingAspect = null;
        const cell = internals._renderer?.cellSize;
        if (!cell || cell.width <= 0 || cell.height <= 0 || typeof document === 'undefined') {
            original(image);
            return;
        }
        const box = conptySixelBox(image.width, image.height, aspect, cell);
        const canvas = document.createElement('canvas');
        canvas.width = box.boxWidth;
        canvas.height = box.boxHeight;
        const context = canvas.getContext('2d');
        if (!context) {
            original(image);
            return;
        }
        // Suavizar solo al reducir: ampliar arte de píxeles sin suavizado lo
        // deja nítido.
        context.imageSmoothingEnabled = box.drawWidth < image.width;
        context.drawImage(image, 0, 0, box.drawWidth, box.drawHeight);
        original(canvas);
    };
    return () => {
        observer.dispose();
        storage.addImage = original;
    };
}
