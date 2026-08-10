<script lang="ts">
    // La tira de pestañas y el botón de abrir una nueva.
    // Port de `renderTabStrip` en renderer.js.

    import { app, MAX_PANES } from '../lib/appState.svelte';

    async function close(event: MouseEvent, tabId: string): Promise<void> {
        // Sin esto, cerrar una pestaña inactiva la activaría primero.
        event.stopPropagation();
        await app.closeTab(tabId);
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
    <button
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
    </button>

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

    {#each app.tabs as tab (tab.id)}
        <button
            type="button"
            class="tab"
            class:active={tab.id === app.activeTabId}
            title={tab.label}
            onclick={() => app.activateTab(tab.id)}
            onauxclick={(event) => onAuxClick(event, tab.id)}
        >
            <span class="tab-label">{tab.label}</span>
            <span
                class="tab-close"
                role="button"
                tabindex="-1"
                aria-label={app.t('tabs.close', 'Cerrar pestaña')}
                onclick={(event) => close(event, tab.id)}
                onkeydown={(event) => event.key === 'Enter' && close(event as unknown as MouseEvent, tab.id)}
            >✕</span>
        </button>
    {/each}

    <button
        type="button"
        class="tab-new"
        title={app.t('tabs.new', 'Nueva pestaña')}
        onclick={() => app.createTab()}
    >+</button>
</div>

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

    .tab-label {
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .tab-close {
        flex: 0 0 auto;
        padding: 0 3px;
        border-radius: 3px;
        color: var(--muted);
        font-size: 11px;
        line-height: 1;
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
