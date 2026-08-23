<script lang="ts">
    // Armazón común de los paneles de la barra: la caja flotante, su cabecera,
    // el cierre al pulsar fuera o con Escape, y el redimensionado. El contenido
    // lo pone cada panel.
    //
    // La caja se posiciona respecto a la VENTANA, no respecto al botón que la
    // abre: así nunca se sale por el lado derecho ni queda más ancha que la
    // ventana, que es lo que obligaba a maximizar para ver sus botones.
    //
    // El redimensionado va por asas propias y no por `resize: both` de CSS: esa
    // pone su asa en la esquina INFERIOR DERECHA, y el panel está anclado por la
    // derecha, así que ensanchar lo sacaría de la pantalla. Las asas están en el
    // borde izquierdo y el inferior, que son los que crecen hacia dentro.

    import type { Snippet } from 'svelte';

    import { app } from '../lib/appState.svelte';
    import { panels, type PanelId } from '../lib/panels.svelte';
    import * as perf from '../lib/performance';

    interface Props {
        id: PanelId;
        title: string;
        /** Segunda línea de la cabecera: qué se está mirando, o el error. */
        subtitle?: string;
        error?: boolean;
        /** Contador de la derecha de la cabecera (cuántas entradas hay). */
        count?: number;
        /** Explicación accesible del contador; evita que un número sin contexto
         *  se confunda con acciones, componentes o elementos instalados. */
        countLabel?: string;
        width?: number;
        height?: number;
        children: Snippet;
        /** Fila propia bajo la cabecera (filtros, pestañas de modo). */
        header?: Snippet;
    }

    let {
        id,
        title,
        subtitle = '',
        error = false,
        count,
        countLabel,
        width = 410,
        height,
        children,
        header
    }: Props = $props();

    /** Mínimos por debajo de los cuales el contenido deja de ser legible: los
     *  botones se parten y las etiquetas quedan a una palabra por línea. */
    const MIN_WIDTH = 280;
    const MIN_HEIGHT = 160;

    let box = $state<HTMLDivElement | null>(null);
    let closeButton = $state<HTMLButtonElement | null>(null);
    let viewport = $state({ width: window.innerWidth, height: window.innerHeight });
    /** El control que abrió el panel. Se restaura al cerrarlo para que el
     *  teclado no se pierda en el documento después de Escape o del botón. */
    let previousFocus: HTMLElement | null = null;

    /** El tamaño que el usuario haya elegido para ESTE panel. Se guarda por
     *  panel: Ajustes necesita más ancho que Dependencias, y una talla única
     *  obligaría a redimensionar cada vez que se cambia de uno a otro.
     *
     *  Vive en `localStorage` y no en `settings.json` porque es estado de vista,
     *  como la posición del scroll: no describe cómo quiere el usuario que
     *  funcione la app, solo cómo tiene colocada la ventana ahora mismo. */
    const storageKey = $derived(`panel-size:${id}`);

    function loadSize(key: string): { width: number; height: number | null } | null {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const saved = JSON.parse(raw) as { width?: unknown; height?: unknown };
            if (typeof saved.width !== 'number') return null;
            return {
                width: saved.width,
                height: typeof saved.height === 'number' ? saved.height : null
            };
        } catch {
            // Un valor corrupto no puede impedir abrir el panel: se ignora y se
            // vuelve al tamaño de fábrica.
            return null;
        }
    }

    /** Sube al escribir o borrar el tamaño guardado. `localStorage` no avisa de
     *  sus propios cambios, así que sin esto lo leído se quedaría congelado y
     *  "restablecer" no tendría efecto hasta reabrir el panel. */
    let storedVersion = $state(0);
    const stored = $derived.by(() => {
        storedVersion;
        return loadSize(storageKey);
    });

    /** Lo que el usuario ha arrastrado en ESTA sesión. `null` = todavía nada,
     *  y entonces manda lo guardado, y si no lo hay, el tamaño de fábrica. */
    let draggedWidth = $state<number | null>(null);
    let draggedHeight = $state<number | null>(null);

    const boxWidth = $derived(draggedWidth ?? stored?.width ?? width);
    const boxHeight = $derived(draggedHeight ?? stored?.height ?? height ?? null);

    /** Lo que de verdad cabe en la ventana AHORA. Un tamaño guardado con la
     *  ventana maximizada no puede dejar el panel fuera de una ventana pequeña,
     *  así que se recorta en cada repintado y no solo al guardarlo. */
    const clampedWidth = $derived(
        Math.max(MIN_WIDTH, Math.min(boxWidth, Math.max(MIN_WIDTH, viewport.width - 16)))
    );
    const clampedHeight = $derived(
        boxHeight === null
            ? null
            : Math.max(MIN_HEIGHT, Math.min(boxHeight, Math.max(MIN_HEIGHT, viewport.height - 60)))
    );

    /** Arrastre en curso: qué borde y desde dónde empezó. */
    let drag = $state<{
        edge: 'left' | 'bottom' | 'corner';
        x: number;
        y: number;
        w: number;
        h: number;
    } | null>(null);

    function startResize(edge: 'left' | 'bottom' | 'corner', event: PointerEvent): void {
        if (!box) return;
        event.preventDefault();
        const rect = box.getBoundingClientRect();
        drag = { edge, x: event.clientX, y: event.clientY, w: rect.width, h: rect.height };
        // Capturar el puntero: si el ratón se sale del asa mientras se arrastra
        // (que pasa siempre), los eventos siguen llegando aquí.
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }

    function onResize(event: PointerEvent): void {
        if (!drag) return;
        // El panel está anclado por la derecha: arrastrar el borde izquierdo
        // hacia la izquierda (delta negativo) lo ENSANCHA.
        if (drag.edge !== 'bottom') draggedWidth = drag.w - (event.clientX - drag.x);
        if (drag.edge !== 'left') draggedHeight = drag.h + (event.clientY - drag.y);
    }

    function endResize(event: PointerEvent): void {
        if (!drag) return;
        drag = null;
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
        try {
            localStorage.setItem(
                storageKey,
                JSON.stringify({ width: clampedWidth, height: clampedHeight })
            );
            storedVersion += 1;
        } catch {
            // Sin almacenamiento el panel sigue funcionando; solo no recuerda.
        }
    }

    /** Vuelve al tamaño de fábrica. Sin esto, un panel que se dejó en 280px se
     *  queda así para siempre y no hay forma evidente de deshacerlo. */
    function resetSize(): void {
        draggedWidth = null;
        draggedHeight = null;
        try {
            localStorage.removeItem(storageKey);
        } catch {
            // Da igual: el tamaño vuelve al de fábrica en pantalla igualmente.
        }
        storedVersion += 1;
    }

    /** El clic se atiende en fase de captura, igual que en la versión Electron:
     *  así el panel se cierra aunque quien reciba el clic detenga la
     *  propagación. El botón que abrió el panel no cuenta como "fuera": si
     *  contara, cerraría aquí y volvería a abrirse en su propio manejador. */
    function onPointerDown(event: MouseEvent): void {
        const target = event.target as Node | null;
        if (!box || !target) return;
        if (box.contains(target)) return;
        if (target instanceof Element && target.closest('[data-panel-toggle]')) return;
        panels.close();
    }

    function onKeyDown(event: KeyboardEvent): void {
        if (event.key === 'Escape') panels.close();
    }

    /** El panel es un diálogo real: Tab no puede escapar hacia la terminal que
     *  quedó detrás. Mantener este comportamiento aquí evita que cada panel
     *  tenga que reimplementar su propia lista de controles enfocables. */
    function trapFocus(event: KeyboardEvent): void {
        if (event.key !== 'Tab' || !box) return;
        const focusable = Array.from(
            box.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
        ).filter((element) => element.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function onWindowResize(): void {
        viewport = { width: window.innerWidth, height: window.innerHeight };
    }

    $effect(() => {
        const handleMouseDown = (e: MouseEvent) => onPointerDown(e);
        window.addEventListener('mousedown', handleMouseDown, { capture: true });
        return () => window.removeEventListener('mousedown', handleMouseDown, { capture: true });
    });

    $effect(() => {
        if (!panels.isOpen(id)) return;
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        queueMicrotask(() => closeButton?.focus());
        return () => {
            if (previousFocus?.isConnected) previousFocus.focus();
            previousFocus = null;
        };
    });

    // Medir después de un frame evita confundir el clic con el momento en que
    // el diálogo ya tiene geometría, contenido y foco utilizables.
    $effect(() => {
        if (!panels.isOpen(id)) return;
        const finish = perf.start('ui.panel.visible', { panel: id });
        const frame = requestAnimationFrame(() => {
            const rect = box?.getBoundingClientRect();
            finish('ok', {
                width: rect?.width ?? 0,
                height: rect?.height ?? 0,
                focused: document.activeElement === closeButton,
            });
        });
        return () => cancelAnimationFrame(frame);
    });
</script>

<svelte:window
    onkeydown={onKeyDown}
    onresize={onWindowResize}
/>

{#if panels.isOpen(id)}
    <div
        class="panel"
        class:resizing={drag !== null}
        style="width: {clampedWidth}px; {clampedHeight === null
            ? ''
            : `height: ${clampedHeight}px`}"
        bind:this={box}
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-label={title}
        onkeydown={trapFocus}
    >
        <!-- Asas de redimensionado. Solo ratón: el teclado no las necesita
             porque el panel ya se adapta al ancho disponible por su cuenta. -->
        <div
            class="grip grip-left"
            onpointerdown={(event) => startResize('left', event)}
            onpointermove={onResize}
            onpointerup={endResize}
            role="presentation"
        ></div>
        <div
            class="grip grip-bottom"
            onpointerdown={(event) => startResize('bottom', event)}
            onpointermove={onResize}
            onpointerup={endResize}
            role="presentation"
        ></div>
        <div
            class="grip grip-corner"
            onpointerdown={(event) => startResize('corner', event)}
            onpointermove={onResize}
            onpointerup={endResize}
            ondblclick={resetSize}
            role="presentation"
                    title={app.t('tabs.dragHint', 'Arrastra para reordenar; doble clic para restablecer.')}
        ></div>

        <!-- Solo este hijo se desplaza. Las asas son hermanas suyas y se
             quedan ancladas al marco exterior aunque la lista haga scroll. -->
        <div class="panel-scroll">
            <div class="panel-header">
                <div class="panel-heading">
                    <div class="panel-title">{title}</div>
                    {#if subtitle}
                        <div class="panel-subtitle" class:error>{subtitle}</div>
                    {/if}
                </div>
                {#if count !== undefined}
                    <span class="panel-count" title={countLabel} aria-label={countLabel}>{count}</span>
                {/if}
                <button
                    type="button"
                    class="panel-close"
                    bind:this={closeButton}
                    aria-label={app.t('common.close', 'Cerrar')}
                    title={app.t('common.close', 'Cerrar')}
                    onclick={() => panels.close()}
                >×</button>
            </div>

            {#if header}
                {@render header()}
            {/if}

            {@render children()}
        </div>
    </div>
{/if}

<style>
    .panel {
        position: fixed;
        top: 44px;
        right: 8px;
        z-index: 50;
        display: flex;
        flex-direction: column;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 60px);
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        font-size: 12px;
        /* Referencia para las consultas de contenedor de los paneles: lo que
           decide si algo cabe es el ancho del PANEL, no el de la ventana. */
        container-type: inline-size;
    }

    /* El scroll vive dentro del marco redimensionable. `min-height: 0` permite
       que este hijo flex se encoja cuando el panel alcanza su `max-height`, en
       vez de hacer crecer el marco y desplazar el asa inferior con la lista. */
    .panel-scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        /* Deja sitio al asa inferior para que la última acción siga siendo
           pulsable incluso con el scroll completamente abajo. */
        padding: 6px 6px 14px;
    }

    /* Mientras se arrastra no se selecciona texto ni se disparan estados de
       hover a su paso, que hacían parpadear media lista. */
    .panel.resizing {
        user-select: none;
    }

    .panel.resizing :global(*) {
        pointer-events: none;
    }

    .grip {
        position: absolute;
        z-index: 3;
    }

    .grip-left {
        top: 0;
        bottom: 0;
        left: 0;
        width: 6px;
        cursor: ew-resize;
    }

    .grip-bottom {
        right: 0;
        bottom: 0;
        left: 0;
        height: 6px;
        cursor: ns-resize;
    }

    /* La esquina manda sobre las otras dos: es la que redimensiona en los dos
       ejes a la vez, así que se pone encima en el mismo sitio. */
    .grip-corner {
        bottom: 0;
        left: 0;
        width: 14px;
        height: 14px;
        cursor: nesw-resize;
        z-index: 4;
    }

    .grip-corner::after {
        content: '';
        position: absolute;
        bottom: 3px;
        left: 3px;
        width: 6px;
        height: 6px;
        border-bottom: 2px solid var(--border);
        border-left: 2px solid var(--border);
    }

    .grip-corner:hover::after {
        border-color: var(--accent);
    }

    /* La cabecera se queda a la vista al desplazar: es donde aparecen los
       errores de una acción que se acaba de pulsar, y en una lista larga el
       aviso se perdía fuera de pantalla. El -6px compensa el padding del
       panel, para que no asome el contenido por encima. */
    .panel-header {
        position: sticky;
        top: -6px;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 9px 8px;
        background: var(--surface);
        border-bottom: 1px solid var(--border);
        color: var(--text);
    }

    /* `min-width: 0` es lo que permite que el texto se recorte en vez de
       empujar al contador fuera de la caja: un hijo de flex no baja de su
       contenido mínimo salvo que se le diga. */
    .panel-heading {
        flex: 1 1 auto;
        min-width: 0;
    }

    .panel-title {
        overflow: hidden;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .panel-subtitle {
        color: var(--muted);
        font-size: 10px;
    }

    .panel-subtitle.error {
        color: #e06c75;
    }

    .panel-count {
        flex: 0 0 auto;
        padding: 0 6px;
        border-radius: 8px;
        background: var(--surface-hover);
        color: var(--muted);
        font-size: 10px;
    }

    .panel-close {
        flex: 0 0 auto;
        display: grid;
        width: 24px;
        height: 24px;
        place-items: center;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
    }

    .panel-close:hover,
    .panel-close:focus-visible {
        border-color: var(--border);
        background: var(--surface-hover);
        color: var(--text);
        outline: none;
    }
</style>
