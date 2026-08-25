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
    // KeyboardEvent.ctrlKey no distingue izquierda/derecha. Se conserva el
    // estado físico de ControlRight para ofrecer un chord que no robe los
    // Ctrl+A/C/S/W habituales de la shell.
    let rightControlDown = false;

    function onGamingNavigationKeyDown(event: KeyboardEvent): void {
        if (event.code === "ControlRight" || (event.key === "Control" && event.location === 2)) {
            rightControlDown = true;
            return;
        }
        if (!rightControlDown || !event.ctrlKey || event.altKey || event.metaKey) return;
        const directions: Record<string, "left" | "right" | "up" | "down"> = {
            KeyA: "left",
            KeyD: "right",
            KeyW: "up",
            KeyS: "down",
        };
        const direction = directions[event.code];
        if (!direction) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) app.navigatePaneDirection(direction);
    }

    function onGamingNavigationKeyUp(event: KeyboardEvent): void {
        if (event.code === "ControlRight" || (event.key === "Control" && event.location === 2)) {
            rightControlDown = false;
        }
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
        const target = event.target as HTMLElement | null;
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

        if (
            matchesShortcut(event, preferences.shortcutNewTab)
        ) {
            event.preventDefault();
            void app.createTab(app.activeTab?.envId ?? undefined);
            return;
        }
        if (esNavegacion) {
            event.preventDefault();
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
            event.preventDefault();
            app.cyclePanes();
            return;
        }
        // Ctrl + Flechas o Alt + Flechas: mover el foco de la terminal en la vista dividida
        {
            const directions = [
                [preferences.shortcutPaneLeft, "left"],
                [preferences.shortcutPaneRight, "right"],
                [preferences.shortcutPaneUp, "up"],
                [preferences.shortcutPaneDown, "down"],
            ] as const;
            const direction = directions.find(([shortcut]) => matchesShortcut(event, shortcut));
            if (direction) {
                event.preventDefault();
                event.stopPropagation();
                app.navigatePaneDirection(direction[1]);
                return;
            }
        }

        if (
            matchesShortcut(event, preferences.shortcutToggleExplorer)
        ) {
            event.preventDefault();
            app.explorerVisible = !app.explorerVisible;
        }
    }

    onMount(() => {
        const openSettingsFromTerminal = () => {
            panels.show('settings');
            void loadSettings();
        };
        window.addEventListener('winslim:open-settings', openSettingsFromTerminal);
        const unlisteners: Promise<UnlistenFn>[] = [
            api.onData((tabId, data) => {
                const term = getTerminal(tabId);
                // La cola de escritura de xterm puede completar después de que
                // el usuario cierre la pestaña. No conservar una referencia
                // destruida evita `_renderer.value.dimensions` al intentar
                // desplazarla desde el callback tardío.
                if (!term?.element?.isConnected) return;
                const bannerLike = /LTerminal|WinSlim|Sistema|System|CPU|Memoria|Memory|Disco|Disk|Kernel/i.test(data);
                try {
                    term.write(data, () => {
                        const current = getTerminal(tabId);
                        if (!current?.element?.isConnected) return;
                        perf.markOnce(`terminal-output:${tabId}`, 'terminal.first-output', { tabId });
                        if (bannerLike) {
                            perf.timeToOnce(`fastfetch-visible:${tabId}`, 'fastfetch.banner-visible', {
                                tabId,
                                source: 'pty-output',
                            });
                            perf.measureFrom(
                                `terminal-mounted:${tabId}`,
                                'fastfetch.banner-visible-after-terminal',
                                { tabId, source: 'pty-output' },
                                `fastfetch-visible-after-terminal:${tabId}`,
                            );
                        }
                        try { current.scrollToBottom(); }
                        catch (error) { console.debug('[App] terminal closed while scrolling', error); }
                    });
                } catch (error) {
                    console.debug('[App] terminal closed while writing', error);
                }
            }),

            // clear / cls: el backend entrega el marcador ANTES del repintado de
            // la shell. Se resetean pantalla e historial y, acto seguido, llegan
            // el banner y un único prompt nuevos. Al revés quedaba el prompt
            // viejo de ConPTY flotando encima del banner.
            api.onClear((tabId) => getTerminal(tabId)?.reset()),

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

            api.onTabClosed((tabId, activeTabId) =>
                app.handleTabClosed(tabId, activeTabId),
            ),

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
        // Captura antes que xterm/readline: la letra no llega al PTY cuando el
        // chord es Control derecho + WASD.
        window.addEventListener("keydown", onGamingNavigationKeyDown, true);
        window.addEventListener("keyup", onGamingNavigationKeyUp, true);
        const resetGamingChord = () => { rightControlDown = false; };
        window.addEventListener("blur", resetGamingChord);

        return () => {
            window.removeEventListener('winslim:open-settings', openSettingsFromTerminal);
            window.removeEventListener("error", onError);
            window.removeEventListener("unhandledrejection", onRejection);
            window.removeEventListener("keydown", onGamingNavigationKeyDown, true);
            window.removeEventListener("keyup", onGamingNavigationKeyUp, true);
            window.removeEventListener("blur", resetGamingChord);
            for (const pending of unlisteners)
                void pending.then((stop) => stop());
        };
    });
</script>

<svelte:window onkeydown={onShortcut} />

<main class:platform-linux={app.appInfo?.platform === "linux"}>
    {#if startupError}
        <section class="startup-error" role="alert">
            <h1>{app.t("startup.errorTitle", "LTerminal no pudo iniciar la interfaz")}</h1>
            <p>{startupError}</p>
            <p>{app.t("startup.logHint", "Consulta la carpeta de logs desde Ajustes.")}</p>
        </section>
    {/if}
    <Toolbar
        onOpenDeps={() => void loadDeps()}
        onOpenSettings={() => void loadSettings()}
        onOpenScripts={() => void loadScripts()}
        onOpenProjects={() => void loadProjects()}
    />
    <TabBar />

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
        border: 1px solid #282c34;
        border-radius: 4px;
        overflow: hidden;
        transition:
            border-color 0.15s ease,
            box-shadow 0.15s ease;
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
        border: 2px solid #e06c75;
        border-radius: 8px;
        background: #1f1f1f;
        color: #f3f3f3;
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
