/**
 * Caché de enlaces de xterm bajo el ratón.
 *
 * xterm (6.0) pregunta a sus proveedores de enlaces (URL detectadas e
 * hipervínculos OSC 8) por la fila que hay bajo el ratón y guarda la
 * respuesta mientras el ratón siga en esa fila; solo la vuelve a pedir al
 * cambiar de fila o al redimensionar. Si la salida de un programa escribe un
 * enlace en la fila donde ya estaba el ratón, xterm sigue usando la respuesta
 * de cuando estaba vacía: el enlace se pinta, pero ni se detecta ni abre con
 * Ctrl+clic hasta salir de la fila y volver (lo encontró el E2E de enlaces con
 * el hipervínculo OSC 8).
 *
 * No hay API pública para invalidarla, así que se tocan los dos campos
 * internos del `Linkifier`. `scripts/test-frontend-logic.mjs` comprueba que la
 * versión instalada de xterm los sigue teniendo.
 */

import type { Terminal } from '@xterm/xterm';

interface LinkifierInternals {
    _activeLine?: number;
    _lastBufferCell?: unknown;
}

/** Olvida la fila de enlaces guardada: el siguiente movimiento del ratón
 *  vuelve a preguntar. Devuelve si encontró la caché. */
export function invalidateLinkCache(term: Terminal): boolean {
    const linkifier = (term as unknown as { _core?: { linkifier?: LinkifierInternals } })._core?.linkifier;
    if (!linkifier || typeof linkifier._activeLine !== 'number') return false;
    linkifier._activeLine = -1;
    linkifier._lastBufferCell = undefined;
    return true;
}
