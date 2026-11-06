<script lang="ts">
    // La tira de pestañas y el botón de abrir una nueva.
    // Port de `renderTabStrip` en renderer.js.

    import { app, MAX_PANES, MAX_TAB_NAME, TAB_COLORS, type TabColor } from '../lib/appState.svelte';
    import { getTerminal } from '../lib/terminalRegistry';
    import type { TabSummary } from '../lib/types';

    let draggedTabId = $state<string | null>(null);
    let dropTargetId = $state<string | null>(null);
    let dropAfter = $state(false);
    let renameDraft = $state('');
    /** El menú de una pestaña (clic derecho, tecla de menú o Mayús+F10). */
    let menu = $state<{ tabId: string; x: number; y: number } | null>(null);
    const menuTab = $derived(menu ? app.tabs.find((tab) => tab.id === menu?.tabId) ?? null : null);

    const COLOR_IDS = Object.keys(TAB_COLORS) as TabColor[];
    const colorName = (color: TabColor): string => ({
        red: app.t('tabs.colorRed', 'Rojo'),
        orange: app.t('tabs.colorOrange', 'Naranja'),
        yellow: app.t('tabs.colorYellow', 'Amarillo'),
        green: app.t('tabs.colorGreen', 'Verde'),
        cyan: app.t('tabs.colorCyan', 'Turquesa'),
        blue: app.t('tabs.colorBlue', 'Azul'),
        purple: app.t('tabs.colorPurple', 'Morado'),
        pink: app.t('tabs.colorPink', 'Rosa'),
    })[color];

    function openMenu(event: MouseEvent, tabId: string): void {
        event.preventDefault();
        event.stopPropagation();
        menu = { tabId, x: event.clientX, y: event.clientY };
    }

    /** Sin ratón el menú sale bajo la pestaña. */
    function openMenuBelow(element: HTMLElement, tabId: string): void {
        const bounds = element.getBoundingClientRect();
        menu = { tabId, x: bounds.left, y: bounds.bottom + 2 };
    }

    function closeMenu(): void {
        menu = null;
        if (app.activeTabId) getTerminal(app.activeTabId)?.focus();
    }

    function pickColor(tabId: string, color: TabColor | null): void {
        app.setTabColor(tabId, color);
        closeMenu();
    }

    /** Un menú abierto junto al borde no puede salirse de la ventana. */
    function placeMenu(node: HTMLElement): void {
        const bounds = node.getBoundingClientRect();
        if (bounds.right > window.innerWidth - 4) node.style.left = `${Math.max(4, window.innerWidth - bounds.width - 4)}px`;
        if (bounds.bottom > window.innerHeight - 4) node.style.top = `${Math.max(4, window.innerHeight - bounds.height - 4)}px`;
        node.querySelector<HTMLElement>('button')?.focus();
    }

    function onMenuKeydown(event: KeyboardEvent): void {
        // Como en el campo de renombrar: los atajos de la ventana no deben
        // llevarse las teclas del menú.
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu();
            return;
        }
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button')];
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[(index + step + items.length) % items.length]?.focus();
    }

    /** La paleta abre el campo desde fuera, así que el texto inicial se carga
     *  al cambiar `renamingTabId` y no en el doble clic. */
    $effect(() => {
        const tab = app.tabs.find((candidate) => candidate.id === app.renamingTabId);
        if (tab) renameDraft = app.tabTitle(tab);
    });

    /** El clic que activa la pestaña devuelve el foco a su terminal un instante
     *  después, y el texto llega por `renameDraft` tras montarse el campo, lo
     *  que borraría una selección hecha aquí: se pide también tras pintarse. */
    function focusRenameInput(input: HTMLInputElement): void {
        input.focus();
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    }

    function finishRename(tabId: string, save: boolean): void {
        if (app.renamingTabId !== tabId) return;
        const tab = app.tabs.find((candidate) => candidate.id === tabId);
        // Sin cambios no se fija nada: la pestaña debe seguir al nombre del
        // entorno si luego se cambia de shell.
        if (save && tab && renameDraft.trim() !== app.tabTitle(tab)) app.renameTab(tabId, renameDraft);
        app.renamingTabId = null;
        getTerminal(tabId)?.focus();
    }

    function onRenameKeydown(event: KeyboardEvent, tabId: string): void {
        // Sin esto, los atajos de la ventana y el arrastre de la pestaña se
        // llevarían las teclas del campo.
        event.stopPropagation();
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        // `finishRename` devuelve el foco a la terminal durante este `keydown`:
        // sin cancelarlo, el `keypress` caería en xterm y ejecutaría lo que
        // hubiera escrito en la shell.
        event.preventDefault();
        finishRename(tabId, event.key === 'Enter');
    }

    function startRename(event: MouseEvent, tab: TabSummary): void {
        if ((event.target as Element).closest('.tab-close')) return;
        app.renamingTabId = tab.id;
    }

    function dragStart(event: DragEvent, tabId: string): void {
        draggedTabId = tabId;
        dropTargetId = null;
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/x-terminal-tab', tabId);
    }

    function dragOver(event: DragEvent, targetId: string): void {
        if (!draggedTabId || draggedTabId === targetId) {
            dropTargetId = null;
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
        dropTargetId = targetId;
        dropAfter = event.clientX >= bounds.left + bounds.width / 2;
    }

    function drop(event: DragEvent, targetId: string): void {
        event.preventDefault();
        const sourceId = draggedTabId ?? event.dataTransfer?.getData('text/x-terminal-tab');
        if (sourceId) app.reorderTab(sourceId, targetId, dropAfter);
        endDrag();
    }

    function endDrag(): void {
        draggedTabId = null;
        dropTargetId = null;
        dropAfter = false;
    }

    async function close(event: MouseEvent, tabId: string): Promise<void> {
        // Sin esto, cerrar una pestaña inactiva la activaría primero.
        event.stopPropagation();
        await app.closeTab(tabId);
    }

    function activateFromKeyboard(event: KeyboardEvent, tabId: string): void {
        // El botón de cierre vive dentro del contenedor de la pestaña. No
        // convertir sus pulsaciones en una activación de la pestaña padre.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'F2') {
            event.preventDefault();
            app.renamingTabId = tabId;
            return;
        }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            openMenuBelow(event.currentTarget as HTMLElement, tabId);
            return;
        }
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void app.activateTab(tabId);
    }

    function onAuxClick(event: MouseEvent, tabId: string): void {
        // Botón central de la rueda del ratón (button === 1)
        if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            void app.closeTab(tabId);
        }
    }

    /** Cuántas casillas se ven ahora. Menos de dos es la vista normal. */
    const panes = $derived(app.panes.length < 2 ? 1 : app.panes.length);

    /** El botón siempre hace algo: las casillas que no tengan pestaña con la
     *  que llenarse la abren solas. */
    const maximo = MAX_PANES;

    /** Qué va a hacer el siguiente clic. Las dos claves vienen del catálogo del
     *  port de Electron, donde este botón sí existía. */
    const rotulo = $derived(
        panes >= maximo
            ? app.t('tabs.splitBackTitle', 'Volver a una sola terminal (Ctrl+Shift+\\)')
            : app
                  .t(
                      'tabs.splitAddTitle',
                      'Añadir otra terminal a la vista, hasta {max} (Ctrl+Shift+\\)'
                  )
                  .replace('{max}', String(maximo))
    );

    /** Las casillas que dibuja el icono, con las mismas proporciones que la
     *  rejilla real: una columna con 1, dos con 2, y 2×2 a partir de 3 (la
     *  tercera ocupa media fila de abajo). */
    const celdas = $derived.by(() => {
        const marco = { x: 1.5, y: 2.5, w: 13, h: 11 };
        if (panes === 1) return [marco];
        const mitad = (marco.w - 1) / 2;
        const izquierda = { ...marco, w: mitad };
        const derecha = { ...marco, x: marco.x + mitad + 1, w: mitad };
        if (panes === 2) return [izquierda, derecha];
        const alto = (marco.h - 1) / 2;
        const abajo = marco.y + alto + 1;
        if (panes === 3) {
            return [
                { ...izquierda, h: alto },
                { ...derecha, h: alto },
                { ...izquierda, y: abajo, h: alto, w: marco.w }
            ];
        }
        return [
            { ...izquierda, h: alto },
            { ...derecha, h: alto },
            { ...izquierda, y: abajo, h: alto },
            { ...derecha, y: abajo, h: alto }
        ];
    });
</script>

<div class="tab-strip">
    <!-- El explorador se abre y se cierra desde aquí y con Ctrl+Shift+E, igual
         que en la versión Electron.

         El icono va en SVG y no como carácter: el glifo de carpeta (U+1F5C0) no
         está en las fuentes de un Windows recortado y salía como el rectángulo
         de "falta el glifo". Un trazo dibujado a mano no depende de qué fuentes
         tenga el sistema y hereda el color del botón, así que el estado activo
         se ve sin cambiar de icono. -->
    {#if app.preferences?.showExplorerPanel !== false}<button
        type="button"
        class="side-toggle"
        class:on={app.explorerVisible}
        aria-pressed={app.explorerVisible}
        title={app.t('tabs.explorerTitle', 'Mostrar u ocultar el explorador de archivos (Ctrl+Shift+E)')}
        onclick={() => (app.explorerVisible = !app.explorerVisible)}
    >
        <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
                d="M1.5 3.5h4l1.4 1.6h7.6v7.4H1.5z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linejoin="round"
            />
        </svg>
    </button>{/if}

    <!-- La vista dividida existía desde el principio pero solo por teclado
         (Ctrl+Shift+\), así que no la encontraba nadie. El icono dibuja la
         rejilla que hay ahora mismo, y el clic rota 1 → 2 → 3 → 4 → 1. -->
    <button
        type="button"
        class="side-toggle panes"
        class:on={panes > 1}
        title={rotulo}
        onclick={() => app.cyclePanes()}
    >
        <svg viewBox="0 0 16 16" aria-hidden="true">
            {#each celdas as celda, i (i)}
                <rect
                    x={celda.x}
                    y={celda.y}
                    width={celda.w}
                    height={celda.h}
                    rx="1"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.2"
                />
            {/each}
        </svg>
    </button>

    <!-- Rotar hasta volver a 1 no se descubre y abre pestañas por el camino:
         este botón deshace la división sin cerrar ninguna. -->
    {#if panes > 1}<button
        type="button"
        class="side-toggle"
        data-testid="tabs-unsplit"
        title={app.t('tabs.unsplit', 'Separar: ver una sola sesión; las demás pestañas siguen abiertas')}
        aria-label={app.t('tabs.unsplit', 'Separar: ver una sola sesión; las demás pestañas siguen abiertas')}
        onclick={() => app.setPaneCount(1)}
    >
        <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
    </button>{/if}

    {#each app.tabs as tab (tab.id)}
        <div
            class="tab"
            data-tab-id={tab.id}
            class:active={tab.id === app.activeTabId}
            class:dragging={tab.id === draggedTabId}
            class:drop-before={tab.id === dropTargetId && !dropAfter}
            class:drop-after={tab.id === dropTargetId && dropAfter}
            class:colored={Boolean(app.tabColors[tab.id])}
            data-tab-color={app.tabColors[tab.id] ?? null}
            style:--tab-color={app.tabColors[tab.id] ? TAB_COLORS[app.tabColors[tab.id]] : null}
            draggable={tab.id !== app.renamingTabId}
            role="tab"
            aria-selected={tab.id === app.activeTabId}
            tabindex={tab.id === app.activeTabId ? 0 : -1}
            aria-label={`${app.tabTitle(tab)}. ${app.t('tabs.dragHint', 'Arrastra para reordenar; doble clic para renombrar.')}`}
            title={app.tabTitle(tab)}
            onclick={() => void app.activateTab(tab.id)}
            ondblclick={(event) => startRename(event, tab)}
            oncontextmenu={(event) => openMenu(event, tab.id)}
            onkeydown={(event) => activateFromKeyboard(event, tab.id)}
            onauxclick={(event) => onAuxClick(event, tab.id)}
            ondragstart={(event) => dragStart(event, tab.id)}
            ondragover={(event) => dragOver(event, tab.id)}
            ondrop={(event) => drop(event, tab.id)}
            ondragend={endDrag}
        >
            {#if tab.id === app.renamingTabId}
                <input
                    class="tab-rename"
                    data-testid="tab-rename"
                    maxlength={MAX_TAB_NAME}
                    aria-label={app.t('tabs.rename', 'Nombre de la pestaña')}
                    bind:value={renameDraft}
                    use:focusRenameInput
                    onkeydown={(event) => onRenameKeydown(event, tab.id)}
                    onblur={() => finishRename(tab.id, true)}
                />
            {:else}
                <span class="tab-label">{app.tabTitle(tab)}</span>
            {/if}
            <button
                type="button"
                class="tab-close"
                aria-label={app.t('tabs.close', 'Cerrar pestaña')}
                title={app.t('tabs.close', 'Cerrar pestaña')}
                onclick={(event) => close(event, tab.id)}
            >✕</button>
        </div>
    {/each}

    <button
        type="button"
        class="tab-new"
        title={app.t('tabs.new', 'Nueva pestaña')}
        onclick={() => app.createTab()}
    >+</button>
</div>

{#if menu && menuTab}
    {@const tab = menuTab}
    <!-- Fuera de la tira: su `overflow` recortaría el menú. Cualquier clic
         fuera lo cierra sin hacer nada más. -->
    <div
        class="tab-menu-backdrop"
        role="presentation"
        onpointerdown={closeMenu}
        oncontextmenu={(event) => { event.preventDefault(); closeMenu(); }}
    ></div>
    <div
        class="tab-menu"
        role="menu"
        tabindex="-1"
        data-testid="tab-menu"
        aria-label={app.t('tabs.menu', 'Opciones de la pestaña')}
        style:left={`${menu.x}px`}
        style:top={`${menu.y}px`}
        use:placeMenu
        onkeydown={onMenuKeydown}
    >
        <button
            type="button"
            role="menuitem"
            data-testid="tab-menu-rename"
            onclick={() => { menu = null; app.renamingTabId = tab.id; }}
        >{app.t('tabs.menuRename', 'Renombrar')}<kbd>F2</kbd></button>
        <div class="tab-menu-colors" role="group" aria-label={app.t('tabs.menuColor', 'Color')}>
            <button
                type="button"
                role="menuitemradio"
                class="swatch none"
                data-testid="tab-menu-color-none"
                aria-checked={!app.tabColors[tab.id]}
                title={app.t('tabs.colorNone', 'Sin color')}
                aria-label={app.t('tabs.colorNone', 'Sin color')}
                onclick={() => pickColor(tab.id, null)}
            ></button>
            {#each COLOR_IDS as color (color)}
                <button
                    type="button"
                    role="menuitemradio"
                    class="swatch"
                    data-testid={`tab-menu-color-${color}`}
                    aria-checked={app.tabColors[tab.id] === color}
                    title={colorName(color)}
                    aria-label={colorName(color)}
                    style:background={TAB_COLORS[color]}
                    onclick={() => pickColor(tab.id, color)}
                ></button>
            {/each}
        </div>
        {#if app.panes.length >= 2 && app.panes.includes(tab.id)}
            <button
                type="button"
                role="menuitem"
                data-testid="tab-menu-unsplit"
                onclick={() => { app.removeFromPanes(tab.id); closeMenu(); }}
            >{app.t('tabs.menuRemoveFromSplit', 'Sacar de la vista dividida')}</button>
        {:else if app.canAddToPanes(tab.id)}
            <button
                type="button"
                role="menuitem"
                data-testid="tab-menu-split"
                onclick={() => { app.addToPanes(tab.id); closeMenu(); }}
            >{app.t('tabs.menuAddToSplit', 'Ver junto a la pestaña activa')}</button>
        {/if}
        <button
            type="button"
            role="menuitem"
            data-testid="tab-menu-close"
            onclick={() => { menu = null; void app.closeTab(tab.id); }}
        >{app.t('tabs.close', 'Cerrar pestaña')}</button>
    </div>
{/if}

<style>
    .tab-strip {
        display: flex;
        /* La tira no debe ceder altura ante el contenido del workspace. El
           desplazamiento horizontal de pestañas sigue funcionando, pero los
           controles de explorador, división y nueva pestaña conservan 28px. */
        flex: 0 0 40px;
        align-items: center;
        gap: 6px;
        height: 40px;
        min-height: 40px;
        padding: 0 8px;
        background: var(--surface-alt);
        border-bottom: 1px solid var(--border);
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: thin;
    }

    .tab {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 28px;
        flex: 0 1 180px;
        min-width: 80px;
        max-width: 220px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s ease, border-color 0.15s ease;
    }

    .tab:hover {
        background: var(--surface-hover);
        border-color: var(--accent);
        color: var(--text);
    }

    .tab.active {
        background: var(--accent-soft);
        border-color: var(--accent);
        color: var(--text);
    }

    .tab.dragging {
        opacity: 0.45;
    }

    .tab.colored {
        border-left: 3px solid var(--tab-color);
        padding-left: 8px;
    }

    .tab-menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
    }

    .tab-menu {
        position: fixed;
        z-index: 1001;
        display: flex;
        flex-direction: column;
        min-width: 200px;
        padding: 4px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface);
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
        font-size: 12px;
    }

    .tab-menu > button {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 6px 8px;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: var(--text);
        font: inherit;
        text-align: left;
        cursor: pointer;
    }

    .tab-menu > button:hover,
    .tab-menu > button:focus-visible {
        background: var(--accent-soft);
        outline: none;
    }

    .tab-menu kbd {
        color: var(--muted);
        font: inherit;
    }

    .tab-menu-colors {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 6px 8px;
        border-top: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
        margin: 2px 0;
    }

    .swatch {
        width: 16px;
        height: 16px;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 50%;
        cursor: pointer;
    }

    .swatch.none {
        background: linear-gradient(135deg, transparent 45%, var(--muted) 45%, var(--muted) 55%, transparent 55%), var(--surface);
    }

    .swatch[aria-checked='true'],
    .swatch:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
    }

    .tab.drop-before {
        box-shadow: -3px 0 0 var(--accent);
    }

    .tab.drop-after {
        box-shadow: 3px 0 0 var(--accent);
    }

    .tab-label {
        /* El título consume todo el espacio disponible. Así el cierre no sigue
           al texto: permanece en el extremo derecho como en un navegador. */
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: left;
    }

    .tab-rename {
        flex: 1 1 auto;
        min-width: 0;
        width: 100%;
        padding: 0 2px;
        border: 1px solid var(--accent);
        border-radius: 2px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
    }

    .tab-close {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        margin-left: auto;
        padding: 0 3px;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: var(--muted);
        font: inherit;
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
    }

    .tab-close:hover {
        background: var(--accent-soft);
        color: var(--text);
    }

    .tab-new {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 28px;
        min-width: 28px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font-size: 14px;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
    }

    .tab-new:hover {
        background: var(--surface-hover);
        border-color: var(--accent);
        color: var(--text);
    }

    .side-toggle {
        display: flex;
        flex: 0 0 28px;
        min-width: 28px;
        align-items: center;
        justify-content: center;
        height: 28px;
        width: 28px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
    }

    .side-toggle svg {
        width: 15px;
        height: 15px;
    }

    .side-toggle:hover {
        background: var(--surface-hover);
        border-color: var(--accent);
        color: var(--text);
    }

    .side-toggle.on {
        background: var(--accent-soft);
        border-color: var(--accent);
        color: var(--accent);
    }

    .side-toggle:disabled {
        opacity: 0.4;
        cursor: default;
    }

    .side-toggle:disabled:hover {
        background: var(--surface);
        border-color: var(--border);
        color: var(--muted);
    }

    /* Separa el par de controles de vista de la primera pestaña. */
    .side-toggle.panes {
        margin-right: 4px;
    }
</style>
