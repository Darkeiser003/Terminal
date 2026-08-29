<script lang="ts">
    // Un xterm por pestaña. El componente se monta cuando nace la pestaña y no
    // se destruye al cambiar de una a otra: el panel se oculta con CSS, pero el
    // xterm y su historial siguen vivos. Destruirlo perdería el scrollback.
    //
    // Port de `createXtermForTab` y sus alrededores en renderer.js.

    import { onMount, onDestroy } from 'svelte';
    import { Terminal } from '@xterm/xterm';
    import { FitAddon } from '@xterm/addon-fit';

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { compareLocalized, foldLocalized } from '../lib/localization';
    import * as perf from '../lib/performance';
    import { cursorOptions, terminalFont, terminalFontWeight, terminalTheme } from '../lib/theme';
    import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry';

    interface Props {
        tabId: string;
        active: boolean;
    }

    let { tabId, active }: Props = $props();

    let host: HTMLDivElement;
    let term: Terminal | undefined;
    let fitAddon: FitAddon | undefined;
    let observer: ResizeObserver | undefined;
    let mirroredLine: string | null = '';
    // En rejilla el banner es una cabecera de la interfaz, no parte del
    // scrollback editable: esta copia visible permanece fija aunque una
    // entrada larga haga reflow y desplace el buffer de xterm.
    let bannerOverlay = $state('');
    // Las promesas de resize/repintado pueden resolver después de desmontar
    // una pestaña. Marcar el ciclo de vida evita que un callback tardío vuelva
    // a escribir un banner en un xterm ya destruido o en una pestaña reciclada.
    let destroyed = false;

    const BANNER_ITEM_KEYS: Record<string, [string, string]> = {
        system: ['banner.system', 'System'],
        host: ['banner.pc', 'PC'],
        kernel: ['banner.kernel', 'Kernel'],
        environment: ['banner.environment', 'Environment'],
        motherboard: ['banner.motherboard', 'Motherboard'],
        cpu: ['banner.cpu', 'CPU'],
        gpu: ['banner.gpu', 'GPU'],
        memory: ['banner.memory', 'Memory'],
        storage: ['banner.storage', 'Disk'],
        uptime: ['banner.uptime', 'Uptime'],
        datetime: ['banner.datetime', 'DateTime'],
    };

    function translated(key: string, fallback: string, values: Record<string, string | number> = {}): string {
        let result = app.t(key, fallback);
        for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value));
        return result;
    }

    function bannerItemLabel(id: string): string {
        const [key, fallback] = BANNER_ITEM_KEYS[id] ?? ['', id];
        return key ? app.t(key, fallback) : fallback;
    }

    // Créditos de autoría mostrados por los easter-eggs. Las URL son datos
    // públicos estables; el texto que las acompaña vive en el catálogo para
    // que el comando respete el idioma activo de la interfaz.
    const CREDIT_URLS = {
        darkeiserProfile: 'https://github.com/Darkeiser003',
        terminalProject: 'https://github.com/Darkeiser003/Terminal',
        cloudProject: 'https://github.com/Darkeiser003/Infraestructura-Web',
        christianProfile: 'https://github.com/Christianlg97',
        winslimStore: 'https://github.com/Christianlg97/WINSLIM_CENTER_STORE',
        winslimUpdate: 'https://github.com/Christianlg97/WinSlim-Update',
    } as const;

    function writeCredits(action: 'darkeiser003' | 'christianlg97'): void {
        if (action === 'darkeiser003') {
            term?.writeln(`\r\n${translated('terminal.creditDarkeiser', 'Darkeiser003 · desarrollador de WinSlim Terminal\nGracias por visitar este proyecto. Puedes seguir el desarrollo, abrir incidencias y conocer las novedades en:\nPerfil: {darkeiserProfile}\nWinSlim Terminal: {terminalProject}\nInfraestructura-Web: {cloudProject}', CREDIT_URLS)}`);
            return;
        }
        term?.writeln(`\r\n${translated('terminal.creditChristian', 'Christianlg97 · colaborador de WinSlim Terminal\nGracias por tu cooperación en este y otros proyectos, y por compartir tus conocimientos, tiempo y recursos, especialmente sobre Windows.\nWinSlim es una versión de Windows optimizada, con herramientas propias, personalización, automatización y utilidades de sistema:\nPerfil: {christianProfile}\nWinSlim Center Store: {winslimStore}\nWinSlim Update: {winslimUpdate}', CREDIT_URLS)}`);
    }

    function isDirectCreditAlias(line: string): boolean {
        // Debe coincidir con el contrato del parser Rust: una línea completa,
        // un `@` opcional y ninguna palabra adicional. Mantener esta pequeña
        // preselección aquí evita enviar el alias a la shell antes de que el
        // IPC pueda confirmarlo.
        return /^@?(?:darkeiser003|christianlg97)$/i.test(line.trim());
    }

    async function configureBanner(argument?: string): Promise<void> {
        const tokens = (argument ?? 'list').trim().split(/\s+/).filter(Boolean);
        // Los verbos del protocolo son ASCII y no deben depender de la
        // configuración regional (en turco, `LIST`.toLocaleLowerCase() no es
        // "list"). Los nombres humanos del REPL sí usan el idioma activo.
        const action = (tokens.shift() ?? 'list').toLowerCase();
        const available = new Set(Object.keys(BANNER_ITEM_KEYS));
        const current = new Set((app.preferences?.bannerHiddenItems ?? '').split(',').filter(Boolean));
        const ids = tokens
            .map((token) => token.toLowerCase())
            .filter((token) => available.has(token));
        const unknown = action === 'preset'
            ? []
            : tokens.filter((token) => !available.has(token.toLowerCase()));

        if (action === 'list') {
            const hidden = [...current].filter((id) => available.has(id));
            const state = hidden.length
                ? translated('terminal.bannerHidden', 'hidden: {items}', { items: hidden.map(bannerItemLabel).join(', ') })
                : app.t('terminal.fullProfile', 'full profile');
            term?.writeln(`\r\n${translated('terminal.bannerStatus', 'Banner: {state}', { state })}`);
            term?.writeln(app.t('terminal.bannerUsage', 'Usage: :banner hide|show|toggle <system|host|kernel|environment|motherboard|cpu|gpu|memory|storage|uptime|datetime>'));
            term?.writeln(app.t('terminal.bannerShortcuts', 'Shortcuts: :banner preset compact | :banner preset full'));
            return;
        }
        if (unknown.length || (action !== 'preset' && !ids.length)) {
            term?.writeln(`\r\n${app.t('terminal.bannerUsageShort', 'Usage: :banner hide|show|toggle <items>, :banner preset compact|full or :banner list')}`);
            return;
        }

        if (action === 'preset') {
            const preset = (tokens[0] ?? '').toLowerCase();
            if (preset === 'full' || preset === 'completo') current.clear();
            else if (preset === 'compact' || preset === 'compacto') {
                current.clear();
                for (const id of ['host', 'kernel', 'environment', 'motherboard', 'gpu', 'datetime']) current.add(id);
            } else {
                term?.writeln(`\r\n${app.t('terminal.bannerProfiles', 'Available profiles: compact | full')}`);
                return;
            }
        } else if (action === 'hide') {
            for (const id of ids) current.add(id);
        } else if (action === 'show') {
            for (const id of ids) current.delete(id);
        } else if (action === 'toggle') {
            for (const id of ids) {
                if (current.has(id)) current.delete(id);
                else current.add(id);
            }
        } else {
            term?.writeln(`\r\n${app.t('terminal.bannerActions', 'Available actions: hide, show, toggle, preset, list')}`);
            return;
        }

        await app.savePreferences({ bannerHiddenItems: [...current].join(',') });
        const state = current.size
            ? translated('terminal.hiddenCount', '{count} hidden item(s)', { count: current.size })
            : app.t('terminal.fullProfile', 'full profile');
        term?.writeln(`\r\n${translated('terminal.bannerUpdated', 'Banner updated: {state}.', { state })}`);
    }

    async function configureQuickActions(argument?: string): Promise<void> {
        const tokens = (argument ?? 'list').trim().split(/\s+/).filter(Boolean);
        if (tokens.length > 1) {
            term?.writeln(`\r\n${app.t('terminal.quickActionsUsage', 'Usage: :quick-actions on|off|toggle|list')}`);
            return;
        }
        const action = (tokens[0] ?? 'list').toLowerCase();
        const current = app.preferences?.showQuickActions ?? true;
        if (action === 'list') {
            const state = current ? app.t('terminal.visible', 'visible') : app.t('terminal.hidden', 'hidden');
            term?.writeln(`\r\n${translated('terminal.quickActionsStatus', 'Quick actions: {state}', { state })}`);
            term?.writeln(app.t('terminal.quickActionsUsage', 'Usage: :quick-actions on|off|toggle|list'));
            return;
        }

        let next: boolean;
        if (['on', 'show', 'mostrar', 'enable', 'enabled'].includes(action)) next = true;
        else if (['off', 'hide', 'ocultar', 'disable', 'disabled'].includes(action)) next = false;
        else if (['toggle', 'alternar'].includes(action)) next = !current;
        else {
            term?.writeln(`\r\n${app.t('terminal.quickActionsUsage', 'Usage: :quick-actions on|off|toggle|list')}`);
            return;
        }

        await app.savePreferences({ showQuickActions: next });
        const state = next ? app.t('terminal.visible', 'visible') : app.t('terminal.hidden', 'hidden');
        term?.writeln(`\r\n${translated('terminal.quickActionsStatus', 'Quick actions: {state}', { state })}.`);
    }

    async function runInternal(line: string): Promise<boolean> {
        const command = await api.parseInternalCommand(line);
        if (!command) return false;
        // Borrar carácter a carácter funciona también en cmd.exe, donde
        // Ctrl+U no limpia la línea. El espejo solo admite ASCII simple, así
        // que el número de DEL coincide exactamente con lo escrito.
        await api.sendInput(tabId, '\u007f'.repeat(line.length));
        if (command.action === 'config') {
            window.dispatchEvent(new CustomEvent('winslim:open-settings'));
        } else if (command.action === 'reload') {
            await app.refreshEnvironments();
        } else if (command.action === 'repl') {
            const wanted = foldLocalized(command.argument!, app.catalog.language);
            const environment = app.environments.find((env) =>
                env.repl && [env.id, env.language ?? '', env.label]
                    .some((value) => foldLocalized(value, app.catalog.language).includes(wanted))
            );
            if (environment) await app.createTab(environment.id);
            else term?.writeln(`\r\n\x1b[33m[${translated('terminal.replMissing', 'REPL not detected: {name}', { name: command.argument! })}]\x1b[0m`);
        } else if (command.action === 'banner') {
            await configureBanner(command.argument);
        } else if (command.action === 'quickActions') {
            await configureQuickActions(command.argument);
        } else if (command.action === 'darkeiser003' || command.action === 'christianlg97') {
            writeCredits(command.action);
        } else if (command.action === 'help' || command.action === 'alias') {
            const topic = command.action === 'alias' ? 'alias' : command.argument;
            const currentEnvironment = app.environments.find(
                (environment) => environment.id === app.activeTab?.envId,
            );
            const canLoadHostAliases = currentEnvironment
                ? ['native', 'msys', 'wsl'].includes(currentEnvironment.transport) && !currentEnvironment.repl
                : true;
            if (canLoadHostAliases) {
                // La ayuda completa vive en el alias generado para ESTA shell.
                // Ejecutarlo aquí mantiene el mismo contenido que `ayuda` y
                // evita que :help se quede en una lista fija desactualizada.
                await api.sendInput(tabId, topic ? 'ayuda ' + topic + '\r' : 'ayuda\r');
            } else {
                // Un REPL o un contenedor no puede cargar el archivo temporal
                // de alias del host. :help sigue siendo útil y no inyecta
                // `ayuda` en Python, Node, Docker o ADB como si fuera código
                // de esa shell.
                term?.writeln(`\r\n${translated('terminal.helpFallback', 'Help{topic}: use :help from a terminal or consult the internal commands.', { topic: topic ? ` (${topic})` : '' })}`);
                term?.writeln(app.t('terminal.internalCommands', 'Internal commands: :config  :reload  :repl <name>  :alias  :help [section]  :banner [options]  :quick-actions [options]'));
            }
        } else {
            term?.writeln(`\r\n${app.t('terminal.commandList', ':config  :reload  :repl <name>  :alias  :help  :banner  :quick-actions')}`);
        }
        return true;
    }

    function completeRepl(line: string): boolean {
        const match = /^\s*:repl\s+([\w-]*)$/i.exec(line);
        if (!match) return false;
        const partial = foldLocalized(match[1], app.catalog.language);
        const names = [...new Set(app.environments
            .filter((env) => env.repl && env.available)
            .map((env) => env.language ?? env.id.replace(/^.*:/, '')))]
            .filter((name) => foldLocalized(name, app.catalog.language).startsWith(partial))
            .sort((left, right) => compareLocalized(left, right, app.catalog.language));
        if (names.length === 1) {
            const suffix = names[0].slice(match[1].length);
            mirroredLine = line + suffix;
            if (suffix) void api.sendInput(tabId, suffix);
        }
        return true;
    }

    /** Último tamaño enviado al backend. Evita mandar un resize por cada píxel
     *  mientras se arrastra el borde de la ventana. */
    let lastSize = { cols: 0, rows: 0 };
    /** Número de repintado solicitado. Un ResizeObserver puede entregar varias
     *  medidas seguidas; las respuestas antiguas no deben volver a pintar un
     *  banner con las dimensiones anteriores. */
    let bannerRefreshSerial = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    // El número de paneles puede cambiar sin que cambien las columnas/filas
    // de este xterm. En ese caso también hay que repintar el banner: el modo
    // de una casilla única es distinto del modo compacto de una rejilla.
    let lastPaneCount = 0;
    let paneRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let initialPromptTimer: number | undefined;
    // El fastfetch es salida visual, pero la línea que el usuario está
    // editando pertenece al PTY. Nunca se debe repintar el banner mientras esa
    // línea está viva: si el banner crece al estrechar la ventana, podría
    // ocupar justamente las filas donde xterm ha envuelto el texto escrito.
    let userEditing = false;
    let pendingBannerSettingsRefresh = false;
    let pendingPaneCountRefresh = false;
    // El backend puede emitir el prompt y un repintado sintético en eventos
    // consecutivos. Esperar a que App.svelte vacíe la cola de `term.write`
    // garantiza que `cursorY` pertenece al prompt real, nunca a una fila del
    // banner que todavía estaba entrando en xterm.
    let terminalOutputBusy = false;
    let pendingBannerRefresh = false;
    let promptRepairTimer: number | undefined;
    // `refresh_banner` emite salida visual, que a su vez provoca los eventos
    // busy/idle del terminal. Mientras el IPC sigue en vuelo no se debe
    // encadenar otro repintado desde ese idle: hacerlo crea un bucle de
    // cabeceras sintÃ©ticas y termina mezclÃ¡ndolas con el prompt.
    let bannerRefreshInFlight = false;
    // En una pestaña única la shell ya posee el banner y xterm lo refluje de
    // forma nativa al cambiar de ancho. Volver a inyectarlo en cada resize
    // desincroniza el cursor de ConPTY; las rejillas sí usan el repintado
    // controlado porque cada casilla cambia de modo.
    let hasCompletedBannerPaint = false;
    let lastBannerRefreshRequest = { cols: 0, rows: 0, panes: 0, at: 0 };

    function eventBelongsToPane(event: Event): boolean {
        return (event as CustomEvent<{ tabId?: string }>).detail?.tabId === tabId;
    }

    function onTerminalOutputBusy(event: Event): void {
        if (eventBelongsToPane(event)) terminalOutputBusy = true;
    }

    function schedulePromptRepair(attempt = 0): void {
        if (promptRepairTimer !== undefined || destroyed || userEditing || terminalOutputBusy
            || terminalPromptVisible()) return;
        promptRepairTimer = window.setTimeout(() => {
            promptRepairTimer = undefined;
            if (destroyed || userEditing || terminalOutputBusy || terminalPromptVisible()) return;
            const activeBuffer = term?.buffer.active;
            const cursorViewportRow = activeBuffer?.cursorY ?? 0;
            const bannerRows = bannerOverlay
                ? Math.max(0, bannerOverlay.split('\n').length - 1)
                : 0;
            const cursorLine = activeBuffer?.getLine((activeBuffer.baseY ?? 0) + cursorViewportRow)
                ?.translateToString(true).trim() ?? '';
            // Solo reparar si la fila activa conserva una forma de prompt. Si
            // la shell estÃ¡ ejecutando un comando, no hay que inyectar Enter
            // aunque todavÃ­a no haya vuelto a pintar su prompt.
            const looksLikePrompt = /(?:[A-Za-z]:\\.+[>â¯$#]|[^\s@]+@[^\s:]+:.+[â¯$#]|(?:~|\/).*[â¯$#])\s*$/u.test(cursorLine);
            if (bannerRows > 0 && (looksLikePrompt || cursorLine === '')) {
                void api.sendInput(tabId, '\r');
            }
            // ConPTY puede redibujar una fila tarde tras el resize. Repetir la
            // observaciÃ³n unos pocos frames corrige ese desplazamiento sin
            // convertir una orden en Enter: cada intento exige un prompt real.
            if (attempt < 6 && (!terminalPromptVisible() || promptCursorBehindBanner())) {
                schedulePromptRepair(attempt + 1);
            }
        }, 180 + attempt * 40);
    }

    function onTerminalOutputIdle(event: Event): void {
        if (!eventBelongsToPane(event)) return;
        terminalOutputBusy = false;
        // Un espejo vacío solo indica que no estamos escribiendo; no demuestra
        // que exista un prompt (puede haber una orden ejecutándose o el cursor
        // estar sobre el banner). Consultar siempre el buffer real evita que
        // el E2E dé por bueno un panel cuyo prompt no se ve.
        const promptVisible = terminalPromptVisible();
        if (!promptVisible && pendingBannerRefresh) schedulePromptRepair();
        if (!pendingBannerRefresh || userEditing || bannerRefreshInFlight) return;
        pendingBannerRefresh = false;
        requestAnimationFrame(refreshBannerNow);
    }

    /** Diagnóstico estructural para E2E. No guarda texto ni códigos de teclas:
     *  solo si el espejo conoce la línea, su longitud y la clase del evento. */
    function exposeInputMirror(eventClass: string): void {
        if (!host) return;
        host.dataset.inputMirrorState = mirroredLine === null ? 'unknown' : 'known';
        host.dataset.inputMirrorLength = mirroredLine === null ? '0' : String(mirroredLine.length);
        host.dataset.inputEventClass = eventClass;
    }

    function controlEventClass(data: string): string {
        if (/^\x1b\[<[0-9;]+[Mm]$/.test(data)) return 'csi-mouse';
        const csi = /^\x1b\[[0-9;?]*([A-Za-z~])$/.exec(data);
        if (csi) return `csi-${csi[1]}`;
        if (/^\x1bO.$/.test(data)) return 'ss3';
        if (/^[\x00-\x1f\x7f]+$/.test(data)) return 'control-bytes';
        return 'non-ascii';
    }

    function bannerOverlayText(value: string): string {
        return value
            .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
            .replace(/\x1b[78]/g, '')
            .replace(/\r/g, '')
            .trim();
    }

    function terminalPromptVisible(): boolean {
        if (!term) return false;
        const buffer = term.buffer.active;
        const cursorAbsoluteRow = buffer.baseY + buffer.cursorY;
        const cursorViewportRow = buffer.cursorY;
        // No basta con encontrar cualquier prompt reciente: tras un clear/home
        // el buffer puede conservar un prompt antiguo justo debajo del banner,
        // mientras el cursor real sigue en otra fila. El overlay conoce cuántas
        // filas ocupa el fastfetch; una línea válida debe pertenecer al entorno
        // del cursor y quedar después de ese bloque.
        const bannerRows = bannerOverlay
            ? Math.max(0, bannerOverlay.split('\n').length - 1)
            : 0;
        const reservedRows = bannerRows + 2;
        if (host) {
            host.dataset.promptCursorRow = String(cursorAbsoluteRow);
            host.dataset.promptCursorViewportRow = String(buffer.cursorY);
            host.dataset.promptBaseY = String(buffer.baseY);
            host.dataset.promptViewportRows = String(term.rows);
            host.dataset.promptBannerRows = String(bannerRows);
        }
        // Una fila de xterm puede conservar texto de un frame anterior aunque
        // el cursor real siga detrÃ¡s del overlay. En ese estado no hay prompt
        // utilizable: obligamos a la ruta de reparaciÃ³n a pedir uno nuevo a la
        // shell, en vez de confiar en el DOM stale.
        if (cursorViewportRow < reservedRows) {
            if (host) host.dataset.promptVisible = 'false';
            return false;
        }
        const start = Math.max(0, cursorAbsoluteRow - 2, bannerRows);
        const end = Math.min(buffer.length - 1, cursorAbsoluteRow + 1);
        for (let row = start; row <= end; row += 1) {
            const text = buffer.getLine(row)?.translateToString(true).trimEnd() ?? '';
            if (/^(?:PS\s+)?(?:[A-Za-z]:\\.+[>❯$#]|[^\s@]+@[^\s:]+:.+[❯$#]|(?:~|\/)?.*[❯$#])\s*$/u.test(text)) {
                if (host) host.dataset.promptVisible = 'true';
                return true;
            }
        }
        // En WebView2 la ruta puede contener caracteres de control o quedarse
        // rasterizada sin texto accesible; la línea donde xterm mantiene el
        // cursor sigue siendo una evidencia fiable de prompt si no está vacía.
        const cursorLine = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true).trim() ?? '';
        // No aceptar cualquier texto de la fila del cursor: durante un
        // repintado el cursor puede quedar momentáneamente sobre una métrica
        // del banner. Solo es prompt si conserva el terminador que usa una
        // shell interactiva (`>`, `❯`, `$` o `#`).
        if (cursorAbsoluteRow >= bannerRows && cursorLine && /[>❯$#]\s*$/u.test(cursorLine)) {
            if (host) host.dataset.promptVisible = 'true';
            return true;
        }
        if (host) host.dataset.promptVisible = 'false';
        return false;
    }

    function promptCursorBehindBanner(): boolean {
        if (!term || !bannerOverlay) return false;
        const cursorViewportRow = term.buffer.active.cursorY;
        const bannerRows = Math.max(0, bannerOverlay.split('\n').length - 1);
        // En rejilla el separador y su padding inferior ocupan casi dos filas
        // adicionales aunque no formen parte del texto del banner. Un cursor
        // exactamente en `bannerRows` sigue quedando tapado; se considera
        // seguro solo después de esa reserva visual.
        const reservedRows = bannerRows + 2;
        return cursorViewportRow < reservedRows;
    }

    function refreshBannerNow(): void {
        // Una pestaña que sale de la rejilla conserva su xterm e historial,
        // pero deja de tener una superficie visible. Los temporizadores y los
        // eventos idle que quedaron de la transición pueden llegar después de
        // ocultarla; no deben seguir enviando repintados con sus dimensiones
        // antiguas (eso mantenía una casilla fantasma en 122x30 y competía con
        // el banner de los paneles visibles).
        if (destroyed || !term || !active) return;
        if (userEditing || terminalOutputBusy) {
            pendingBannerRefresh = true;
            pendingPaneCountRefresh = true;
            return;
        }
        if (bannerRefreshInFlight) {
            pendingBannerRefresh = true;
            return;
        }
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const panes = Math.max(1, app.panes.length);
        if (lastBannerRefreshRequest.cols === term.cols
            && lastBannerRefreshRequest.rows === term.rows
            && lastBannerRefreshRequest.panes === panes
            && now - lastBannerRefreshRequest.at < 250) {
            pendingBannerRefresh = true;
            window.setTimeout(() => {
                if (!bannerRefreshInFlight && pendingBannerRefresh && !userEditing && !terminalOutputBusy) {
                    refreshBannerNow();
                }
            }, 250);
            return;
        }
        // La respuesta indica si el backend pudo proteger el cursor. Si la
        // shell aún estaba redibujando, no se pierde la solicitud: el backend
        // la deja pendiente y el siguiente lote de salida volverá a intentarlo.
        pendingBannerRefresh = true;
        bannerRefreshInFlight = true;
        lastBannerRefreshRequest = { cols: term.cols, rows: term.rows, panes, at: now };
        const buffer = term.buffer.active;
        const cursorRow = buffer.cursorY;
        const cursorCol = buffer.cursorX;
        void api.refreshBanner(
            tabId,
            term.cols,
            term.rows,
            panes,
            // Solo se llama cuando no hay edición ni salida pendiente; en ese
            // punto xterm ya tiene la posición que usará la siguiente salida.
            // El backend la acota al área inferior y nunca restaura una fila
            // del banner que pudiera haber quedado de un frame anterior.
            cursorRow,
            cursorCol,
        ).then((result) => {
            if (destroyed) return;
            bannerOverlay = bannerOverlayText(result.text);
            if (result.applied) {
                const firstPaint = !hasCompletedBannerPaint;
                pendingBannerRefresh = false;
                pendingPaneCountRefresh = false;
                hasCompletedBannerPaint = true;
                // En una rejilla cada PTY puede conservar el scroll offset del
                // banner anterior. El prompt sí está en el buffer, pero queda
                // fuera de la captura (sobre todo en las casillas nuevas).
                // Llevar al final después del repintado solo afecta a la
                // transición visual; no escribe nada en la shell ni cambia
                // una línea que el usuario esté editando.
                const currentTerm = term;
                // El espejo puede quedar en `null` tras una secuencia de foco,
                // pegado o una tecla de control que no sea texto editable. En
                // ese estado no conocemos la línea, pero `userEditing` sigue
                // siendo la salvaguarda que evita tocar una orden viva; el
                // scroll de la vista sí es siempre seguro.
                if (panes > 1 && currentTerm && !userEditing
                    && (mirroredLine === '' || mirroredLine === null)) {
                    currentTerm.scrollToBottom();
                    currentTerm.refresh(0, Math.max(0, currentTerm.rows - 1));
                }
                // El repintado ANSI se entrega como salida sintética y no
                // mueve el cursor interno de ConPTY. Si durante la limpieza
                // se había borrado la fila del prompt, una línea vacía fuerza
                // a la shell a emitirlo de nuevo en la posición ya estable.
                // `userEditing` es la salvaguarda autoritativa; el espejo puede
                // quedar obsoleto tras una transiciÃ³n de foco y no debe impedir
                // recuperar un prompt que sigue oculto bajo el overlay.
                // En rejilla el prompt puede haber sido borrado por la
                // limpieza de la capa xterm y se puede solicitar de inmediato.
                const promptVisibleAfterPaint = terminalPromptVisible();
                const promptBehindBannerAfterPaint = promptCursorBehindBanner();
                if (panes > 1 && !userEditing
                    && (!promptVisibleAfterPaint || promptBehindBannerAfterPaint)) {
                    // El prompt puede haber sido borrado durante la limpieza;
                    // la rutina escalonada lo recupera cuando la fila activa
                    // vuelve a pertenecer a la shell.
                    schedulePromptRepair();
                } else if (panes === 1 && !terminalPromptVisible()
                    && (firstPaint || mirroredLine === '' || mirroredLine === null)) {
                    // Para una sola shell esperamos otro frame: ConPTY puede
                    // terminar SIGWINCH después de resolver el IPC. El Enter
                    // inmediato era el que a veces escribía la ruta sobre
                    // `PC`; esta comprobación tardía solo se ejecuta si el
                    // prompt sigue ausente.
                    schedulePromptRepair();
                }
            }
        }).catch((error) => {
            if (!destroyed) {
                // No perder un repintado por un fallo transitorio del IPC: el
                // siguiente idle/resize lo reintentará con el mismo viewport.
                pendingBannerRefresh = true;
                console.error('[TerminalPane] refresh banner settings failed', error);
            }
        }).finally(() => {
            bannerRefreshInFlight = false;
            if (!destroyed && pendingBannerRefresh && !userEditing && !terminalOutputBusy) {
                window.setTimeout(() => {
                    if (!bannerRefreshInFlight && pendingBannerRefresh && !userEditing && !terminalOutputBusy) {
                        refreshBannerNow();
                    }
                }, 80);
            }
        });
    }

    function refreshBannerForSettings(): void {
        if (!term) return;
        // El panel puede guardar mientras el usuario está escribiendo. No se
        // debe borrar su línea, pero tampoco perder el cambio: se reintenta
        // justo después de que Enter/Backspace deje libre el prompt.
        if (userEditing) {
            pendingBannerSettingsRefresh = true;
            return;
        }
        refreshBannerNow();
    }

    function flushPendingBannerSettingsRefresh(): void {
        if (userEditing || (!pendingBannerSettingsRefresh && !pendingPaneCountRefresh && !pendingBannerRefresh)) return;
        pendingBannerSettingsRefresh = false;
        pendingBannerRefresh = false;
        // Esperar un frame permite que la shell termine de pintar el prompt
        // tras Enter antes de que el banner restaure su cursor visual.
        requestAnimationFrame(refreshBannerForSettings);
    }

    function fitAndReport(): void {
        if (destroyed || !term || !fitAddon || !active) return;
        // Proteger contra accesos cuando el nodo host ya no exista.
        if (!host) {
            console.debug('[TerminalPane] fitAndReport: host is null, skipping');
            return;
        }
        // Un panel oculto mide 0: ajustarlo ahí daría un tamaño absurdo que
        // luego habría que deshacer.
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        try {
            const dims = fitAddon.proposeDimensions();
            if (dims) {
                // Verificar que el alto total ocupado por las filas no sobrepase la caja
                // usable del host para evitar que la última línea de comandos se solape con el borde.
                const core = (term as any)._core;
                const cellHeight = core?._renderService?.dimensions?.css?.cell?.height;
                if (cellHeight && cellHeight > 0) {
                    const style = window.getComputedStyle(host);
                    const paddingTop = parseFloat(style.paddingTop) || 0;
                    const paddingBottom = parseFloat(style.paddingBottom) || 0;
                    const availableHeight = host.clientHeight - paddingTop - paddingBottom;
                    if (dims.rows * cellHeight > availableHeight && dims.rows > 1) {
                        dims.rows -= 1;
                    }
                }
                term.resize(dims.cols, dims.rows);
            } else {
                fitAddon.fit();
            }
            // xterm puede conservar píxeles del canvas anterior cuando el
            // panel cambia varias veces de tamaño en una misma ráfaga. El
            // buffer lógico ya está correcto (el DOM del smoke lo confirma),
            // pero el compositor deja "fantasmas" de banners antiguos. Una
            // invalidación completa del rango visible obliga al renderer a
            // repintar también las filas vacías.
            const refreshRows = () => {
                if (destroyed || !term) return;
                // No tocar directamente los canvas: WebView2 puede ejecutar
                // este callback después de que xterm haya pintado el nuevo
                // buffer, dejando un panel aparentemente vacío aunque el DOM
                // siga conteniendo el banner. La API pública marca las filas
                // sucias y deja que el renderer coordine el atlas de texturas.
                term.refresh(0, Math.max(0, term.rows - 1));
            };
            refreshRows();
            // El addon de ajuste puede terminar el resize del canvas en el
            // frame siguiente. Repetir la invalidación después de ese frame
            // evita que el compositor conserve una capa de la geometría
            // anterior durante una ráfaga de redimensionados.
            requestAnimationFrame(refreshRows);
            // El inspector del WebView y algunos gestores de ventanas cambian
            // el viewport sin emitir un resize convencional. Exponer las
            // dimensiones efectivas ayuda a que el smoke compare el espacio
            // pintado con el que recibió el backend.
            host.dataset.terminalCols = String(term.cols);
            host.dataset.terminalRows = String(term.rows);
        } catch (err) {
            console.error('[TerminalPane] fitAndReport error', err);
            return;
        }
        const paneCount = Math.max(1, app.panes.length);
        const paneCountChanged = paneCount !== lastPaneCount;
        // Un cambio de filas/columnas también requiere sincronizar el banner
        // aunque siga habiendo una sola casilla. Si se omite esta dimensión,
        // el banner que imprimió la shell queda recortado en la parte superior
        // (por ejemplo, solo «Sesión») al encoger la ventana.
        const viewportChanged = term.cols !== lastSize.cols || term.rows !== lastSize.rows;
        if (term.cols === lastSize.cols && term.rows === lastSize.rows && !paneCountChanged) return;
        lastPaneCount = paneCount;
        lastSize = { cols: term.cols, rows: term.rows };
        const serial = ++bannerRefreshSerial;
        const editingAtResize = userEditing;
        // Un cambio de rejilla invalida el cursor del viewport anterior. El
        // primer repintado debe ignorarlo y tener un reintento explícito si la
        // shell todavía está entregando su lote de arranque.
        if (paneCountChanged) pendingPaneCountRefresh = true;
        // No resetear xterm antes del resize: la shell todavía conserva la
        // posición real de su prompt y ConPTY la repinta al recibir SIGWINCH.
        // Si se vacía solo el frontend aquí, ese prompt aparece en la fila
        // actual y el repintado del banner puede restaurarlo dentro de sus
        // secciones. `refresh_banner` limpia las filas antiguas de forma
        // coordinada y conserva el historial posterior.
        if (resizeTimer) clearTimeout(resizeTimer);
        const cols = term.cols;
        const rows = term.rows;
        const resizeStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        resizeTimer = setTimeout(() => {
            resizeTimer = undefined;
            if (destroyed) return;
            void api.resize(tabId, cols, rows).then(() => {
                if (destroyed || serial !== bannerRefreshSerial) return;
                // Dar margen suficiente a la shell para procesar el resize y
                // repintar su prompt antes de guardar/restaurar el cursor del
                // banner. En ConPTY/WebView2 el SIGWINCH puede llegar después
                // de varios frames, y 120 ms dejaba el prompt intercalado en
                // «PC» al maximizar la ventana.
                window.setTimeout(() => {
                    if (destroyed || serial !== bannerRefreshSerial) return;
                    // También se conserva el estado capturado al empezar el
                    // resize: si había texto en edición, no se repinta justo
                    // después de Enter, cuando todavía puede estar saliendo
                    // la respuesta del comando.
                    if (editingAtResize || userEditing) {
                        // Un cambio de rejilla no se puede perder solo porque
                        // el usuario estuviera editando la línea al dividir.
                        // Se vuelve a pintar al terminar esa edición, cuando
                        // el cursor ya no corre riesgo de ser sobrescrito.
                        if (paneCountChanged) pendingPaneCountRefresh = true;
                        pendingBannerRefresh = true;
                        return;
                    }
                    const refreshSinglePane = paneCount > 1
                        || paneCountChanged
                        // Tras cualquier cambio de viewport hay que llevar el
                        // banner al origen visible. La ruta de repintado de
                        // una sola terminal limpia la superficie completa
                        // antes de escribirlo, por lo que no compite con el
                        // reflujo de ConPTY ni deja solo la cola de «Sesión».
                        || viewportChanged
                        || !hasCompletedBannerPaint
                        || pendingBannerSettingsRefresh;
                    if (refreshSinglePane) refreshBannerNow();
                    if (paneCountChanged) {
                        // La shell puede tener todavía encolado el banner que
                        // escribió durante su inicialización. Un segundo
                        // repintado, cuando ese lote ya llegó a xterm, evita
                        // que reaparezca una cabecera completa sobre el modo
                        // compacto de la rejilla.
                        if (paneRefreshTimer) clearTimeout(paneRefreshTimer);
                        paneRefreshTimer = setTimeout(() => {
                            paneRefreshTimer = undefined;
                            pendingPaneCountRefresh = true;
                            pendingBannerRefresh = true;
                            if (!destroyed && serial === bannerRefreshSerial) refreshBannerNow();
                        }, 450);
                    }
                }, 400);
            }).then(() => {
                if (destroyed) return;
                const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                perf.record('terminal.resize', 'duration', {
                    durationMs: Math.round(Math.max(0, now - resizeStartedAt) * 100) / 100,
                    status: 'ok',
                    tabId,
                    details: { cols, rows },
                });
            }).catch((error) => {
                if (destroyed) return;
                pendingBannerRefresh = true;
                if (paneCountChanged) pendingPaneCountRefresh = true;
                console.error('[TerminalPane] resize failed', error);
                perf.record('terminal.resize', 'duration', {
                    durationMs: Math.round(Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - resizeStartedAt) * 100) / 100,
                    status: 'error',
                    tabId,
                    details: { cols, rows, error: String(error).slice(0, 300) },
                });
            });
        }, 60);
    }

    onMount(() => {
        destroyed = false;
        perf.startPoint(`terminal-mounted:${tabId}`);
        const mountFinished = perf.start('terminal.xterm-mount', { tabId });
        const handshakeFinished = perf.start('terminal.ready-handshake', { tabId });
        const preferences = app.preferences;
        term = new Terminal({
            cursorBlink: preferences?.terminalCursorBlink ?? true,
            ...(preferences ? cursorOptions(preferences) : { cursorStyle: 'block' as const }),
            scrollOnUserInput: true,
            scrollback: preferences?.terminalScrollback ?? 5000,
            fontFamily: preferences ? terminalFont(preferences, app.fonts) : 'monospace',
            fontSize: preferences?.terminalFontSize ?? 14,
            lineHeight: preferences?.terminalLineHeight ?? 1.1,
            letterSpacing: preferences?.terminalLetterSpacing ?? 0,
            fontWeight: preferences ? terminalFontWeight(preferences) : 400,
            scrollSensitivity: preferences?.terminalScrollSensitivity ?? 3,
            theme: preferences ? terminalTheme(preferences, app.themes) : undefined
        });
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(host);
        mountFinished('ok', { cols: term.cols, rows: term.rows });

        term.onData((data) => {
            // Si el usuario había desplazado el historial, cualquier entrada
            // nueva debe devolverle a la línea que está editando.
            term?.scrollToBottom();
            // xterm puede activar el informe de foco y emitir ESC[I / ESC[O al
            // entrar o salir de un diálogo. Esas secuencias sí deben llegar a
            // la shell, pero no son texto editado: si envenenan `mirroredLine`
            // el siguiente `:comando` cae en Fish/cmd en vez de interceptarse.
            const editingData = data
                .replaceAll('\x1b[I', '')
                .replaceAll('\x1b[O', '');
            // `onData` solo recibe teclas del usuario, no la salida de la
            // shell. Mantener este estado separado del espejo ASCII también
            // cubre nano, REPLs y entradas con teclas de control.
            if (editingData.includes('\r') || editingData.includes('\n') || editingData.includes('\u0003')) {
                userEditing = false;
                flushPendingBannerSettingsRefresh();
            } else if (editingData) {
                userEditing = true;
            }
            const mirroredData = editingData
                .replaceAll('\x1b[200~', '')
                .replaceAll('\x1b[201~', '');
            if (!mirroredData) {
                exposeInputMirror('focus');
                void api.sendInput(tabId, data);
                return;
            }
            // WebDriver y ConPTY pueden representar una sola pulsación Enter
            // como CRLF. Contarla como dos terminadores deja el espejo en
            // estado desconocido y el siguiente comando interno cae en la
            // shell. Una línea pegada con varios saltos sigue teniendo varios.
            const mirroredLineData = mirroredData.replaceAll('\r\n', '\n');
            if (mirroredLineData === '\t' && mirroredLine !== null && completeRepl(mirroredLine)) return;

            // xterm puede entregar Enter separado (tecleo normal) o junto a la
            // línea completa (pegado, IME y algunas configuraciones de Fish).
            // Solo se intercepta una línea única; un pegado multilínea sigue
            // viajando intacto a la shell.
            const terminators = [...mirroredLineData.matchAll(/[\r\n]/g)];
            const enterAt = terminators.length === 1 ? terminators[0].index : undefined;
            const beforeEnter = enterAt === undefined ? mirroredLineData : mirroredLineData.slice(0, enterAt);
            const afterEnter = enterAt === undefined ? '' : mirroredLineData.slice(enterAt + 1);
            const candidate = mirroredLine === null ? beforeEnter : mirroredLine + beforeEnter;
            if (enterAt !== undefined && !afterEnter
                && (candidate.trimStart().startsWith(':') || isDirectCreditAlias(candidate))) {
                const line = candidate;
                mirroredLine = '';
                exposeInputMirror('internal-enter');
                void runInternal(line)
                    .then((handled) => {
                        if (!handled) void api.sendInput(tabId, data);
                    })
                    .catch((error) => {
                        // Si el backend no está disponible, conservar el
                        // comportamiento normal de la shell y no perder Enter.
                        console.error('[TerminalPane] internal command failed', error);
                        void api.sendInput(tabId, data);
                    });
                return;
            }
            if (enterAt !== undefined) mirroredLine = '';
            else if (terminators.length > 1) mirroredLine = /[\r\n]$/.test(mirroredLineData) ? '' : null;
            else if (mirroredLineData === '\u007f' && mirroredLine !== null) mirroredLine = mirroredLine.slice(0, -1);
            else if (/^[\x20-\x7e]+$/.test(mirroredLineData) && mirroredLine !== null) mirroredLine += mirroredLineData;
            else mirroredLine = null;
            exposeInputMirror(
                enterAt !== undefined || terminators.length > 1
                    ? 'shell-enter'
                    : mirroredLineData === '\u007f'
                        ? 'delete'
                        : /^[\x20-\x7e]+$/.test(mirroredLineData)
                            ? 'ascii'
                            : controlEventClass(mirroredLineData),
            );
            void api.sendInput(tabId, data);
        });

        // Devolver false impide que xterm procese además la pulsación (y la
        // mande al proceso como una tecla más).
        term.attachCustomKeyEventHandler((event) => {
            if (event.type === 'keydown' && event.altKey && !event.ctrlKey && !event.metaKey) {
                const directions: Record<string, 'left' | 'right' | 'up' | 'down'> = {
                    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'
                };
                const direction = directions[event.key];
                if (direction) {
                    app.navigatePaneDirection(direction);
                    return false;
                }
            }
            if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
            const key = (event.key || '').toLowerCase();
            if (key === 'c' && term?.hasSelection()) {
                void api.writeClipboard(term.getSelection());
                return false;
            }
            if (key === 'v') {
                void pasteFromClipboard();
                return false;
            }
            if (key === 'x' && deleteEditableSelection(true)) return false;
            return true;
        });

        observer = new ResizeObserver(() => fitAndReport());
        observer.observe(host);
        window.addEventListener('resize', fitAndReport);

        registerTerminal(tabId, term);
        const fitStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        fitAndReport();
        const fitNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        perf.record('terminal.initial-fit', 'duration', {
            durationMs: Math.round(Math.max(0, fitNow - fitStartedAt) * 100) / 100,
            status: 'ok',
            tabId,
            details: { cols: term.cols, rows: term.rows },
        });
        window.addEventListener('winslim:banner-settings-changed', refreshBannerForSettings);
        window.addEventListener('winslim:terminal-output-busy', onTerminalOutputBusy);
        window.addEventListener('winslim:terminal-output-idle', onTerminalOutputIdle);

        // Algunas instalaciones de cmd tardan varios segundos en terminar
        // los alias de arranque y no emiten el primer prompt tras el marcador
        // de limpieza. Un único reintento tardío evita dejar el panel sin
        // entrada, sin participar en ningún resize posterior.
        initialPromptTimer = window.setTimeout(() => {
            initialPromptTimer = undefined;
            if (!destroyed && !terminalPromptVisible()) {
                void api.sendInput(tabId, '\r');
                window.setTimeout(() => {
                    if (!destroyed) terminalPromptVisible();
                }, 300);
            }
        }, 4500);

        // Solo ahora existe un xterm donde pintar: el backend suelta todo lo
        // que el pty escribió mientras tanto (banner + primer prompt).
        void api.markTabReady(tabId)
            .then(() => api.markFrontendReady(tabId))
            .then(() => {
                handshakeFinished('ok', { cols: term?.cols, rows: term?.rows });
                perf.measureFrom(
                    `terminal-mounted:${tabId}`,
                    'terminal.ready-for-input-after-mount',
                    { tabId },
                    `ready-for-input-after-mount:${tabId}`,
                );
                perf.timeToOnce('app-ready-for-input', 'app.ready-for-input', { tabId });
            })
            .catch((error) => {
                handshakeFinished('error', { error: String(error).slice(0, 300) });
                console.error('[TerminalPane] ready handshake failed', error);
            });
    });

    onDestroy(() => {
        destroyed = true;
        observer?.disconnect();
        window.removeEventListener('resize', fitAndReport);
        if (resizeTimer) clearTimeout(resizeTimer);
        if (paneRefreshTimer) clearTimeout(paneRefreshTimer);
        if (initialPromptTimer) clearTimeout(initialPromptTimer);
        if (promptRepairTimer !== undefined) window.clearTimeout(promptRepairTimer);
        window.removeEventListener('winslim:banner-settings-changed', refreshBannerForSettings);
        window.removeEventListener('winslim:terminal-output-busy', onTerminalOutputBusy);
        window.removeEventListener('winslim:terminal-output-idle', onTerminalOutputIdle);
        unregisterTerminal(tabId);
        term?.dispose();
    });

    async function pasteFromClipboard(): Promise<void> {
        const text = await api.readClipboard();
        if (text) void api.sendInput(tabId, text);
    }

    /** Convierte una selección xterm en teclas de edición para el proceso hijo.
     *
     * xterm selecciona por pantalla, mientras que la shell o nano mantienen
     * su propio cursor. Solo actuamos cuando uno de los extremos de la
     * selección coincide con ese cursor; así una selección de historial nunca
     * se convierte accidentalmente en cientos de retrocesos. Se admiten varias
     * filas y ambos sentidos de selección cuando el programa se encuentra en
     * el extremo seleccionado.
     */
    function editableSelection(): { text: string; input: string } | null {
        if (!term?.hasSelection()) return null;
        const text = term.getSelection();
        const range = term.getSelectionPosition();
        // Una selección puede contener solo celdas vacías y xterm puede
        // devolverla como una cadena vacía. El rango sigue siendo válido y la
        // tecla de borrado debe poder actuar sobre él igualmente.
        if (!range) return null;
        const buffer = term.buffer.active;
        const cursorX = buffer.cursorX;
        const cursorY = buffer.baseY + buffer.cursorY;
        const normalizeX = (x: number) => (x === cursorX + 1 ? cursorX : x);
        const endX = normalizeX(range.end.x);
        const startX = normalizeX(range.start.x);
        const atEnd = range.end.y === cursorY && endX === cursorX;
        const atStart = range.start.y === cursorY && startX === cursorX;
        if (!atEnd && !atStart) return null;

        const start = { x: range.start.x, y: range.start.y };
        const end = { x: endX, y: range.end.y };
        const distance = Math.max(
            1,
            (end.y - start.y) * Math.max(1, term.cols) + end.x - start.x,
        );
        if (distance > 4096) return null;

        if (atEnd) {
            // Llevar el cursor al comienzo y retroceder borra también saltos
            // de línea en editores interactivos que los aceptan.
            return {
                text,
                input: '\u001b[D'.repeat(distance) + '\u007f'.repeat(distance),
            };
        }
        // Si el cursor está al principio, usar Delete en vez de Backspace.
        return { text, input: '\u001b[3~'.repeat(distance) };
    }

    /** Borra la selección de la línea que se está editando mandando tantos
     *  DEL (0x7f) como caracteres tenga: es lo que xterm envía por Backspace a
     *  una shell interactiva. Devuelve si había algo que borrar. */
    function deleteEditableSelection(copyFirst: boolean): boolean {
        const editable = editableSelection();
        if (!editable) return false;
        // Capturamos el texto y las teclas antes de tocar el portapapeles. El
        // plugin de clipboard puede cambiar temporalmente el foco/selección
        // de xterm; si se inicia primero esa operación, «Cortar» puede acabar
        // copiando correctamente pero no llegar a enviar el borrado al PTY.
        term?.clearSelection();
        void api.sendInput(tabId, editable.input);
        // El texto ya está guardado en `editable`, por lo que copiarlo después
        // de enviar el borrado no pierde la selección ni retrasa la edición.
        if (copyFirst) void api.writeClipboard(editable.text);
        return true;
    }

    /** Menú contextual estilo consola de Windows.
     *
     *  Se intercepta en fase de CAPTURA: xterm escucha `contextmenu` en su
     *  propio nodo y mueve ahí su textarea invisible para su pegado nativo.
     *  Dejando que llegue, el menú propio y el suyo se pisan. */
    let menu = $state<{ x: number; y: number } | null>(null);
    const menuState = $derived.by(() => {
        // Se recalcula al abrir: qué se puede hacer depende de la selección
        // que hubiera en ese momento.
        menu;
        return { hasSelection: term?.hasSelection() === true, editable: editableSelection() !== null };
    });

    function onContextMenu(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        // El menú mide ~150x104: se aparta de los bordes para no salirse.
        menu = {
            x: Math.min(event.clientX, window.innerWidth - 156),
            y: Math.min(event.clientY, window.innerHeight - 110)
        };
        perf.mark('ui.context-menu.open', { tabId, x: event.clientX, y: event.clientY });
    }

    function runMenu(action: 'copy' | 'cut' | 'delete' | 'paste'): void {
        perf.mark('ui.context-menu.action', { tabId, action });
        menu = null;
        if (action === 'copy' && term?.hasSelection()) void api.writeClipboard(term.getSelection());
        else if (action === 'cut') deleteEditableSelection(true);
        else if (action === 'delete') deleteEditableSelection(false);
        else if (action === 'paste') void pasteFromClipboard();
        term?.focus();
    }

    /** "Copiar al seleccionar": se copia al SOLTAR el ratón, no en cada evento
     *  de selección. Mientras se arrastra, xterm emite uno por celda, y copiar
     *  en todos deja el portapapeles con fragmentos. A diferencia de
     *  Ctrl+Shift+C, la selección no se limpia: sigue marcada para que se vea
     *  qué se copió. */
    function handleMouseUp(): void {
        console.debug('[TerminalPane] handleMouseUp', { tabId, hasSelection: term?.hasSelection() });
        if (!app.preferences?.copyOnSelect || !term?.hasSelection()) return;
        const selection = term.getSelection();
        if (selection) void api.writeClipboard(selection);
    }

    /** Con la vista dividida hay varias terminales a la vista y solo una recibe
     *  lo que se teclea. La activa manda además en el selector de entorno y en
     *  los paneles: sin esto se escribía en una casilla y «Ejecutar script» iba
     *  a parar a otra. */
    function tomarElFoco(): void {
        console.debug('[TerminalPane] tomarElFoco', { tabId, appActive: app.activeTabId });
        if (app.activeTabId !== tabId) void app.activateTab(tabId);
    }

    // Cuando esta casilla pasa a ser la activa, le damos el foco a su xterm.
    $effect(() => {
        if (active && app.activeTabId === tabId) {
            term?.focus();
        }
    });

    // Al volver a estar visible o cambiar el número de paneles hay que remedir.
    $effect(() => {
        if (!active) return;
        const esLaActiva = app.activeTabId === tabId;
        // Se observa el número de paneles para volver a medir al dividir/unir ventanas
        app.panes.length;
        requestAnimationFrame(() => {
            fitAndReport();
            if (esLaActiva) term?.focus();
        });
        const timer = setTimeout(() => {
            fitAndReport();
        }, 80);
        return () => clearTimeout(timer);
    });

    // Las preferencias visuales se aplican en caliente, sin recrear el xterm.
    $effect(() => {
        const preferences = app.preferences;
        if (!term || !preferences) return;
        const cursor = cursorOptions(preferences);
        term.options.cursorBlink = preferences.terminalCursorBlink;
        term.options.cursorStyle = cursor.cursorStyle;
        term.options.cursorWidth = cursor.cursorWidth;
        term.options.scrollback = preferences.terminalScrollback;
        term.options.fontFamily = terminalFont(preferences, app.fonts);
        term.options.fontSize = preferences.terminalFontSize;
        term.options.lineHeight = preferences.terminalLineHeight;
        term.options.letterSpacing = preferences.terminalLetterSpacing;
        term.options.fontWeight = terminalFontWeight(preferences);
        term.options.scrollSensitivity = preferences.terminalScrollSensitivity;
        term.options.theme = terminalTheme(preferences, app.themes);
        fitAndReport();
    });
    // Interceptamos eventos en fase de captura directamente en el nodo host:
    // xterm.js consume los eventos de ratón en su propio canvas con stopPropagation,
    // por lo que los manejadores de burbujeo normales nunca llegaban a ejecutarse.
    $effect(() => {
        if (!host) return;
        const activate = () => tomarElFoco();
        host.addEventListener('pointerdown', activate, { capture: true });
        host.addEventListener('mousedown', activate, { capture: true });
        host.addEventListener('focusin', activate, { capture: true });
        host.addEventListener('contextmenu', onContextMenu, { capture: true });
        return () => {
            host.removeEventListener('pointerdown', activate, { capture: true });
            host.removeEventListener('mousedown', activate, { capture: true });
            host.removeEventListener('focusin', activate, { capture: true });
            host.removeEventListener('contextmenu', onContextMenu, { capture: true });
        };
    });
</script>

<div
    class="tab-pane"
    class:hidden={!active}
    class:multiventana={app.panes.length > 1}
    bind:this={host}
    onmouseup={handleMouseUp}
    role="presentation"
>
    {#if active && bannerOverlay}
        <pre class="banner-overlay" data-testid="banner-overlay">{bannerOverlay}</pre>
    {/if}
</div>

{#if menu}
    <!-- Cualquier clic fuera lo cierra, incluido el que elige una opción: el
         botón se atiende antes por estar encima. -->
    <div class="menu-backdrop" onmousedown={() => (menu = null)} role="presentation"></div>
    <div class="menu" style="left: {menu.x}px; top: {menu.y}px" role="menu">
        <button
            type="button"
            role="menuitem"
            disabled={!menuState.hasSelection}
            onclick={() => runMenu('copy')}
        >
            {app.t('menu.copy', 'Copiar')}
        </button>
        <button
            type="button"
            role="menuitem"
            disabled={!menuState.editable}
            onclick={() => runMenu('cut')}
        >
            {app.t('menu.cutInput', 'Cortar entrada')}
        </button>
        <button
            type="button"
            role="menuitem"
            disabled={!menuState.editable}
            onclick={() => runMenu('delete')}
        >
            {app.t('menu.deleteInput', 'Borrar entrada')}
        </button>
        <button type="button" role="menuitem" onclick={() => runMenu('paste')}>
            {app.t('menu.paste', 'Pegar')}
        </button>
    </div>
{/if}

<style>
    .tab-pane {
        position: absolute;
        inset: 0;
        padding: var(--terminal-padding);
        background: var(--terminal-bg);
        overflow: hidden;
    }

    .tab-pane.multiventana {
        padding: 6px 8px;
    }

    .banner-overlay {
        position: absolute;
        /* Por encima del canvas de xterm, pero por debajo de los menús
           contextuales globales (z-index 60/61). Con 100 el fondo opaco del
           banner podía tapar un menú abierto sobre la parte superior de la
           terminal, aunque el menú siguiera siendo interactuable. */
        z-index: 10;
        top: var(--terminal-padding);
        right: var(--terminal-padding);
        left: var(--terminal-padding);
        /* El prompt pertenece a xterm y se mantiene en la zona inferior.
           Reservar dos filas completas evita que, cuando el banner compacto
           se parte por ancho, el prompt quede pegado o parezca escrito dentro
           de la última métrica (el residuo que aparecía al redimensionar). */
        max-height: calc(100% - 3.5em);
        margin: 0;
        overflow: hidden;
        background: var(--terminal-bg);
        color: var(--text);
        font: inherit;
        line-height: inherit;
        /* El backend ya recorta cada línea al número real de columnas. Si
           aquí permitimos `pre-wrap`, el navegador vuelve a partir CPU/RAM y
           desplaza el final sobre la fila del prompt en paneles estrechos. */
        white-space: pre;
        overflow-wrap: normal;
        pointer-events: none;
    }

    .tab-pane.multiventana .banner-overlay {
        top: 6px;
        right: 8px;
        left: 8px;
        max-height: calc(100% - 3.5em);
        border-bottom: 1px dashed var(--muted);
        padding-bottom: 0.5em;
        box-sizing: border-box;
    }

    .menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 60;
    }

    .menu {
        position: fixed;
        z-index: 61;
        display: flex;
        min-width: 150px;
        flex-direction: column;
        padding: 4px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    .menu button {
        padding: 5px 10px;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
    }

    .menu button:hover:not(:disabled) {
        background: var(--surface-hover);
    }

    .menu button:disabled {
        color: var(--muted);
        cursor: default;
    }

    .tab-pane.hidden {
        /* `visibility` en vez de `display: none`: xterm necesita que su nodo
           siga teniendo caja para poder medirse cuando vuelva a mostrarse. */
        visibility: hidden;
        pointer-events: none;
    }
</style>
