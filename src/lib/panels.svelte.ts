// Qué panel lateral está abierto.
//
// En la versión Electron cada panel era un `<div class="hidden">` y quien lo
// abría iba escondiendo los otros cuatro a mano, uno por uno, en cada sitio
// desde el que se pudiera abrir alguno. Aquí solo hay un valor: abrir uno
// cierra el anterior sin que nadie tenga que acordarse de los demás.

export type PanelId = 'deps' | 'projects' | 'scripts' | 'explorer' | 'settings';

class PanelStore {
    open = $state<PanelId | null>(null);

    isOpen(id: PanelId): boolean {
        return this.open === id;
    }

    /** Devuelve si el panel queda abierto, que es lo que decide si hay que
     *  recargar su contenido. */
    toggle(id: PanelId): boolean {
        this.open = this.open === id ? null : id;
        return this.open === id;
    }

    show(id: PanelId): void {
        this.open = id;
    }

    close(): void {
        this.open = null;
    }
}

export const panels = new PanelStore();
