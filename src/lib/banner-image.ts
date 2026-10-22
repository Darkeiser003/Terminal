/**
 * Imagen a la izquierda del banner del sistema.
 *
 * El backend compone el banner en lo que queda tras un margen de
 * `columnas + BANNER_IMAGE_GAP` espacios (`system_info::banner_image_padding`),
 * y esos espacios llegan igual a ConPTY y a xterm. La imagen no pasa nunca por
 * ConPTY, así que su cursor sigue donde xterm lo espera: es una decoración de
 * xterm anclada a la línea del título, encima de ese margen y con el mismo
 * hueco contra el borde que contra el texto (`bannerImageBox`). El banner se
 * reconoce por su título precedido de un margen de entre 10 y 42 espacios (8 a
 * 40 columnas más la separación), lo que cubre por igual el banner inicial,
 * `:banner`, `clear`, `sysinfo` y los repintados de ConPTY; cada banner recibe
 * una imagen del ancho de su propio margen, así que uno impreso antes de
 * cambiar el ancho en Ajustes sigue bien cubierto. La decoración se desplaza
 * con el texto y desaparece con él (al limpiar, al salir del historial o si
 * otra salida lo sobrescribe).
 */

import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';

/** Columnas entre la imagen y el texto; igual que `BANNER_IMAGE_GAP` en Rust. */
export const BANNER_IMAGE_GAP = 2;
/** Columnas posibles de la imagen (`bannerImageColumns`, 8–40). */
export const BANNER_IMAGE_MIN_COLUMNS = 8;
export const BANNER_IMAGE_MAX_COLUMNS = 40;

export interface BannerImageConfig {
    enabled: boolean;
    /** `${nombre} ${versión}`: la primera línea del banner. */
    title: string;
    /** El logo de la app o la imagen propia como `data:`. */
    url: string;
}

export interface BannerBlock {
    /** Índice de la línea del título dentro de las líneas recibidas. */
    index: number;
    /** Líneas del banner desde el título, todas con el margen. */
    rows: number;
    /** Espacios del margen: columnas de la imagen + `BANNER_IMAGE_GAP`. */
    padding: number;
}

/** Margen que deja el backend: las columnas de la imagen más la separación. */
export function bannerImagePadding(columns: number): number {
    return Math.max(0, Math.floor(columns)) + BANNER_IMAGE_GAP;
}

/**
 * Celdas del margen que ocupa la imagen: el mismo hueco (`BANNER_IMAGE_GAP`)
 * contra el borde de la ventana que contra el texto. Ocupar todo el margen la
 * centraba solo cuando la limitaba el alto (banner compacto); en el grande, más
 * alto que ancho, la limita el ancho y quedaba pegada al borde izquierdo.
 */
export function bannerImageBox(padding: number): { x: number; width: number } {
    const width = Math.max(1, Math.floor(padding) - 2 * BANNER_IMAGE_GAP);
    return { x: Math.max(0, Math.floor((Math.floor(padding) - width) / 2)), width };
}

function isBannerLine(line: string, margin: string): boolean {
    return line.length > margin.length && line.startsWith(margin) && line[margin.length] !== ' ';
}

/**
 * Bloques de banner en unas líneas de texto (sin espacios al final). Un bloque
 * empieza en una línea que es un margen de entre 10 y 42 espacios seguido
 * exactamente del título, y sigue mientras las líneas tengan ese mismo margen
 * y texto justo después. Un título suelto, sin al menos una línea de datos, no
 * cuenta: sería otra salida que lo menciona.
 */
export function findBannerBlocks(lines: readonly string[], title: string): BannerBlock[] {
    if (!title.trim()) return [];
    const minimum = bannerImagePadding(BANNER_IMAGE_MIN_COLUMNS);
    const maximum = bannerImagePadding(BANNER_IMAGE_MAX_COLUMNS);
    const blocks: BannerBlock[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.endsWith(title)) continue;
        const padding = line.length - title.length;
        if (padding < minimum || padding > maximum || line.slice(0, padding).trim()) continue;
        const margin = ' '.repeat(padding);
        let rows = 1;
        while (index + rows < lines.length && isBannerLine(lines[index + rows], margin)) rows += 1;
        if (rows < 2) continue;
        blocks.push({ index, rows, padding });
        index += rows - 1;
    }
    return blocks;
}

export interface BannerImageController {
    /** Vuelve a buscar banners (tras cambiar la configuración o la imagen). */
    refresh(): void;
    dispose(): void;
}

interface PlacedImage {
    marker: IMarker;
    decoration: IDecoration;
    rows: number;
    padding: number;
    url: string;
}

function renderImage(element: HTMLElement, url: string): void {
    element.classList.add('banner-image-decoration');
    let image = element.querySelector('img');
    if (!image) {
        image = document.createElement('img');
        image.alt = '';
        image.draggable = false;
        image.dataset.bannerImage = '';
        element.appendChild(image);
    }
    if (image.getAttribute('src') !== url) image.src = url;
}

/**
 * Coloca y retira las imágenes de los banners visibles. Se revisa la vista
 * tras cada escritura (como mucho una vez por fotograma), al redimensionar y
 * al desplazarse; los banners que salen de la vista conservan su imagen.
 */
export function attachBannerImages(
    terminal: Terminal,
    config: () => BannerImageConfig | null,
): BannerImageController {
    const placed: PlacedImage[] = [];
    let frame: number | undefined;
    let disposed = false;

    const remove = (entry: PlacedImage): void => {
        const index = placed.indexOf(entry);
        if (index >= 0) placed.splice(index, 1);
        entry.decoration.dispose();
        entry.marker.dispose();
    };

    const scan = (): void => {
        frame = undefined;
        if (disposed) return;
        const current = config();
        if (!current?.enabled || !current.url || !current.title) {
            for (const entry of [...placed]) remove(entry);
            return;
        }
        const buffer = terminal.buffer.active;
        // Con un programa a pantalla completa (vim, less) xterm oculta las
        // decoraciones del búfer normal; no hay nada que buscar.
        if (buffer.type !== 'normal') return;
        for (const entry of [...placed]) {
            if (entry.url !== current.url || entry.marker.isDisposed) remove(entry);
        }
        const top = buffer.viewportY;
        const lines: string[] = [];
        for (let row = 0; row < terminal.rows; row += 1) {
            lines.push(buffer.getLine(top + row)?.translateToString(true) ?? '');
        }
        const blocks = findBannerBlocks(lines, current.title);
        // Lo que estaba en la vista y ya no es un banner (sobrescrito o con
        // otro alto) pierde su imagen.
        for (const entry of [...placed]) {
            const line = entry.marker.line;
            if (line < top || line >= top + terminal.rows) continue;
            const block = blocks.find((candidate) => top + candidate.index === line);
            if (!block || block.rows !== entry.rows || block.padding !== entry.padding) remove(entry);
        }
        const cursorLine = buffer.baseY + buffer.cursorY;
        for (const block of blocks) {
            const line = top + block.index;
            if (placed.some((entry) => entry.marker.line === line)) continue;
            const marker = terminal.registerMarker(line - cursorLine);
            if (!marker) continue;
            // El margen menos el mismo hueco a cada lado: la imagen queda
            // centrada entre el borde de la ventana y el texto, la limite el
            // alto (banner compacto) o el ancho (banner grande).
            const box = bannerImageBox(block.padding);
            const decoration = terminal.registerDecoration({
                marker,
                x: box.x,
                width: box.width,
                height: block.rows,
                layer: 'top',
            });
            if (!decoration) {
                marker.dispose();
                continue;
            }
            const entry: PlacedImage = { marker, decoration, rows: block.rows, padding: block.padding, url: current.url };
            const url = current.url;
            decoration.onRender((element) => renderImage(element, url));
            marker.onDispose(() => {
                const index = placed.indexOf(entry);
                if (index >= 0) {
                    placed.splice(index, 1);
                    decoration.dispose();
                }
            });
            placed.push(entry);
        }
    };

    const schedule = (): void => {
        if (disposed || frame !== undefined) return;
        frame = window.requestAnimationFrame(scan);
    };
    const subscriptions: IDisposable[] = [
        terminal.onWriteParsed(schedule),
        terminal.onResize(schedule),
        terminal.onScroll(schedule),
    ];
    schedule();

    return {
        refresh: schedule,
        dispose() {
            disposed = true;
            if (frame !== undefined) window.cancelAnimationFrame(frame);
            for (const subscription of subscriptions) subscription.dispose();
            for (const entry of [...placed]) remove(entry);
        },
    };
}
