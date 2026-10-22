/**
 * Buscador de Ajustes.
 *
 * Con texto en el buscador, Ajustes enseña todas sus secciones a la vez y solo
 * los bloques que lo contienen. El formulario se recorre como una lista de
 * bloques (títulos de sección, encabezados, filas de ajuste y notas bajo un
 * campo) y aquí se decide cuáles se ven: así la lógica se prueba sin DOM y la
 * vista solo tiene que esconder lo que esta función diga.
 */

export type SettingsBlockKind = 'section' | 'heading' | 'row' | 'hint';

export interface SettingsBlock {
    kind: SettingsBlockKind;
    text: string;
}

/** Minúsculas y sin tildes, para que «maximizada» encuentre «Maximizada» y
 *  «menu» encuentre «Menú». */
export function foldSearchText(text: string): string {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/**
 * Qué bloques se ven para una búsqueda.
 *
 * - Sin búsqueda se ve todo.
 * - Una fila se ve si contiene el texto o si lo contiene su encabezado (todo
 *   el grupo responde a la búsqueda de su título).
 * - Un encabezado se ve si coincide o si se ve alguna de sus filas.
 * - Una nota va con la fila de encima: se ve con ella y, si es la nota la que
 *   coincide, la fila también.
 * - El título de una sección se ve si se ve algo de la sección.
 */
export function settingsSearchVisibility(blocks: readonly SettingsBlock[], query: string): boolean[] {
    const needle = foldSearchText(query.trim());
    if (!needle) return blocks.map(() => true);
    const matches = blocks.map((block) => foldSearchText(block.text).includes(needle));
    const visible = blocks.map(() => false);
    let section = -1;
    let heading = -1;
    let previousRow = -1;
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (block.kind === 'section') {
            section = index;
            heading = -1;
            previousRow = -1;
            continue;
        }
        if (block.kind === 'heading') {
            heading = index;
            previousRow = -1;
            visible[index] = matches[index];
        } else if (block.kind === 'row') {
            previousRow = index;
            visible[index] = matches[index] || (heading >= 0 && matches[heading]);
            if (visible[index] && heading >= 0) visible[heading] = true;
        } else {
            const rowVisible = previousRow >= 0 && visible[previousRow];
            visible[index] = rowVisible || matches[index];
            if (matches[index] && previousRow >= 0) {
                visible[previousRow] = true;
                if (heading >= 0) visible[heading] = true;
            }
        }
        if (visible[index] && section >= 0) visible[section] = true;
    }
    return visible;
}

/** Cuántas filas de ajuste se ven: lo que cuenta el buscador. */
export function visibleSettingsRows(blocks: readonly SettingsBlock[], visible: readonly boolean[]): number {
    return blocks.filter((block, index) => block.kind === 'row' && visible[index]).length;
}

/** Apartados a partir de los que una pestaña lleva índice. Solo compensa en
 *  las largas (hoy, Comportamiento): Información, con 4 apartados cortos,
 *  enseñaba un índice y Apariencia y Terminal no, sin un criterio claro. */
export const SETTINGS_INDEX_MIN_HEADINGS = 6;

/** Si la pestaña enseña el índice de sus apartados (nunca mientras se busca). */
export function showSettingsIndex(headings: number, searching: boolean): boolean {
    return !searching && headings >= SETTINGS_INDEX_MIN_HEADINGS;
}
