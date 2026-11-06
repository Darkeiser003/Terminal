// Las órdenes escritas en las pestañas, para buscarlas y volver a escribirlas.
//
// Solo entra lo tecleado sobre un prompt que la shell marcó con OSC 133: lo
// que se escribe mientras corre una orden (la contraseña de `sudo`, un
// `read -s`, un `Read-Host`) llega sin prompt y nunca se guarda. Vive en
// memoria y se pierde al cerrar la aplicación: cada shell ya guarda el suyo
// en disco. El módulo es puro para probarlo en Node con
// `scripts/test-frontend-logic.mjs`.

/** Suficiente para buscar en un día de trabajo sin crecer sin fin. */
export const MAX_HISTORY = 1000;

/** Más larga que esto es un pegado, no una orden que se quiera repetir. */
const MAX_COMMAND_LENGTH = 4096;

/** Añade al final; una orden repetida sube al final en vez de duplicarse. */
export function rememberCommand(history: readonly string[], command: string, max = MAX_HISTORY): string[] {
    const clean = command.trim();
    if (!clean || clean.length > MAX_COMMAND_LENGTH || clean.includes('\n')) return [...history];
    const next = history.filter((item) => item !== clean);
    next.push(clean);
    return next.length > max ? next.slice(next.length - max) : next;
}

/** La más reciente primero. Cada palabra buscada tiene que aparecer, en
 *  cualquier orden y sin distinguir mayúsculas. */
export function searchCommands(history: readonly string[], query: string, limit = 50): string[] {
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    const found: string[] = [];
    for (let index = history.length - 1; index >= 0 && found.length < limit; index -= 1) {
        const lower = history[index].toLowerCase();
        if (words.every((word) => lower.includes(word))) found.push(history[index]);
    }
    return found;
}
