<script lang="ts">
    // Raíz de la interfaz. Aquí se cargan el estado inicial y las suscripciones
    // a los eventos del pty: una sola vez para toda la app, no una por pestaña.

    import { onMount, tick } from "svelte";
    import type { UnlistenFn } from "@tauri-apps/api/event";
    import type { UpdateStatus } from "./lib/types";

    import * as api from "./lib/api";
    import { app } from "./lib/appState.svelte";
    import { panels } from "./lib/panels.svelte";
    import * as perf from "./lib/performance";
    import { matchesShortcut } from "./lib/shortcuts";
    import { getTerminal } from "./lib/terminalRegistry";
    import DependenciesPanel from "./components/DependenciesPanel.svelte";
    import ExplorerSidebar from "./components/ExplorerSidebar.svelte";
    import ProjectsPanel from "./components/ProjectsPanel.svelte";
    import ScriptsPanel from "./components/ScriptsPanel.svelte";
    import SettingsPanel from "./components/SettingsPanel.svelte";
    import TabBar from "./components/TabBar.svelte";
    import TerminalPane from "./components/TerminalPane.svelte";
    import Toolbar from "./components/Toolbar.svelte";

    let ready = $state(false);
    let startupError = $state("");
    let deps = $state<DependenciesPanel | null>(null);
    let settings = $state<SettingsPanel | null>(null);
    let scripts = $state<ScriptsPanel | null>(null);
    let projects = $state<ProjectsPanel | null>(null);
    // Los paneles conservan su estado una vez abiertos, pero no construyen sus
    // árboles DOM durante el arranque. `tick()` garantiza que la referencia ya
    // existe antes de pedirle su carga, también en la primera apertura.
    let depsMounted = $state(false);
    let settingsMounted = $state(false);
    let scriptsMounted = $state(false);
    let projectsMounted = $state(false);
    /** La versión publicada, cuando el backend encuentra una más nueva al
     *  arrancar. Null mientras no haya nada que ofrecer. */
    let update = $state<UpdateStatus | null>(null);
    let updating = $state(false);
    let updateError = $state("");
    /** Inicio del cambio de shell por pestaña. Se consume al completar el
     * primer `term.write`, que es el instante en que el usuario ya ve la nueva
     * sesión (el IPC por sí solo no incluye el arranque del inicializador). */
    const environmentSwitchStarted = new Map<string, number>();
    // Toda la salida del PTY pasa por una cola por pestaña. Tauri puede entregar
    // eventos desde hilos distintos y xterm mantiene su propio buffer de
    // escritura; serializarlos conserva el orden exacto de la shell.
    const outputQueues = new Map<string, Promise<void>>();
    // El id de una pestaña sobrevive a un cambio de entorno. Invalidar la época
    // hace que los bloques que aún esperan turno en la cola no se pinten sobre
    // la sesión siguiente.
    const outputEpochs = new Map<string, number>();
    function consumeShortcut(event: KeyboardEvent): void {
        // Capturarlo en la fase de captura es importante: el textarea oculto de
        // xterm recibe las flechas antes que un listener normal de la ventana.
        event.preventDefault();
        event.stopPropagation();
    }

    function invalidateTerminalOutput(tabId: string, preserveOrdering = false): Promise<void> {
        // Para un clear hay que conservar la promesa actual: aunque sus datos
        // pertenezcan a una época obsoleta, una escritura que ya esté dentro
        // de xterm debe terminar antes del borrado. Si se elimina la cola
        // primero, el clear puede adelantarse y el prompt antiguo reaparece
        // después del fastfetch nuevo.
        const previous = outputQueues.get(tabId) ?? Promise.resolve();
        outputEpochs.set(tabId, (outputEpochs.get(tabId) ?? 0) + 1);
        // Las promesas antiguas siguen resolviendo, pero ya no son la cola
        // vigente. La siguiente salida empieza desde una cola limpia.
        if (!preserveOrdering) outputQueues.delete(tabId);
        api.invalidateInput(tabId);
        return previous;
    }

    async function loadDeps(): Promise<void> {
        const finish = perf.start('panel.load', { panel: 'dependencies' });
        depsMounted = true;
        try {
            await tick();
            await deps?.load();
            finish('ok');
        } catch (cause) {
            finish('error', { error: String(cause).slice(0, 300) });
            throw cause;
        }
    }

    async function loadSettings(): Promise<void> {
        const finish = perf.start('panel.load', { panel: 'settings' });
        settingsMounted = true;
        try {
            await tick();
            await settings?.load();
            finish('ok');
        } catch (cause) {
            finish('error', { error: String(cause).slice(0, 300) });
            throw cause;
        }
    }

    async function loadScripts(): Promise<void> {
        const finish = perf.start('panel.load', { panel: 'scripts' });
        scriptsMounted = true;
        try {
            await tick();
            await scripts?.load();
            finish('ok');
        } catch (cause) {
            finish('error', { error: String(cause).slice(0, 300) });
            throw cause;
        }
    }

    async function loadProjects(): Promise<void> {
        const finish = perf.start('panel.load', { panel: 'projects' });
        projectsMounted = true;
        try {
            await tick();
            await projects?.load();
            finish('ok');
        } catch (cause) {
            finish('error', { error: String(cause).slice(0, 300) });
            throw cause;
        }
    }

    /** Atajos globales. Son los de la versión Electron, y se eligieron para no
     *  chocar con la edición de línea de las shells: Ctrl+W, por ejemplo, borra
     *  una palabra en bash/readline, así que no se usa para cerrar pestaña.
     *
     *  Dentro de un campo de formulario no se atienden — alguien escribiendo una
     *  ruta en Ajustes no quiere abrir pestañas — salvo Ctrl+Tab, que es
     *  navegación y tiene sentido desde cualquier sitio. */
    function onShortcut(event: KeyboardEvent): void {
        // Los eventos de WebView/IME y los sintéticos del E2E pueden llegar
        // con `window` como target; solo los elementos DOM ofrecen `closest`.
        const target = event.target instanceof HTMLElement ? event.target : null;
        // Un campo de grabación usa precisamente las mismas combinaciones que
        // la aplicación: no debe abrir un panel mientras el usuario lo está
        // configurando.
        if (target?.closest('[data-shortcut-input]')) return;
        // Un campo de formulario solo bloquea los atajos si está FUERA de la
        // terminal. xterm mantiene un textarea invisible para recibir la
        // entrada, así que sin esta condición el foco normal de la terminal
        // contaba como "escribiendo en un formulario" y ningún atajo llegaba a
        // dispararse nunca.
        const dentroDeTerminal =
            target?.closest(".workspace") !== null && target !== null;
        const enFormulario =
            !dentroDeTerminal &&
            (target?.closest("input, textarea, select") != null ||
                target?.isContentEditable === true);
        const preferences = app.preferences;
        if (!preferences) return;
        const esSiguiente = matchesShortcut(event, preferences.shortcutNextTab);
        const esAnterior = matchesShortcut(event, preferences.shortcutPreviousTab);
        const esNavegacion = esSiguiente || esAnterior;
        if (enFormulario && !esNavegacion) return;

        if (matchesShortcut(event, preferences.shortcutToggleTerminalOnly)) {
            consumeShortcut(event);
            panels.close();
            app.explorerVisible = false;
            void app.savePreferences({ terminalOnlyMode: !preferences.terminalOnlyMode });
            return;
        }

        if (
            matchesShortcut(event, preferences.shortcutNewTab)
        ) {
            consumeShortcut(event);
            void app.createTab(app.activeTab?.envId ?? undefined);
            return;
        }
        if (esNavegacion) {
            consumeShortcut(event);
            if (app.tabs.length < 2) return;
            const actual = app.tabs.findIndex(
                (tab) => tab.id === app.activeTabId,
            );
            // Shift invierte el sentido; el módulo hace que dé la vuelta por los
            // dos extremos sin casos especiales.
            const salto = esAnterior ? -1 : 1;
            const siguiente =
                (actual + salto + app.tabs.length) % app.tabs.length;
            void app.activateTab(app.tabs[siguiente].id);
            return;
        }
        // Ctrl+Shift+\ rota entre 1, 2, 3 y 4 terminales a la vista.
        if (matchesShortcut(event, preferences.shortcutCyclePanes)) {
            consumeShortcut(event);
            app.cyclePanes();
            return;
        }
        // Atajos direccionales configurables: mover el foco en la vista dividida.
        {
            const directions = [
                [preferences.shortcutPaneLeft, "left"],
                [preferences.shortcutPaneRight, "right"],
                [preferences.shortcutPaneUp, "up"],
                [preferences.shortcutPaneDown, "down"],
            ] as const;
            const direction = directions.find(([shortcut]) => matchesShortcut(event, shortcut));
            if (direction) {
                consumeShortcut(event);
                app.navigatePaneDirection(direction[1]);
                return;
            }
        }

        if (
            matchesShortcut(event, preferences.shortcutToggleExplorer)
        ) {
            consumeShortcut(event);
            if (preferences.showExplorerPanel === false) return;
            app.explorerVisible = !app.explorerVisible;
            return;
        }

        const extraActions = [
            [preferences.shortcutOpenSettings, 'openSettings'],
            [preferences.shortcutOpenProjects, 'openProjects'],
            [preferences.shortcutOpenScripts, 'openScripts'],
            [preferences.shortcutOpenDependencies, 'openDependencies'],
            [preferences.shortcutClosePanel, 'closePanel'],
            [preferences.shortcutRefreshEnvironments, 'refreshEnvironments'],
            [preferences.shortcutExplorerFollow, 'explorerFollow'],
            [preferences.shortcutExplorerCd, 'explorerCd'],
            [preferences.shortcutClearTerminal, 'clearTerminal'],
            [preferences.shortcutOpenSystemExplorer, 'openSystemExplorer'],
        ] as const;
        const extra = extraActions.find(([shortcut]) => shortcut && matchesShortcut(event, shortcut));
        if (extra) {
            consumeShortcut(event);
            runExtraShortcut(extra[1]);
        }
    }

    function runExtraShortcut(action: string): void {
        switch (action) {
            case 'openSettings':
                panels.show('settings');
                void loadSettings();
                break;
            case 'openProjects':
                if (app.preferences?.showProjectsPanel === false) return;
                panels.show('projects');
                void loadProjects();
                break;
            case 'openScripts':
                if (app.preferences?.showScriptsPanel === false) return;
                panels.show('scripts');
                void loadScripts();
                break;
            case 'openDependencies':
                if (app.preferences?.showDependenciesPanel === false) return;
                panels.show('deps');
                void loadDeps();
                break;
            case 'closePanel':
                panels.close();
                app.explorerVisible = false;
                break;
            case 'refreshEnvironments':
                void app.refreshEnvironments();
                break;
            case 'explorerFollow':
                if (app.preferences?.showExplorerPanel === false) return;
                app.explorerVisible = true;
                window.dispatchEvent(new CustomEvent('winslim:explorer-follow', {
                    detail: { tabId: app.activeTabId },
                }));
                break;
            case 'explorerCd':
                if (app.preferences?.showExplorerPanel === false) return;
                app.explorerVisible = true;
                window.dispatchEvent(new CustomEvent('winslim:explorer-cd', {
                    detail: { tabId: app.activeTabId },
                }));
                break;
            case 'clearTerminal': {
                const terminal = app.activeTabId ? getTerminal(app.activeTabId) : undefined;
                terminal?.clear();
                terminal?.focus();
                break;
            }
            case 'openSystemExplorer':
                if (app.activeTabId) {
                    window.dispatchEvent(new CustomEvent('winslim:open-current-directory', {
                        detail: { tabId: app.activeTabId },
                    }));
                }
                break;
        }
    }

    onMount(() => {
        const onEnvironmentSwitchStarted = (event: Event) => {
            const detail = (event as CustomEvent<{ tabId?: string }>).detail;
            if (detail?.tabId) {
                // El backend emitirá pty-clear después de invalidar la PTY.
                // Mantener el orden hasta ese evento evita que una escritura
                // vieja termine después del clear de la nueva sesión.
                invalidateTerminalOutput(detail.tabId, true);
                environmentSwitchStarted.set(
                    detail.tabId,
                    typeof performance !== 'undefined' ? performance.now() : Date.now(),
                );
            }
        };
        window.addEventListener('winslim:environment-switch-started', onEnvironmentSwitchStarted);
        const openSettingsFromTerminal = () => {
            panels.show('settings');
            void loadSettings();
        };
        window.addEventListener('winslim:open-settings', openSettingsFromTerminal);
        const openPanelFromTerminal = (event: Event) => {
            const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel;
            if (panel === 'deps') {
                panels.show('deps');
                void loadDeps();
            } else if (panel === 'projects') {
                panels.show('projects');
                void loadProjects();
            } else if (panel === 'scripts') {
                panels.show('scripts');
                void loadScripts();
            } else if (panel === 'settings') {
                panels.show('settings');
                void loadSettings();
            }
        };
        window.addEventListener('winslim:open-panel', openPanelFromTerminal);
        const unlisteners: Promise<UnlistenFn>[] = [
            api.onData((tabId, data) => {
                window.dispatchEvent(new CustomEvent('winslim:terminal-output-busy', { detail: { tabId } }));
                const previous = outputQueues.get(tabId) ?? Promise.resolve();
                const epoch = outputEpochs.get(tabId) ?? 0;
                const queued = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
                    if ((outputEpochs.get(tabId) ?? 0) !== epoch) {
                        resolve();
                        return;
                    }
                    const term = getTerminal(tabId);
                    // La cola de escritura de xterm puede completar después de
                    // que el usuario cierre la pestaña. No conservar una
                    // referencia destruida evita `_renderer.value.dimensions`
                    // al intentar desplazarla desde el callback tardío.
                    if (!term?.element?.isConnected) {
                        resolve();
                        return;
                    }
                    try {
                        term.write(data, () => {
                        const current = getTerminal(tabId);
                        if (!current?.element?.isConnected) {
                            resolve();
                            return;
                        }
                        perf.markOnce(`terminal-output:${tabId}`, 'terminal.first-output', { tabId });
                        const switchStarted = environmentSwitchStarted.get(tabId);
                        if (switchStarted !== undefined) {
                            environmentSwitchStarted.delete(tabId);
                            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            perf.record('terminal.environment-switch-first-output', 'duration', {
                                durationMs: Math.round(Math.max(0, now - switchStarted) * 100) / 100,
                                status: 'ok',
                                tabId,
                            });
                        }
                        // Toda salida nueva (incluido el banner inicial o el
                        // que pide Ajustes) pasa por esta cola y devuelve la
                        // vista al prompt sin superponer capas DOM.
                        try { current.scrollToBottom(); }
                        catch (error) { console.debug('[App] terminal closed while scrolling', error); }
                        resolve();
                        });
                    } catch (error) {
                        console.debug('[App] terminal closed while writing', error);
                        resolve();
                    }
                }));
                outputQueues.set(tabId, queued);
                void queued.then(() => {
                    if (outputQueues.get(tabId) !== queued) return;
                    outputQueues.delete(tabId);
                    window.dispatchEvent(new CustomEvent('winslim:terminal-output-idle', { detail: { tabId } }));
                });
            }),

            // clear / cls: el backend entrega el marcador ANTES del repintado de
            // la shell. El borrado también debe pasar por la misma cola que los
            // bloques de salida: hacerlo directamente podría ejecutarse después
            // de datos posteriores y borrar el buffer en el orden equivocado.
            //
            // El marcador llega antes de que CMD/ConPTY repinte el prompt.
            // Hay que borrar tanto la pantalla visible como el scrollback,
            // pero conservar la posición del cursor que ya tiene la shell.
            // Si solo se enviaba CSI 3 J, la fila del prompt anterior quedaba
            // visible y el prompt nuevo aparecía debajo como una línea
            // duplicada; si además se hacía HOME, xterm y cmd quedaban
            // desincronizados y la entrada empezaba en la fila siguiente.
            // No usamos RIS/reset: restablece modos y buffer local de xterm en
            // un momento distinto al de la shell y vuelve a desincronizar la
            // fila donde se escribe la siguiente entrada.
            api.onClear((tabId) => {
                const previous = invalidateTerminalOutput(tabId, true);
                window.dispatchEvent(new CustomEvent('winslim:terminal-output-busy', { detail: { tabId } }));
                const epoch = outputEpochs.get(tabId) ?? 0;
                const queued = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
                    if ((outputEpochs.get(tabId) ?? 0) !== epoch) {
                        resolve();
                        return;
                    }
                    const term = getTerminal(tabId);
                    if (!term?.element?.isConnected) {
                        resolve();
                        return;
                    }
                    try { term.write('\x1b[2J\x1b[3J', resolve); }
                    catch (error) {
                        console.debug('[App] terminal closed while clearing scrollback', error);
                        resolve();
                    }
                }));
                outputQueues.set(tabId, queued);
                void queued.then(() => {
                    if (outputQueues.get(tabId) !== queued) return;
                    outputQueues.delete(tabId);
                    window.dispatchEvent(new CustomEvent('winslim:terminal-output-idle', { detail: { tabId } }));
                });
            }),

            api.onExit((tabId, code) => {
                const term = getTerminal(tabId);
                term?.writeln(
                    `\r\n\x1b[33m${app
                        .t(
                            "tabs.exited",
                            "[Proceso finalizado con código {code}]",
                        )
                        .replace("{code}", String(code))}\x1b[0m`,
                );
            }),

            api.onTabClosed((tabId, activeTabId) => {
                invalidateTerminalOutput(tabId);
                app.handleTabClosed(tabId, activeTabId);
            }),

            api.onEnvironmentChanged((event) => {
                app.applyEnvironmentChange(event);
            }),

            api.onEnvironmentsUpdated((inventory) =>
                app.applyInventory(inventory),
            ),

            api.onCommandNotFound((event) =>
                app.noteSuggestion(event.tabId, event.suggestion),
            ),

            api.onUpdateAvailable((status) => {
                update = status;
            }),
        ];

        perf.markOnce('frontend-mounted', 'frontend.mounted');
        const initialLoad = perf.start('app.initial-load');
        void app.load()
            .then(async () => {
                initialLoad('ok', {
                    tabs: app.tabs.length,
                    environments: app.environments.length,
                });
                ready = true;
                await tick();
                perf.timeToOnce('ui-shell-ready', 'app.ui-shell-visible', {
                    tabs: app.tabs.length,
                });
            })
            .catch((cause) => {
                initialLoad('error', { error: String(cause).slice(0, 300) });
                startupError = String(cause);
                // La ventana se mantiene oculta durante un arranque correcto
                // para no enseñar un frame blanco. Si la carga falla antes de
                // crear el PTY, revelar el error es la única ruta recuperable.
                void api.revealWindow().catch((revealError) => {
                    console.error('[App] no se pudo mostrar el error de arranque', revealError);
                });
                void api.reportFrontendError({
                    message: `No se pudo iniciar la interfaz: ${startupError}`,
                });
            });

        // Los errores del frontend acaban en el mismo archivo de log que los del
        // backend, que es donde se mira cuando algo falla.
        const onError = (event: ErrorEvent) =>
            api.reportFrontendError({
                message: event.message,
                source: event.filename,
                line: event.lineno,
                stack: event.error?.stack,
            });
        const onRejection = (event: PromiseRejectionEvent) =>
            api.reportFrontendError({ message: String(event.reason) });

        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
        window.addEventListener("keydown", onShortcut, true);

        return () => {
            window.removeEventListener('winslim:environment-switch-started', onEnvironmentSwitchStarted);
            environmentSwitchStarted.clear();
            window.removeEventListener('winslim:open-settings', openSettingsFromTerminal);
            window.removeEventListener('winslim:open-panel', openPanelFromTerminal);
            window.removeEventListener("error", onError);
            window.removeEventListener("unhandledrejection", onRejection);
            window.removeEventListener("keydown", onShortcut, true);
            for (const pending of unlisteners)
                void pending.then((stop) => stop());
            outputQueues.clear();
            outputEpochs.clear();
        };
    });
</script>

<main class:platform-linux={app.appInfo?.platform === "linux"}>
    {#if startupError}
        <section class="startup-error" role="alert">
            <h1>{app.t("startup.errorTitle", "La terminal no pudo iniciar la interfaz")}</h1>
            <p>{startupError}</p>
        </section>
    {/if}
    {#if app.preferences?.terminalOnlyMode !== true}
        <Toolbar
            onOpenDeps={() => void loadDeps()}
            onOpenSettings={() => void loadSettings()}
            onOpenScripts={() => void loadScripts()}
            onOpenProjects={() => void loadProjects()}
        />
        {#if app.preferences?.showTabBar !== false}<TabBar />{/if}
    {/if}

    <div class="workspace">
        {#if app.preferences?.showExplorerPanel !== false}
            <ExplorerSidebar />
        {/if}

        <!-- La rejilla: una casilla es la vista normal, y de dos a cuatro es la
             vista dividida. Los paneles NO se destruyen al ocultarse — cada uno
             guarda su xterm con su historial —, así que lo que cambia es solo
             cuál se ve y en qué casilla. -->
        <div
            class="grid"
            style="--panes: {app.panes.length < 2 ? 1 : app.panes.length}"
        >
            {#if ready}
                {#each app.tabs as tab (tab.id)}
                    {@const pane = app.visibleTabs.indexOf(tab.id)}
                    <div
                        class="cell"
                        class:hidden={pane === -1}
                        class:wide={app.panes.length === 3 && pane === 2}
                        data-tab-id={tab.id}
                        class:focused={app.panes.length > 1 &&
                            tab.id === app.activeTabId}
                        style="order: {pane}"
                        onpointerdown={() => void app.activateTab(tab.id)}
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
                    .t("suggestion.missing", "{tool} no está instalado.")
                    .replace("{tool}", suggestion.label)}
            </span>
            <div class="suggestion-actions">
                <!-- Aunque no exista una acción automática para esta plataforma,
                     el catálogo puede ofrecerla bajo WSL, Chocolatey o una
                     descarga manual. En todos los casos el botón lleva al panel
                     de dependencias; nunca ejecuta comandos por detrás. -->
                <button
                    type="button"
                    onclick={() => {
                        app.dismissSuggestion(app.activeTabId!);
                        panels.show("deps");
                        void loadDeps();
                    }}
                >
                    {#if suggestion.actionId}
                        {app
                            .t("suggestion.install", "Instalar {tool}")
                            .replace("{tool}", suggestion.label)
                            .replace("{app}", suggestion.label)}
                    {:else}
                        {app.t("toolbar.deps", "Entorno y dependencias")}
                    {/if}
                </button>
                <button
                    type="button"
                    onclick={() => app.dismissSuggestion(app.activeTabId!)}
                >
                    {app.t("suggestion.dismiss", "Descartar")}
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
                    .t(
                        "update.available",
                        "Hay una versión más reciente: {version}.",
                    )
                    .replace("{version}", update.latestVersion ?? "")}
                {#if updateError}
                    <strong class="update-error">{updateError}</strong>
                {:else if update.installPath}
                    <small>
                        {app
                            .t("update.into", "Se instalará en {path}")
                            .replace("{path}", update.installPath)}
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
                        updateError = "";
                        try {
                            // Si va bien, el proceso muere durante esta llamada
                            // y no vuelve: lo que sigue solo corre si ha fallado.
                            const result = await api.installUpdate();
                            updateError =
                                result.error ??
                                app.t(
                                    "update.failed",
                                    "No se pudo actualizar.",
                                );
                        } catch (cause) {
                            updateError = String(cause);
                        } finally {
                            updating = false;
                        }
                    }}
                >
                    {updating
                        ? app.t("update.installing", "Actualizando…")
                        : app.t("update.install", "Actualizar y reiniciar")}
                </button>
                <button type="button" onclick={() => (update = null)}>
                    {app.t("update.later", "Ahora no")}
                </button>
            </div>
        </div>
    {/if}

    {#if depsMounted}
        <DependenciesPanel bind:this={deps} />
    {/if}
    {#if projectsMounted}
        <ProjectsPanel bind:this={projects} />
    {/if}
    {#if scriptsMounted}
        <ScriptsPanel bind:this={scripts} />
    {/if}
    {#if settingsMounted}
        <SettingsPanel bind:this={settings} />
    {/if}
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
        grid-auto-rows: minmax(0, 1fr);
        gap: 6px;
        background: var(--app-bg);
    }

    .cell {
        position: relative;
        min-width: 0;
        min-height: 0;
        background: var(--terminal-bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        overflow: hidden;
        transition:
            border-color 0.15s ease,
            box-shadow 0.15s ease;
    }

    /* Con tres paneles, el tercero ocupa toda la fila inferior. El índice se
       calcula sobre `visibleTabs`, así las pestañas ocultas no alteran qué
       casilla recibe la regla. */
    .cell.wide {
        grid-column: 1 / -1;
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

    .startup-error {
        position: fixed;
        inset: 24px;
        z-index: 10000;
        overflow: auto;
        padding: 24px;
        border: 2px solid var(--danger);
        border-radius: 8px;
        background: var(--surface);
        color: var(--text);
        font: 14px/1.5 system-ui, sans-serif;
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
        color: var(--danger);
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
