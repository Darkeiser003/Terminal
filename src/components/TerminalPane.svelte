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
    let terminalHost: HTMLDivElement;
    let term: Terminal | undefined;
    let fitAddon: FitAddon | undefined;
    let observer: ResizeObserver | undefined;
    let mirroredLine: string | null = '';
    // La shell puede aceptar teclas antes de que el banner inicial haya
    // terminado de llegar al xterm (sobre todo en pestañas creadas en segundo
    // plano). Retenerlas brevemente conserva la entrada del usuario y evita
    // que el eco se escriba dentro de una línea del banner.
    let inputReady = false;
    let queuedInput = '';
    let inputReleaseTimer: number | undefined;
    // Las promesas de resize/impresión pueden resolver después de desmontar
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
                for (const id of ['host', 'kernel', 'environment', 'motherboard', 'gpu', 'storage', 'datetime']) current.add(id);
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
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let initialPromptTimer: number | undefined;
    let tinyViewportCleared = false;
    // Cuando el frontend tiene que reescribir el prompt en una casilla
    // estrecha, xterm puede conservar ese wrap aunque después sobren
    // columnas. Guardar la línea lógica permite recomponerla al recuperar
    // espacio, en vez de dejar `C:\\Users\\Admini` + `strador>` para siempre.
    let tinyViewportPrompt = '';
    let userEditing = false;
    // Esperar a que App.svelte vacíe la cola de `term.write` evita recalcular
    // el banner mientras la shell todavía está entregando un bloque de
    // salida; xterm conserva así un orden visual estable.
    let terminalOutputBusy = false;
    // Una redimensión de xterm mientras procesa un bloque de salida puede
    // dejar filas rasterizadas con columnas antiguas (el síntoma visual es
    // texto de un comando mezclado con GPU/CPU). Se difiere hasta que la cola
    // de escritura confirma que el terminal quedó inactivo.
    let fitAfterOutput = false;
    let fitQuietTimer: number | undefined;
    let lastOutputFinishedAt = 0;
    let bannerActivationTimer: number | undefined;
    let inputReadyTimer: number | undefined;
    let pendingBannerPrint = false;
    // Mientras una solicitud sigue en vuelo no se encadena otra
    // desde el evento idle; así se evita trabajo duplicado durante un resize.
    let bannerRefreshInFlight = false;

    function eventBelongsToPane(event: Event): boolean {
        return (event as CustomEvent<{ tabId?: string }>).detail?.tabId === tabId;
    }

    function onTerminalOutputBusy(event: Event): void {
        if (!eventBelongsToPane(event)) return;
        terminalOutputBusy = true;
        // El banner inicial puede llegar en varios bloques desde ConPTY. Si
        // entra otro bloque antes del margen de 700 ms, el temporizador que
        // libera la entrada deja de ser válido: cancelarlo evita que el eco
        // del primer comando se inserte entre dos líneas del banner.
        if (inputReleaseTimer) {
            window.clearTimeout(inputReleaseTimer);
            inputReleaseTimer = undefined;
        }
    }

    function onTerminalOutputIdle(event: Event): void {
        if (!eventBelongsToPane(event)) return;
        terminalOutputBusy = false;
        lastOutputFinishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!inputReady && terminalStartupReady() && !inputReleaseTimer) {
            // El callback de `term.write` confirma el parseo, pero el canvas
            // puede necesitar otro frame para rasterizar las últimas líneas.
            // Esperar 700 ms antes de soltar la entrada evita que el primer
            // comando se pinte encima del banner en pestañas nuevas.
            inputReleaseTimer = window.setTimeout(() => {
                inputReleaseTimer = undefined;
                if (destroyed || inputReady) return;
                inputReady = true;
                if (inputReadyTimer) window.clearTimeout(inputReadyTimer);
                inputReadyTimer = undefined;
                if (queuedInput) {
                    const pending = queuedInput;
                    queuedInput = '';
                    void api.sendInput(tabId, pending);
                }
            }, 700);
        }
        if (fitAfterOutput) {
            fitAfterOutput = false;
            // Dejar un pequeño margen permite que el renderer de xterm vacíe
            // su frame pendiente antes de recalcular el ancho de las líneas.
            if (fitQuietTimer) window.clearTimeout(fitQuietTimer);
            fitQuietTimer = window.setTimeout(() => {
                fitQuietTimer = undefined;
                requestAnimationFrame(() => fitAndReport());
            }, 250);
        }
        if (!pendingBannerPrint || userEditing || bannerRefreshInFlight) return;
        pendingBannerPrint = false;
        requestAnimationFrame(() => requestBannerPrint());
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

    function requestBannerPrint(event?: Event): void {
        if (event && (event as CustomEvent<{ bannerChanged?: boolean }>).detail?.bannerChanged !== true) return;
        // Las casillas ocultas conservan su scrollback y no deben acumular una
        // impresión pendiente para el momento en que vuelvan a la rejilla:
        // ese momento puede coincidir con un comando todavía en curso y
        // mezclar su eco con el banner. El siguiente `sysinfo` explícito o un
        // cambio de preferencia con la casilla activa actualizará su salida.
        if (!active) return;
        if (destroyed || !term || userEditing || terminalOutputBusy || bannerRefreshInFlight) {
            pendingBannerPrint = true;
            return;
        }
        pendingBannerPrint = false;
        bannerRefreshInFlight = true;
        void api.printBanner(tabId).then((applied) => {
            if (applied) {
                perf.timeToOnce(`fastfetch-visible:${tabId}`, 'fastfetch.banner-visible', { tabId, source: 'pty-output' });
            }
        }).catch((error) => {
            pendingBannerPrint = true;
            console.error('[TerminalPane] impresión de banner fallida', error);
        }).finally(() => {
            bannerRefreshInFlight = false;
            if (pendingBannerPrint && !userEditing && !terminalOutputBusy) window.setTimeout(() => requestBannerPrint(), 80);
        });
    }

    function terminalPromptVisible(): boolean {
        if (!term) return false;
        const buffer = term.buffer.active;
        const cursorAbsoluteRow = buffer.baseY + buffer.cursorY;
        if (host) {
            host.dataset.promptCursorRow = String(cursorAbsoluteRow);
            host.dataset.promptCursorViewportRow = String(buffer.cursorY);
            host.dataset.promptBaseY = String(buffer.baseY);
            host.dataset.promptViewportRows = String(term.rows);
        }
        const start = Math.max(0, cursorAbsoluteRow - 2);
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
        if (cursorLine && /[>❯$#]\s*$/u.test(cursorLine)) {
            if (host) host.dataset.promptVisible = 'true';
            return true;
        }
        if (host) host.dataset.promptVisible = 'false';
        return false;
    }

    function terminalStartupReady(): boolean {
        if (!term) return false;
        // En una casilla demasiado baja el banner se omite por diseño: basta
        // con que xterm tenga una línea utilizable para liberar la entrada.
        if (term.rows < 12) return terminalPromptVisible();
        const buffer = term.buffer.active;
        const start = Math.max(0, buffer.length - Math.max(term.rows + 20, 64));
        let text = '';
        for (let row = start; row < buffer.length; row += 1) {
            text += `${buffer.getLine(row)?.translateToString(true) ?? ''}\n`;
        }
        const titleIndex = Math.max(
            text.lastIndexOf('WinSlim Terminal'),
            text.lastIndexOf('LTerminal'),
        );
        const latestBanner = titleIndex >= 0 ? text.slice(titleIndex) : text;
        const separatorCount = (latestBanner.match(/-{20,}/g) ?? []).length;
        // El perfil completo tiene separador de apertura y cierre. El perfil
        // esencial no dibuja marcos, pero siempre conserva CPU/Memoria/Uptime;
        // exigir sus dos filas evita liberar la entrada al ver solo la cabecera
        // mientras el resto del bloque aún llega desde la PTY.
        const fullBannerComplete = separatorCount >= 2;
        const compactBannerComplete = separatorCount === 0
            && /(?:Uptime|Tiempo activo)/i.test(latestBanner)
            && /(?:Memory|Memoria)/i.test(latestBanner);
        return terminalPromptVisible()
            && /(?:WinSlim Terminal|LTerminal)\s+\d/i.test(latestBanner)
            && (fullBannerComplete || compactBannerComplete);
    }

    function flushPendingBannerSettingsRefresh(): void {
        if (userEditing || !pendingBannerPrint) return;
        pendingBannerPrint = false;
        // Esperar un frame deja que xterm termine el eco de Enter antes de
        // recalcular la altura de su región.
        requestAnimationFrame(() => requestBannerPrint());
    }

    function fitAndReport(): void {
        if (destroyed || !term || !fitAddon || !active) return;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (terminalOutputBusy || now - lastOutputFinishedAt < 250) {
            fitAfterOutput = true;
            if (!terminalOutputBusy && !fitQuietTimer) {
                fitQuietTimer = window.setTimeout(() => {
                    fitQuietTimer = undefined;
                    requestAnimationFrame(() => fitAndReport());
                    }, Math.max(1, 250 - (now - lastOutputFinishedAt)));
            }
            return;
        }
        // La caja medible es exclusivamente la región inferior de xterm.
        if (!host || !terminalHost) {
            console.debug('[TerminalPane] fitAndReport: layout host is null, skipping');
            return;
        }
        // Un panel oculto mide 0: ajustarlo ahí daría un tamaño absurdo que
        // luego habría que deshacer.
        if (terminalHost.clientWidth === 0 || terminalHost.clientHeight === 0) return;
        try {
            const dims = fitAddon.proposeDimensions();
            if (dims) {
                // `CSI 2J` solo se procesa en xterm: el PTY no sabe que su
                // prompt ha desaparecido del canvas. Guardarlo antes del
                // resize permite restaurar la misma línea tras limpiar una
                // casilla baja y mantiene sincronizados el cursor visual y
                // el cursor real de la shell.
                const bufferBeforeResize = term.buffer.active;
                const cursorRowBeforeResize = bufferBeforeResize.baseY + bufferBeforeResize.cursorY;
                let promptBeforeResize = '';
                for (let row = Math.max(0, cursorRowBeforeResize - 2); row <= cursorRowBeforeResize; row += 1) {
                    const line = bufferBeforeResize.getLine(row)?.translateToString(true).trimEnd() ?? '';
                    if (/^(?:PS\s+)?(?:[A-Za-z]:\\.+[>❯$#]|[^\s@]+@[^\s:]+:.+[❯$#]|(?:~|\/).*[>❯$#])\s*$/u.test(line)) {
                        promptBeforeResize = line;
                    }
                }
                // Verificar que el alto total ocupado por las filas no sobrepase la caja
                // usable del host para evitar que la última línea de comandos se solape con el borde.
                const core = (term as any)._core;
                const cellHeight = core?._renderService?.dimensions?.css?.cell?.height;
                if (cellHeight && cellHeight > 0) {
                    const style = window.getComputedStyle(terminalHost);
                    const paddingTop = parseFloat(style.paddingTop) || 0;
                    const paddingBottom = parseFloat(style.paddingBottom) || 0;
                    const availableHeight = terminalHost.clientHeight - paddingTop - paddingBottom;
                    if (dims.rows * cellHeight > availableHeight && dims.rows > 1) {
                        dims.rows -= 1;
                    }
                }
                term.resize(dims.cols, dims.rows);
                // Cuando una ventana ya mostraba un banner largo y se reduce
                // por debajo del mínimo útil, sus últimas líneas seguirían
                // visibles en la pantalla aunque el backend deje de generar
                // banner. Limpiar solo el viewport (no el scrollback) elimina
                // ese residuo sin borrar el historial del usuario. Mientras
                // se edita no tocamos la pantalla: el siguiente resize o la
                // salida de la shell hará la limpieza cuando sea segura.
                const tinyViewportChanged = term.cols !== lastSize.cols || term.rows !== lastSize.rows;
                if (term.rows < 12
                    && !userEditing
                    && (promptBeforeResize || tinyViewportPrompt)
                    && (!tinyViewportCleared || tinyViewportChanged)) {
                    if (promptBeforeResize) tinyViewportPrompt = promptBeforeResize;
                    term.write(`\x1b[2J\x1b[H${tinyViewportPrompt}`);
                    tinyViewportCleared = true;
                } else if (term.rows >= 12) {
                    tinyViewportCleared = false;
                    // Si una geometría anterior obligó a reescribir el prompt,
                    // hacerlo una vez más con el ancho actual elimina el wrap
                    // residual. En cuanto cabe completo ya no hace falta
                    // conservar la copia.
                    if (!userEditing && tinyViewportPrompt) {
                        if (promptBeforeResize) tinyViewportPrompt = promptBeforeResize;
                        const restoredPrompt = tinyViewportPrompt;
                        term.write(`\x1b[2J\x1b[H${restoredPrompt}`);
                        if (restoredPrompt.length <= term.cols) tinyViewportPrompt = '';
                    }
                    // Una reducción fuerte de columnas también puede dejar
                    // el prompt recortado aunque sobren filas. Reescribirlo
                    // fuerza a xterm a envolver la ruta con las dimensiones
                    // nuevas; el scrollback continúa intacto.
                    else if (!userEditing
                        && promptBeforeResize
                        && term.cols < lastSize.cols
                        && promptBeforeResize.length >= term.cols) {
                        tinyViewportPrompt = promptBeforeResize;
                        term.write(`\x1b[2J\x1b[H${promptBeforeResize}`);
                    }
                }
            } else {
                fitAddon.fit();
            }
            // Invalidar el rango visible tras cambiar la caja de xterm evita
            // residuos del canvas anterior en WebView2.
            const refreshRows = () => {
                if (destroyed || !term) return;
                term.refresh(0, Math.max(0, term.rows - 1));
            };
            refreshRows();
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
        if (term.cols === lastSize.cols && term.rows === lastSize.rows) return;
        lastSize = { cols: term.cols, rows: term.rows };
        if (resizeTimer) clearTimeout(resizeTimer);
        const cols = term.cols;
        const rows = term.rows;
        const resizeStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        resizeTimer = setTimeout(() => {
            resizeTimer = undefined;
            if (destroyed) return;
            void api.resize(tabId, cols, rows).then(() => {
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
                console.error('[TerminalPane] resize failed', error);
                perf.record('terminal.resize', 'duration', {
                    durationMs: Math.round(Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - resizeStartedAt) * 100) / 100,
                    status: 'error',
                    tabId,
                    details: { cols, rows, error: String(error).slice(0, 300) },
                });
            });
        }, 250);
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
        term.open(terminalHost);
        mountFinished('ok', { cols: term.cols, rows: term.rows });

        term.onData((data) => {
            if (!inputReady) {
                queuedInput += data;
                exposeInputMirror('startup-queued');
                return;
            }
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
        observer.observe(terminalHost);
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

        // Solo ahora existe un xterm donde pintar: el backend suelta la salida
        // que el PTY escribió mientras se montaba la interfaz.
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
                // Algunas shells no dejan un prompt reconocible (REPL,
                // dispositivos o contenedores). Liberar la cola en un límite
                // acotado evita bloquearlas indefinidamente; las shells host
                // normales se liberan antes por `terminal-output-idle`.
                inputReadyTimer = window.setTimeout(() => {
                    inputReadyTimer = undefined;
                    if (!destroyed && !inputReady) {
                        inputReady = true;
                        if (queuedInput) {
                            const pending = queuedInput;
                            queuedInput = '';
                            void api.sendInput(tabId, pending);
                        }
                    }
                }, 8000);
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
        if (fitQuietTimer) window.clearTimeout(fitQuietTimer);
        if (bannerActivationTimer) window.clearTimeout(bannerActivationTimer);
        if (inputReadyTimer) window.clearTimeout(inputReadyTimer);
        if (inputReleaseTimer) window.clearTimeout(inputReleaseTimer);
        if (initialPromptTimer) clearTimeout(initialPromptTimer);
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
            if (pendingBannerPrint) {
                // Al activar una pestaña puede quedar salida del comando que
                // se lanzó justo antes de cambiar de vista. No inyectar el
                // banner en ese primer frame: esperar a que la shell y xterm
                // terminen ese bloque evita mezclar el eco con la cabecera.
                if (bannerActivationTimer) window.clearTimeout(bannerActivationTimer);
                bannerActivationTimer = window.setTimeout(() => {
                    bannerActivationTimer = undefined;
                    if (!destroyed && active && pendingBannerPrint) requestBannerPrint();
                }, 700);
            }
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
    <div class="terminal-host" data-testid="terminal-host" bind:this={terminalHost}></div>
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
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        background: var(--terminal-bg);
        overflow: hidden;
    }

    .terminal-host {
        position: relative;
        min-width: 0;
        min-height: 0;
        flex: 1 1 auto;
        padding: 0;
        overflow: hidden;
    }

    .tab-pane.multiventana .terminal-host {
        padding: 0;
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
