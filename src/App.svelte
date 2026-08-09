<script lang="ts">
    // Raíz de la interfaz. Aquí se cargan el estado inicial y las suscripciones
    // a los eventos del pty: una sola vez para toda la app, no una por pestaña.

    import { onMount } from 'svelte';
    import type { UnlistenFn } from '@tauri-apps/api/event';
    import type { UpdateStatus } from './lib/types';

    import * as api from './lib/api';
    import { app } from './lib/appState.svelte';
    import { panels } from './lib/panels.svelte';
    import { getTerminal } from './lib/terminalRegistry';
    import DependenciesPanel from './components/DependenciesPanel.svelte';
    import ExplorerSidebar from './components/ExplorerSidebar.svelte';
    import ProjectsPanel from './components/ProjectsPanel.svelte';
    import ScriptsPanel from './components/ScriptsPanel.svelte';
    import SettingsPanel from './components/SettingsPanel.svelte';
    import TabBar from './components/TabBar.svelte';
    import TerminalPane from './components/TerminalPane.svelte';
    import Toolbar from './components/Toolbar.svelte';

    let ready = $state(false);
    let deps = $state<DependenciesPanel | null>(null);
    let settings = $state<SettingsPanel | null>(null);
    let scripts = $state<ScriptsPanel | null>(null);
    let projects = $state<ProjectsPanel | null>(null);
    /** La versión publicada, cuando el backend encuentra una más nueva al
     *  arrancar. Null mientras no haya nada que ofrecer. */
    let update = $state<UpdateStatus | null>(null);
    let updating = $state(false);
    let updateError = $state('');

    /** Atajos globales. Son los de la versión Electron, y se eligieron para no
     *  chocar con la edición de línea de las shells: Ctrl+W, por ejemplo, borra
     *  una palabra en bash/readline, así que no se usa para cerrar pestaña.
     *
     *  Dentro de un campo de formulario no se atienden — alguien escribiendo una
     *  ruta en Ajustes no quiere abrir pestañas — salvo Ctrl+Tab, que es
     *  navegación y tiene sentido desde cualquier sitio. */
    function onShortcut(event: KeyboardEvent): void {
        const target = event.target as HTMLElement | null;
        // Un campo de formulario solo bloquea los atajos si está FUERA de la
        // terminal. xterm mantiene un textarea invisible para recibir la
        // entrada, así que sin esta condición el foco normal de la terminal
        // contaba como "escribiendo en un formulario" y ningún atajo llegaba a
        // dispararse nunca.
        const dentroDeTerminal = target?.closest('.workspace') !== null && target !== null;
        const enFormulario =
            !dentroDeTerminal &&
            (target?.closest('input, textarea, select') != null || target?.isContentEditable === true);
        const esNavegacion = event.ctrlKey && event.key === 'Tab';
        if (enFormulario && !esNavegacion) return;

        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
            event.preventDefault();
            void app.createTab(app.activeTab?.envId ?? undefined);
            return;
        }
        if (esNavegacion) {
            event.preventDefault();
            if (app.tabs.length < 2) return;
            const actual = app.tabs.findIndex((tab) => tab.id === app.activeTabId);
            // Shift invierte el sentido; el módulo hace que dé la vuelta por los
            // dos extremos sin casos especiales.
            const salto = event.shiftKey ? -1 : 1;
            const siguiente = (actual + salto + app.tabs.length) % app.tabs.length;
            void app.activateTab(app.tabs[siguiente].id);
            return;
        }
        // Ctrl+Shift+\ rota entre 1, 2, 3 y 4 terminales a la vista.
        if (event.ctrlKey && event.shiftKey && event.key === '\\') {
            event.preventDefault();
            app.cyclePanes();
            return;
        }
        // Ctrl + Flechas o Alt + Flechas: mover el foco de la terminal en la vista dividida
        if ((event.ctrlKey || event.altKey) && !event.shiftKey && app.panes.length >= 2) {
            const key = event.key;
            if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
                event.preventDefault();
                event.stopPropagation();
                const dirMap: Record<string, 'left' | 'right' | 'up' | 'down'> = {
                    ArrowLeft: 'left',
                    ArrowRight: 'right',
                    ArrowUp: 'up',
                    ArrowDown: 'down'
                };
                app.navigatePaneDirection(dirMap[key]);
                return;
            }
        }

        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'e') {
            event.preventDefault();
            app.explorerVisible = !app.explorerVisible;
        }
    }

    onMount(() => {
        const unlisteners: Promise<UnlistenFn>[] = [
            api.onData((tabId, data) => getTerminal(tabId)?.write(data)),

            // clear / cls: el backend entrega el marcador ANTES del repintado de
            // la shell. Se resetean pantalla e historial y, acto seguido, llegan
            // el banner y un único prompt nuevos. Al revés quedaba el prompt
            // viejo de ConPTY flotando encima del banner.
            api.onClear((tabId) => getTerminal(tabId)?.reset()),

            api.onExit((tabId, code) => {
                const term = getTerminal(tabId);
                term?.writeln(
                    `\r\n\x1b[33m${app
                        .t('tabs.exited', '[Proceso finalizado con código {code}]')
                        .replace('{code}', String(code))}\x1b[0m`
                );
            }),

            api.onTabClosed((tabId, activeTabId) => app.handleTabClosed(tabId, activeTabId)),

            api.onEnvironmentChanged((event) => {
                // La sesión anterior ya no existe: su historial no tiene nada
                // que ver con la shell nueva, y el banner de esta llega justo
                // detrás. Sin el reset quedaban los dos pegados.
                getTerminal(event.tabId)?.reset();
                app.applyEnvironmentChange(event);
            }),

            api.onEnvironmentsUpdated((inventory) => app.applyInventory(inventory)),

            api.onCommandNotFound((event) => app.noteSuggestion(event.tabId, event.suggestion)),

            api.onUpdateAvailable((status) => {
                update = status;
            })
        ];

        void app.load().then(() => {
            ready = true;
        });

        // Los errores del frontend acaban en el mismo archivo de log que los del
        // backend, que es donde se mira cuando algo falla.
        const onError = (event: ErrorEvent) =>
            api.reportFrontendError({
                message: event.message,
                source: event.filename,
                line: event.lineno,
                stack: event.error?.stack
            });
        const onRejection = (event: PromiseRejectionEvent) =>
            api.reportFrontendError({ message: String(event.reason) });

        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);

        return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
            for (const pending of unlisteners) void pending.then((stop) => stop());
        };
    });
</script>

<svelte:window onkeydown={onShortcut} />

<main>
    <Toolbar
        onOpenDeps={() => deps?.load()}
        onOpenSettings={() => settings?.load()}
        onOpenScripts={() => scripts?.load()}
        onOpenProjects={() => projects?.load()}
    />
    <TabBar />

    <div class="workspace">
        <ExplorerSidebar />

        <!-- La rejilla: una casilla es la vista normal, y de dos a cuatro es la
             vista dividida. Los paneles NO se destruyen al ocultarse — cada uno
             guarda su xterm con su historial —, así que lo que cambia es solo
             cuál se ve y en qué casilla. -->
        <div class="grid" style="--panes: {app.panes.length < 2 ? 1 : app.panes.length}">
            {#if ready}
                {#each app.tabs as tab (tab.id)}
                    {@const pane = app.visibleTabs.indexOf(tab.id)}
                    <div
                        class="cell"
                        class:hidden={pane === -1}
                        class:focused={app.panes.length > 1 && tab.id === app.activeTabId}
                        style="order: {pane}"
                        onpointerdown={() => app.activateTab(tab.id)}
                        role="presentation"
                    >
                        <TerminalPane tabId={tab.id} active={pane !== -1} />
                    </div>
                {/each}
            {/if}
        </div>
    </div>

    {#if app.activeTabId && app.suggestions[app.activeTabId]}
        {@const suggestion = app.suggestions[app.activeTabId]}
        <div class="suggestion" role="status">
            <span>
                {app
                    .t('suggestion.missing', '{tool} no está instalado.')
                    .replace('{tool}', suggestion.label)}
            </span>
            <div class="suggestion-actions">
                <!-- Sin `actionId` se reconoce la herramienta pero no hay nada
                     que ejecutar por ella en este sistema: solo queda descartar. -->
                {#if suggestion.actionId}
                    <button
                        type="button"
                        onclick={() => {
                            app.dismissSuggestion(app.activeTabId!);
                            panels.show('deps');
                            void deps?.load();
                        }}
                    >
                        {app.t('suggestion.install', 'Instalar')}
                    </button>
                {/if}
                <button type="button" onclick={() => app.dismissSuggestion(app.activeTabId!)}>
                    {app.t('suggestion.dismiss', 'Descartar')}
                </button>
            </div>
        </div>
    {/if}

    <!-- Aviso de versión nueva. Va abajo y no en un diálogo: encontrar una
         actualización no es motivo para interrumpir lo que se esté haciendo. -->
    {#if update}
        <div class="update" role="status">
            <span>
                {app
                    .t('update.available', 'Hay una versión más reciente: {version}.')
                    .replace('{version}', update.latestVersion ?? '')}
                {#if updateError}
                    <strong class="update-error">{updateError}</strong>
                {:else if update.installPath}
                    <small>
                        {app
                            .t('update.into', 'Se instalará en {path}')
                            .replace('{path}', update.installPath)}
                    </small>
                {/if}
            </span>
            <div class="update-actions">
                <button
                    type="button"
                    class="primary"
                    disabled={updating}
                    onclick={async () => {
                        updating = true;
                        updateError = '';
                        try {
                            // Si va bien, el proceso muere durante esta llamada
                            // y no vuelve: lo que sigue solo corre si ha fallado.
                            const result = await api.installUpdate();
                            updateError =
                                result.error ??
                                app.t('update.failed', 'No se pudo actualizar.');
                        } catch (cause) {
                            updateError = String(cause);
                        } finally {
                            updating = false;
                        }
                    }}
                >
                    {updating
                        ? app.t('update.installing', 'Actualizando…')
                        : app.t('update.install', 'Actualizar y reiniciar')}
                </button>
                <button type="button" onclick={() => (update = null)}>
                    {app.t('update.later', 'Ahora no')}
                </button>
            </div>
        </div>
    {/if}

    <DependenciesPanel bind:this={deps} />
    <ProjectsPanel bind:this={projects} />
    <ScriptsPanel bind:this={scripts} />
    <SettingsPanel bind:this={settings} />
</main>

<style>
    main {
        display: flex;
        flex-direction: column;
        height: 100vh;
        background: var(--app-bg);
        color: var(--text);
    }

    .workspace {
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
        background: var(--app-bg);
        padding: 4px;
    }

    /* Dos columnas a partir de la tercera casilla: con cuatro quedan 2x2, y con
       tres una fila de dos y una de una, que es como se reparte el hueco sin
       dejar una terminal de un palmo. */
    .grid {
        display: grid;
        flex: 1 1 auto;
        min-width: 0;
        grid-template-columns: repeat(min(var(--panes), 2), minmax(0, 1fr));
        gap: 6px;
        background: var(--app-bg);
    }

    .cell {
        position: relative;
        min-width: 0;
        min-height: 0;
        background: var(--terminal-bg);
        border: 1px solid #282c34;
        border-radius: 4px;
        overflow: hidden;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    /* Cuál recibe lo que se teclea. */
    .cell.focused {
        border-color: var(--accent);
        box-shadow: 0 0 0 1px var(--accent);
    }

    /* `display: none` sí vale aquí: el xterm de dentro se oculta con
       `visibility` en su propio componente, que es lo que necesita para poder
       medirse. La casilla entera sí puede salir de la rejilla. */
    .cell.hidden {
        display: none;
    }

    /* Aviso de herramienta que falta. Es una barra fija abajo y no un diálogo:
       no debe robar el foco de la terminal ni tapar lo que se está leyendo.
       Instalar no ejecuta nada: abre el panel de dependencias, donde se ve el
       comando exacto antes de escribirlo en la terminal. */
    .suggestion {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 6px 12px;
        background: var(--accent-soft);
        border-top: 1px solid var(--border);
        color: var(--text);
        font-size: 12px;
    }

    .suggestion-actions {
        display: flex;
        flex: 0 0 auto;
        gap: 6px;
    }

    .suggestion button {
        padding: 2px 10px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
    }

    .suggestion button:hover {
        background: var(--surface-hover);
    }

    /* Misma barra que el aviso de herramienta que falta, con el acento del
       tema: es información, no una alarma. */
    .update {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 6px 12px;
        border-top: 1px solid var(--accent);
        background: var(--accent-soft);
        color: var(--text);
        font-size: 12px;
    }

    .update small {
        display: block;
        color: var(--muted);
        font-size: 10px;
    }

    .update-error {
        display: block;
        color: #e06c75;
        font-size: 11px;
        font-weight: 400;
    }

    .update-actions {
        display: flex;
        flex: 0 0 auto;
        gap: 6px;
    }

    .update button {
        padding: 2px 10px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
    }

    .update button.primary {
        border-color: var(--accent);
        font-weight: 600;
    }

    .update button:hover:not(:disabled) {
        background: var(--surface-hover);
    }

    .update button:disabled {
        opacity: 0.6;
        cursor: default;
    }
</style>
