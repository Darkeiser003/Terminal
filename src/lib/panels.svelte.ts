// Qué panel lateral está abierto.
//
// En la versión Electron cada panel era un `<div class="hidden">` y quien lo
// abría iba escondiendo los otros cuatro a mano, uno por uno, en cada sitio
// desde el que se pudiera abrir alguno. Aquí solo hay un valor: abrir uno
// cierra el anterior sin que nadie tenga que acordarse de los demás.

import * as perf from './performance';

export type PanelId = 'deps' | 'projects' | 'scripts' | 'explorer' | 'settings';

class PanelStore {
    open = $state<PanelId | null>(null);

    isOpen(id: PanelId): boolean {
        return this.open === id;
    }

    /** Devuelve si el panel queda abierto, que es lo que decide si hay que
     *  recargar su contenido. */
    toggle(id: PanelId): boolean {
        const opening = this.open !== id;
        const previous = this.open;
        this.open = opening ? id : null;
        perf.mark('ui.panel.toggle', { panel: id, opened: opening, previous });
        return this.open === id;
    }

    show(id: PanelId): void {
        this.open = id;
        perf.mark('ui.panel.show', { panel: id });
    }

    close(): void {
        if (this.open) perf.mark('ui.panel.close', { panel: this.open });
        this.open = null;
    }
}

export const panels = new PanelStore();
