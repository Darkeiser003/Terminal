<script lang="ts">
    // Un xterm por pestaña. El componente se monta cuando nace la pestaña y no
    // se destruye al cambiar de una a otra: el panel se oculta con CSS, pero el
    // xterm y su historial siguen vivos. Destruirlo perdería el scrollback.
    //
    // Port de `createXtermForTab` y sus alrededores en renderer.js.

    import { onMount, onDestroy, tick } from 'svelte';
    import { Terminal, type ILinkHandler } from '@xterm/xterm';
    import { FitAddon } from '@xterm/addon-fit';
    import { SearchAddon } from '@xterm/addon-search';
    import { ImageAddon } from '@xterm/addon-image';
    import { Unicode11Addon } from '@xterm/addon-unicode11';
    import { WebLinksAddon } from '@xterm/addon-web-links';
    import { alignSixelWithConpty } from '../lib/sixel-conpty';
    import { attachBannerImages, type BannerImageController } from '../lib/banner-image';
    import { columnAtTextIndex, comparePoints, contentEndColumn, inputSelectionEdit, promptInputStart, selectionSearchText, type BufferPoint, type InputSelectionEdit } from '../lib/input-selection';
    import { TERMINAL_LINK_REGEX, checkTerminalLink, isLinkActivation, linkRejectionMessageKey, type TerminalLinkScheme } from '../lib/terminal-links';

    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { compareLocalized, foldLocalized } from '../lib/localization';
    import { panels, type PanelId } from '../lib/panels.svelte';
    import * as perf from '../lib/performance';
    import { retryUntilReady } from '../lib/terminal-ready';
    import { normalizeWheelDelta } from '../lib/terminal-scroll';
    import { inputReservationColumns, isShellInputLine, longestVisibleLogicalLineWidth, occupiedTerminalColumns, requiredTerminalColumns } from '../lib/terminal-columns';
    import {
        interactiveReplBannerSignalsReady,
        interactiveReplInputLine,
        interactiveReplPromptIsVisible,
    } from '../lib/terminal-prompt';
    import { cursorInactiveStyle, cursorOptions, terminalFont, terminalFontWeight, terminalTheme, themePreferencePatch } from '../lib/theme';
    import {
        registerTerminal,
        registerTerminalControls,
        unregisterTerminal,
        unregisterTerminalControls,
        type TerminalLineRejection,
    } from '../lib/terminalRegistry';
    import { matchesShortcut } from '../lib/shortcuts';
    import type { Environment, Preferences } from '../lib/types';

    interface Props {
        tabId: string;
        active: boolean;
    }

    interface EnvironmentSwitchSnapshot {
        inputReady: boolean;
        queuedInput: string;
        mirroredLine: string | null;
        userEditing: boolean;
    }

    let { tabId, active }: Props = $props();

    let host: HTMLDivElement;
    let terminalHost: HTMLDivElement;
    let term: Terminal | undefined;
    let fitAddon: FitAddon | undefined;
    let searchAddon: SearchAddon | undefined;
    let bannerImages: BannerImageController | undefined;
    let observer: ResizeObserver | undefined;
    let rootWidthObserver: ResizeObserver | undefined;
    let rootWidthSyncFrame: number | undefined;
    let mirroredLine: string | null = '';
    // Long pastes can arrive from xterm as several onData chunks while the
    // mirror is temporarily unknown (IME/clipboard/control sequences). Keep
    // an independent logical length so the PTY is widened for the whole line
    // instead of only for the last chunk.
    let inputLogicalLength = 0;
    /** Columna en la que empieza la entrada (justo detrás del prompt). La
     *  línea que ve el usuario mide prompt + lo tecleado: compararla con el
     *  ancho visible sin el prompt habilitaba el scroll horizontal unas 20
     *  columnas tarde y el cursor se salía por la derecha. */
    let inputStartColumn = 0;
    // La línea que acaba de enviar el usuario puede quedar visible como eco
    // envuelto mientras la orden ya está produciendo salida. No debe contarse
    // como contenido horizontal: una orden larga se ajusta al viewport, pero
    // una barra larga que imprime la orden sí debe poder pedir scroll.
    let submittedCommand: string | null = null;
    // La shell puede aceptar teclas antes de que el banner inicial haya
    // terminado de llegar al xterm (sobre todo en pestañas creadas en segundo
    // plano). Retenerlas brevemente conserva la entrada del usuario y evita
    // que el eco se escriba dentro de una línea del banner.
    let inputReady = false;
    let queuedInput = '';
    let inputReleaseTimer: number | undefined;
    let environmentSwitchPending = false;
    let environmentSwitchRequestId: number | undefined;
    let startupEnvironmentId: string | undefined;
    let environmentSwitchSnapshot: EnvironmentSwitchSnapshot | undefined;
    let commandResizeUnlisten: (() => void) | undefined;
    // El cursor inactivo no debe depender de que xterm conserve el nodo que
    // anima. Un reloj estable en el host evita que el parpadeo se reinicie al
    // recrear la fila durante un reflow o al cambiar el foco.
    let cursorBlinkTimer: number | undefined;
    let cursorVisible = $state(true);

    function startCursorBlinkTimer(): void {
        if (cursorBlinkTimer !== undefined) window.clearInterval(cursorBlinkTimer);
        cursorBlinkTimer = window.setInterval(() => {
            if (destroyed || app.preferences?.terminalCursorBlink === false) {
                cursorVisible = true;
                terminalHost?.setAttribute('data-cursor-visible', 'true');
                return;
            }
            cursorVisible = !cursorVisible;
            terminalHost?.setAttribute('data-cursor-visible', cursorVisible ? 'true' : 'false');
        }, 500);
    }
    // Las promesas de resize/impresión pueden resolver después de desmontar
    // una pestaña. Marcar el ciclo de vida evita que un callback tardío vuelva
    // a escribir un banner en un xterm ya destruido o en una pestaña reciclada.
    let destroyed = false;
    let searchOpen = $state(false);
    let searchQuery = $state('');
    let searchResultIndex = $state(-1);
    let searchResultCount = $state(0);
    let searchInput = $state<HTMLInputElement | undefined>(undefined);
    let terminalSearchHandler: ((event: KeyboardEvent) => void) | undefined;

    // ---- Enlaces de la salida (Ctrl+clic) ----
    // `@xterm/addon-web-links` subraya las URL http/https/file y xterm los
    // hipervínculos OSC 8. Ninguno abre nada aquí: con Ctrl+clic se comprueba
    // el texto (`terminal-links.ts`), se pide confirmación si está activada y
    // el backend (`terminal_open_link`) lo valida de nuevo y lo abre.
    let webLinksAddon: WebLinksAddon | undefined;
    let terminalLinksEnabled: boolean | undefined;
    let linkDialog = $state<{ url: string; host: string; scheme: TerminalLinkScheme } | null>(null);
    let linkOpenButton = $state<HTMLButtonElement | undefined>(undefined);
    let linkNotice = $state<string | null>(null);
    let linkNoticeTimer: number | undefined;

    const osc8LinkHandler: ILinkHandler = {
        // Los OSC 8 de cualquier esquema llegan al manejador, que solo deja
        // pasar http, https y file y avisa de lo demás.
        allowNonHttpProtocols: true,
        activate: (event, text) => activateTerminalLink(event, text),
        hover: (_event, text) => showLinkHover(text),
        leave: () => hideLinkHover(),
    };
    // Sin manejador, xterm abriría los OSC 8 con `confirm()` y `window.open`.
    const disabledLinkHandler: ILinkHandler = { activate: () => undefined };

    function terminalLinkHandler(enabled: boolean): ILinkHandler {
        return enabled ? osc8LinkHandler : disabledLinkHandler;
    }

    /** Carga o retira la detección de URL según `terminalLinks`. */
    function syncTerminalLinks(enabled: boolean): void {
        if (!term || terminalLinksEnabled === enabled) return;
        terminalLinksEnabled = enabled;
        term.options.linkHandler = terminalLinkHandler(enabled);
        if (enabled) {
            webLinksAddon = new WebLinksAddon((event, uri) => activateTerminalLink(event, uri), {
                urlRegex: TERMINAL_LINK_REGEX,
                hover: (_event, uri) => showLinkHover(uri),
                leave: () => hideLinkHover(),
            });
            term.loadAddon(webLinksAddon);
        } else {
            webLinksAddon?.dispose();
            webLinksAddon = undefined;
            hideLinkHover();
            linkDialog = null;
        }
        host?.setAttribute('data-terminal-links', enabled ? 'true' : 'false');
    }

    function showLinkHover(uri: string): void {
        if (!terminalHost) return;
        terminalHost.dataset.linkHover = uri;
        terminalHost.title = app.t('terminal.linkHover', 'Ctrl+clic para abrir {url}').replace('{url}', uri);
    }

    function hideLinkHover(): void {
        if (!terminalHost) return;
        delete terminalHost.dataset.linkHover;
        terminalHost.removeAttribute('title');
    }

    function showLinkNotice(code: string): void {
        let text: string | null = null;
        switch (linkRejectionMessageKey(code)) {
            case 'terminal.linkBlockedScheme':
                text = app.t('terminal.linkBlockedScheme', 'WTerminal solo abre enlaces http, https y file://.');
                break;
            case 'terminal.linkBlockedFile':
                text = app.t('terminal.linkBlockedFile', 'Enlace no abierto: la ruta no existe en este equipo o es de otro equipo.');
                break;
            case 'terminal.linkOpenFailed':
                text = app.t('terminal.linkOpenFailed', 'El sistema no pudo abrir el enlace.');
                break;
            case 'terminal.linkBlockedUnsafe':
                text = app.t('terminal.linkBlockedUnsafe', 'Enlace no abierto: no es una dirección válida, lleva caracteres ocultos o una contraseña.');
                break;
            default:
                return;
        }
        linkNotice = text;
        if (linkNoticeTimer !== undefined) window.clearTimeout(linkNoticeTimer);
        linkNoticeTimer = window.setTimeout(() => {
            linkNotice = null;
            linkNoticeTimer = undefined;
        }, 5000);
    }

    /** Clic sobre un enlace detectado: solo Ctrl+clic hace algo. */
    function activateTerminalLink(event: MouseEvent, text: string): void {
        if (!isLinkActivation(event) || app.preferences?.terminalLinks === false) return;
        event.preventDefault();
        const checked = checkTerminalLink(text);
        if (!checked.ok) {
            showLinkNotice(checked.reason);
            return;
        }
        if (app.preferences?.terminalLinksConfirm !== false) {
            linkDialog = { url: checked.url, host: checked.host, scheme: checked.scheme };
            void tick().then(() => linkOpenButton?.focus());
            return;
        }
        void openTerminalLink(checked.url);
    }

    async function openTerminalLink(url: string): Promise<void> {
        try {
            const result = await api.openTerminalLink(url);
            if (!result.ok && result.error) showLinkNotice(result.error);
        } catch (error) {
            console.error('[TerminalPane] terminal_open_link', error);
            showLinkNotice('open-failed');
        }
    }

    function closeLinkDialog(open: boolean): void {
        const url = linkDialog?.url;
        linkDialog = null;
        if (open && url) void openTerminalLink(url);
        term?.focus();
    }

    function onLinkDialogKeydown(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeLinkDialog(false);
    }

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

    const searchOptions = {
        caseSensitive: false,
        incremental: true,
        decorations: {
            matchBackground: '#665c1e',
            matchBorder: '#d8c36a',
            matchOverviewRuler: '#d8c36a',
            activeMatchBackground: '#b8860b',
            activeMatchBorder: '#ffe58a',
            activeMatchColorOverviewRuler: '#ffe58a',
        },
    } as const;

    function bufferSearch(query: string): { count: number; firstLine: number } {
        if (!term || !query) return { count: 0, firstLine: -1 };
        const needle = query.toLowerCase();
        let count = 0;
        let firstLine = -1;
        for (let lineIndex = 0; lineIndex < term.buffer.active.length; lineIndex += 1) {
            const line = term.buffer.active.getLine(lineIndex)?.translateToString(true).toLowerCase() ?? '';
            let offset = 0;
            while (offset < line.length) {
                const match = line.indexOf(needle, offset);
                if (match < 0) break;
                if (firstLine < 0) firstLine = lineIndex;
                count += 1;
                offset = match + Math.max(1, needle.length);
            }
        }
        return { count, firstLine };
    }

    // WebView2 puede pintar una fila antes de que SearchAddon haya terminado
    // de indexar el buffer. La lectura DOM no sustituye al scrollback de xterm;
    // solo evita declarar «sin coincidencias» cuando la coincidencia ya está
    // visible y el índice del addon va un frame por detrás.
    function visibleRowsSearch(query: string): boolean {
        if (!terminalHost || !query) return false;
        const rendered = terminalHost.querySelector('.xterm-rows')?.textContent ?? '';
        return rendered.toLowerCase().includes(query.toLowerCase());
    }

    function scheduleVisibleRowsSearch(query: string): void {
        const apply = (): void => {
            if (destroyed || searchQuery !== query || searchResultCount > 0) return;
            if (visibleRowsSearch(query)) {
                searchResultIndex = 0;
                searchResultCount = 1;
            }
        };
        window.requestAnimationFrame(apply);
        window.setTimeout(apply, 50);
        window.setTimeout(apply, 200);
    }

    function updateSearch(query: string, backwards = false): void {
        searchQuery = query;
        if (!searchAddon || !query) {
            searchResultIndex = -1;
            searchResultCount = 0;
            searchAddon?.clearDecorations();
            return;
        }
        const found = backwards
            ? searchAddon.findPrevious(query, searchOptions)
            : searchAddon.findNext(query, searchOptions);
        if (!found) {
            const fallback = bufferSearch(query);
            if (fallback.count > 0) {
                searchResultIndex = 0;
                searchResultCount = fallback.count;
                if (fallback.firstLine >= 0) term?.scrollToLine(fallback.firstLine);
                return;
            }
            if (visibleRowsSearch(query)) {
                searchResultIndex = 0;
                searchResultCount = 1;
                return;
            }
            searchResultIndex = -1;
            searchResultCount = 0;
        } else if (searchResultCount === 0) {
            // SearchAddon publica el recuento en un evento posterior. El
            // buffer local evita que una carrera de WebView2 deje el contador
            // vacío aunque la coincidencia ya se haya encontrado.
            const fallback = bufferSearch(query);
            if (fallback.count > 0) searchResultCount = fallback.count;
            else if (visibleRowsSearch(query)) searchResultCount = 1;
        }
        scheduleVisibleRowsSearch(query);
    }

    function openSearch(): void {
        searchOpen = true;
        void tick().then(() => {
            if (!destroyed) searchInput?.focus();
            if (searchQuery) updateSearch(searchQuery);
        });
    }

    function closeSearch(): void {
        searchOpen = false;
        searchQuery = '';
        searchResultIndex = -1;
        searchResultCount = 0;
        searchAddon?.clearDecorations();
        term?.focus();
    }

    function searchNext(backwards = false): void {
        if (!searchQuery) return;
        updateSearch(searchQuery, backwards);
    }

    // Durante la apertura del overlay WebView2 puede entregar la fila pintada
    // después de todos los eventos de xterm. Vigilar solo esta ventana corta
    // evita que un callback tardío vuelva a mostrar «Sin coincidencias».
    $effect(() => {
        const query = searchQuery;
        if (!searchOpen || !query) return;
        const timer = window.setInterval(() => {
            if (searchResultCount === 0 && visibleRowsSearch(query)) {
                searchResultIndex = 0;
                searchResultCount = 1;
            }
        }, 50);
        const stop = window.setTimeout(() => window.clearInterval(timer), 500);
        return () => {
            window.clearInterval(timer);
            window.clearTimeout(stop);
        };
    });

    function onSearchKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeSearch();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            searchNext(event.shiftKey);
        }
    }

    // En los smokes Windows el frontend puede montarse antes de que ConPTY
    // termine su arranque asíncrono. Reintentar brevemente no bloquea el WebView
    // y el backend devuelve true de inmediato en el uso normal.
    async function waitForFrontendReady(): Promise<boolean> {
        return retryUntilReady(
            () => api.markFrontendReady(tabId),
            {
                intervalMs: 200,
                timeoutMs: 35_000,
                now: () => performance.now(),
                wait: (delayMs) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)),
                shouldContinue: () => !destroyed,
            },
        );
    }

    // Las salidas de los comandos internos pasan por el catálogo. El texto
    // puede contener nombres dinámicos de entornos/temas, por eso se inyecta
    // como `{text}` después de resolver el idioma activo.
    //
    // Es importante que esta cola se vacíe antes de devolver el prompt a la
    // shell. Antes cada línea se programaba con un timeout independiente de
    // 220 ms; `runInternal` terminaba, enviaba Enter y la shell dibujaba el
    // prompt mientras esas líneas seguían pendientes. El resultado era el
    // prompt intercalado con la respuesta (visible sobre todo en `:banner` y
    // en las salidas largas de `:terminal list`). Xterm ya serializa sus
    // escrituras: usamos su callback de finalización para conservar ese orden
    // y hacemos que el ejecutor espere a la última línea.
    let internalOutputQueue: Promise<void> = Promise.resolve();
    // Estas líneas solo existen en xterm: ConPTY no las conoce y su cursor se
    // queda N filas más arriba. Como ConPTY coloca el eco con `ESC[fila;colH`,
    // la siguiente orden sobrescribía el mensaje (se veía `cd /d "…"as de
    // LTools.`). Al terminar cada bloque, xterm desplaza esas N filas al
    // historial y devuelve el cursor a la fila/columna que conserva ConPTY.
    let internalWritesPending = 0;
    let internalBatchStart: { row: number; col: number } | null = null;
    function writeInternal(text: string): void {
        internalWritesPending += 1;
        internalOutputQueue = internalOutputQueue.then(() => new Promise<void>((resolve) => {
            if (destroyed || !term) {
                internalWritesPending = Math.max(0, internalWritesPending - 1);
                resolve();
                return;
            }
            internalBatchStart ??= { row: term.buffer.active.cursorY, col: term.buffer.active.cursorX };
            term.writeln(translated('terminal.dynamicOutput', '{text}', { text }), () => {
                internalWritesPending = Math.max(0, internalWritesPending - 1);
                // Las órdenes internas imprimen directamente en xterm y no
                // siempre pasan por el evento de salida de la PTY. Mantener la
                // sonda sincronizada evita que el prompt parezca ausente.
                const finish = () => requestAnimationFrame(() => {
                    if (!destroyed) {
                        terminalPromptVisible();
                        scheduleTerminalRepaint();
                    }
                    resolve();
                });
                const start = internalWritesPending === 0 ? internalBatchStart : null;
                if (start) internalBatchStart = null;
                const shift = start && term ? term.buffer.active.cursorY - start.row : 0;
                if (term && start && shift > 0) {
                    term.write(
                        `\x1b[${term.rows};1H${'\n'.repeat(shift)}\x1b[${start.row + 1};${start.col + 1}H`,
                        finish,
                    );
                    return;
                }
                finish();
            });
        })).catch(() => undefined);
    }

    async function flushInternalOutput(): Promise<void> {
        await internalOutputQueue;
        // El callback de xterm se ejecuta cuando el parser termina, pero el
        // canvas necesita un frame para reflejar las filas nuevas antes de que
        // ConPTY pinte el prompt final.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    function bannerItemLabel(id: string): string {
        const [key, fallback] = BANNER_ITEM_KEYS[id] ?? ['', id];
        return key ? app.t(key, fallback) : fallback;
    }

    async function clearPromptInput(line: string): Promise<void> {
        // `sendInput` solo confirma que el backend aceptó los DEL. En cmd y
        // PowerShell el eco de esos caracteres llega después, como salida de
        // ConPTY. Si pintamos el crédito antes de que termine esa cola, el
        // eco mueve el cursor y parte del título acaba pegada al prompt. Se
        // espera a la señal de salida inactiva de App.svelte, con un límite
        // corto para shells que no hacen eco de la edición.
        let sawBusy = terminalOutputBusy;
        let finished = false;
        let timer: number | undefined;
        let resolveIdle!: () => void;
        const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
        const cleanup = () => {
            if (finished) return;
            finished = true;
            if (timer !== undefined) window.clearTimeout(timer);
            window.removeEventListener('winslim:terminal-output-busy', onBusy);
            window.removeEventListener('winslim:terminal-output-idle', onIdle);
            resolveIdle();
        };
        const onBusy = (event: Event) => {
            if (eventBelongsToPane(event)) sawBusy = true;
        };
        const onIdle = (event: Event) => {
            if (eventBelongsToPane(event) && sawBusy) cleanup();
        };
        window.addEventListener('winslim:terminal-output-busy', onBusy);
        window.addEventListener('winslim:terminal-output-idle', onIdle);
        timer = window.setTimeout(cleanup, 650);
        await api.sendInput(tabId, '\u007f'.repeat(line.length));
        // Dejar que el evento busy de una respuesta inmediata entre en la
        // cola antes de decidir que no hubo salida que esperar.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 24));
        if (!sawBusy && !terminalOutputBusy) cleanup();
        await idle;
    }

    function isDirectCreditAlias(line: string): boolean {
        // Debe coincidir con el contrato del parser Rust: una línea completa,
        // un `@` opcional y ninguna palabra adicional. Mantener esta pequeña
        // preselección aquí evita enviar el alias a la shell antes de que el
        // IPC pueda confirmarlo.
        return /^@?darkeiser003$/i.test(line.trim())
            || (app.appInfo?.platform === 'windows' && /^@?christianlg97$/i.test(line.trim()));
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
            writeInternal(`\r\n${translated('terminal.bannerStatus', 'Banner: {state}', { state })}`);
            writeInternal(app.t('terminal.bannerUsage', 'Usage: :banner hide|show|toggle <system|host|kernel|environment|motherboard|cpu|gpu|memory|storage|uptime|datetime>'));
            writeInternal(app.t('terminal.bannerShortcuts', 'Shortcuts: :banner preset compact | :banner preset full'));
            return;
        }
        if (unknown.length || (action !== 'preset' && !ids.length)) {
            writeInternal(`\r\n${app.t('terminal.bannerUsageShort', 'Usage: :banner hide|show|toggle <items>, :banner preset compact|full or :banner list')}`);
            return;
        }

        if (action === 'preset') {
            const preset = (tokens[0] ?? '').toLowerCase();
            if (preset === 'full' || preset === 'completo') current.clear();
            else if (preset === 'compact' || preset === 'compacto') {
                current.clear();
                for (const id of ['host', 'kernel', 'environment', 'motherboard', 'gpu', 'storage', 'datetime']) current.add(id);
            } else {
                writeInternal(`\r\n${app.t('terminal.bannerProfiles', 'Available profiles: compact | full')}`);
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
            writeInternal(`\r\n${app.t('terminal.bannerActions', 'Available actions: hide, show, toggle, preset, list')}`);
            return;
        }

        await app.savePreferences({ bannerHiddenItems: [...current].join(',') });
        const state = current.size
            ? translated('terminal.hiddenCount', '{count} hidden item(s)', { count: current.size })
            : app.t('terminal.fullProfile', 'full profile');
        writeInternal(`\r\n${translated('terminal.bannerUpdated', 'Banner updated: {state}.', { state })}`);
    }

    async function configureQuickActions(argument?: string): Promise<void> {
        const tokens = (argument ?? 'list').trim().split(/\s+/).filter(Boolean);
        if (tokens.length > 1) {
            writeInternal(`\r\n${app.t('terminal.quickActionsUsage', 'Uso heredado: :quick-actions list')}`);
            return;
        }
        const action = (tokens[0] ?? 'list').toLowerCase();
        if (action !== 'list') {
            writeInternal(`\r\n${app.t('terminal.quickActionsUsage', 'Uso heredado: :quick-actions list')}`);
            return;
        }
        writeInternal(`\r\n${app.t('terminal.quickActionsStatus', 'Las acciones rápidas heredadas fueron sustituidas por las acciones fijadas de LTools.')}`);
        writeInternal(app.t('terminal.quickActionsMigration', 'Configúralas desde Biblioteca → Acciones fijadas de LTools.'));
    }

    function environmentMatches(environment: Environment, wanted: string): boolean {
        const query = foldLocalized(wanted, app.catalog.language);
        return [environment.id, environment.label, environment.shell ?? '', environment.language ?? '']
            .some((value) => foldLocalized(value, app.catalog.language) === query)
            || [environment.id, environment.label, environment.shell ?? '', environment.language ?? '']
                .some((value) => foldLocalized(value, app.catalog.language).includes(query));
    }

    function writeShellList(): void {
        const shells = app.environments.filter((environment) => !environment.repl);
        writeInternal('\r\nShells y entornos disponibles:');
        if (!shells.length) {
            writeInternal('  (todavía no hay entornos detectados; prueba :reload)');
            return;
        }
        for (const environment of shells) {
            const marker = environment.id === app.activeTab?.envId ? '*' : ' ';
            const availability = environment.available ? '' : ' [no disponible]';
            writeInternal(` ${marker} ${environment.id} — ${environment.label}${availability}`);
        }
        writeInternal('Uso: :shell <id o nombre> | :shell current | :shell list');
    }

    async function configureShell(argument?: string): Promise<void> {
        const wanted = argument?.trim() ?? '';
        if (!wanted || ['list', 'lista', 'help', 'ayuda'].includes(wanted.toLowerCase())) {
            writeShellList();
            return;
        }
        if (['current', 'actual'].includes(wanted.toLowerCase())) {
            const current = app.environments.find((environment) => environment.id === app.activeTab?.envId);
            writeInternal(`\r\nShell actual: ${current?.label ?? app.activeTab?.label ?? '(desconocida)'}`);
            return;
        }
        const environment = app.environments.find((candidate) => !candidate.repl && environmentMatches(candidate, wanted));
        if (!environment) {
            writeInternal(`\r\n[No se encontró la shell o entorno «${wanted}». Usa :shell list.]`);
            return;
        }
        if (!environment.available) {
            writeInternal(`\r\n[${environment.label} no está disponible: ${environment.note ?? 'revisa Entornos y dependencias.'}]`);
            return;
        }
        if (!app.activeTabId) return;
        const switched = await app.switchEnvironment(app.activeTabId, environment.id);
        if (!switched) writeInternal(`\r\n[No se pudo cambiar a ${environment.label}.]`);
    }

    async function configurePanel(argument?: string): Promise<void> {
        const wanted = (argument ?? 'list').trim().toLowerCase();
        const panelsByName: Record<string, PanelId> = {
            deps: 'deps', dependencies: 'deps', dependencias: 'deps',
            projects: 'projects', project: 'projects', proyectos: 'projects',
            scripts: 'scripts', library: 'scripts', biblioteca: 'scripts',
            settings: 'settings', config: 'settings', ajustes: 'settings',
        };
        if (['list', 'lista', 'help', 'ayuda'].includes(wanted)) {
            writeInternal('\r\nPaneles: settings, deps, projects, scripts, explorer.');
            writeInternal('Uso: :panel <panel> | :panel close');
            return;
        }
        if (['close', 'cerrar', 'none', 'off'].includes(wanted)) {
            panels.close();
            app.explorerVisible = false;
            writeInternal('\r\nPaneles cerrados.');
            return;
        }
        if (wanted === 'explorer' || wanted === 'explorador') {
            if (app.preferences?.showExplorerPanel === false) {
                writeInternal('\r\n[El Explorador está oculto en Ajustes. Actívalo desde Ajustes > Comportamiento.]');
                return;
            }
            panels.close();
            app.explorerVisible = true;
            return;
        }
        const panel = panelsByName[wanted];
        if (!panel) {
            writeInternal('\r\n[Panel desconocido. Usa :panel list.]');
            return;
        }
        const visible = panel === 'deps'
            ? app.preferences?.showDependenciesPanel !== false
            : panel === 'projects'
                ? app.preferences?.showProjectsPanel !== false
                : panel === 'scripts'
                    ? app.preferences?.showScriptsPanel !== false
                    : true;
        if (!visible) {
            writeInternal('\r\n[Este panel está oculto en Ajustes. Actívalo desde Ajustes > Comportamiento.]');
            return;
        }
        app.explorerVisible = false;
        panels.show(panel);
        // Los paneles se montan bajo demanda para evitar trabajo y parpadeos al
        // arrancar. La barra lateral ya conoce sus callbacks de carga, pero un
        // comando escrito en la shell necesita avisar al raíz para montar el
        // componente antes de que `panels.open` intente mostrarlo.
        window.dispatchEvent(new CustomEvent('winslim:open-panel', { detail: { panel } }));
    }

    async function configureTheme(argument?: string): Promise<void> {
        const wanted = (argument ?? 'list').trim();
        if (!wanted || ['list', 'lista'].includes(wanted.toLowerCase())) {
            writeInternal('\r\nTemas disponibles:');
            for (const theme of app.themes) writeInternal(`  ${theme.id} — ${theme.label}`);
            for (const theme of app.preferences?.customThemes ?? []) writeInternal(`  ${theme.id} — ${theme.label}`);
            writeInternal('Uso: :theme <id> | :theme list');
            return;
        }
        const theme = [...app.themes, ...(app.preferences?.customThemes ?? [])].find((candidate) => candidate.id.toLowerCase() === wanted.toLowerCase()
            || foldLocalized(candidate.label, app.catalog.language) === foldLocalized(wanted, app.catalog.language));
        if (!theme) {
            writeInternal(`\r\n[No se encontró el tema «${wanted}». Usa :theme list.]`);
            return;
        }
        // Elegir el tema sin sus colores solo cambiaba el identificador: la
        // interfaz pinta con los colores de las preferencias.
        const patch = app.preferences ? themePreferencePatch(theme.id, app.preferences, app.themes) : null;
        await app.savePreferences(patch ?? { themeId: theme.id });
        writeInternal(`\r\nTema aplicado: ${theme.label}.`);
    }

    async function configureFont(argument?: string): Promise<void> {
        const wanted = (argument ?? 'list').trim();
        if (!wanted || ['list', 'lista'].includes(wanted.toLowerCase())) {
            writeInternal('\r\nFuentes disponibles:');
            for (const font of app.fonts) writeInternal(`  ${font.id} — ${font.label}`);
            writeInternal('Uso: :font <id> | :font list');
            return;
        }
        const font = app.fonts.find((candidate) => candidate.id.toLowerCase() === wanted.toLowerCase()
            || foldLocalized(candidate.label, app.catalog.language) === foldLocalized(wanted, app.catalog.language));
        if (!font) {
            writeInternal(`\r\n[No se encontró la fuente «${wanted}». Usa :font list.]`);
            return;
        }
        await app.savePreferences({ terminalFontFamily: font.id });
        writeInternal(`\r\nFuente aplicada: ${font.label}.`);
    }

    async function configureLanguage(argument?: string): Promise<void> {
        const wanted = (argument ?? 'list').trim();
        if (!wanted || ['list', 'lista'].includes(wanted.toLowerCase())) {
            writeInternal('\r\nIdiomas disponibles:');
            for (const language of app.languages) writeInternal(`  ${language.id} — ${language.label}`);
            writeInternal('Uso: :language <id> | :language list');
            return;
        }
        const language = app.languages.find((candidate) => candidate.id.toLowerCase() === wanted.toLowerCase()
            || foldLocalized(candidate.label, app.catalog.language) === foldLocalized(wanted, app.catalog.language)
            || foldLocalized(candidate.englishLabel, app.catalog.language) === foldLocalized(wanted, app.catalog.language));
        if (!language) {
            writeInternal(`\r\n[No se encontró el idioma «${wanted}». Usa :language list.]`);
            return;
        }
        await app.savePreferences({ language: language.id });
        writeInternal(`\r\nIdioma aplicado: ${language.label}.`);
    }

    function terminalStatus(): void {
        const preferences = app.preferences;
        if (!preferences) return;
        const rows: Array<[string, string | number | boolean]> = [
            ['font-size', preferences.terminalFontSize], ['line-height', preferences.terminalLineHeight],
            ['letter-spacing', preferences.terminalLetterSpacing], ['padding', preferences.terminalPadding],
            ['scrollback', preferences.terminalScrollback], ['scroll-sensitivity', preferences.terminalScrollSensitivity],
            ['cursor', preferences.terminalCursorStyle], ['font-weight', preferences.terminalFontWeight],
            ['cursor-blink', preferences.terminalCursorBlink],
            ['density', preferences.uiDensity], ['background', preferences.terminalBackground],
            ['foreground', preferences.terminalForeground], ['selection', preferences.terminalSelectionColor],
            ['cursor-color', preferences.terminalCursorColor], ['fastfetch-color', preferences.fastfetchColor],
        ];
        writeInternal('\r\nParámetros de terminal:');
        for (const [name, value] of rows) writeInternal(`  ${name} = ${value}`);
        writeInternal('Uso: :terminal <parámetro> <valor> | :terminal list');
        writeInternal('Colores: #rrggbb · booleanos: on/off · cursor: block|underline|bar|beam|underline-thick');
    }

    async function configureTerminal(argument?: string): Promise<void> {
        const tokens = (argument ?? 'list').trim().split(/\s+/).filter(Boolean);
        const key = (tokens.shift() ?? 'list').toLowerCase();
        const raw = tokens.join(' ').trim();
        if (['list', 'lista', 'show', 'mostrar'].includes(key)) {
            terminalStatus();
            return;
        }
        if (!raw) {
            writeInternal('\r\n[Falta el valor. Usa :terminal list para ver los parámetros.]');
            return;
        }
        const aliases: Record<string, keyof Preferences> = {
            'font-size': 'terminalFontSize', fontsize: 'terminalFontSize', size: 'terminalFontSize',
            'line-height': 'terminalLineHeight', lineheight: 'terminalLineHeight',
            'letter-spacing': 'terminalLetterSpacing', letterspacing: 'terminalLetterSpacing',
            padding: 'terminalPadding', scrollback: 'terminalScrollback',
            'scroll-sensitivity': 'terminalScrollSensitivity', sensitivity: 'terminalScrollSensitivity',
            cursor: 'terminalCursorStyle', 'font-weight': 'terminalFontWeight', weight: 'terminalFontWeight',
            'cursor-blink': 'terminalCursorBlink', blink: 'terminalCursorBlink',
            density: 'uiDensity',
            background: 'terminalBackground', bg: 'terminalBackground',
            foreground: 'terminalForeground', fg: 'terminalForeground',
            selection: 'terminalSelectionColor', 'cursor-color': 'terminalCursorColor',
            'fastfetch-color': 'fastfetchColor',
        };
        const field = aliases[key];
        if (!field) {
            writeInternal(`\r\n[Parámetro desconocido «${key}». Usa :terminal list.]`);
            return;
        }
        let value: string | number | boolean = raw;
        if (['terminalFontSize', 'terminalPadding', 'terminalScrollback', 'terminalScrollSensitivity'].includes(field)) {
            value = Number(raw);
            if (!Number.isInteger(value) || value <= 0) {
                writeInternal('\r\n[Debe ser un número entero positivo.]');
                return;
            }
        } else if (['terminalLineHeight', 'terminalLetterSpacing'].includes(field)) {
            value = Number(raw);
            if (!Number.isFinite(value)) {
                writeInternal('\r\n[Debe ser un número válido.]');
                return;
            }
        } else if (['terminalCursorBlink'].includes(field)) {
            if (['on', 'true', 'yes', 'si', 'sí', '1'].includes(raw.toLowerCase())) value = true;
            else if (['off', 'false', 'no', '0'].includes(raw.toLowerCase())) value = false;
            else {
                writeInternal('\r\n[Usa on u off para este parámetro.]');
                return;
            }
        } else if (['terminalCursorStyle', 'terminalFontWeight', 'uiDensity'].includes(field)) {
            value = raw.toLowerCase();
            const allowed: Record<string, string[]> = {
                terminalCursorStyle: ['block', 'underline', 'bar', 'beam', 'underline-thick'],
                terminalFontWeight: ['light', 'normal', 'medium', 'semibold', 'bold'],
                uiDensity: ['compact', 'comfortable'],
            };
            if (!allowed[field].includes(value)) {
                writeInternal(`\r\n[Valor no válido para ${key}. Usa :terminal list.]`);
                return;
            }
        } else if (['terminalBackground', 'terminalForeground', 'terminalSelectionColor', 'terminalCursorColor', 'fastfetchColor'].includes(field)
            && !/^#[0-9a-f]{6}$/i.test(raw)) {
            writeInternal('\r\n[El color debe tener formato #rrggbb.]');
            return;
        }
        await app.savePreferences({ [field]: value } as Partial<Preferences>);
        writeInternal(`\r\nParámetro actualizado: ${key} = ${value}.`);
    }

    async function configurePanes(argument?: string): Promise<void> {
        const wanted = (argument ?? 'list').trim().toLowerCase();
        const current = app.panes.length < 2 ? 1 : app.panes.length;
        if (['list', 'lista', 'show', 'mostrar'].includes(wanted)) {
            writeInternal(`\r\nDiseño actual: ${current} panel${current === 1 ? '' : 'es'}.`);
            writeInternal('Uso: :panes 1|2|3|4 | :panes cycle');
            return;
        }
        if (['cycle', 'ciclo', 'next', 'siguiente'].includes(wanted)) {
            await app.cyclePanes();
        } else {
            const count = Number(wanted);
            if (!Number.isInteger(count) || count < 1 || count > 4) {
                writeInternal('\r\n[El diseño debe ser 1, 2, 3 o 4.]');
                return;
            }
            await app.setPaneCount(count);
        }
        const next = app.panes.length < 2 ? 1 : app.panes.length;
        writeInternal(`\r\nDiseño aplicado: ${next} panel${next === 1 ? '' : 'es'}.`);
    }

    const canOpenCurrentDirectory = $derived(
        app.appInfo?.platform === 'windows' || app.appInfo?.platform === 'linux',
    );

    async function openCurrentDirectory(): Promise<void> {
        if (!canOpenCurrentDirectory) {
            writeInternal(`\r\n[${app.t('explorer.openInSystem', 'Abrir en el explorador del sistema')}: esta plataforma no está soportada.]`);
            return;
        }
        try {
            // El explorador lateral puede estar navegando manualmente en otra
            // carpeta; esta acción significa siempre «la ruta de la shell».
            const result = await api.openDirectory(tabId, undefined, true);
            if (!result.ok) {
                writeInternal(`\r\n[${result.error ?? app.t('explorer.failed', 'No se pudo abrir el explorador de archivos.')}]`);
            }
        } catch (error) {
            writeInternal(`\r\n[${String(error)}]`);
        } finally {
            term?.focus();
        }
    }

    function onOpenCurrentDirectory(event: Event): void {
        const requestedTabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
        if (requestedTabId === tabId) void openCurrentDirectory();
    }

    async function runInternal(line: string): Promise<{ handled: boolean; shellPrintsPrompt: boolean }> {
        const command = await api.parseInternalCommand(line);
        if (!command) return { handled: false, shellPrintsPrompt: false };
        let shellPrintsPrompt = false;
        // Borrar carácter a carácter funciona también en cmd.exe, donde
        // Ctrl+U no limpia la línea. El espejo solo admite ASCII simple, así
        // que el número de DEL coincide exactamente con lo escrito. La
        // función espera a que ConPTY termine de reflejarlos antes de pintar.
        // Si una ayuda anterior sigue escribiendo por la PTY, no tocar esa
        // fila todavía: el alias acabaría insertado dentro del texto visible.
        await outputInputReady;
        await flushTerminalInputBeforeInternal();
        await clearPromptInput(line);
        // ConPTY puede conservar el cursor de edición en la misma fila hasta
        // recibir un Enter. Si escribimos la respuesta interna antes de ese
        // Enter, el prompt que devuelve la shell puede repintar esa fila y
        // comerse visualmente la primera línea. Crear primero un prompt vacío
        // deja una fila estable para la salida de los comandos interceptados.
        if (!['help', 'alias', 'darkeiser003', 'christianlg97'].includes(command.action)) {
            await api.sendInput(tabId, '\r');
            await new Promise((resolve) => window.setTimeout(resolve, 180));
        }
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
            else writeInternal(`\r\n\x1b[33m[${translated('terminal.replMissing', 'REPL not detected: {name}', { name: command.argument! })}]\x1b[0m`);
        } else if (command.action === 'shell') {
            await configureShell(command.argument);
        } else if (command.action === 'banner') {
            await configureBanner(command.argument);
        } else if (command.action === 'quickActions') {
            await configureQuickActions(command.argument);
        } else if (command.action === 'ltools') {
            await configurePanel('scripts');
        } else if (command.action === 'panel') {
            await configurePanel(command.argument);
        } else if (command.action === 'theme') {
            await configureTheme(command.argument);
        } else if (command.action === 'font') {
            await configureFont(command.argument);
        } else if (command.action === 'language') {
            await configureLanguage(command.argument);
        } else if (command.action === 'terminal') {
            await configureTerminal(command.argument);
        } else if (command.action === 'panes') {
            await configurePanes(command.argument);
        } else if (command.action === 'openDirectory') {
            await openCurrentDirectory();
        } else if (command.action === 'darkeiser003') {
            // Los créditos se generan en el mismo archivo de ayuda que usa la
            // shell. Ejecutarlos por el PTY, en vez de escribir directamente
            // en xterm, mantiene sincronizados el cursor real, el historial y
            // el prompt; además recoge el idioma actualizado al regenerarse
            // los archivos de sesión.
            // Usar la sección específica evita desplazar el título fuera del
            // viewport y mantiene el crédito del desarrollador aislado.
            await api.sendInput(tabId, `ayuda ${command.action}\r`);
            shellPrintsPrompt = true;
        } else if (command.action === 'christianlg97') {
            // Christian figura en los créditos de WTerminal, pero no en
            // LTerminal. El backend solo reconoce este alias en Windows.
            await api.sendInput(tabId, `ayuda ${command.action}\r`);
            shellPrintsPrompt = true;
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
                shellPrintsPrompt = true;
                await api.sendInput(tabId, topic ? 'ayuda ' + topic + '\r' : 'ayuda\r');
            } else {
                // Un REPL o un contenedor no puede cargar el archivo temporal
                // de alias del host. :help sigue siendo útil y no inyecta
                // `ayuda` en Python, Node, Docker o ADB como si fuera código
                // de esa shell.
                writeInternal(`\r\n${translated('terminal.helpFallback', 'Help{topic}: use :help from a terminal or consult the internal commands.', { topic: topic ? ` (${topic})` : '' })}`);
                writeInternal(app.t('terminal.internalCommands', 'Internal commands: :help [section]  :config/:settings  :reload  :shell [list|current|<name>]  :repl <name>  :panel <panel|close>  :ltools  :explorer-here  :theme [list|<id>]  :font [list|<id>]  :language [list|<id>]  :terminal [list|<key> <value>]  :panes [1|2|3|4|cycle]  :banner [options]  :quick-actions list'));
            }
        } else {
            writeInternal(`\r\n${app.t('terminal.commandList', ':help  :config/:settings  :reload  :shell  :repl  :panel  :ltools  :explorer-here  :theme  :font  :language  :terminal  :panes  :alias  :banner  :quick-actions')}`);
        }
        // No enviar el Enter final hasta que toda la respuesta escrita
        // directamente en xterm haya sido parseada y pintada. Así el prompt
        // de la shell queda siempre después del bloque de salida, nunca en
        // medio de sus cabeceras o líneas largas.
        await flushInternalOutput();
        return { handled: true, shellPrintsPrompt };
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
    /** Última geometría que ConPTY confirmó. ConPTY coloca el eco con
     *  posiciones absolutas (`ESC[fila;colH`) relativas a SU viewport: si sus
     *  filas no coinciden con las de xterm, la orden aparece una o dos filas
     *  por debajo del prompt, sangrada en la columna donde terminaba. Las
     *  columnas pueden quedar protegidas (más anchas) por una reserva de
     *  entrada, pero las filas siempre deben seguir a xterm. */
    let lastPtySize = { cols: 0, rows: 0 };
    let ptySyncPendingAfterOutput = false;
    /** Geometría más baja que xterm aplicó desde el último resize de ConPTY.
     *  Al dividir paneles, el layout pasa por tamaños transitorios (p. ej. 1
     *  fila) que xterm aplica al instante pero el debounce del PTY nunca
     *  envía. xterm empuja entonces líneas al historial y, en modo ConPTY, no
     *  las recupera al crecer: ConPTY acababa una fila por delante. */
    let xtermTransientShrink: { cols: number; rows: number } | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    // Las llamadas a `api.resize` pueden sobrevivir a un nuevo ajuste local.
    // ConPTY aplica las solicitudes en el orden en que llegan y una respuesta
    // vieja que termina después de la nueva vuelve a envolver el scrollback
    // con la rejilla anterior. Serializar la cola evita ese reflow tardío.
    let resizeSequence = 0;
    let resizeQueue: Promise<void> = Promise.resolve();
    // xterm cambia sus filas al instante, pero el resize de ConPTY espera un
    // debounce de 250 ms. Una tecla dentro de esa ventana llegaba a ConPTY con
    // las filas viejas y el eco caía una fila por debajo del prompt (al
    // volver a una pestaña oculta tras cambiar el tamaño de la ventana, o al
    // escribir justo después de redimensionar). La entrada adelanta el resize
    // pendiente en vez de colarse delante de él.
    let pendingPtyResizeRun: (() => void) | undefined;
    function flushPendingPtyResize(): void {
        pendingPtyResizeRun?.();
    }
    // Al volver a ser visible, la casilla mide en el siguiente frame. Hasta
    // entonces no se conoce la geometría nueva: la entrada espera esa medida
    // (con un tope corto para no bloquear nunca el teclado).
    let activationGeometryReady: Promise<void> = Promise.resolve();
    let activationGeometryResolve: (() => void) | undefined;
    function openActivationGeometryBarrier(): void {
        activationGeometryResolve?.();
        activationGeometryReady = new Promise<void>((resolve) => {
            const timer = window.setTimeout(() => done(), 250);
            const done = () => {
                window.clearTimeout(timer);
                if (activationGeometryResolve === done) activationGeometryResolve = undefined;
                resolve();
            };
            activationGeometryResolve = done;
        });
    }
    function closeActivationGeometryBarrier(): void {
        activationGeometryResolve?.();
    }
    // Las acciones de teclado pueden llegar en una ráfaga mucho más rápida
    // que el primer `onData`. Precalentar ConPTY al recibir el foco evita que
    // la primera orden larga se empiece a ecoar con las columnas del
    // viewport, sin ensanchar todavía el canvas local ni mostrar una barra
    // para comandos cortos.
    let commandPtyWarmupColumns = 0;
    let commandPtyWarmupQueue: Promise<void> = Promise.resolve();
    function warmupPtyForInput(): Promise<void> {
        if (!term || destroyed) return commandPtyWarmupQueue;
        // El primer `pty_resize` confirma la geometría y arranca la shell en
        // el backend; debe llevar las filas medidas por el primer fit, no las
        // 24 por defecto de xterm. Las columnas ya son >= 1024 en ambos lados.
        if (lastSize.rows <= 0 && lastPtySize.rows === 0) return commandPtyWarmupQueue;
        const target = Math.min(MAX_HORIZONTAL_COLS, Math.max(INPUT_PTY_WARMUP_COLS, term.cols));
        if (target <= commandPtyWarmupColumns) return commandPtyWarmupQueue;
        commandPtyWarmupColumns = target;
        commandPtyWarmupQueue = commandPtyWarmupQueue
            .catch(() => undefined)
            .then(() => resizeQueue)
            .then(async () => {
                const rows = Math.max(1, term?.rows ?? 1);
                await api.resize(tabId, target, rows);
                lastPtySize = { cols: target, rows };
            })
            .catch(() => undefined);
        return commandPtyWarmupQueue;
    }
    // Cada evento `onData` puede llegar como una pulsación independiente.
    // Enviar todos los IPC en paralelo permitía que una letra posterior
    // atravesara antes el resize de una anterior; ConPTY acababa pintando
    // `e`, `cho` y el resto de la orden en filas distintas. La cola es por
    // terminal y conserva el orden exacto de las teclas después de todas las
    // barreras de geometría.
    let terminalInputQueue: Promise<void> = Promise.resolve();
    let pendingTerminalInputData = '';
    let pendingTerminalInputBarrier: Promise<void> = Promise.resolve();
    let terminalInputBatchTimer: number | undefined;
    const TERMINAL_INPUT_BATCH_MS = 12;
    let pendingInputPtyColumns = 0;
    let inputPtyResizeRunning = false;
    // La primera medida local puede estar lista antes de que ConPTY reciba
    // ese tamaño. No liberar la entrada en esa ventana: cmd/PowerShell puede
    // envolver la primera orden con la rejilla inicial aunque el panel ya se
    // vea ancho. El límite evita bloquear una shell si el IPC falla.
    let initialResizePending = false;
    let initialResizeTimer: number | undefined;
    let pendingInputRelease = false;

    function beginInitialResizeBarrier(): void {
        if (initialResizePending) return;
        initialResizePending = true;
        initialResizeTimer = window.setTimeout(() => {
            initialResizeTimer = undefined;
            completeInitialResizeBarrier();
        }, 2000);
    }

    function completeInitialResizeBarrier(): void {
        if (!initialResizePending) return;
        initialResizePending = false;
        if (initialResizeTimer !== undefined) {
            window.clearTimeout(initialResizeTimer);
            initialResizeTimer = undefined;
        }
        if (pendingInputRelease && !destroyed) {
            pendingInputRelease = false;
            releaseInput();
        }
    }
    let resizeObserverFrame: number | undefined;
    // Al dividir la rejilla WebView2 puede entregar durante uno o dos frames
    // una anchura de host ya grande con la matriz de xterm todavía reducida a
    // 1-3 columnas. Nunca se debe propagar ese tamaño transitorio a la PTY:
    // ConPTY reenvuelve el scrollback con esa matriz y el texto queda en
    // fragmentos verticales aunque el panel se estabilice inmediatamente.
    let tinyLayoutFitTimer: number | undefined;
    let tinyLayoutFitRetries = 0;
    let resumeRefreshFrame: number | undefined;
    const onWindowResize = () => fitAndReport();
    let initialPromptTimer: number | undefined;
    let startupReadinessTimer: number | undefined;
    let initialPromptRecoveryAttempts = 0;
    let initialPromptRecoverySent = false;
    /** Momento de la primera salida PTY de esta casilla (0 = ninguna). El
     *  backend retiene la salida del inicializador hasta su marcador: sin
     *  salida, la shell sigue inicializando y no le falta ningún prompt. */
    let firstShellOutputAt = 0;
    let inputReleaseFallbackDeadline = 0;
    let userEditing = false;
    // Esperar a que App.svelte vacíe la cola de `term.write` evita recalcular
    // el banner mientras la shell todavía está entregando un bloque de
    // salida; xterm conserva así un orden visual estable.
    let terminalOutputBusy = false;
    // Conserva si la salida empezó con el usuario anclado al final. Xterm
    // puede crecer el scrollback durante un reflow y dejar una rejilla mínima
    // mostrando la primera fila, aunque la shell ya haya escrito el prompt.
    // Solo se corrige ese caso cuando no había un desplazamiento manual.
    let outputStartedAtBottom = true;
    // El usuario puede leer el scrollback mientras la PTY sigue entregando
    // datos. No volver a anclarlo al final en el siguiente idle: hacerlo daba
    // la impresión de que la rueda "saltaba" y ocultaba líneas anteriores.
    let userScrolledBack = false;
    // `display: none` reinicia el scroll del contenedor. Al volver a mostrar
    // una casilla cuyas filas cambiaron mientras estaba oculta, xterm quedaba
    // en la cima del historial (viewportY 0) y, creyendo que el usuario había
    // subido, no seguía la salida: lo que se escribía no aparecía. La posición
    // se guarda al ocultarse y se restaura tras el primer ajuste visible.
    let hiddenScrollState: { atBottom: boolean; viewportY: number } | null = null;
    // Al reactivarla, el área de scroll interna de xterm conserva la posición
    // y el alto de antes de ocultarse, y el renderer aplica su tamaño nuevo
    // cuando la página queda inactiva. Mientras tanto el área tiene rango 0:
    // recorta cualquier posición, emite scroll con top=0 y arrastra el buffer
    // a la cima; un `scrollToBottom` en ese intervalo se recorta igual. La
    // intención (seguir el final o una línea) se mantiene unos segundos y se
    // reaplica en los renders, con un intervalo mínimo y sin forzar repintados
    // que mantendrían la página ocupada y retrasarían aún más ese tamaño.
    const ACTIVATION_SCROLL_PIN_MS = 4000;
    const ACTIVATION_SCROLL_RETRY_MS = 80;
    let activationScrollPinUntil = 0;
    let activationScrollLastRetry = 0;
    let activationScrollPinTimer: number | undefined;
    function scrollMatchesHiddenState(): boolean {
        if (!hiddenScrollState || !term) return true;
        const buffer = term.buffer.active;
        return hiddenScrollState.atBottom
            ? buffer.viewportY >= buffer.baseY
            : buffer.viewportY === Math.min(hiddenScrollState.viewportY, buffer.baseY);
    }
    function applyHiddenScrollState(): void {
        if (!hiddenScrollState || !term || destroyed || scrollMatchesHiddenState()) return;
        activationScrollLastRetry = performance.now();
        if (hiddenScrollState.atBottom) {
            term.scrollToBottom();
            userScrolledBack = false;
        } else {
            term.scrollToLine(Math.min(hiddenScrollState.viewportY, term.buffer.active.baseY));
        }
    }
    function noteScrollRestore(key: string): void {
        if (!host) return;
        host.dataset[key] = String(Number(host.dataset[key] ?? '0') + 1);
    }
    // Al volver de oculta, el IntersectionObserver de xterm la sigue dando por
    // invisible hasta su siguiente notificación, y un resize en ese intervalo
    // se aplaza hasta que la página queda inactiva (segundos si está ocupada):
    // el área de scroll se quedaba con rango 0 todo ese tiempo. El reajuste de
    // la reactivación espera a que la casilla vuelva a ser visible para xterm.
    let awaitingTerminalVisibility = false;
    let visibilityGateObserver: IntersectionObserver | undefined;
    let visibilityGateTimer: number | undefined;
    function disposeVisibilityGate(): void {
        awaitingTerminalVisibility = false;
        visibilityGateObserver?.disconnect();
        visibilityGateObserver = undefined;
        if (visibilityGateTimer !== undefined) window.clearTimeout(visibilityGateTimer);
        visibilityGateTimer = undefined;
    }
    function closeVisibilityGate(): void {
        if (!awaitingTerminalVisibility) return;
        disposeVisibilityGate();
        if (destroyed || !active) return;
        fitAndReport();
        restoreScrollAfterActivation();
        closeActivationGeometryBarrier();
    }
    function openVisibilityGate(): void {
        const target = term?.element?.querySelector<HTMLElement>('.xterm-screen') ?? term?.element;
        if (!target || typeof IntersectionObserver === 'undefined') return;
        disposeVisibilityGate();
        awaitingTerminalVisibility = true;
        // El observador de xterm se creó antes y recibe la notificación
        // primero; esperar a la tarea siguiente garantiza que ya reanudó.
        visibilityGateObserver = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) window.setTimeout(closeVisibilityGate, 0);
        }, { threshold: 0 });
        visibilityGateObserver.observe(target);
        visibilityGateTimer = window.setTimeout(closeVisibilityGate, 200);
    }
    function activationScrollPinned(): boolean {
        return hiddenScrollState !== null && performance.now() < activationScrollPinUntil;
    }
    function releaseActivationScrollPin(): void {
        hiddenScrollState = null;
        activationScrollPinUntil = 0;
        if (activationScrollPinTimer !== undefined) window.clearTimeout(activationScrollPinTimer);
        activationScrollPinTimer = undefined;
    }
    function restoreScrollAfterActivation(): void {
        noteScrollRestore('scrollRestoreCalls');
        if (!hiddenScrollState) return;
        noteScrollRestore('scrollRestoreWithState');
        applyHiddenScrollState();
        activationScrollPinUntil = performance.now() + ACTIVATION_SCROLL_PIN_MS;
        if (activationScrollPinTimer !== undefined) window.clearTimeout(activationScrollPinTimer);
        activationScrollPinTimer = window.setTimeout(() => {
            activationScrollPinTimer = undefined;
            applyHiddenScrollState();
            releaseActivationScrollPin();
        }, ACTIVATION_SCROLL_PIN_MS);
    }
    /** Reaplica la posición guardada tras un render mientras dure la
     *  intención. Cuando el renderer ya tiene su tamaño nuevo, el intento se
     *  mantiene y los siguientes renders no hacen nada. */
    function restoreScrollAfterRender(): void {
        if (!active || !activationScrollPinned() || scrollMatchesHiddenState()) return;
        if (performance.now() - activationScrollLastRetry < ACTIVATION_SCROLL_RETRY_MS) return;
        noteScrollRestore('scrollGuardApplied');
        applyHiddenScrollState();
    }
    // Una redimensión de xterm mientras procesa un bloque de salida puede
    // dejar filas rasterizadas con columnas antiguas (el síntoma visual es
    // texto de un comando mezclado con GPU/CPU). Se difiere hasta que la cola
    // de escritura confirma que el terminal quedó inactivo.
    let fitAfterOutput = false;
    let outputGeometryPending = false;
    let outputGeometryResolve: (() => void) | undefined;
    let outputGeometryReady: Promise<void> = Promise.resolve();
    let outputInputBlocked = false;
    let outputInputEpoch = 0;
    let outputInputResolve: (() => void) | undefined;
    let outputInputReady: Promise<void> = Promise.resolve();
    let fitQuietTimer: number | undefined;
    // La liberación de la reserva ancha es independiente del fit tardío. Un
    // único temporizador para ambas tareas hacía que el fit cancelara la
    // liberación y dejara la barra horizontal visible tras una orden corta.
    let wideReleaseTimer: number | undefined;
    let lateOutputFitTimer: number | undefined;
    let repaintTimer: number | undefined;
    let lastOutputFinishedAt = 0;
    // ConPTY puede entregar una línea larga en varios bloques separados por
    // unos cientos de milisegundos. Rehacer la rejilla en ese hueco provoca
    // que el host reenvuelva la línea mientras aún llegan caracteres y deja
    // visible solo la cola (el síntoma de `SEQ0340…`). Esperar un intervalo
    // tranquilo completo antes de redimensionar conserva todos los fragmentos
    // y sigue permitiendo que una orden corta recupere su ancho después.
    const OUTPUT_QUIET_SETTLE_MS = 900;
    let bannerActivationTimer: number | undefined;
    let inputReadyTimer: number | undefined;
    let pendingBannerPrint = false;
    // Mientras una solicitud sigue en vuelo no se encadena otra
    // desde el evento idle; así se evita trabajo duplicado durante un resize.
    let bannerRefreshInFlight = false;
    let pendingOutputColumns = 0;
    // ConPTY puede dividir una línea muy larga en varios bloques. No aplicar
    // un `term.resize()` por cada bloque: durante WTERMSEQ la rejilla crecía
    // una y otra vez y el canvas llegaba a pintar estados intermedios. La
    // reserva conserva el máximo y se aplica una sola vez cuando la ráfaga
    // deja un pequeño intervalo de reposo.
    let pendingOutputPtyColumns = 0;
    let outputPtyResizeTimer: number | undefined;
    let outputPtyEarlyResizeScheduled = false;
    const OUTPUT_PTY_EARLY_RESERVE_COLS = 1024;
    // La salida de ConPTY puede partir una misma línea física en bloques que
    // no llevan CR/LF. Medir solo cada bloque deja la matriz en 151 columnas
    // y obliga a envolver WTERMSEQ, aunque la línea completa sea mucho mayor.
    let outputLogicalLineColumns = 0;

    function flushOutputPtyResize(): Promise<void> {
        if (outputPtyResizeTimer !== undefined) {
            window.clearTimeout(outputPtyResizeTimer);
            outputPtyResizeTimer = undefined;
        }
        const requiredColumns = pendingOutputPtyColumns;
        pendingOutputPtyColumns = 0;
        return requiredColumns > 0 ? queueInputPtyResize(requiredColumns) : resizeQueue;
    }

    function queueOutputPtyResize(requiredColumns: number): void {
        if (!term || requiredColumns <= term.cols) return;
        pendingOutputPtyColumns = Math.max(
            pendingOutputPtyColumns,
            Math.min(MAX_HORIZONTAL_COLS, Math.ceil(requiredColumns)),
        );
        // Reservar una rejilla amplia una sola vez al comienzo de la ráfaga.
        // Debe ocurrir antes de que App.svelte escriba el primer bloque en
        // xterm: esperar un temporizador deja que la PTY envuelva la salida
        // numérica con la anchura antigua y luego ya no se puede recomponer
        // esa fila mediante un reflow. Las ampliaciones posteriores siguen
        // acumulándose y se aplican al quedar la salida inactiva.
        if (outputPtyEarlyResizeScheduled) return;
        outputPtyEarlyResizeScheduled = true;
        const earlyColumns = Math.min(
            MAX_HORIZONTAL_COLS,
            Math.max(
                pendingOutputPtyColumns,
                OUTPUT_PTY_EARLY_RESERVE_COLS,
            ),
        );
        pendingOutputPtyColumns = earlyColumns;
        void flushOutputPtyResize();
    }
    // Una ráfaga que imprimió una línea ancha conserva esa reserva mientras
    // sigan llegando órdenes a la misma sesión. Encoger después de la primera
    // orden corta y volver a expandir en la siguiente obliga a xterm a hacer
    // un reflow ancho→estrecho→ancho que puede perder la fila corta; `clear`
    // o un cambio de entorno inicia una época nueva y libera la reserva.
    let outputBurstWide = false;
    // La entrada pendiente se consume al aplicar el resize, pero la reserva
    // no puede desaparecer mientras sigan visibles esas filas. Guardarla por
    // separado evita que un ResizeObserver posterior vuelva a proponer las
    // columnas del viewport y provoque un reflow ancho→estrecho.
    let reservedOutputColumns = 0;
    // Una orden que se está editando no debe envolverse en la matriz visible:
    // mientras xterm recibe la ráfaga de teclas mantenemos una rejilla ancha
    // y dejamos que el host ofrezca el único scroll horizontal. Se libera
    // después del siguiente bloque de salida, cuando la shell ya confirmó la
    // orden y podemos medir su resultado real.
    let inputWideReservationColumns = 0;
    // Calentamos ConPTY antes de que una línea llegue al borde visible. La
    // reserva se mantiene oculta en el host mientras la línea sigue corta;
    // así una escritura rápida no puede cruzar el borde con la anchura vieja
    // y tampoco aparece una barra horizontal para comandos normales.
    let inputPtyWarmupDone = false;
    const INPUT_PTY_WARMUP_COLS = 1024;
    // Igual que `MIN_INTERACTIVE_COLS` en src-tauri/src/terminal/tabs.rs: la
    // rejilla de xterm nunca es más estrecha que la de ConPTY.
    const CONPTY_MIN_COLS = 1024;
    // Columnas que la vista quiere mostrar (lo que xterm tendría sin el
    // mínimo). Sustituye a `term.cols` donde la lógica significa «ancho
    // visible», no «ancho de la rejilla».
    let displayCols = 0;
    function currentDisplayCols(): number {
        return displayCols || term?.cols || 0;
    }
    // Una ráfaga de WebDriver/pegado puede informar varias veces la misma
    // línea mientras el espejo aún es `null`. No dejar que esa suma defensiva
    // convierta una orden de cientos de caracteres en una rejilla de 16k y
    // una barra casi microscópica; las salidas impresas sí conservan el tope
    // amplio de `MAX_HORIZONTAL_COLS` por separado.
    const MAX_INPUT_RESERVATION_COLS = 4096;
    let localInputGridPinned = false;
    let inputLineSubmitted = false;
    // `clear` puede volver a imprimir el banner de sistema, que no debe
    // convertirse en una reserva horizontal permanente para la siguiente
    // orden. La próxima salida normal vuelve a habilitar la medición al
    // terminar la época de clear.
    let suppressWideReservation = false;
    // Un panel puede pasar de ocupar toda la ventana a una columna estrecha
    // al dividir la vista. La reserva de una salida ancha pertenece a la
    // geometría anterior; conservarla en la nueva columna deja un canvas
    // enorme aunque solo quede visible una ayuda corta. La siguiente medida
    // volverá a reservar ancho si el contenido actualmente visible lo exige.
    let observedPaneCount = 0;

    // El último bloque de salida puede dejar a xterm y al host en frames
    // distintos. Antes de aceptar la siguiente orden, dar dos frames al fit
    // local evita que ConPTY reciba el eco mientras la rejilla aún conserva
    // las columnas antiguas.
    function scheduleOutputGeometrySettle(): void {
        if (outputGeometryPending || destroyed) return;
        outputGeometryPending = true;
        outputGeometryReady = new Promise((resolve) => {
            outputGeometryResolve = resolve;
        });
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                if (!destroyed) fitAndReport();
                window.setTimeout(() => {
                    outputGeometryPending = false;
                    const resolve = outputGeometryResolve;
                    outputGeometryResolve = undefined;
                    resolve?.();
                }, 0);
            });
        });
    }

    function blockInputDuringOutput(): void {
        if (outputInputBlocked) return;
        outputInputBlocked = true;
        outputInputReady = new Promise((resolve) => {
            outputInputResolve = resolve;
        });
    }

    function releaseInputAfterOutput(): void {
        if (!outputInputBlocked) return;
        const epoch = outputInputEpoch;
        outputGeometryReady.then(() => {
            if (destroyed || terminalOutputBusy || epoch !== outputInputEpoch) return;
            outputInputBlocked = false;
            const resolve = outputInputResolve;
            outputInputResolve = undefined;
            resolve?.();
        });
    }

    // `cls`/`clear` llega antes de que la PTY vuelva a pintar el prompt. No
    // podemos reducir la matriz en ese primer evento porque todavía está
    // visible la salida anterior; esperamos a la señal idle del clear y la
    // devolvemos entonces a las columnas del viewport.
    let clearPending = false;

    /**
     * Amplía ConPTY antes de entregar una ráfaga de teclas que ya no cabe en
     * la rejilla actual. `term.resize()` solo cambia xterm localmente; si la
     * entrada se envía inmediatamente después, cmd/PowerShell todavía cree
     * que tiene la anchura vieja y envuelve el comando antes de que aparezca
     * el scroll horizontal. Encadenarlo a la misma cola que los resizes evita
     * además que una petición antigua vuelva a envolver la línea después.
     */
    function queueInputPtyResize(requiredColumns: number): Promise<void> {
        if (!term || requiredColumns <= 0) return resizeQueue;
        const cols = Math.min(MAX_HORIZONTAL_COLS, Math.max(term.cols, Math.ceil(requiredColumns)));
        const rows = Math.max(1, term.rows);
        // La rejilla local debe crecer antes de que xterm procese el eco; la
        // llamada nativa se espera en la cola inmediatamente posterior.
        if (cols !== term.cols) {
            term.resize(cols, rows);
            // xterm limpia y vuelve a construir el canvas durante resize. Si
            // la salida larga empieza justo en ese frame, WebView2 puede
            // capturar únicamente la fila que se está escribiendo y dejar el
            // banner/prompt invisibles durante un instante. Forzar el primer
            // repintado aquí mantiene el buffer visible mientras ConPTY acepta
            // la misma geometría.
            try {
                term.refresh(0, Math.max(0, term.rows - 1));
            } catch (error) {
                console.debug('[TerminalPane] repintado inicial tras resize omitido', error);
            }
        }
        pendingInputPtyColumns = Math.max(pendingInputPtyColumns, cols);
        if (inputPtyResizeRunning) return resizeQueue;
        inputPtyResizeRunning = true;
        const previous = resizeQueue;
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                while (!destroyed && pendingInputPtyColumns > 0) {
                    const targetColumns = pendingInputPtyColumns;
                    pendingInputPtyColumns = 0;
                    const targetRows = Math.max(1, term?.rows ?? rows);
                    await replayTransientShrink(targetRows);
                    await api.resize(tabId, targetColumns, targetRows);
                    lastPtySize = { cols: targetColumns, rows: targetRows };
                    if (destroyed || !term) return;
                    // El IPC confirma que ConPTY aceptó la petición antes de
                    // que cmd/PowerShell haya publicado la nueva geometría en
                    // su ciclo de entrada. Sin este pequeño margen, un
                    // pegado largo puede llegar justo entre ambos estados:
                    // xterm queda en 1024 columnas, pero el eco se calcula
                    // todavía con las ~100 columnas anteriores y luego no se
                    // puede recomponer porque ConPTY no marca esas filas como
                    // `isWrapped`.
                    await new Promise<void>((resolve) => window.setTimeout(resolve, 24));
                    if (destroyed || !term) return;
                    // ConPTY puede emitir un último bloque con la rejilla
                    // anterior justo al resolver el IPC. Si mientras tanto
                    // llegó otra reserva, no volver a encoger xterm al tamaño
                    // viejo: conservar la mayor geometría local evita un
                    // reflow intermedio que pueda separar el prompt.
                    const confirmedColumns = Math.max(
                        targetColumns,
                        pendingInputPtyColumns,
                        term.cols,
                    );
                    const confirmedRows = Math.max(targetRows, term.rows);
                    term.resize(confirmedColumns, confirmedRows);
                    // Si xterm se quedó con más columnas o filas de las que
                    // acaba de recibir ConPTY, repetir la vuelta con esa
                    // geometría: dejar las rejillas distintas desplaza los
                    // `ESC[fila;colH` posteriores.
                    if (confirmedColumns !== targetColumns || confirmedRows !== targetRows) {
                        pendingInputPtyColumns = Math.max(pendingInputPtyColumns, confirmedColumns);
                    }
                    term.scrollToBottom();
                    keepCursorHorizontallyVisible();
                    terminalPromptVisible();
                    scheduleTerminalRepaint();
                }
            })
            .finally(() => {
                inputPtyResizeRunning = false;
                // Una nueva pulsación puede haber reservado columnas mientras
                // la llamada IPC anterior estaba terminando. No dejar esa
                // reserva huérfana: reiniciar la cola con el último tamaño
                // pendiente evita que la siguiente tecla adelante a ConPTY.
                if (!destroyed && pendingInputPtyColumns > 0) {
                    queueInputPtyResize(pendingInputPtyColumns);
                }
            });
        resizeQueue = next.catch(() => undefined);
        return resizeQueue;
    }

    function flushTerminalInputBatch(): void {
        terminalInputBatchTimer = undefined;
        const data = pendingTerminalInputData;
        const inputBarrier = pendingTerminalInputBarrier;
        pendingTerminalInputData = '';
        pendingTerminalInputBarrier = Promise.resolve();
        if (!data) return;
        terminalInputQueue = terminalInputQueue
            .catch(() => undefined)
            .then(() => inputBarrier)
            .then(() => outputInputReady)
            .then(() => outputGeometryReady)
            .then(() => activationGeometryReady)
            // Leer la cola al final incluye un resize de layout que se haya
            // programado mientras se asentaban las barreras anteriores; si aún
            // esperaba su debounce, se envía ahora, antes que las teclas.
            .then(() => {
                flushPendingPtyResize();
                return resizeQueue;
            })
            .then(() => api.sendInput(tabId, data))
            .catch((error) => {
                if (!destroyed) console.debug('[TerminalPane] entrada encolada omitida', error);
            });
    }

    function enqueueTerminalInput(data: string, inputBarrier: Promise<void>): void {
        if (!data) return;
        pendingTerminalInputData += data;
        // Todas las barreras de un lote deben quedar satisfechas antes del
        // envío agrupado; conservar la cola evita adelantar una tecla que
        // cruzó el siguiente bloque de 64 columnas.
        pendingTerminalInputBarrier = pendingTerminalInputBarrier
            .catch(() => undefined)
            .then(() => inputBarrier);
        if (terminalInputBatchTimer === undefined) {
            terminalInputBatchTimer = window.setTimeout(
                () => flushTerminalInputBatch(),
                TERMINAL_INPUT_BATCH_MS,
            );
        }
    }

    // Un comando interno se intercepta al recibir Enter, mientras que las
    // letras anteriores pueden seguir esperando en el lote de entrada de
    // 12 ms o en la cola IPC. Si se borraba el prompt antes de vaciar esa
    // cola, ConPTY volvía a pintar parte de la orden después del borrado y el
    // cursor quedaba sobre la primera letra (por ejemplo,
    // `cursor-blink = true.`). Drenar la cola antes de limpiar hace que el
    // borrado y la salida interna formen una única secuencia ordenada.
    async function flushTerminalInputBeforeInternal(): Promise<void> {
        if (terminalInputBatchTimer !== undefined) {
            window.clearTimeout(terminalInputBatchTimer);
            flushTerminalInputBatch();
        }
        await terminalInputQueue.catch(() => undefined);
    }

    /** Reserva la anchura acumulada de la línea editada y devuelve la barrera
     * que debe preceder a la siguiente tecla. Se comparte entre las letras y
     * los espacios capturados fuera de `onData`, para que una ráfaga como
     * `if errorlevel 1 echo ...` no envuelva justo al cruzar un espacio. */
    function reserveCurrentInputColumns(lineLength: number): Promise<void> {
        if (!term || lineLength <= 0) return resizeQueue;
        // Si la salida acaba de reservar columnas pero el usuario ya puede
        // editar, incluir esa reserva en la misma cola antes de la entrada.
        // Así el debounce visual no puede dejar una petición de salida detrás
        // del eco de la siguiente orden.
        if (pendingOutputPtyColumns > 0) void flushOutputPtyResize();
        const previousColumns = term.cols;
        const cursorColumn = term.buffer.active.cursorX;
        // Lo que ocupa la línea en pantalla: prompt + entrada.
        lineLength += Math.max(0, inputStartColumn);
        const viewport = getHorizontalViewport();
        const cellWidth = terminalCellWidth();
        const visibleColumns = viewport && cellWidth > 0
            ? Math.max(1, Math.floor(viewport.clientWidth / cellWidth))
            : previousColumns;
        // No redimensionar la rejilla cada 64 caracteres mientras se escribe:
        // xterm puede dejar continuaciones no marcadas en cada reflow y el
        // resultado termina escalonado (la orden se ve en 3–4 filas aunque
        // todavía no se haya pulsado Enter). Al cruzar el primer viewport se
        // reserva de una vez una matriz amplia; las órdenes normales que caben
        // en pantalla no pagan ese coste.
        const inputLookahead = lineLength > visibleColumns
            ? Math.min(
                MAX_INPUT_RESERVATION_COLS,
                Math.max(INPUT_PTY_WARMUP_COLS, Math.ceil((lineLength + 2) / 64) * 64),
            )
            : Math.max(64, Math.ceil((lineLength + 2) / 64) * 64);
        let warmupBarrier = resizeQueue;
        const ptyWarmupBarrier = warmupPtyForInput();
        if (!inputPtyWarmupDone && previousColumns < INPUT_PTY_WARMUP_COLS) {
            inputPtyWarmupDone = true;
            warmupBarrier = queueInputPtyResize(INPUT_PTY_WARMUP_COLS);
        }
        const exposeWideInput = lineLength > visibleColumns;
        // Cuando la línea ya supera el viewport, `inputLookahead` representa
        // una anchura absoluta de trabajo para la orden completa. Sumársela a
        // `cursorColumn` hacía que una misma orden creciera 1024→1088→1152
        // mientras cmd seguía haciendo eco. ConPTY interpreta cada cambio
        // como una nueva rejilla y su redibujo deja las continuaciones
        // escalonadas. Mantener la primera reserva estable hasta que la línea
        // la supere evita ese reflow intermedio; las líneas cortas conservan
        // la reserva incremental original.
        const rawRequiredColumns = exposeWideInput
            ? Math.max(
                INPUT_PTY_WARMUP_COLS,
                Math.min(MAX_INPUT_RESERVATION_COLS, lineLength + 4),
            )
            : inputReservationColumns(
                cursorColumn,
                inputLookahead,
                inputLookahead,
                MAX_HORIZONTAL_COLS,
            );
        // El cursor avanza una columna por carácter. Redondear la reserva a
        // bloques evita solicitar un reflow/IPC por cada pulsación cuando se
        // está pegando o escribiendo una orden larga; solo se amplía al
        // cruzar el siguiente bloque estable.
        const reservationBlock = 64;
        const requiredColumns = Math.min(
            MAX_INPUT_RESERVATION_COLS,
            Math.max(
                rawRequiredColumns,
                Math.ceil(rawRequiredColumns / reservationBlock) * reservationBlock,
            ),
        );
        inputWideReservationColumns = exposeWideInput
            ? Math.max(inputWideReservationColumns, requiredColumns)
            : inputWideReservationColumns;
        // Mostrar la línea (scroll horizontal) depende del ancho visible; la
        // rejilla ya suele estar en 1024 columnas y solo crece si hace falta.
        if (exposeWideInput && requiredColumns > currentDisplayCols()) fitAndReport(requiredColumns);
        if (requiredColumns > previousColumns) {
            return Promise.all([queueInputPtyResize(requiredColumns), ptyWarmupBarrier]).then(() => undefined);
        }
        return Promise.all([warmupBarrier, ptyWarmupBarrier]).then(() => undefined);
    }

    // La salida puede llegar ya dividida por ConPTY antes de que xterm haya
    // podido marcar las filas envueltas. Medir el bloque original recibido
    // por la PTY conserva la anchura lógica de la línea y permite a xterm
    // replegarla en una sola fila al aplicar el siguiente resize. Se eliminan
    // las secuencias ANSI y los controles de cursor, pero se respetan CR/LF
    // porque una barra de progreso puede actualizar la misma línea con CR.
    function estimateOutputChunkColumns(data: string | undefined): number {
        if (!data) return 0;
        // Durante el eco de una orden normal, una ráfaga de ConPTY puede
        // repetir el mismo fragmento ANSI varias veces. No convertir esa
        // repetición en una reserva de 16k: la entrada ya quedó precalentada
        // con `MAX_INPUT_RESERVATION_COLS` y el resultado real se medirá en
        // las filas posteriores. Una orden que de verdad supera ese límite
        // conserva el tope completo cuando su longitud lógica también lo
        // demuestra.
        const inputEchoLimit = inputLineSubmitted
            && (submittedCommand?.length ?? 0) <= MAX_INPUT_RESERVATION_COLS
            ? MAX_INPUT_RESERVATION_COLS
            : MAX_HORIZONTAL_COLS;
        const plain = data
            .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
            .replace(/\x1b[()][0-2A-Z]/gu, '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '');
        let longest = 0;
        const lines = plain.split(/[\r\n]/u);
        let logicalLine = outputLogicalLineColumns;
        for (const [index, line] of lines.entries()) {
            logicalLine += Array.from(line).length;
            longest = Math.max(longest, logicalLine);
            if (index < lines.length - 1) logicalLine = 0;
            if (longest >= inputEchoLimit) {
                outputLogicalLineColumns = 0;
                return inputEchoLimit;
            }
        }
        outputLogicalLineColumns = logicalLine;
        return Math.min(inputEchoLimit, longest);
    }

    // La PTY puede crecer hasta la línea visible más larga. El host conserva
    // un único scroll horizontal, mientras el viewport interno de xterm solo
    // gestiona el eje vertical. Así la salida completa sigue siendo accesible
    // después de cambiar resolución o volver a una línea más corta.
    const MAX_HORIZONTAL_COLS = 16384;
    let horizontalCanScrollRight = $state(false);
    let horizontalViewport: HTMLElement | undefined;
    let horizontalStateFrame: number | undefined;
    let horizontalRepaintFrame: number | undefined;
    // Un scroll horizontal manual no debe ser corregido por el evento de
    // cursor que xterm emite al repintar la misma fila. El bloqueo es corto y
    // solo cubre el gesto actual; una tecla nueva vuelve a llevar el cursor a
    // la vista de edición de forma normal.
    let horizontalScrollLockUntil = 0;
    let horizontalProgrammaticScroll = false;
    // Una barra horizontal arrastrada por el usuario conserva su posición
    // aunque xterm repinte el cursor. Se libera únicamente al empezar una
    // nueva edición o al volver explícitamente al extremo izquierdo/derecho.
    let horizontalUserScrolled = false;
    let horizontalProgrammaticScrollToken = 0;
    // Solo un gesto real (puntero pulsado o rueda reciente) cuenta como scroll
    // del usuario. El navegador también desplaza el host por su cuenta para
    // mantener visible el textarea de xterm, que sigue al cursor; tomar ese
    // desplazamiento nativo por el usuario bloqueaba el seguimiento y dejaba
    // el cursor pegado al borde o medio fuera.
    let horizontalPointerDown = false;
    let lastHorizontalGestureAt = 0;
    const HORIZONTAL_GESTURE_WINDOW_MS = 800;

    function setHorizontalScrollLeft(viewport: HTMLElement, value: number, holdFrames = 2): void {
        const token = ++horizontalProgrammaticScrollToken;
        horizontalProgrammaticScroll = true;
        viewport.scrollLeft = value;
        let framesLeft = Math.max(1, holdFrames);
        const release = () => {
            if (token !== horizontalProgrammaticScrollToken) return;
            if (framesLeft > 0) {
                framesLeft -= 1;
                window.requestAnimationFrame(release);
                return;
            }
            horizontalProgrammaticScroll = false;
        };
        window.requestAnimationFrame(release);
    }

    function getHorizontalViewport(): HTMLElement | undefined {
        // `.xterm-viewport` y `.xterm-screen` son hermanos: el primero solo
        // desplaza el scrollback vertical y nunca llega a contabilizar el
        // ancho del lienzo. El contenedor que sí envuelve ambos es
        // `terminalHost`, por lo que ahí vive el eje horizontal.
        return terminalHost ?? horizontalViewport;
    }

    /** El eje X pertenece al host común; el viewport interno conserva solo
     * el scroll vertical para evitar dos barras desincronizadas. */
    function enforceSingleHorizontalScrollContainer(): void {
        if (!terminalHost) return;
        const innerViewport = terminalHost.querySelector<HTMLElement>('.xterm-viewport');
        const scrollableElement = terminalHost.querySelector<HTMLElement>('.xterm-scrollable-element');
        innerViewport?.style.setProperty('overflow-x', 'hidden', 'important');
        scrollableElement?.style.setProperty('overflow-x', 'hidden', 'important');
        for (const row of terminalHost.querySelectorAll<HTMLElement>('.xterm-rows, .xterm-rows > div')) {
            // Las filas pueden ser más anchas que el viewport, pero no deben
            // convertirse en otra barra: el desplazamiento horizontal vive
            // exclusivamente en terminal-host. El pseudo-elemento de cola y
            // el ancho físico del screen conservan los glifos del extremo.
            // El texto de una fila puede ocupar unas celdas más que el
            // rectángulo publicado por xterm durante un reflow. Mantenerlo
            // visible deja que el host único contabilice esa cola; `visible`
            // no crea una barra secundaria porque la fila no es scrollable.
            row.style.setProperty('overflow', 'visible', 'important');
        }
    }

    // Algunos builds de xterm mantienen la anchura de su raíz en el tamaño
    // del host aunque el CSS de la rejilla ya tenga una variable más grande.
    // Fijar el ancho físico en el nodo raíz evita que el flex interno lo
    // vuelva a encoger y garantiza que el scroll horizontal pertenezca al
    // único `terminal-host`.
    function syncTerminalRootWidth(width: number): void {
        if (!terminalHost) return;
        const root = terminalHost.querySelector<HTMLElement>('.xterm');
        if (!root) return;
        const cssWidth = `${Math.max(terminalHost.clientWidth, Math.ceil(width))}px`;
        const hasHorizontalOverflow = width > terminalHost.clientWidth + 1;
        terminalHost.dataset.horizontalTail = String(hasHorizontalOverflow);
        terminalHost.style.overflowX = hasHorizontalOverflow ? 'auto' : 'hidden';
        if (!hasHorizontalOverflow) {
            terminalHost.style.removeProperty('--horizontal-tail-left');
            terminalHost.style.removeProperty('--horizontal-tail-width');
        }
        let spacer = terminalHost.querySelector<HTMLElement>('.terminal-width-spacer');
        // xterm puede limpiar el contenido inicial del host al abrirse; en
        // ese caso recreamos el espaciador después del montaje y seguimos
        // usando el mismo contenedor horizontal.
        if (!spacer) {
            spacer = document.createElement('div');
            spacer.className = 'terminal-width-spacer';
            spacer.setAttribute('aria-hidden', 'true');
            terminalHost.appendChild(spacer);
        }
        spacer?.style.setProperty('width', cssWidth, 'important');
        spacer?.style.setProperty('min-width', cssWidth, 'important');
        root.style.setProperty('width', cssWidth, 'important');
        root.style.setProperty('min-width', cssWidth, 'important');
        root.style.setProperty('max-width', 'none', 'important');
        root.style.setProperty('flex', '0 0 auto', 'important');
        const screen = root.querySelector<HTMLElement>('.xterm-screen');
        screen?.style.setProperty('width', '100%', 'important');
        screen?.style.setProperty('min-width', '100%', 'important');
        screen?.style.setProperty('max-width', 'none', 'important');
        screen?.style.setProperty('flex', '0 0 100%', 'important');
        const refreshSpacer = () => {
            if (destroyed || !terminalHost || !spacer || !root.isConnected) return;
            // Mientras el usuario está leyendo el extremo derecho, el ancho
            // publicado ya es la medida lógica de la línea. El rectángulo del
            // screen puede incluir el desplazamiento/reflow del frame anterior
            // y crecer otra vez al leerlo aquí; no lo uses como nueva medida.
            const horizontalReadInProgress = horizontalUserScrolled
                && terminalHost.scrollLeft > 1;
            // Cuando el ancho lógico ya supera el panel, el rectángulo del
            // root/screen puede ser el de la rejilla preventiva anterior y
            // volver a inflar el spacer en este mismo frame. Respetar `width`
            // mantiene el máximo del scroll alineado con los glifos medidos;
            // el margen de celdas se añade en `fitAndReport` cuando hace falta.
            const renderedWidth = width > terminalHost.clientWidth + 1
                ? width
                : Math.max(
                    width,
                    ...(horizontalReadInProgress
                        ? []
                        : [
                            root.getBoundingClientRect().width,
                            root.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect().width ?? 0,
                        ]),
                );
            const renderedCssWidth = `${Math.max(terminalHost.clientWidth, Math.ceil(renderedWidth))}px`;
            if (spacer.style.width !== renderedCssWidth) spacer.style.setProperty('width', renderedCssWidth, 'important');
            if (spacer.style.minWidth !== renderedCssWidth) spacer.style.setProperty('min-width', renderedCssWidth, 'important');
            const renderedOverflow = renderedWidth > terminalHost.clientWidth + 1;
            terminalHost.dataset.horizontalTail = String(renderedOverflow);
            terminalHost.style.overflowX = renderedOverflow ? 'auto' : 'hidden';
            if (!renderedOverflow) {
                terminalHost.style.removeProperty('--horizontal-tail-left');
                terminalHost.style.removeProperty('--horizontal-tail-width');
            }
            const pane = terminalHost.closest<HTMLElement>('.tab-pane');
            if (pane) pane.dataset.horizontalOverflow = String(renderedOverflow);
        };
        requestAnimationFrame(refreshSpacer);
        requestAnimationFrame(() => requestAnimationFrame(refreshSpacer));
    }

    function terminalCellWidth(): number {
        const core = (term as any)?._core;
        const measured = core?._renderService?.dimensions?.css?.cell?.width ?? 0;
        if (measured > 0) return measured;
        // Durante el primer frame después de dividir xterm aún puede no
        // haber publicado `_renderService.dimensions`. El screen ya tiene un
        // rectángulo físico y sus columnas actuales, que proporcionan una
        // medida estable para decidir si hay que replegar el canvas.
        // El screen ocupa el ancho publicado (columnas visibles), no la
        // rejilla completa de 1024 columnas que comparte con ConPTY.
        const screenWidth = terminalHost?.querySelector('.xterm-screen')?.getBoundingClientRect().width ?? 0;
        const columns = currentDisplayCols();
        return screenWidth > 0 && columns > 0 ? screenWidth / columns : 0;
    }

    function terminalCellHeight(): number {
        const core = (term as any)?._core;
        const measured = core?._renderService?.dimensions?.css?.cell?.height ?? 0;
        if (measured > 0) return measured;
        const screenHeight = terminalHost?.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? 0;
        const rows = term?.rows ?? 0;
        return screenHeight > 0 && rows > 0 ? screenHeight / rows : 0;
    }

    function measureVisibleDomContent(cellWidth: number): { overflowColumns: number; contentWidth: number } {
        if (!terminalHost || !cellWidth || cellWidth <= 0) return { overflowColumns: 0, contentWidth: 0 };
        const normalizedCommand = (submittedCommand ?? '').replace(/\s+/gu, ' ');
        const hostLeft = terminalHost.getBoundingClientRect().left;
        const horizontalViewport = getHorizontalViewport();
        // Cuando el usuario está leyendo el extremo derecho, los rectángulos
        // DOM ya están desplazados por `scrollLeft`. Usarlos como coordenadas
        // absolutas vuelve a sumar el desplazamiento en cada ResizeObserver y
        // hace crecer la rejilla 7200→115200 px, dejando el canvas vacío. En
        // ese estado la longitud lógica de la fila es la única medida estable.
        const horizontallyScrolled = horizontalUserScrolled
            || (horizontalViewport?.scrollLeft ?? 0) > 1;
        // `term.cols` puede conservar una reserva anterior y ser casi tan
        // grande como la fila lógica aunque el canvas siga recortado al ancho
        // visible. La decisión de ampliar debe compararse con el viewport
        // actual, no con esa reserva histórica.
        const visibleColumns = Math.max(1, Math.floor(terminalHost.clientWidth / cellWidth));
        let longestOverflowColumns = 0;
        let longestContentWidth = 0;
        for (const row of terminalHost.querySelectorAll('.xterm-rows > div')) {
            const text = row.textContent ?? '';
            const normalizedText = text.replace(/\s+/gu, ' ');
            if (!normalizedText || isShellInputLine(normalizedText)) continue;
            if (/(?:powershell|\.ps1|[A-Za-z]:[\\/]|(?:^|\s)(?:cmd|bash|sh)(?:\s|$))/iu.test(normalizedText)) continue;
            // Las continuaciones del eco no llevan el prompt y no se pueden
            // distinguir por sí solas; si forman parte de la orden activa,
            // quedan fuera de la medida de salida.
            if (normalizedCommand.length >= 24
                && (normalizedCommand.includes(normalizedText)
                    || normalizedCommand.endsWith(normalizedText))) continue;
            const rowRect = row.getBoundingClientRect();
            let right = Math.max(
                rowRect.right,
                ...[...row.children].map((child) => child.getBoundingClientRect().right),
            );
            // xterm puede conservar una fila lógica larga como un nodo de
            // texto directo. En ese caso el rectángulo de `.xterm-rows > div`
            // solo cubre la rejilla actual y no refleja los glifos que se
            // pintan fuera de ella; el resultado era un extremo numérico
            // visible hasta 113 aunque 114–120 siguieran en el DOM. Medir el
            // Range del texto publica el borde real sin crear un viewport
            // secundario ni depender de que xterm genere spans.
            const logicalTextColumns = Array.from(row.textContent ?? '').length;
            // Borde real de los glifos. La fila mide toda la rejilla compartida
            // con ConPTY (>= 1024 columnas), así que el texto ya no «rebasa»
            // su caja: hay que compararlo con el ancho visible del host.
            let textRight = 0;
            if (logicalTextColumns > Math.max(1, visibleColumns + 1)) {
                // Cuando WebView2 recorta el Range al canvas actual, su borde
                // derecho no contiene ninguna pista de la parte que falta.
                // La fuente monoespaciada sí permite reconstruir ese límite:
                // cada carácter ocupa una celda de `cellWidth` aunque todavía
                // no tenga un rectángulo pintado.
                right = Math.max(right, rowRect.left + logicalTextColumns * cellWidth);
                // El rectángulo de la fila puede estar limitado al canvas
                // recortado, así que `overflowWidth` no siempre supera
                // `row.clientWidth`. La longitud lógica sí es una prueba
                // directa de que hay que reservar todas sus columnas.
                longestOverflowColumns = Math.max(longestOverflowColumns, logicalTextColumns);
                const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    const node = walker.currentNode as Text;
                    if (!node.data) continue;
                    const range = document.createRange();
                    range.setStart(node, 0);
                    range.setEnd(node, node.data.length);
                    const rangeRight = range.getBoundingClientRect().right;
                    right = Math.max(right, rangeRight);
                    textRight = Math.max(textRight, rangeRight);
                }
            }
            // `scrollWidth` pertenece a la fila y no incorpora el scrollLeft
            // del host. Cuando WebView2 mantiene glifos fuera del rectángulo
            // del canvas, es la medida física estable que necesitamos; el
            // ancho lógico actúa como respaldo si aún no se ha publicado.
            const rowScrollWidth = Math.max(0, row.scrollWidth || 0);
            const logicalContentWidth = logicalTextColumns * cellWidth;
            const overflowContentWidth = Math.max(
                !horizontallyScrolled && rowScrollWidth > row.clientWidth + 1 ? rowScrollWidth : 0,
                logicalContentWidth > row.clientWidth + cellWidth
                    ? rowRect.left - hostLeft + logicalContentWidth
                    : 0,
                // Solo usar el rectángulo cuando realmente rebasa la caja de
                // la fila. Tomarlo siempre como base vuelve a medir el root
                // completo y puede alimentar una expansión acumulativa.
                !horizontallyScrolled && right > rowRect.left + row.clientWidth + 1
                    ? right - hostLeft
                    : 0,
                !horizontallyScrolled && textRight > hostLeft + terminalHost.clientWidth + 1
                    ? textRight - hostLeft
                    : 0,
            );
            longestContentWidth = Math.max(longestContentWidth, Math.ceil(overflowContentWidth));
            const overflowWidth = right - rowRect.left;
            if (overflowWidth > row.clientWidth + 1) {
                longestOverflowColumns = Math.max(longestOverflowColumns, Math.ceil(overflowWidth / cellWidth));
            }
            if (!horizontallyScrolled && textRight > hostLeft + terminalHost.clientWidth + 1) {
                longestOverflowColumns = Math.max(
                    longestOverflowColumns,
                    Math.ceil((textRight - rowRect.left) / cellWidth),
                );
            }
        }
        return {
            overflowColumns: Math.min(MAX_HORIZONTAL_COLS, longestOverflowColumns),
            contentWidth: Math.max(0, longestContentWidth),
        };
    }

    function updateHorizontalTailReservation(cellWidth: number): void {
        if (!terminalHost || !cellWidth || cellWidth <= 0) return;
        if (terminalHost.dataset.horizontalTail !== 'true') {
            terminalHost.style.removeProperty('--horizontal-tail-left');
            terminalHost.style.removeProperty('--horizontal-tail-width');
            return;
        }
        const measurement = measureVisibleDomContent(cellWidth);
        const screenWidth = terminalHost.querySelector('.xterm-screen')?.getBoundingClientRect().width ?? 0;
        // La rejilla aporta una base estable, pero una fila puede conservar
        // glifos reales más allá de esa anchura durante el reflow. Tomar el
        // máximo evita tanto recortar el final como crear una cola corta.
        const measuredContentWidth = Math.max(screenWidth, measurement.contentWidth);
        // La cola ocupa el margen final dentro del ancho ya medido. Si se
        // añadiera después del último glifo, el extremo de scroll quedaría en
        // una zona vacía y ocultaría precisamente los últimos caracteres.
        const tailWidth = 640;
        terminalHost.style.setProperty(
            '--horizontal-tail-left',
            `${Math.max(0, Math.ceil(measuredContentWidth - tailWidth))}px`,
        );
        terminalHost.style.setProperty(
            '--horizontal-tail-width',
            '640px',
        );
    }

    /** Mide las líneas lógicas que siguen en el buffer de xterm.
     *
     * Una salida larga puede haber quedado temporalmente envuelta antes de
     * que llegue el evento de reposo de la PTY. Si solo se inspecciona la
     * ventana visible, la primera parte de esa línea puede estar en el
     * scrollback y el ancho se calcula como si la cola no existiera. Recorrer
     * el buffer completo permite replegar la línea con la nueva rejilla y
     * conservarla accesible mediante el único scroll horizontal del host.
     */
    function longestVisibleLineWidth(): number {
        if (!term) return 0;
        const terminal = term;
        const buffer = terminal.buffer.active;
        const cursorAbsoluteRow = buffer.baseY + buffer.cursorY;
        const ignoredInputLineStarts = new Set<number>();
        const command = submittedCommand;
        if (command) {
            const visited = new Set<number>();
            const firstRow = 0;
            const lastRow = buffer.length;
            for (let row = firstRow; row < lastRow; row += 1) {
                let lineStart = row;
                while (lineStart > 0 && buffer.getLine(lineStart)?.isWrapped) lineStart -= 1;
                if (visited.has(lineStart)) continue;
                visited.add(lineStart);
                let text = '';
                for (let part = lineStart; part < lastRow; part += 1) {
                    const line = buffer.getLine(part);
                    text += line?.translateToString(true) ?? '';
                    if (!buffer.getLine(part + 1)?.isWrapped) break;
                }
                // El eco suele llevar el prompt delante y xterm puede insertar
                // una separación al replegar una palabra justo en el borde.
                // Para órdenes largas exigimos principio y final: así no se
                // descarta una salida que solo comparte un fragmento, pero sí
                // se reconoce el eco aunque el renderer haya refluido la fila.
                const normalizedText = text.replace(/\s+/gu, ' ');
                const normalizedCommand = command.replace(/\s+/gu, ' ');
                const isLongCommand = normalizedCommand.length >= 32;
                const promptLike = isShellInputLine(normalizedText) || /^~(?:\s|$)/u.test(normalizedText);
                const commandMatches = isLongCommand
                    ? (normalizedText.includes(normalizedCommand.slice(0, 16))
                        || normalizedText.includes(normalizedCommand.slice(-16)))
                    : normalizedText.includes(normalizedCommand);
                // Algunas shells reenvuelven o colorean el eco de una orden
                // larga antes de que el espejo de entrada conserve el texto
                // completo. Su prompt sigue siendo una señal inequívoca de
                // que la línea es entrada del usuario, no salida que deba
                // ensanchar la rejilla horizontal.
                const shellInputLike = isShellInputLine(normalizedText);
                // Una vez que Enter terminó, el eco largo sigue en el
                // scrollback pero continúa siendo entrada, no salida que
                // deba pedir 16k columnas. Solo se conserva la medición
                // durante la ráfaga de salida real.
                const preserveSubmittedInput = terminalOutputBusy;
                if (!preserveSubmittedInput && (commandMatches || (isLongCommand && (promptLike || shellInputLike)))) {
                    ignoredInputLineStarts.add(lineStart);
                }
            }
        }
        // El driver y algunas shells pueden entregar una orden larga en un
        // solo bloque, sin poblar `submittedCommand`. Reconocer el prompt en
        // la propia pantalla cubre ese caso sin volver a tratar la entrada
        // como salida; solo se ignoran líneas realmente reenvueltas.
        const visibleInputStarts = new Set<number>();
        const firstRow = recentOutputStartRow(buffer, terminal);
        const lastRow = buffer.length;
        for (let row = firstRow; row < lastRow; row += 1) {
            let lineStart = row;
            while (lineStart > 0 && buffer.getLine(lineStart)?.isWrapped) lineStart -= 1;
            if (visibleInputStarts.has(lineStart)) continue;
            visibleInputStarts.add(lineStart);
            let text = '';
            for (let part = lineStart; part < lastRow; part += 1) {
                text += buffer.getLine(part)?.translateToString(true) ?? '';
                if (!buffer.getLine(part + 1)?.isWrapped) break;
            }
            const normalizedText = text.replace(/\s+/gu, ' ');
            const shellInputLike = isShellInputLine(normalizedText);
            if (shellInputLike && text.length > terminal.cols && !inputLineSubmitted && !terminalOutputBusy) {
                ignoredInputLineStarts.add(lineStart);
            }
        }
        const recentFirstRow = recentOutputStartRow(buffer, terminal);
        return longestVisibleLogicalLineWidth(
            buffer.length,
            recentFirstRow,
            buffer.length - recentFirstRow,
            (row) => {
                const line = buffer.getLine(row);
                const visibleText = line?.translateToString(true).trimStart() ?? '';
                // El banner de arranque/clear se adapta verticalmente al
                // panel. Sus campos pueden ocupar 64 columnas en una sola
                // fila cuando se imprimieron con la rejilla anterior, pero
                // no deben convertir un panel estrecho en scroll horizontal.
                // Las salidas de comandos no usan estas cabeceras y siguen
                // midiendo toda su longitud real.
                if (/^(?:WTerminal|LTerminal|Sistema|System|CPU\s|Uptime\s|Tiempo\s+activo|Memoria\s|Memory\s|Plataforma\s|Platform\s)/iu.test(visibleText)) {
                    return line ? { columns: 0, isWrapped: line.isWrapped } : undefined;
                }
                let lineStart = row;
                while (lineStart > 0 && buffer.getLine(lineStart)?.isWrapped) lineStart -= 1;
                if (ignoredInputLineStarts.has(lineStart)) {
                    return line ? { columns: 0, isWrapped: line.isWrapped } : undefined;
                }
                let columns = line
                    // Tras un reflow xterm puede conservar celdas visibles
                    // más allá de `term.cols`. Medir solo las columnas
                    // actuales deja la fila DOM desbordada y recorta sus
                    // últimos glifos en el canvas; la longitud real de la
                    // fila es el límite correcto para este contenido activo.
                    ? Math.max(
                        occupiedTerminalColumns(line, Math.max(terminal.cols, line.length), MAX_HORIZONTAL_COLS),
                        // Cuando xterm conserva una fila sobre el límite de
                        // columnas, translateToString mantiene sus glifos
                        // aunque `line.length` ya refleje la rejilla vieja.
                        Math.min(MAX_HORIZONTAL_COLS, line.translateToString(true).length),
                    )
                    : 0;
                if (row === cursorAbsoluteRow) {
                    // `translateToString(true)` recorta los espacios finales. En
                    // una línea que solo contiene espacios la posición del cursor
                    // es, por tanto, el único dato que conserva el ancho real de
                    // la edición. Reservar una celda extra cuando llega al borde
                    // evita que el siguiente espacio provoque un salto de línea.
                    const cursorWidth = buffer.cursorX + (buffer.cursorX >= terminal.cols - 1 ? 2 : 1);
                    // Después de dividir un panel xterm puede conservar
                    // momentáneamente cursorX en la última columna de la
                    // rejilla anterior, aunque la fila actual solo contenga
                    // un prompt corto. No convertir esa posición fantasma
                    // en 64 columnas evita crear una cola horizontal de
                    // 640px en un panel de 32 columnas. Durante una edición
                    // real sí conservamos la reserva, incluidos espacios.
                    const trimmedRowLength = line?.translateToString(true).length ?? 0;
                    const cursorMatchesContent = cursorWidth <= trimmedRowLength + 2
                        || trimmedRowLength >= terminal.cols - 4;
                    if (cursorMatchesContent) columns = Math.max(columns, cursorWidth);
                }
                return line ? { columns, isWrapped: line.isWrapped } : undefined;
            },
            // La entrada usa una reserva acotada para no reenvolver el prompt
            // en cada pulsación, pero una salida ya confirmada puede ser más
            // larga. Si aplicamos aquí el límite de entrada, una línea como
            // 1–2048 queda partida en dos filas y el extremo derecho solo
            // muestra el final de la primera; el resto existe en el buffer,
            // pero queda fuera del único scroll horizontal.
            MAX_HORIZONTAL_COLS,
        );
    }

    // La salida que puede pedir ancho está entre la orden anterior y el
    // prompt actual. Usar ese tramo evita que una línea larga del banner o de
    // un comando viejo mantenga la rejilla artificialmente ancha.
    function recentOutputStartRow(buffer: NonNullable<Terminal['buffer']['active']>, terminal: Terminal): number {
        const promptRows: number[] = [];
        for (let row = buffer.length - 1; row >= 0 && promptRows.length < 2; row -= 1) {
            const text = buffer.getLine(row)?.translateToString(true) ?? '';
            if (text && isShellInputLine(text)) promptRows.push(row);
        }
        if (promptRows.length >= 2) return Math.min(buffer.length, promptRows[1] + 1);
        return Math.max(0, buffer.length - Math.max(terminal.rows * 4, 64));
    }

    // ConPTY puede entregar una línea larga como varias filas completas sin
    // marcar las continuaciones con `isWrapped`. En ese caso el buffer tiene
    // todo el texto, pero la métrica lógica solo ve filas de `term.cols` y no
    // llega a crear el ancho físico del host. Inferir únicamente las rachas
    // contiguas de filas llenas evita perder la cola sin cambiar el ancho de
    // comandos normales o prompts posteriores.
    function inferUnmarkedWrappedOutputColumns(): number {
        if (!term) return 0;
        const buffer = term.buffer.active;
        const viewportColumns = Math.max(1, term.cols);
        const normalizedCommand = (submittedCommand ?? '').replace(/\s+/gu, ' ').trim();
        // ConPTY puede entregar el eco de una orden larga como varias filas
        // completas sin marcar `isWrapped`. La primera fila contiene el
        // prompt y las continuaciones parecen salida normal, por lo que una
        // simple racha de filas llenas convertiría el propio comando en una
        // reserva horizontal. Reconocer fragmentos contiguos del comando
        // evita ensanchar la rejilla por el eco, pero deja intactas las
        // barras y resultados que no pertenecen a la entrada.
        const preserveSubmittedInput = terminalOutputBusy;
        const commandLooksLikeInput = (text: string, row: number): boolean => {
            if (preserveSubmittedInput) return false;
            if (normalizedCommand.length < 24) return false;
            const normalizedText = text.replace(/\s+/gu, ' ').trim();
            if (!normalizedText || normalizedText.length < 8) return false;
            if (isShellInputLine(normalizedText)) return true;
            // Una salida como `echo """...` puede ser literalmente un
            // fragmento contenido en la orden enviada. No la descartes solo
            // por compartir caracteres: únicamente las continuaciones de una
            // fila que empieza con el prompt pertenecen al eco de entrada.
            let lineStart = row;
            while (lineStart > 0 && buffer.getLine(lineStart)?.isWrapped) lineStart -= 1;
            const firstText = buffer.getLine(lineStart)?.translateToString(true) ?? '';
            if (lineStart !== row && isShellInputLine(firstText.replace(/\s+/gu, ' ').trim())) return true;
            const prefix = normalizedText.slice(0, Math.min(24, normalizedText.length));
            const suffix = normalizedText.slice(-Math.min(24, normalizedText.length));
            const commandPrefix = normalizedCommand.slice(0, Math.min(24, normalizedCommand.length));
            return normalizedText.includes(commandPrefix)
                || (prefix.length >= 24 && normalizedCommand.startsWith(prefix)
                    && normalizedCommand.endsWith(suffix));
        };
        let longest = 0;
        const firstRecentRow = recentOutputStartRow(buffer, term);
        for (let row = firstRecentRow; row < buffer.length; row += 1) {
            const line = buffer.getLine(row);
            const text = line?.translateToString(true) ?? '';
            if (!line || !text || isShellInputLine(text)
                 || commandLooksLikeInput(text, row)
                || /^(?:WTerminal|LTerminal|Sistema|System|CPU\s|Uptime\s|Tiempo\s+activo|Memoria\s|Memory\s|Plataforma\s|Platform\s)/iu.test(text.trimStart())) continue;
            const firstColumns = occupiedTerminalColumns(line, Math.max(viewportColumns, line.length), MAX_HORIZONTAL_COLS);
            if (firstColumns < viewportColumns - 1) continue;
            let total = firstColumns;
            for (let next = row + 1; next < buffer.length; next += 1) {
                const continuation = buffer.getLine(next);
                const continuationText = continuation?.translateToString(true) ?? '';
                if (!continuation || !continuationText || isShellInputLine(continuationText)
                    || commandLooksLikeInput(continuationText, next)
                    || /^(?:WTerminal|LTerminal|Sistema|System|CPU\s|Uptime\s|Tiempo\s+activo|Memoria\s|Memory\s|Plataforma\s|Platform\s)/iu.test(continuationText.trimStart())) break;
                const continuationColumns = occupiedTerminalColumns(
                    continuation,
                    Math.max(viewportColumns, continuation.length),
                    MAX_HORIZONTAL_COLS,
                );
                if (continuationColumns <= 0) break;
                total = Math.min(MAX_HORIZONTAL_COLS, total + continuationColumns);
                if (continuationColumns < viewportColumns - 1) break;
            }
            longest = Math.max(longest, total);
            if (longest >= MAX_HORIZONTAL_COLS) return MAX_HORIZONTAL_COLS;
        }
        return longest;
    }

    function visibleLineNeedsHorizontalScroll(viewport: HTMLElement): boolean {
        if (!term) return false;
        const cellWidth = terminalCellWidth();
        if (!cellWidth) return false;
        const visibleCols = Math.max(1, Math.floor(viewport.clientWidth / cellWidth));
        const buffer = term.buffer.active;
        const firstRow = buffer.viewportY;
        for (let row = 0; row < term.rows; row += 1) {
            const line = buffer.getLine(firstRow + row);
            if (line && occupiedTerminalColumns(line, Math.max(term.cols, line.length), MAX_HORIZONTAL_COLS) > visibleCols) return true;
        }
        return false;
    }

    function updateHorizontalScrollState(): void {
        horizontalStateFrame = undefined;
        const viewport = getHorizontalViewport();
        if (!viewport) {
            horizontalCanScrollRight = false;
            return;
        }
        const canScrollRight = viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1;
        const cellWidth = terminalCellWidth();
        const visibleCols = cellWidth > 0
            ? Math.max(1, Math.floor(viewport.clientWidth / cellWidth))
            : currentDisplayCols();
        const visibleOverflow = visibleLineNeedsHorizontalScroll(viewport);
        // El canvas puede conservar temporalmente una línea ancha en scrollback,
        // pero si existe overflow físico el usuario debe poder alcanzarlo aunque
        // la fila larga no sea la que xterm tiene en `viewportY` en ese frame.
        // Ocultar la barra en ese instante hacía que cualquier intento de moverla
        // volviera a `scrollLeft = 0` al siguiente ResizeObserver.
        const reservedOverflow = reservedOutputColumns > visibleCols + 1;
        const physicalOverflow = viewport.scrollWidth > viewport.clientWidth + 1 || reservedOverflow;
        if (terminalHost) terminalHost.style.overflowX = physicalOverflow ? 'auto' : 'hidden';
        horizontalCanScrollRight = canScrollRight && (visibleOverflow || physicalOverflow);
        if (host) host.dataset.horizontalOverflow = String(horizontalCanScrollRight);
    }

    function scheduleHorizontalScrollState(): void {
        if (horizontalStateFrame !== undefined) return;
        horizontalStateFrame = window.requestAnimationFrame(updateHorizontalScrollState);
    }

    function onHorizontalViewportScroll(): void {
        if (!horizontalProgrammaticScroll) {
            const userGesture = horizontalPointerDown
                || performance.now() - lastHorizontalGestureAt < HORIZONTAL_GESTURE_WINDOW_MS;
            if (userGesture) {
                horizontalUserScrolled = true;
                // No expirar mientras el usuario está arrastrando o leyendo una
                // línea larga. La entrada de una tecla nueva lo libera abajo.
                horizontalScrollLockUntil = Number.POSITIVE_INFINITY;
            } else {
                // Desplazamiento nativo (textarea de xterm): se corrige en el
                // frame siguiente con el margen normal del cursor.
                window.requestAnimationFrame(() => {
                    if (!destroyed) keepCursorHorizontallyVisible();
                });
            }
        }
        scheduleHorizontalScrollState();
        // WebView2 puede conservar la textura anterior de xterm cuando el
        // lienzo se desplaza dentro del host. Invalidar el atlas en el mismo
        // frame hace que el extremo derecho visible coincida con el scroll
        // real y evita capturas con los últimos glifos ausentes.
        if (horizontalRepaintFrame !== undefined) return;
        horizontalRepaintFrame = window.requestAnimationFrame(() => {
            horizontalRepaintFrame = undefined;
            if (destroyed || !term) return;
            try {
                term.clearTextureAtlas();
                term.refresh(0, Math.max(0, term.rows - 1));
                // WebView2 puede aplicar el desplazamiento al host un frame
                // después de que xterm haya repintado el canvas. Un segundo
                // refresco en el frame siguiente evita capturas y pantallas
                // negras al llegar al extremo de una rejilla muy ancha.
                window.requestAnimationFrame(() => {
                    if (destroyed || !term) return;
                    try {
                        term.clearTextureAtlas();
                        term.refresh(0, Math.max(0, term.rows - 1));
                    } catch (error) {
                        console.debug('[TerminalPane] segundo repintado horizontal omitido', error);
                    }
                });
            } catch (error) {
                console.debug('[TerminalPane] repintado tras scroll horizontal omitido', error);
            }
        });
    }

    function onTerminalWheel(event: WheelEvent): void {
        // La rueda normal pertenece al viewport de xterm y conserva el
        // scroll vertical. Shift convierte la rueda en navegación horizontal
        // sin exigir acertar con una barra de pocos píxeles de alto.
        if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
        const viewport = getHorizontalViewport();
        if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return;
        const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
        const normalizedDelta = normalizeWheelDelta(
            delta,
            event.deltaMode,
            Number.parseFloat(window.getComputedStyle(viewport).lineHeight),
            viewport.clientWidth,
        );
        if (normalizedDelta === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        viewport.scrollLeft = Math.max(0, Math.min(maxScrollLeft, viewport.scrollLeft + normalizedDelta));
        horizontalUserScrolled = true;
        horizontalScrollLockUntil = Number.POSITIVE_INFINITY;
        scheduleHorizontalScrollState();
    }

    // Al empezar una orden nueva, xterm puede emitir un movimiento de cursor
    // tardío perteneciente todavía a la fila ancha anterior. Si ese evento
    // llega durante el reflow, `keepCursorHorizontallyVisible` vuelve a llevar
    // el host al extremo derecho y la primera orden corta (por ejemplo `cls`)
    // aparece desplazada a mitad de línea. Reafirmar el anclaje durante dos
    // frames cubre el ciclo de layout y el repintado del canvas sin bloquear
    // el scroll horizontal de las órdenes que realmente siguen siendo largas.
    function resetHorizontalPromptViewport(): void {
        const viewport = getHorizontalViewport();
        if (!viewport) return;
        const reset = () => {
            if (destroyed || !userEditing) return;
            if (viewport.scrollLeft > 0) setHorizontalScrollLeft(viewport, 0);
        };
        reset();
        window.requestAnimationFrame(reset);
        window.requestAnimationFrame(() => window.requestAnimationFrame(reset));
    }

    /** Garantiza que el host pueda desplazarse hasta `requiredWidth` píxeles
     *  (acotado al ancho real de la rejilla de xterm). Solo crece. */
    function ensureHorizontalRoom(requiredWidth: number, cellWidth: number): void {
        if (!terminalHost || !term || cellWidth <= 0) return;
        const target = Math.min(Math.ceil(term.cols * cellWidth), Math.ceil(requiredWidth));
        if (target <= terminalHost.scrollWidth + 0.5) return;
        terminalHost.style.setProperty('--terminal-content-width', `${target}px`);
        syncTerminalRootWidth(target);
    }

    function keepCursorHorizontallyVisible(): void {
        const viewport = getHorizontalViewport();
        const cellWidth = terminalCellWidth();
        if (!viewport || !cellWidth || !term) return;
        if (horizontalUserScrolled || Date.now() < horizontalScrollLockUntil) return;
        const cursorLeft = term.buffer.active.cursorX * cellWidth;
        const cursorRight = cursorLeft + cellWidth;
        // Unas celdas de margen: pegado al borde, el cursor queda bajo la
        // barra vertical y el indicador de desbordamiento. Al volver hacia la
        // izquierda, si el cursor cabe en el primer tercio, se enseña la línea
        // desde el principio (con el prompt completo).
        const margin = Math.min(viewport.clientWidth / 4, cellWidth * 3);
        if (cursorLeft < viewport.scrollLeft + margin) {
            const target = cursorLeft - margin;
            setHorizontalScrollLeft(viewport, target < viewport.clientWidth / 3 ? 0 : target);
        } else if (cursorRight > viewport.scrollLeft + viewport.clientWidth - margin) {
            // El ancho desplazable lo publican varias rutas (reserva de
            // entrada, medición del DOM) y una medición puede dejarlo en lo
            // que ocupaba la línea hace unas teclas. Si el cursor no cabe, se
            // amplía aquí en bloques de 64 columnas, sin pasar de la rejilla.
            ensureHorizontalRoom(cursorRight + margin + cellWidth * 64, cellWidth);
            setHorizontalScrollLeft(viewport, cursorRight - viewport.clientWidth + margin);
        }
        scheduleHorizontalScrollState();
    }

    function horizontalResizeNeeded(): boolean {
        const viewport = getHorizontalViewport();
        const cellWidth = terminalCellWidth();
        if (!viewport || !cellWidth || !term) return false;
        const visibleCols = Math.max(1, Math.floor(viewport.clientWidth / cellWidth));
        const promptColumns = minimumPromptColumns();
        // Si no existe una reserva de salida confirmada, una matriz que quedó
        // más ancha que el panel solo puede ser el eco de una orden editada o
        // una medición vieja. Forzar su reducción evita que ese eco deje una
        // barra horizontal en la orden corta siguiente.
        const shownCols = currentDisplayCols();
        if (!outputBurstWide && inputWideReservationColumns === 0 && shownCols > visibleCols + 2) return true;
        const requiredCols = requiredTerminalColumns(
            visibleCols,
            Math.max(longestVisibleLineWidth(), pendingOutputColumns, inputWideReservationColumns, promptColumns),
            0,
            MAX_HORIZONTAL_COLS,
        );
        return requiredCols !== shownCols;
    }

    // WebView2 puede conservar una textura parcial de xterm justo después de
    // cambiar el número de columnas. El árbol accesible ya contiene toda la
    // línea, pero el canvas aún muestra huecos (se pierden fragmentos de
    // «Muestra... scrollback» hasta el siguiente repintado). Invalidar la
    // atlas y refrescar en varios frames hace atómica la transición visual.
    function refreshTerminalViewport(resetHorizontalScroll = false): void {
        if (destroyed || !term) return;
        try {
            // Al dividir un panel, xterm puede conservar la columna horizontal
            // que estaba visible en la geometría anterior. La textura se
            // repinta correctamente, pero comienza a mitad de cada línea (el
            // síntoma era «r|close>» en vez de «:panel ... <close>»). Solo
            // volver al margen izquierdo cuando la transición lo solicita:
            // durante la lectura horizontal un resize no debe hacer saltar al
            // usuario al principio de una secuencia larga.
            const viewport = getHorizontalViewport();
            if (viewport && resetHorizontalScroll) setHorizontalScrollLeft(viewport, 0, 3);
            term.clearTextureAtlas();
            term.refresh(0, Math.max(0, term.rows - 1));
        } catch (error) {
            console.debug('[TerminalPane] refresh tras resize omitido', error);
        }
    }

    function scheduleTerminalRepaint(): void {
        if (repaintTimer) window.clearTimeout(repaintTimer);
        refreshTerminalViewport();
        requestAnimationFrame(() => {
            refreshTerminalViewport();
            requestAnimationFrame(() => refreshTerminalViewport());
        });
        repaintTimer = window.setTimeout(() => {
            repaintTimer = undefined;
            refreshTerminalViewport();
        }, 120);
    }

    function refreshAfterWindowResume(): void {
        if (!active || destroyed || document.visibilityState === 'hidden'
            || !term?.element?.isConnected || resumeRefreshFrame !== undefined) return;
        resumeRefreshFrame = window.requestAnimationFrame(() => {
            resumeRefreshFrame = undefined;
            if (!active || destroyed || document.visibilityState === 'hidden'
                || !term?.element?.isConnected) return;
            try {
                // La ventana puede haber suspendido los frames mientras la
                // shell seguía escribiendo. Reparar solo el viewport visible
                // al volver, sin fit/resize ni cambios en el scroll del usuario.
                term.refresh(0, Math.max(0, term.rows - 1));
            } catch (error) {
                console.debug('[TerminalPane] repintado al volver omitido', error);
            }
        });
    }

    const onWindowFocus = () => refreshAfterWindowResume();
    const onDocumentVisibilityChange = () => {
        if (document.visibilityState === 'visible') refreshAfterWindowResume();
    };

    function eventBelongsToPane(event: Event): boolean {
        return (event as CustomEvent<{ tabId?: string }>).detail?.tabId === tabId;
    }

    function onProgrammaticCommandResize(detail: { tabId?: string; cols?: number; rows?: number }): void {
        if (detail?.tabId !== tabId || !term || destroyed) return;
        const previousCols = term.cols;
        const cols = Math.max(previousCols, Math.min(MAX_HORIZONTAL_COLS, Math.floor(detail.cols ?? 0)));
        const rows = Math.max(1, Math.floor(detail.rows ?? term.rows));
        const backendCols = Math.min(MAX_HORIZONTAL_COLS, Math.floor(detail.cols ?? 0));
        if (backendCols > 0) lastPtySize = { cols: backendCols, rows };
        if (cols <= term.cols && rows === term.rows) return;
        // El backend ya ha aplicado la misma geometría a ConPTY. Aplicarla
        // localmente antes de que llegue el eco mantiene el cursor y las
        // cabeceras en una sola línea; la salida posterior decidirá si hace
        // falta conservar o liberar el scroll horizontal.
        term.resize(cols, rows);
        outputBurstWide = cols > previousCols || outputBurstWide;
        reservedOutputColumns = Math.max(reservedOutputColumns, cols);
        pendingOutputColumns = Math.max(pendingOutputColumns, cols);
        fitAfterOutput = true;
        const commandCellWidth = terminalCellWidth();
        const commandContentWidth = Math.max(terminalHost?.clientWidth ?? 0, Math.ceil(cols * commandCellWidth));
        terminalHost?.style.setProperty('--terminal-content-width', `${commandContentWidth}px`);
        syncTerminalRootWidth(commandContentWidth);
        scheduleTerminalRepaint();
    }

    async function releaseInput(): Promise<void> {
        if (destroyed || inputReady || environmentSwitchPending) return;
        if (initialResizePending) {
            // El prompt puede ser reconocible antes de que la primera
            // geometría llegue a ConPTY. Esperar a la misma barrera que usa
            // el resize inicial evita que la primera orden se parta en una
            // fila nueva por conservar la anchura de arranque.
            pendingInputRelease = true;
            return;
        }
        // No abrir la compuerta de teclado hasta que ConPTY haya recibido la
        // reserva preventiva. En una ráfaga rápida, esperar solo al primer
        // `onData` llega tarde: cmd ya habría podido ecoar las primeras
        // columnas y sus continuaciones quedarían sin marcar.
        await warmupPtyForInput();
        if (destroyed || inputReady || environmentSwitchPending) return;
        if (term && term.cols < INPUT_PTY_WARMUP_COLS) {
            // Mantener xterm ancho desde que la shell queda lista evita que
            // cmd redibuje una línea larga con retornos de carro sobre la
            // rejilla estrecha. El host permanece oculto mientras no haya
            // contenido que desplazar; al superar el viewport, fitAndReport
            // publica la barra horizontal.
            localInputGridPinned = true;
            term.resize(INPUT_PTY_WARMUP_COLS, term.rows);
            terminalHost?.style.setProperty('--terminal-content-width', `${terminalHost.clientWidth}px`);
            if (terminalHost) terminalHost.style.overflowX = 'hidden';
        }
        inputReady = true;
        // El mismo cambio de estado que libera la entrada debe publicar la
        // compuerta visual. Dejar inputReady=true con startupReady=false
        // bloquea al siguiente comando tras cambiar de REPL (Ruby/JShell),
        // aunque su prompt ya esté pintado.
        reportStartupReady(true);
        // La reserva de 1024 columnas solo protege el primer eco. Una vez
        // abierto el teclado, dejarla marcada hace que cada ResizeObserver
        // salga antes de publicar `terminalCols/terminalRows`; las
        // redimensiones nativas quedan con el dataset en cero aunque el
        // canvas se vea. Mantenerla únicamente si aún hay una cola pendiente.
        if (!queuedInput) localInputGridPinned = false;
        inputReleaseFallbackDeadline = 0;
        exposeInputMirror('ready');
        if (inputReadyTimer) window.clearTimeout(inputReadyTimer);
        inputReadyTimer = undefined;
        if (queuedInput) {
            const pending = queuedInput;
            queuedInput = '';
            const barrier = reserveCurrentInputColumns(
                mirroredLine?.length ?? pending.replace(/[\x00-\x1f\x7f]/g, '').length,
            );
            void barrier
                .then(() => outputInputReady)
                .then(() => api.sendInput(tabId, pending))
                .finally(() => {
                    // La reserva solo debía durar mientras la cola esperaba.
                    // Si sigue marcada tras enviarla, `fitAndReport` sale
                    // antes de ajustar las filas en cada resize posterior: la
                    // rejilla conservaba la altura de la ventana anterior y el
                    // prompt quedaba fuera de la casilla. El resize aplazado
                    // mientras tanto se aplica con la salida del eco.
                    if (!queuedInput) localInputGridPinned = false;
                    exposeFitSkip(host?.dataset.fitSkip ?? '');
                });
        }
    }

    function scheduleInputReleaseFallback(): void {
        if (destroyed || inputReady) return;
        if (inputReadyTimer) window.clearTimeout(inputReadyTimer);
        if (inputReleaseFallbackDeadline === 0) {
            inputReleaseFallbackDeadline = Date.now() + 35_000;
        }
        inputReadyTimer = window.setTimeout(() => {
            inputReadyTimer = undefined;
            const startupReady = terminalStartupReady();
            if (startupBannerExpected()
                && !startupReady
                && Date.now() < inputReleaseFallbackDeadline) {
                scheduleInputReleaseFallback();
                return;
            }
            // Algunas sesiones REPL (IRB en particular) pueden crear la PTY y
            // pintar su prompt antes de que llegue el evento de confirmación
            // del cambio de entorno. En ese caso la marca pendiente bloqueaba
            // `releaseInput()` para siempre aunque el prompt ya fuese visible.
            // Tras el límite acotado del handshake, el prompt es la evidencia
            // suficiente para cerrar esa época y abrir la entrada.
            if (environmentSwitchPending && startupReady) {
                environmentSwitchPending = false;
                environmentSwitchRequestId = undefined;
                environmentSwitchSnapshot = undefined;
                exposeInputMirror('environment-switch-timeout-recovered');
            }
            inputReleaseFallbackDeadline = 0;
            releaseInput();
        }, 2000);
    }

    function updateVerticalScrollIntent(): void {
        if (!term) return;
        const buffer = term.buffer.active;
        const scrollable = terminalHost?.querySelector<HTMLElement>('.xterm-scrollable-element');
        const domAtBottom = !scrollable
            || scrollable.scrollTop >= scrollable.scrollHeight - scrollable.clientHeight - 2;
        const atBottom = buffer.viewportY >= buffer.baseY - 1 || domAtBottom;
        if (atBottom) {
            userScrolledBack = false;
        } else if (!userEditing) {
            userScrolledBack = true;
            outputStartedAtBottom = false;
        }
    }

    function onTerminalOutputBusy(event: Event): void {
        if (!eventBelongsToPane(event)) return;
        const detail = (event as CustomEvent<{ tabId?: string; data?: string; kind?: string }>).detail;
        if (firstShellOutputAt === 0) firstShellOutputAt = performance.now();
        outputInputEpoch += 1;
        blockInputDuringOutput();
        if (!terminalOutputBusy && term) {
            const buffer = term.buffer.active;
            // WebDriver y algunos eventos de rueda pueden mover directamente
            // el viewport DOM sin actualizar todavía `buffer.viewportY`.
            // Consultar ambos estados evita que una salida posterior se pinte
            // arriba del scrollback y parezca haber perdido la orden corta.
            const scrollable = terminalHost?.querySelector<HTMLElement>('.xterm-scrollable-element');
            const domAtBottom = !scrollable
                || scrollable.scrollTop >= scrollable.scrollHeight - scrollable.clientHeight - 2;
            outputStartedAtBottom = !userScrolledBack
                && (buffer.viewportY >= buffer.baseY - 1 || domAtBottom);
        }
        if (detail?.kind === 'clear') {
            if (outputPtyResizeTimer !== undefined) {
                window.clearTimeout(outputPtyResizeTimer);
                outputPtyResizeTimer = undefined;
            }
            outputPtyEarlyResizeScheduled = false;
            pendingOutputPtyColumns = 0;
            outputLogicalLineColumns = 0;
            clearPending = true;
            suppressWideReservation = true;
            outputBurstWide = false;
            reservedOutputColumns = 0;
            inputWideReservationColumns = 0;
            inputPtyWarmupDone = false;
            inputLogicalLength = 0;
            inputLineSubmitted = false;
        }
        // Reservar el ancho a partir del bloque PTY antes de que App.svelte
        // lo escriba en xterm. Esto cubre salidas que ConPTY ya fragmentó
        // (barras, cabeceras ANSI y mensajes largos) y evita que el idle
        // posterior interprete cada fila como una línea independiente.
        const chunkColumns = detail?.kind === 'clear'
            ? 0
            : estimateOutputChunkColumns(detail?.data);
        // Se compara con el ancho visible, no con la rejilla (>= 1024): una
        // salida más ancha que la vista debe marcar `outputBurstWide` para que
        // el ajuste posterior mida la línea completa en vez de partirla.
        if (chunkColumns > currentDisplayCols()) {
            // Una orden larga ya fue precalentada con la longitud acumulada de
            // su propia línea. El eco que llega por ConPTY puede contener el
            // bloque completo y `estimateOutputChunkColumns` lo ve como una
            // línea de varios miles de columnas aunque visualmente la orden
            // solo necesite una rejilla de 1024. Reutilizar la reserva de la
            // entrada evita encogerla a mitad del eco, pero también evita que
            // una repetición ANSI convierta el scroll en una miniatura.
            const submittedInputLimit = submittedCommand
                && submittedCommand.length <= MAX_INPUT_RESERVATION_COLS
                ? Math.min(
                    MAX_INPUT_RESERVATION_COLS,
                    Math.max(
                        INPUT_PTY_WARMUP_COLS,
                        Math.ceil((submittedCommand.length + 64) / 64) * 64,
                    ),
                )
                // Si no podemos asociar el bloque al eco de la orden, no
                // convertir una medida ambigua en una rejilla de 4096
                // columnas: la salida se volverá a medir después de escribir
                // y crecerá solo si existe contenido real que lo exige.
                : INPUT_PTY_WARMUP_COLS;
            const requiredColumns = Math.min(
                submittedInputLimit,
                Math.max(INPUT_PTY_WARMUP_COLS, chunkColumns + 2),
            );
            outputBurstWide = true;
            reservedOutputColumns = Math.max(reservedOutputColumns, requiredColumns);
            pendingOutputColumns = Math.max(pendingOutputColumns, requiredColumns);
            // La salida puede llegar en muchos bloques. Agruparlos evita que
            // cada uno provoque un reflow visible; la entrada sigue usando la
            // ruta inmediata de `queueInputPtyResize`.
            queueOutputPtyResize(requiredColumns);
        }
        terminalOutputBusy = true;
        // El banner inicial puede llegar en varios bloques desde ConPTY. Si
        // entra otro bloque antes del siguiente repintado, el temporizador que
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
        if (ptySyncPendingAfterOutput) {
            ptySyncPendingAfterOutput = false;
            syncPtyToTerminalAfterOutput();
        }
        if (outputStartedAtBottom && !userEditing && !userScrolledBack && term) {
            term.scrollToBottom();
        }
        outputStartedAtBottom = true;
        // La salida normal de la PTY no pasa por `writeInternal`, por lo que
        // hasta ahora el atributo de diagnóstico del prompt podía quedarse en
        // `false` después de un comando largo aunque xterm ya dibujara el
        // prompt al final del scrollback. Actualizarlo al vaciar la cola (y
        // una vez más tras el frame de rasterizado) mantiene la entrada y las
        // comprobaciones visuales sincronizadas con el buffer real.
        terminalPromptVisible();
        requestAnimationFrame(() => {
            if (!destroyed) terminalPromptVisible();
        });
        lastOutputFinishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // Aplicar la mayor reserva una sola vez, después de que la cola de
        // escritura de xterm haya quedado vacía. Durante la ráfaga se acumula
        // en `pendingOutputPtyColumns` para evitar reflows intermedios.
        if (pendingOutputPtyColumns > 0) void flushOutputPtyResize();
        outputPtyEarlyResizeScheduled = false;
        // Si la orden que acaba de confirmarse necesitaba una rejilla ancha,
        // esa anchura forma parte de la salida visible que sigue. No se puede
        // inferir que la salida cabe solo porque xterm ya la ha reenvuelto en
        // filas cortas: al encoger en ese instante se pierde precisamente el
        // scroll horizontal y el `echo` queda partido en varias líneas.
        let submittedWideCommand = false;
        if (inputLineSubmitted) {
            inputLineSubmitted = false;
            // No liberar la rejilla ancha antes de que ConPTY entregue la
            // salida de la orden. En `echo` y en comandos con muchas comillas
            // el shell puede producir una línea más larga que el viewport;
            // si reducimos aquí, ConPTY la reenvuelve antes de que xterm pueda
            // medirla y el extremo derecho queda partido o inaccesible. La
            // reserva pasa a la fase de salida y se libera en el siguiente fit
            // cuando las filas visibles ya caben.
            const submittedInputColumns = inputWideReservationColumns;
            inputWideReservationColumns = 0;
            inputPtyWarmupDone = false;
            inputLogicalLength = 0;
            if (submittedInputColumns > 0) {
                const submittedViewport = getHorizontalViewport();
                const submittedCellWidth = terminalCellWidth();
                const submittedViewportColumns = submittedViewport && submittedCellWidth > 0
                    ? Math.max(1, Math.floor(submittedViewport.clientWidth / submittedCellWidth))
                    : currentDisplayCols();
                submittedWideCommand = submittedInputColumns > submittedViewportColumns + 1;
                outputBurstWide = true;
                reservedOutputColumns = Math.max(reservedOutputColumns, submittedInputColumns);
                pendingOutputColumns = Math.max(pendingOutputColumns, submittedInputColumns);
            }
            fitAfterOutput = true;
        }
        if (clearPending) {
            clearPending = false;
            pendingOutputColumns = 0;
            outputBurstWide = false;
            reservedOutputColumns = 0;
            fitAfterOutput = false;
            if (wideReleaseTimer !== undefined) {
                window.clearTimeout(wideReleaseTimer);
                wideReleaseTimer = undefined;
            }
            if (fitQuietTimer !== undefined) {
                window.clearTimeout(fitQuietTimer);
                fitQuietTimer = undefined;
            }
            if (terminalHost) {
                terminalHost.dataset.horizontalTail = 'false';
                terminalHost.dataset.longestVisibleLine = '0';
                terminalHost.style.removeProperty('--horizontal-tail-left');
                terminalHost.style.removeProperty('--horizontal-tail-width');
                terminalHost.style.removeProperty('--terminal-content-width');
                setHorizontalScrollLeft(terminalHost, 0, 3);
            }
            // El callback de term.write ya vació el buffer; dejar un frame
            // para el repintado de xterm evita volver a medir la textura vieja.
                requestAnimationFrame(() => {
                if (!destroyed) fitAndReport(0, true);
            });
        }
        scheduleHorizontalScrollState();
        // La línea puede haber llegado partida con el ancho anterior. Esperar
        // al siguiente intervalo tranquilo deja que xterm termine de llenar
        // el buffer antes de calcular su ancho lógico y rehacer el fit.
        // Si el bloque llegó partido por ConPTY antes de que xterm lo
        // procesara, la medición del buffer puede ver solo filas envueltas.
        // La reserva bruta conserva la anchura lógica hasta que el siguiente
        // fit la convierte en columnas reales y en ancho físico del host.
        const currentColumns = currentDisplayCols();
        const viewportColumns = (() => {
            const viewport = getHorizontalViewport();
            const cellWidth = terminalCellWidth();
            return viewport && cellWidth > 0
                ? Math.max(1, Math.floor(viewport.clientWidth / cellWidth))
                : currentColumns;
        })();
        const alreadyExpanded = currentColumns > viewportColumns + 1;
        // Tras dividir una vista, el scrollback puede conservar una línea
        // ancha mientras las filas que se ven en el panel nuevo ya caben. En
        // ese caso la reserva pertenece a la geometría anterior y debe
        // liberarse en este idle; mantenerla deja el canvas y el scrollWidth
        // grandes aunque no haya una línea visible que desplazar.
        const normalizedSubmittedCommand = (submittedCommand ?? '').replace(/\s+/gu, ' ').trim();
        const visibleRows = terminalHost
            ? [...terminalHost.querySelectorAll('.xterm-rows > div')].map((row) => {
                const text = row.textContent ?? '';
                const normalizedText = text.replace(/\s+/gu, ' ').trim();
                // El eco de una orden larga puede ocupar varias filas sin
                // conservar el prompt en las continuaciones. No debe
                // impedir que una salida corta libere la reserva; solo la
                // salida real decide si el host sigue siendo desplazable.
                const isCommandEcho = normalizedSubmittedCommand.length >= 24
                    && (normalizedText.includes(normalizedSubmittedCommand.slice(0, 24))
                        || normalizedText.includes(normalizedSubmittedCommand.slice(-24)));
                return { text, normalizedText, isCommandEcho };
            })
            : [];
        const visibleRowsFit = visibleRows.length > 0
            && visibleRows.every(({ text, normalizedText, isCommandEcho }) =>
                isShellInputLine(normalizedText)
                || isCommandEcho
                || text.trimEnd().length <= viewportColumns + 1);
        // A long command echo can keep the PTY warm at 1024 columns even when
        // the command's actual output is short. In that state the artificial
        // reservation is wider than the painted glyphs: scrolling to its
        // maximum shows an empty terminal and makes the right edge look lost.
        // Track real non-echo output separately so the reservation can be
        // released as soon as the output is known to fit the viewport.
        const visibleLongOutput = visibleRows.some(({ text, normalizedText, isCommandEcho }) =>
            !isShellInputLine(normalizedText)
            && !isCommandEcho
            && text.trimEnd().length > viewportColumns + 1);
        // La reserva preventiva de 1024 columnas protege el eco inicial, pero
        // no representa necesariamente la anchura de la salida que acaba de
        // pintar xterm. Si la salida real ocupa, por ejemplo, 497 columnas,
        // conservar las 1024 deja un tramo vacío al llevar el host al extremo
        // derecho. Medir solo filas que no son prompt/eco permite reducir la
        // reserva al ancho lógico visible sin tocar el texto ni provocar un
        // reflow innecesario de la salida larga.
        const visibleOutputColumns = Math.max(
            0,
            ...visibleRows
                .filter(({ normalizedText, isCommandEcho }) =>
                    !isShellInputLine(normalizedText) && !isCommandEcho)
                .map(({ text }) => text.trimEnd().length),
        );
        if (submittedWideCommand && visibleOutputColumns > viewportColumns + 1) {
            const measuredOutputColumns = Math.min(
                MAX_HORIZONTAL_COLS,
                Math.max(viewportColumns + 1, visibleOutputColumns),
            );
            reservedOutputColumns = Math.min(
                Math.max(viewportColumns + 1, reservedOutputColumns),
                measuredOutputColumns,
            );
            pendingOutputColumns = Math.min(
                Math.max(viewportColumns + 1, pendingOutputColumns),
                measuredOutputColumns,
            );
        }
        if (alreadyExpanded && visibleRowsFit
            // Una salida larga recién confirmada puede aparecer como varias
            // filas de la anchura actual. Ese aspecto no demuestra que su
            // contenido lógico quepa; conservar la reserva evita el reflow
            // ancho→estrecho que elimina la barra y corta la cola.
            && (!submittedWideCommand || !visibleLongOutput)
            && !suppressWideReservation && inputWideReservationColumns === 0) {
            // No liberar la reserva en el mismo idle que confirma el prompt.
            // Ese frame suele ser también el que recibe la primera letra de
            // la orden siguiente. Si se encoge aquí, ConPTY puede aceptar esa
            // letra con la rejilla estrecha y las letras restantes con la
            // ancha, dejando el síntoma `e` / `cho ...` en filas distintas.
            // El temporizador solo encoge después de un intervalo completo sin
            // edición; `onData` lo cancela al comenzar una orden nueva.
            if (wideReleaseTimer !== undefined) window.clearTimeout(wideReleaseTimer);
            const releaseWideReservation = (): void => {
                wideReleaseTimer = undefined;
                if (destroyed || terminalOutputBusy || userEditing
                    || inputLineSubmitted || pendingTerminalInputData.length > 0) {
                    // La cola puede conservar una orden mientras ConPTY
                    // termina de confirmar el prompt. No abandonar la
                    // liberación en ese caso: reintentar tras otro intervalo
                    // tranquilo evita dejar la matriz en miles de columnas y
                    // perder el extremo de una secuencia posterior.
                    if (!destroyed) {
                        wideReleaseTimer = window.setTimeout(releaseWideReservation, OUTPUT_QUIET_SETTLE_MS);
                    }
                    return;
                }
                outputBurstWide = false;
                reservedOutputColumns = 0;
                pendingOutputColumns = 0;
                if (terminalHost && viewportColumns >= 4) {
                    terminalHost.style.setProperty('--terminal-content-width', `${terminalHost.clientWidth}px`);
                }
                requestAnimationFrame(() => fitAndReport());
            };
            const settleDelay = submittedWideCommand && !visibleLongOutput
                ? Math.min(OUTPUT_QUIET_SETTLE_MS, 200)
                : OUTPUT_QUIET_SETTLE_MS;
            wideReleaseTimer = window.setTimeout(releaseWideReservation, settleDelay);
            fitAfterOutput = true;
        }
        // ConPTY puede entregar el fin de la orden antes de que xterm haya
        // insertado la fila de salida en `.xterm-rows`. Si esa fila aparece
        // después del primer idle, el bloque anterior no llega a programar la
        // liberación porque todavía no podía medirla. Un único ajuste tardío
        // cubre ese intervalo sin entrar en un bucle de reflows; en él
        // `logicalDomColumns` ya puede sustituir la reserva preventiva por el
        // ancho real de la fila.
        if (submittedWideCommand && wideReleaseTimer === undefined && !userEditing) {
            fitQuietTimer = window.setTimeout(() => {
                fitQuietTimer = undefined;
                if (!destroyed && !terminalOutputBusy && !inputLineSubmitted
                    && pendingTerminalInputData.length === 0) {
                    requestAnimationFrame(() => fitAndReport());
                }
            }, 300);
            fitAfterOutput = true;
        }
        const outputNeedsLateFit = submittedWideCommand
            || (outputBurstWide && pendingOutputColumns > viewportColumns + 1);
        if (outputNeedsLateFit && !userEditing) {
            if (lateOutputFitTimer !== undefined) window.clearTimeout(lateOutputFitTimer);
            // La salida de una orden larga puede superar el primer idle de
            // ConPTY. Medir una segunda vez cuando el DOM ya contiene toda la
            // fila permite ampliar la rejilla por encima de 1024 columnas y
            // evita que el scroll termine en mitad de una secuencia.
            lateOutputFitTimer = window.setTimeout(() => {
                lateOutputFitTimer = undefined;
                if (!destroyed && !terminalOutputBusy && !inputLineSubmitted
                    && pendingTerminalInputData.length === 0) {
                    fitAndReport(0, true);
                    // El scrollWidth del screen puede publicarse un frame
                    // después de la primera medición. Repetir dos veces, sin
                    // crear un intervalo permanente, sincroniza el host con
                    // ese ancho tardío y cubre WebView2 bajo carga.
                    window.setTimeout(() => {
                        if (!destroyed && !terminalOutputBusy && !inputLineSubmitted)
                            fitAndReport(0, true);
                    }, 1200);
                    window.setTimeout(() => {
                        if (!destroyed && !terminalOutputBusy && !inputLineSubmitted)
                            fitAndReport(0, true);
                    }, 2800);
                }
            }, 1200);
        }
        // El evento idle puede llegar antes de que WebView2 haya terminado de
        // rasterizar las últimas filas. Si en ese primer instante una fila aún
        // parece ancha, la reserva queda retenida y ninguna ResizeObserver
        // posterior vuelve a entrar en `fitAndReport`. Reintentar después de
        // un frame de reposo permite medir el DOM definitivo: la salida larga
        // conserva su único scroll, mientras que una orden corta vuelve a las
        // columnas reales del panel.
        // La liberación de la reserva se programa en el bloque anterior y se
        // cancela desde `onData` si comienza una orden nueva. No crear aquí
        // otro temporizador: dos ajustes consecutivos vuelven a introducir
        // el reflow ancho→estrecho→ancho que se está evitando.
        // Una rejilla ya ensanchada contiene el scrollback de la salida
        // anterior. Volver a inferir esas filas en cada prompt las suma otra
        // vez (2161 -> 2750 -> ...), fuerza reflows innecesarios y puede hacer
        // desaparecer una orden corta confirmada. Las entradas nuevas siguen
        // llegando por `pendingOutputColumns` desde output-busy; solo usamos
        // la inferencia del buffer cuando aún estamos en el ancho base.
        if (!alreadyExpanded && !suppressWideReservation) {
            const inferredColumns = inferUnmarkedWrappedOutputColumns();
            if (inferredColumns > currentColumns) {
                outputBurstWide = true;
                reservedOutputColumns = Math.max(reservedOutputColumns, inferredColumns);
            }
            pendingOutputColumns = Math.max(pendingOutputColumns, inferredColumns);
        }
        const pendingNeedsResize = pendingOutputColumns > currentColumns;
        // Una rejilla ensanchada por una salida anterior también debe poder
        // volver al ancho del panel cuando `clear`/la siguiente orden ya caben.
        // `longestVisibleLineWidth` limita la medida a la salida reciente, por
        // lo que no reintroduce las líneas largas que quedaron en scrollback.
        const needsHorizontalResize = pendingNeedsResize
            || (!outputBurstWide && horizontalResizeNeeded());
        if (needsHorizontalResize) fitAfterOutput = true;
        if (fitAfterOutput || alreadyExpanded || pendingNeedsResize) {
            scheduleOutputGeometrySettle();
        }
        releaseInputAfterOutput();
        if (!inputReady && !environmentSwitchPending && terminalStartupReady() && !inputReleaseTimer) {
            // El callback de `term.write` confirma el parseo, pero el canvas
            // puede necesitar otro frame para rasterizar las últimas líneas.
            // Un margen breve permite ese frame sin hacer que las primeras
            // pulsaciones parezcan invisibles cuando el prompt ya está listo.
            inputReleaseTimer = window.setTimeout(() => {
                inputReleaseTimer = undefined;
                releaseInput();
            }, 50);
        }
        if (fitAfterOutput) {
            fitAfterOutput = false;
            // Dejar un pequeño margen permite que el renderer de xterm vacíe
            // su frame pendiente antes de recalcular el ancho de las líneas.
            if (fitQuietTimer) window.clearTimeout(fitQuietTimer);
            fitQuietTimer = window.setTimeout(() => {
                fitQuietTimer = undefined;
                requestAnimationFrame(() => fitAndReport(pendingNeedsResize ? pendingOutputColumns : 0));
            }, OUTPUT_QUIET_SETTLE_MS);
        }
        // El banner que acompaña a `clear` ya quedó fuera de la reserva. A
        // partir de este punto la siguiente orden normal vuelve a medirse,
        // pero no reanalizamos las filas del banner recién repintado.
        if (suppressWideReservation) suppressWideReservation = false;
        // Conservar el último eco hasta que la geometría se estabilice. El
        // reflow posterior a Enter puede ejecutarse después de este callback;
        // si se borra aquí, la orden larga parece salida y la rejilla salta a
        // MAX_HORIZONTAL_COLS (el extremo derecho queda negro).
        if (!pendingBannerPrint || userEditing || bannerRefreshInFlight) return;
        pendingBannerPrint = false;
        requestAnimationFrame(() => requestBannerPrint());
    }

    function onEnvironmentSwitchStarted(event: Event): void {
        const detail = (event as CustomEvent<{ tabId?: string; envId?: string; requestId?: number }>).detail;
        if (detail?.tabId !== tabId || typeof detail.requestId !== 'number') return;
        environmentSwitchRequestId = detail.requestId;
        startupEnvironmentId = detail.envId;
        if (!environmentSwitchPending) {
            environmentSwitchSnapshot = {
                inputReady,
                queuedInput,
                mirroredLine,
                userEditing,
            };
        }
        environmentSwitchPending = true;
        outputBurstWide = false;
        reservedOutputColumns = 0;
        inputWideReservationColumns = 0;
        inputPtyWarmupDone = false;
        inputLineSubmitted = false;
        suppressWideReservation = false;
        pendingOutputColumns = 0;
        if (outputPtyResizeTimer !== undefined) window.clearTimeout(outputPtyResizeTimer);
        outputPtyResizeTimer = undefined;
        outputPtyEarlyResizeScheduled = false;
        pendingOutputPtyColumns = 0;
        outputLogicalLineColumns = 0;
        commandPtyWarmupColumns = 0;
        commandPtyWarmupQueue = Promise.resolve();
        localInputGridPinned = false;
        if (host) host.dataset.environmentSwitchRequestId = String(detail.requestId);
        // La sonda de recuperación pertenece a la shell inicial. Si sobrevive
        // a un cambio de entorno, podría enviar Enter a la shell nueva antes
        // de que termine su inicializador.
        if (initialPromptTimer) window.clearTimeout(initialPromptTimer);
        initialPromptTimer = undefined;
        initialPromptRecoveryAttempts = 0;
        initialPromptRecoverySent = false;
        // La misma instancia de xterm se reutiliza al cambiar de entorno. Su
        // estado de edición, temporizadores y cola de entrada también tienen
        // que empezar una nueva época; de lo contrario el prompt de la shell
        // anterior puede conservar un espejo de texto o liberar una tecla en la
        // sesión recién creada.
        mirroredLine = '';
        userEditing = false;
        queuedInput = '';
        inputReady = false;
        if (host) host.dataset.startupReady = 'false';
        inputReleaseFallbackDeadline = 0;
        if (inputReleaseTimer) {
            window.clearTimeout(inputReleaseTimer);
            inputReleaseTimer = undefined;
        }
        if (inputReadyTimer) window.clearTimeout(inputReadyTimer);
        // La nueva sesión todavía no existe: no vaciar la cola contra la PTY
        // anterior ni perder teclas al vencer el límite de ocho segundos.
        inputReadyTimer = undefined;
        exposeInputMirror('environment-switch');
    }

    function failEnvironmentSwitch(error?: unknown): void {
        if (destroyed) return;
        // El backend ya muestra el motivo del fallo en xterm. No dejar el pane
        // marcado como pendiente ni reenviar las teclas escritas a una shell
        // que nunca llegó a crearse; el usuario podrá elegir otro entorno.
        environmentSwitchPending = false;
        environmentSwitchRequestId = undefined;
        startupEnvironmentId = undefined;
        environmentSwitchSnapshot = undefined;
        inputReady = false;
        if (host) host.dataset.startupReady = 'false';
        queuedInput = '';
        mirroredLine = '';
        userEditing = false;
        exposeInputMirror('environment-switch-failed');
        if (error !== undefined) console.error('[TerminalPane] cambio de entorno no disponible', error);
    }

    function onEnvironmentSwitchRequested(event: Event): void {
        const detail = (event as CustomEvent<{ tabId?: string; requestId?: number }>).detail;
        if (detail?.tabId !== tabId || typeof detail.requestId !== 'number'
            || detail.requestId !== environmentSwitchRequestId) return;
        // La petición ya fue aceptada: la cola y la línea de la shell anterior
        // no deben reaparecer si el PTY nuevo tarda en llegar.
        environmentSwitchSnapshot = undefined;
        void waitForFrontendReady()
            .then((ready) => {
                if (destroyed || detail.requestId !== environmentSwitchRequestId) return;
                if (ready) {
                    environmentSwitchPending = false;
                    environmentSwitchRequestId = undefined;
                    if (terminalStartupReady()) releaseInput();
                    else scheduleInputReleaseFallback();
                } else {
                    failEnvironmentSwitch();
                }
            })
            .catch((error) => {
                if (detail.requestId === environmentSwitchRequestId) failEnvironmentSwitch(error);
            });
    }

    function onEnvironmentSwitchCancelled(event: Event): void {
        const detail = (event as CustomEvent<{ tabId?: string; requestId?: number }>).detail;
        if (detail?.tabId !== tabId || typeof detail.requestId !== 'number'
            || detail.requestId !== environmentSwitchRequestId) return;
        startupEnvironmentId = undefined;
        const snapshot = environmentSwitchSnapshot;
        // Si la shell anterior ya aceptaba entrada, el rechazo conserva esa
        // misma PTY. No esperar otro handshake: podría fallar y dejar una
        // sesión válida bloqueada por una respuesta que ya no es necesaria.
        if (snapshot?.inputReady) {
            const typedWhilePending = queuedInput;
            environmentSwitchPending = false;
            environmentSwitchRequestId = undefined;
            environmentSwitchSnapshot = undefined;
            queuedInput = snapshot.queuedInput + typedWhilePending;
            const lineWasSubmitted = /[\r\n\x03]$/.test(queuedInput);
            if (lineWasSubmitted) mirroredLine = '';
            else if (snapshot.mirroredLine === null) mirroredLine = null;
            else if (typedWhilePending.length === 0) mirroredLine = snapshot.mirroredLine;
            else if (/^[\x20-\x7e]+$/.test(queuedInput.slice(snapshot.queuedInput.length))) {
                mirroredLine = snapshot.mirroredLine + typedWhilePending;
            } else mirroredLine = null;
            userEditing = lineWasSubmitted ? false : snapshot.userEditing || typedWhilePending.length > 0;
            releaseInput();
            return;
        }
        void waitForFrontendReady()
            .then((ready) => {
                if (destroyed || detail.requestId !== environmentSwitchRequestId) return;
                if (!ready) {
                    failEnvironmentSwitch();
                    return;
                }
                const typedWhilePending = queuedInput;
                environmentSwitchPending = false;
                environmentSwitchRequestId = undefined;
                environmentSwitchSnapshot = undefined;
                if (snapshot) {
                    const restoredInput = snapshot.queuedInput + typedWhilePending;
                    queuedInput = restoredInput;
                    const lineWasSubmitted = /[\r\n\x03]$/.test(restoredInput);
                    if (lineWasSubmitted) mirroredLine = '';
                    else if (snapshot.mirroredLine === null) mirroredLine = null;
                    else if (restoredInput.length === 0) mirroredLine = snapshot.mirroredLine;
                    else if (/^[\x20-\x7e]+$/.test(restoredInput)) {
                        mirroredLine = snapshot.mirroredLine + restoredInput;
                    } else mirroredLine = null;
                    userEditing = lineWasSubmitted ? false : snapshot.userEditing || typedWhilePending.length > 0;
                }
                if (snapshot?.inputReady || terminalStartupReady()) releaseInput();
                else scheduleInputReleaseFallback();
            })
            .catch((error) => {
                if (detail.requestId === environmentSwitchRequestId) failEnvironmentSwitch(error);
            });
    }

    /** Diagnóstico estructural para E2E. No guarda texto ni códigos de teclas:
     *  solo si el espejo conoce la línea, su longitud y la clase del evento. */
    function exposeInputMirror(eventClass: string): void {
        if (!host) return;
        host.dataset.userEditing = String(userEditing);
        host.dataset.inputReady = String(inputReady);
        host.dataset.inputMirrorState = mirroredLine === null ? 'unknown' : 'known';
        host.dataset.inputMirrorLength = mirroredLine === null ? '0' : String(mirroredLine.length);
        host.dataset.inputEventClass = eventClass;
    }

    /** Publica por qué el último `fitAndReport` no ajustó la rejilla. Una
     *  salida temprana que nadie reprograma deja las filas de la ventana
     *  anterior; el E2E lo usa para diagnosticar una casilla desbordada. */
    function exposeFitSkip(reason: string): void {
        if (!host) return;
        host.dataset.fitSkip = reason;
        host.dataset.inputGridPinned = String(localInputGridPinned);
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
        // Un REPL no tiene banner: inyectar uno aquí volvería a mezclarlo con
        // su prompt vivo. El backend también lo rechaza, pero cortar la ruta
        // en el renderer evita dejar una solicitud pendiente durante cada
        // cambio de rejilla o de preferencias.
        if (paneIsRepl()) {
            pendingBannerPrint = false;
            return;
        }
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
        const environmentId = startupEnvironmentId ?? app.tabs.find((tab) => tab.id === tabId)?.envId;
        if (host) {
            host.dataset.promptCursorRow = String(cursorAbsoluteRow);
            host.dataset.promptCursorViewportRow = String(buffer.cursorY);
            host.dataset.promptBaseY = String(buffer.baseY);
            host.dataset.promptViewportRows = String(term.rows);
        }
        const start = Math.max(0, cursorAbsoluteRow - 2);
        const end = Math.min(buffer.length - 1, cursorAbsoluteRow + 1);
        // Al pasar de un REPL a otro, la fila del prompt anterior puede
        // sobrevivir unos frames. Solo el prompt del entorno solicitado debe
        // abrir la entrada de Java/Ruby.
        const requiredPrompt = environmentId === 'lang:java'
            ? /^jshell>\s?.*$/u
            : environmentId === 'lang:ruby'
                ? /^irb\([^)]*\):\d+(?::\d+)?[>]\s?.*$/iu
                : null;
        if (requiredPrompt) {
            const bufferRows: string[] = [];
            for (let row = start; row <= end; row += 1) {
                bufferRows.push(buffer.getLine(row)?.translateToString(true).trim() ?? '');
            }
            const renderedRows = [...terminalHost?.querySelectorAll<HTMLElement>('.xterm-rows > div') ?? []]
                .map((row) => (row.textContent ?? '').trim());
            const visible = [...bufferRows, ...renderedRows].some((line) => requiredPrompt.test(line));
            if (host) host.dataset.promptVisible = String(visible);
            return visible;
        }
        for (let row = start; row <= end; row += 1) {
            const text = buffer.getLine(row)?.translateToString(true).trimEnd() ?? '';
            if (interactiveReplPromptIsVisible(text, environmentId)
                || /^(?:PS\s+)?(?:[A-Za-z]:\\.+[>❯$#]|[^\s@]+@[^\s:]+:.+[❯$#]|(?:~|\/)?.*[❯$#])\s*$/u.test(text)) {
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
        if (cursorLine && (interactiveReplPromptIsVisible(cursorLine, environmentId)
            || /[>❯$#]\s*$/u.test(cursorLine))) {
            if (host) host.dataset.promptVisible = 'true';
            return true;
        }
        if (host) host.dataset.promptVisible = 'false';
        // WebView2 puede actualizar el DOM de `.xterm-rows` un frame antes
        // de que el buffer accesible de xterm exponga la misma fila. Usar esa
        // representación pintada como respaldo evita que un prompt visible
        // tras dividir/redimensionar deje la compuerta en `false`.
        const renderedLines = [...terminalHost?.querySelectorAll<HTMLElement>('.xterm-rows > div') ?? []]
            .map((row) => (row.textContent ?? '').replace(/\r/g, '').trim());
        const renderedPrompt = renderedLines.some((line) => (
            interactiveReplPromptIsVisible(line, environmentId)
            || /^(?:PS\s+)?[A-Za-z]:\\.+[>❯$#]\s*$/u.test(line)
            || /^jshell>\s?.*$/u.test(line)
            || /^irb\([^)]*\):\d+(?::\d+)?[>]\s?.*$/iu.test(line)
        ));
        if (renderedPrompt) {
            if (host) host.dataset.promptVisible = 'true';
            return true;
        }
        return false;
    }

    /**
     * ConPTY/cmd necesita unas columnas mínimas para volver a dibujar el
     * prompt completo. Si la rejilla se reduce por debajo de la longitud de
     * `C:\\Users\\...>`, cmd puede dejar solo el prefijo visible en xterm en
     * vez de envolverlo. Reservar una pequeña matriz horizontal mantiene la
     * línea íntegra y deja que el host ofrezca su scroll si el panel es más
     * estrecho. No se aplica a REPLs, que controlan su propio prompt.
     */
    function minimumPromptColumns(): number {
        if (!term || paneIsRepl()) return 0;
        const buffer = term.buffer.active;
        const cursorRow = buffer.baseY + buffer.cursorY;
        const cursorLine = buffer.getLine(cursorRow)?.translateToString(true).trimEnd() ?? '';
        const recentRows = [cursorLine];
        for (let row = Math.max(0, cursorRow - 2); row < cursorRow; row += 1) {
            recentRows.push(buffer.getLine(row)?.translateToString(true).trimEnd() ?? '');
        }
        const looksLikeWindowsPrompt = recentRows.some((line) => /^(?:PS\s+)?[A-Za-z]:[\\/]/u.test(line));
        const looksLikePosixPrompt = recentRows.some((line) => /^(?:[^\s@]+@[^\s:]+:|~(?:[\\/]|$)|\/[^\s]*)/u.test(line));
        if (!looksLikeWindowsPrompt && !looksLikePosixPrompt) return 0;
        // 32 columnas cubren el prompt por defecto de Windows y los prompts
        // habituales con usuario/ruta, sin imponer una anchura grande en una
        // terminal que no está en una línea de edición.
        return 32;
    }

    function currentEditableLine(): string | null {
        if (!term) return null;
        const buffer = term.buffer.active;
        const cursorRow = buffer.baseY + buffer.cursorY;
        const line = buffer.getLine(cursorRow)?.translateToString(true).trimEnd() ?? '';
        if (!line) return null;
        const environmentId = startupEnvironmentId ?? app.tabs.find((tab) => tab.id === tabId)?.envId;
        const replInput = interactiveReplInputLine(line, environmentId);
        if (replInput !== null) return replInput;
        const promptEnd = Math.max(
            line.lastIndexOf('❯'),
            line.lastIndexOf('>'),
            line.lastIndexOf('$'),
            line.lastIndexOf('#'),
        );
        return promptEnd >= 0 ? line.slice(promptEnd + 1).trimStart() : null;
    }

    /** Entrada de la paleta de comandos. No escribe en xterm: `term.input`
     *  dispara `onData` igual que una pulsación, así que la línea llega a la
     *  shell (o al interceptor de `:`, que borra lo tecleado y resincroniza
     *  su salida con ConPTY) por la ruta de siempre, y el eco lo pinta ConPTY.
     *  Solo se acepta con la shell lista, un prompt a la vista y la línea
     *  vacía: nunca se mezcla con lo que el usuario estuviera escribiendo ni
     *  se teclea dentro de un programa a pantalla completa. */
    function submitLineFromApp(line: string): TerminalLineRejection | null {
        if (!term || destroyed || !inputReady || environmentSwitchPending) return 'not-ready';
        if (term.buffer.active.type === 'alternate') return 'busy';
        // El borrador va antes que el prompt: con texto escrito la fila ya no
        // termina en `>`/`$` y parecería una terminal ocupada.
        const draft = mirroredLine ?? currentEditableLine() ?? '';
        if (draft.trim()) return 'draft';
        if (!terminalPromptVisible()) return 'busy';
        term.input(line, true);
        term.input('\r', true);
        return null;
    }

    function paneIsRepl(): boolean {
        const tab = app.tabs.find((candidate) => candidate.id === tabId);
        const environmentId = String(startupEnvironmentId ?? tab?.envId ?? '');
        const environment = app.environments.find((candidate) => candidate.id === environmentId);
        const tabLabel = String(tab?.label ?? '');
        // Durante los primeros frames `listEnvironments` puede seguir en
        // segundo plano y todavía no haber rellenado `app.environments`. La
        // etiqueta de la pestaña ya viene en `listTabs`/`env-changed`, así que
        // sirve como respaldo inequívoco para no volver a esperar un fastfetch
        // que ese REPL nunca va a recibir.
        return environment?.repl === true
            || environment?.kind === 'repl'
            // El selector puede publicar la pestaña antes de que termine la
            // detección y todavía no existir en `app.environments`. Los
            // entornos `lang:*` son REPL por contrato del catálogo; usar el
            // id como respaldo evita banner y readiness de shell durante esa
            // ventana inicial.
            || /^lang:/u.test(environmentId)
            || /(?:·|\u2022)\s*REPL\s*$/iu.test(tabLabel)
            // Durante el cambio de entorno la etiqueta puede llegar antes
            // que `envId`; cualquier pestaña etiquetada como REPL sigue la
            // ruta de prompt interactivo y no debe esperar el banner shell.
            || /\bREPL\b/iu.test(tabLabel);
    }

    function startupBannerExpected(): boolean {
        if (paneIsRepl() || app.preferences?.showSystemBanner === false) return false;
        const cellHeight = terminalCellHeight();
        const physicalRows = terminalHost && cellHeight > 0
            ? Math.floor(terminalHost.clientHeight / cellHeight)
            : (term?.rows ?? 0);
        return physicalRows >= 12;
    }

    function reportStartupReady(ready: boolean): boolean {
        // Una vez que la entrada se abrió para esta sesión, un reflow puede
        // mover el prompt fuera de las filas inspeccionadas sin volver a
        // deshabilitar el teclado. La época nueva se reinicia explícitamente
        // en onEnvironmentSwitchStarted.
        const sessionReady = ready || inputReady;
        if (host) host.dataset.startupReady = String(sessionReady);
        return sessionReady;
    }

    function terminalStartupReady(): boolean {
        if (!term) return reportStartupReady(false);
        // El selector puede mostrar una pestaña REPL antes de que el catálogo
        // haya actualizado `envId`. Estos prompts son inequívocos y permiten
        // abrir la entrada aunque esa hidratación llegue más tarde.
        const renderedRows = [...terminalHost?.querySelectorAll<HTMLElement>('.xterm-rows > div') ?? []]
            .map((row) => row.textContent ?? '').join('\n');
        const environmentId = startupEnvironmentId ?? app.tabs.find((tab) => tab.id === tabId)?.envId;
        if ((environmentId === 'lang:java' && /(?:^|\n)\s*jshell>\s?/mu.test(renderedRows))
            || (environmentId === 'lang:ruby' && /(?:^|\n)\s*irb\([^)]*\):\d+(?::\d+)?[>]\s?/imu.test(renderedRows))) {
            return reportStartupReady(true);
        }
        // Las shells normales esperan a que termine el fastfetch para no
        // liberar el primer comando encima del banner. Un REPL no lo recibe:
        // su criterio es que aparezca su prompt (`>>>`, `irb(main):001>`, etc.)
        // o la señal de arranque documentada de un REPL sin prompt inicial.
        if (paneIsRepl()) return reportStartupReady(
            terminalPromptVisible() || terminalPromptlessReplStartupReady(),
        );
        // Si el usuario ha desactivado el banner, no existe ningún bloque que
        // esperar: exigir todavía el título de fastfetch retenía la entrada
        // hasta el temporizador de seguridad y hacía parecer que un resize o
        // el botón de dividir "despertaba" una shell que ya estaba lista.
        if (app.preferences?.showSystemBanner === false) return reportStartupReady(terminalPromptVisible());
        // En una casilla realmente baja el banner se omite por diseño. No usar
        // solo `term.rows`: durante el primer fit puede ser provisionalmente
        // 8 aunque el host físico ya tenga altura para el banner, y liberar
        // entonces la entrada coloca la primera orden encima del arranque.
        if (!startupBannerExpected()) return reportStartupReady(terminalPromptVisible());
        const buffer = term.buffer.active;
        const start = Math.max(0, buffer.length - Math.max(term.rows + 20, 64));
        let text = '';
        for (let row = start; row < buffer.length; row += 1) {
            text += `${buffer.getLine(row)?.translateToString(true) ?? ''}\n`;
        }
        const titleIndex = Math.max(
            text.lastIndexOf('WTerminal'),
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
        return reportStartupReady((terminalPromptVisible() || shellPromptAfterBanner(latestBanner))
            && /(?:WTerminal|LTerminal)\s+\d/i.test(latestBanner)
            && (fullBannerComplete || compactBannerComplete));
    }

    /** Una línea de prompt de shell después del banner, aunque lleve una orden
     *  detrás: la shell ya terminó de arrancar. Es la pestaña que abre una
     *  acción del panel y deja corriendo un programa que pregunta (`gh auth
     *  login` y su Y/n): el prompt queda encima de la salida, lejos del
     *  cursor, y las teclas esperaban al seguro de 35 s sin responder. */
    function shellPromptAfterBanner(latestBanner: string): boolean {
        return latestBanner.split('\n').some((line) => isShellInputLine(line));
    }

    function terminalPromptlessReplStartupReady(): boolean {
        if (!term) return false;
        const environmentId = startupEnvironmentId ?? app.tabs.find((tab) => tab.id === tabId)?.envId;
        const buffer = term.buffer.active;
        const cursorRow = buffer.baseY + buffer.cursorY;
        const startRow = Math.max(0, cursorRow - 64);
        let recentOutput = '';
        for (let row = startRow; row <= cursorRow; row += 1) {
            recentOutput += `${buffer.getLine(row)?.translateToString(true) ?? ''}\n`;
        }
        return interactiveReplBannerSignalsReady(recentOutput, environmentId);
    }

    function flushPendingBannerSettingsRefresh(): void {
        if (userEditing || !pendingBannerPrint) return;
        pendingBannerPrint = false;
        // Esperar un frame deja que xterm termine el eco de Enter antes de
        // recalcular la altura de su región.
        requestAnimationFrame(() => requestBannerPrint());
    }

    function ptyAlreadyHas(cols: number, rows: number): boolean {
        return cols === lastPtySize.cols && rows === lastPtySize.rows && xtermTransientShrink === null;
    }

    function noteXtermGeometry(): void {
        if (!term || lastPtySize.rows === 0 || term.rows >= lastPtySize.rows) return;
        if (!xtermTransientShrink || term.rows < xtermTransientShrink.rows) {
            xtermTransientShrink = { cols: term.cols, rows: term.rows };
        }
    }

    /** Reproduce en ConPTY la reducción transitoria de filas que ya sufrió
     *  xterm, para que ambos lleguen al tamaño final por el mismo camino. */
    async function replayTransientShrink(finalRows: number): Promise<void> {
        const shrink = xtermTransientShrink;
        xtermTransientShrink = null;
        if (!shrink || shrink.rows >= finalRows || shrink.rows >= lastPtySize.rows) return;
        const cols = protectedPtyColumns(shrink.cols);
        await api.resize(tabId, cols, shrink.rows);
        lastPtySize = { cols, rows: shrink.rows };
    }

    /** Columnas que puede recibir ConPTY sin encoger una reserva de entrada
     *  activa. Las condiciones son las mismas que antes descartaban el resize
     *  completo; ahora solo impiden reducir columnas. */
    function protectedPtyColumns(cols: number): number {
        if (initialResizePending) return cols;
        const protectsWideInput = inputWideReservationColumns > 0
            && cols < inputWideReservationColumns;
        const protectsEditing = userEditing
            && inputPtyWarmupDone
            && inputWideReservationColumns === 0
            && !inputLineSubmitted
            && cols < INPUT_PTY_WARMUP_COLS;
        const protectsWarmup = commandPtyWarmupColumns >= INPUT_PTY_WARMUP_COLS
            && !environmentSwitchPending
            && !inputLineSubmitted
            && cols < INPUT_PTY_WARMUP_COLS;
        if (!protectsWideInput && !protectsEditing && !protectsWarmup) return cols;
        return Math.min(
            MAX_HORIZONTAL_COLS,
            Math.max(cols, lastPtySize.cols, protectsWideInput ? inputWideReservationColumns : 0),
        );
    }

    /** Un resize aplazado por una ráfaga de salida no se pierde: al quedar la
     *  salida inactiva se envía UNA vez la geometría actual de xterm. No se
     *  sondea ni se vuelve a medir el DOM; con una rejilla 8K, repetir
     *  `fitAndReport` mientras la salida seguía ocupada bloqueaba la página. */
    function syncPtyToTerminalAfterOutput(): void {
        resizeQueue = resizeQueue.then(async () => {
            if (destroyed || !term) return;
            if (terminalOutputBusy) {
                ptySyncPendingAfterOutput = true;
                return;
            }
            const rows = term.rows;
            const targetCols = protectedPtyColumns(term.cols);
            if (ptyAlreadyHas(targetCols, rows)) return;
            await replayTransientShrink(rows);
            await api.resize(tabId, targetCols, rows);
            lastPtySize = { cols: targetCols, rows };
            if (!destroyed && term && term.cols !== targetCols) term.resize(targetCols, rows);
        }).catch((error) => {
            if (!destroyed) console.debug('[TerminalPane] resize aplazado omitido', error);
        });
    }

    function fitAndReport(minimumCols = 0, forceReflow = false): void {
        if (destroyed || !term || !fitAddon || !active) return;
        // La compuerta de visibilidad hará este ajuste en cuanto xterm reanude.
        if (awaitingTerminalVisibility) return;
        // Un resize o una división puede repintar el prompt sin emitir salida
        // de PTY. Reevaluarlo aquí sincroniza `startupReady` con la superficie
        // visible y libera la entrada cuando la shell ya está lista.
        if (!inputReady) {
            const startupReady = terminalStartupReady();
            if (startupReady && !environmentSwitchPending && !inputReleaseTimer) {
                inputReleaseTimer = window.setTimeout(() => {
                    inputReleaseTimer = undefined;
                    void releaseInput();
                }, 50);
            }
        }
        enforceSingleHorizontalScrollContainer();
        // ResizeObserver también puede ser la primera señal después de una
        // división. No depender solo del evento de la PTY: si las filas que
        // se ven ya caben en el nuevo panel, descartar aquí la reserva de la
        // geometría anterior permite que FitAddon proponga las columnas del
        // panel y no las del canvas ancho que quedó en scrollback.
        const layoutViewport = getHorizontalViewport();
        const layoutCellWidth = terminalCellWidth();
        const layoutVisibleCols = layoutViewport && layoutCellWidth > 0
            ? Math.max(1, Math.floor(layoutViewport.clientWidth / layoutCellWidth))
            : 0;
        // El desplazamiento horizontal es una lectura del contenido ya
        // renderizado. No debe iniciar otra medición ni un resize de xterm:
        // los rectángulos DOM se mueven con scrollLeft y una nueva propuesta
        // puede duplicar el desplazamiento (52k→115k columnas), dejando el
        // canvas negro justo en el extremo que se está inspeccionando. Las
        // redimensiones reales vuelven a entrar por la tecla/gesto de edición
        // o por el cambio de layout, que limpia `horizontalUserScrolled`.
        const horizontalReadInProgress = Boolean(
            layoutViewport
            && layoutViewport.scrollLeft > 1
            && horizontalUserScrolled
            && !forceReflow
            && !terminalOutputBusy
            // El auto-scroll del cursor durante una edición también emite
            // scrollLeft. No congelarlo: la reserva de entrada debe poder
            // ampliar ConPTY antes de que el texto llegue al borde.
            && !userEditing
            && !localInputGridPinned
            && inputWideReservationColumns === 0
        );
        if (horizontalReadInProgress) {
            exposeFitSkip('horizontal-read');
            scheduleHorizontalScrollState();
            return;
        }
        // El primer informe de geometría no se salta nunca: el backend retiene
        // la shell hasta recibirlo, y la rejilla solo se libera al ver el
        // prompt que esa shell todavía no ha podido escribir.
        const inputWarmupActive = localInputGridPinned
            && lastSize.rows > 0
            && !outputBurstWide
            && !terminalOutputBusy
            && inputWideReservationColumns === 0
            && !inputLineSubmitted;
        // La reserva preventiva ya cambió xterm localmente a una rejilla
        // amplia. No dejar que el ResizeObserver la devuelva al viewport
        // mientras el usuario sigue escribiendo: ese vaivén es otra forma de
        // producir filas escalonadas antes del Enter.
        if (inputWarmupActive) {
            exposeFitSkip('input-warmup');
            fitAfterOutput = true;
            return;
        }
        const layoutRowsFit = layoutVisibleCols > 0
            && [...terminalHost?.querySelectorAll('.xterm-rows > div') ?? []]
                .every((row) => (row.textContent ?? '').trimEnd().length <= layoutVisibleCols + 1);
        const layoutPromptColumns = minimumPromptColumns();
        if (layoutRowsFit
            // Las filas de una salida larga pueden estar ya reenvueltas por
            // el frame anterior aunque la orden aún necesite su anchura
            // lógica. No desmontar la reserva mientras `outputBurstWide`
            // siga activa; la liberación controlada ocurre después de una
            // orden posterior corta o de `clear`.
            && !outputBurstWide
            && inputWideReservationColumns === 0
            && !terminalOutputBusy
            && layoutVisibleCols > 0
            && (currentDisplayCols() > Math.max(layoutVisibleCols + 2, layoutPromptColumns))) {
            outputBurstWide = false;
            reservedOutputColumns = 0;
            pendingOutputColumns = 0;
            // Publicar el ancho físico antes de proponer dimensiones evita
            // que FitAddon vuelva a leer el canvas antiguo en este mismo
            // frame. El resize explícito conserva el historial y reenvuelve
            // sus líneas, pero no deja un scroll horizontal fantasma.
            if (layoutVisibleCols >= 4 || currentDisplayCols() < 4) {
                terminalHost.style.setProperty('--terminal-content-width', `${terminalHost.clientWidth}px`);
                term.resize(Math.max(layoutVisibleCols, layoutPromptColumns), term.rows);
            } else if (tinyLayoutFitTimer === undefined) {
                tinyLayoutFitTimer = window.setTimeout(() => {
                    tinyLayoutFitTimer = undefined;
                    if (!destroyed) fitAndReport();
                }, 32);
            }
        }
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // Cuando el cursor alcanza el borde, esperar el debounce normal puede
        // dejar que el siguiente espacio se envuelva en una fila nueva antes
        // de ampliar la rejilla. Las ampliaciones horizontales se pueden
        // aplicar en cuanto xterm terminó de procesar la salida.
        // Mientras una sesión conserva una salida ancha, una llamada de
        // ResizeObserver o el repintado de la orden corta no debe encoger la
        // rejilla por su cuenta. Si lo hace, el siguiente bloque vuelve a
        // expandirla y xterm refluye dos veces el scrollback (la fila corta
        // puede desaparecer). `clear` y el cambio de entorno liberan esta
        // reserva; una entrada nueva todavía puede ampliarla mediante
        // `minimumCols`.
        const needsHorizontalResize = outputBurstWide
            ? false
            : horizontalResizeNeeded();
        const needsImmediateInputResize = minimumCols > currentDisplayCols();
        if (!forceReflow
            && !needsImmediateInputResize
            && (terminalOutputBusy || (now - lastOutputFinishedAt < OUTPUT_QUIET_SETTLE_MS && !needsHorizontalResize))) {
            exposeFitSkip(terminalOutputBusy ? 'output-busy' : 'output-quiet');
            fitAfterOutput = true;
            if (!terminalOutputBusy && !fitQuietTimer) {
                fitQuietTimer = window.setTimeout(() => {
                    fitQuietTimer = undefined;
                    requestAnimationFrame(() => fitAndReport());
                    }, Math.max(1, OUTPUT_QUIET_SETTLE_MS - (now - lastOutputFinishedAt)));
            }
            return;
        }
        exposeFitSkip('');
        // La caja medible es exclusivamente la región inferior de xterm.
        if (!host || !terminalHost) {
            console.debug('[TerminalPane] fitAndReport: layout host is null, skipping');
            return;
        }
        // Un panel oculto mide 0: ajustarlo ahí daría un tamaño absurdo que
        // luego habría que deshacer.
        if (terminalHost.clientWidth === 0 || terminalHost.clientHeight === 0) return;
        try {
            // Al dividir/restaurar paneles, FitAddon puede medir todavía la
            // anchura física de la rejilla anterior (`--terminal-content-width`)
            // aunque el buffer actual ya solo contenga el prompt. Retirar esa
            // reserva antes de proponer dimensiones evita que un panel de 32
            // columnas se quede atrapado en 64 sin overflow real. Si existe
            // una línea que sí supera el viewport, se conserva la reserva y
            // el único scroll horizontal sigue siendo el del host.
            const prefitViewport = getHorizontalViewport();
            const prefitCellWidth = terminalCellWidth();
            const prefitVisibleCols = prefitViewport && prefitCellWidth > 0
                ? Math.max(1, Math.floor(prefitViewport.clientWidth / prefitCellWidth))
                : 0;
            const renderedContentColumns = Math.max(
                0,
                ...[...terminalHost.querySelectorAll('.xterm-rows > div')]
                    .map((row) => (row.textContent ?? '').trimEnd().length),
            );
            const renderedRowsFit = prefitVisibleCols > 0
                && renderedContentColumns <= prefitVisibleCols + 1;
            const prefitContentColumns = Math.max(longestVisibleLineWidth(), pendingOutputColumns);
            const promptColumns = minimumPromptColumns();
            const staleGridReservation = renderedRowsFit
                && prefitContentColumns <= currentDisplayCols() + 1
                && (reservedOutputColumns <= prefitVisibleCols + 1 || forceReflow);
            if (prefitVisibleCols > 0
                && (prefitContentColumns <= prefitVisibleCols + 1 || staleGridReservation)
                && inputWideReservationColumns === 0
                && !terminalOutputBusy) {
                terminalHost.dataset.horizontalTail = 'false';
                terminalHost.style.removeProperty('--horizontal-tail-left');
                terminalHost.style.removeProperty('--horizontal-tail-width');
                // Retirar la reserva no basta en WebView2: FitAddon puede
                // medir el ancho físico anterior durante este mismo ciclo de
                // layout. Publicar primero el ancho real del host hace que la
                // propuesta siguiente vuelva a las columnas del panel, en
                // vez de conservar 52/64 columnas en una celda de 32.
                terminalHost.style.setProperty('--terminal-content-width', `${terminalHost.clientWidth}px`);
                pendingOutputColumns = 0;
            }
            const dims = fitAddon.proposeDimensions();
            if (dims) {
                // Una propuesta de 1-3 columnas solo es válida para un panel
                // realmente diminuto. Durante una transición de 2→3/3→4
                // paneles, en cambio, el host ya tiene espacio de sobra pero
                // FitAddon aún lee la geometría del frame anterior. Aplazar
                // el ajuste conserva la matriz anterior y da tiempo a que el
                // grid y el renderer publiquen sus medidas definitivas.
                const proposedColumns = Math.max(1, dims.cols);
                const hostHasStableSpace = terminalHost.clientWidth >= 64
                    && terminalHost.clientHeight >= 32;
                if (hostHasStableSpace && proposedColumns < 4 && currentDisplayCols() >= 4) {
                    if (tinyLayoutFitTimer === undefined) {
                        const retryDelay = tinyLayoutFitRetries < 12 ? 32 : 200;
                        tinyLayoutFitRetries = tinyLayoutFitRetries < 12 ? tinyLayoutFitRetries + 1 : 0;
                        tinyLayoutFitTimer = window.setTimeout(() => {
                            tinyLayoutFitTimer = undefined;
                            if (!destroyed) fitAndReport(minimumCols, forceReflow);
                        }, retryDelay);
                    }
                    return;
                }
                tinyLayoutFitRetries = 0;
                // La primera orden no puede empezar con la rejilla corta del
                // primer `fit()`. Aunque el handshake todavía esté reteniendo
                // el teclado, cmd puede tener ya el prompt visible y WebView2
                // puede entregar una ráfaga en el mismo frame. Reservar la
                // anchura de entrada desde este primer ajuste hace que PTY y
                // xterm nazcan con la misma matriz; luego el host sigue oculto
                // hasta que haya contenido que desplazar.
                const startupGridWarmup = !inputReady
                    && !environmentSwitchPending
                    && !terminalOutputBusy
                    && !inputLineSubmitted;
                if (startupGridWarmup && proposedColumns < INPUT_PTY_WARMUP_COLS) {
                    localInputGridPinned = true;
                    dims.cols = INPUT_PTY_WARMUP_COLS;
                    terminalHost.style.setProperty('--terminal-content-width', `${terminalHost.clientWidth}px`);
                    terminalHost.style.overflowX = 'hidden';
                }
                const bufferBeforeResize = term.buffer.active;
                // Si el usuario estaba en el prompt, xterm debe seguir anclado al
                // final después de recalcular columnas. Al envolver una línea
                // larga el scrollback gana filas; conservar el mismo `viewportY`
                // dejaba visible una continuación arriba y daba la impresión de
                // que se había perdido texto al dividir la pestaña.
                const wasAtBottom = bufferBeforeResize.viewportY >= bufferBeforeResize.baseY - 1;
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
                const viewport = getHorizontalViewport();
                const previousScrollLeft = viewport?.scrollLeft ?? 0;
                const previousMaximumScrollLeft = viewport
                    ? Math.max(0, viewport.scrollWidth - viewport.clientWidth)
                    : 0;
                const wasAtHorizontalEnd = previousMaximumScrollLeft > 0
                    && previousScrollLeft >= previousMaximumScrollLeft - 2;
                // Una redimensión que sigue a `Enter` no debe conservar el
                // pequeño `scrollLeft` que dejó el cursor al final de la
                // edición. Ese desplazamiento intermedio corta el prompt y
                // el inicio de la salida aunque el usuario no haya movido la
                // barra. Solo preservamos la posición cuando es una decisión
                // explícita del usuario o mientras la línea sigue editándose.
                const preserveHorizontalPosition = horizontalUserScrolled || userEditing;
                const restoreScrollLeft = preserveHorizontalPosition ? previousScrollLeft : 0;
                const restoreAtHorizontalEnd = preserveHorizontalPosition && wasAtHorizontalEnd;
                const cellWidth = terminalCellWidth();
                // El renderer de xterm puede publicar sus dimensiones una
                // frame después de `proposeDimensions()`. En ese intervalo
                // todavía conocemos el ancho de una celda por la caja que
                // acaba de medir FitAddon; usarlo evita que el host vuelva a
                // 100% aunque la PTY ya tenga más columnas.
                const measuredCellWidth = cellWidth > 0
                    ? cellWidth
                    : terminalHost.clientWidth / proposedColumns;
                const longestLine = longestVisibleLineWidth();
                const visibleCols = viewport && measuredCellWidth > 0
                    ? Math.max(1, Math.floor(viewport.clientWidth / measuredCellWidth))
                    : dims.cols;
                // La PTY debe recibir el ancho de la línea visible más larga.
                // Si se mantiene siempre en el ancho del viewport, ConPTY
                // puede envolver o descartar la cola antes de que xterm pueda
                // desplazarla. La medición DOM cubre glifos que xterm conserva
                // durante un reflow y evita perder `%WS` o el mensaje final.
                const measuredRenderColumns = Math.max(
                    longestLine,
                    pendingOutputColumns,
                    inputWideReservationColumns,
                    promptColumns,
                );
                // Si la propia línea lógica supera el viewport, no limitarla
                // a `visibleCols`: ese atajo deja a ConPTY con una rejilla de
                // una o dos celdas menos y el canvas recorta precisamente la
                // cola (el DOM sigue mostrando los últimos números, pero la
                // captura no). La salida corta recupera su ancho en el fit
                // posterior cuando deja de superar el viewport.
                const renderWideContent = outputBurstWide
                    || pendingOutputColumns > visibleCols + 1;
                const renderContentColumns = renderWideContent
                    ? measuredRenderColumns
                    : Math.min(measuredRenderColumns, visibleCols);
                terminalHost.dataset.horizontalTail = String(renderContentColumns > visibleCols);
                if (outputBurstWide && reservedOutputColumns > visibleCols + 1) {
                    terminalHost.dataset.horizontalTail = 'true';
                }
                terminalHost.dataset.longestVisibleLine = String(longestLine);
                const domMeasurement = measureVisibleDomContent(measuredCellWidth);
                const domOverflowColumns = domMeasurement.overflowColumns;
                const finalContentColumns = Math.max(
                    renderContentColumns,
                    domOverflowColumns,
                    inputWideReservationColumns,
                    promptColumns,
                    outputBurstWide ? reservedOutputColumns : 0,
                );
                dims.cols = requiredTerminalColumns(
                    visibleCols,
                    finalContentColumns,
                    minimumCols,
                    MAX_HORIZONTAL_COLS,
                );
                // FitAddon puede leer el canvas anterior (por ejemplo, 167
                // columnas) aunque el panel ya sea una columna de ~58. Si
                // las filas visibles caben y no existe una reserva de salida
                // ancha, la dimensión correcta es la del viewport; forzarla
                // aquí evita que el canvas y el scrollWidth permanezcan
                // grandes después de dividir la vista.
                // Durante una edición larga, el DOM puede seguir mostrando
                // solo el prompt mientras ConPTY aún devuelve el eco. Encoger
                // aquí la rejilla a las columnas visibles (tras un resize de
                // ventana) separa la orden del prompt aunque la reserva de
                // entrada y ConPTY ya estén en 1024 columnas.
                if (layoutRowsFit
                    && !outputBurstWide
                    && inputWideReservationColumns === 0
                    && !userEditing
                    && !inputLineSubmitted
                    && layoutVisibleCols > 0
                    && !startupGridWarmup) {
                    dims.cols = Math.max(
                        layoutVisibleCols,
                        promptColumns,
                        Math.min(MAX_HORIZONTAL_COLS, minimumCols),
                    );
                }
                // La capa DOM puede conservar una fila lógica más larga que
                // la rejilla que FitAddon acaba de proponer. Si dejamos que
                // esta propuesta gane, el canvas se queda en ~326 columnas y
                // el extremo de una salida como 1–120 se pinta solo hasta
                // 113 aunque el texto completo siga en el buffer. Reforzar
                // aquí la longitud de la fila visible mantiene el canvas y la
                // PTY alineados con lo que realmente debe poder verse.
                // El eco de una orden ejecutada también forma parte del
                // historial visible. Si se ignora aquí, una orden de 959
                // columnas seguida de una salida de 931 reduce la rejilla a
                // 931 y xterm reenvuelve el eco: el final del comando aparece
                // al comienzo de otra fila aunque el buffer aún lo conserve.
                const logicalDomColumns = Math.max(
                    0,
                    ...[...terminalHost.querySelectorAll('.xterm-rows > div')]
                        .map((row) => (row.textContent ?? '').trimEnd().length),
                );
                // El primer fit posterior a Enter puede ejecutarse antes de
                // que xterm haya insertado la salida. En ese frame la reserva
                // preventiva sigue siendo 1024 columnas; en el siguiente ya
                // conocemos la fila lógica real. Ajustarla aquí evita que el
                // spacer conserve cientos de columnas sin glifos y que el
                // scroll al extremo derecho deje el viewport completamente
                // vacío.
                if (outputBurstWide
                    && inputWideReservationColumns === 0
                    && !inputLineSubmitted
                    && logicalDomColumns > visibleCols + 1
                    && logicalDomColumns < reservedOutputColumns) {
                    reservedOutputColumns = logicalDomColumns;
                    pendingOutputColumns = Math.min(
                        Math.max(visibleCols + 1, pendingOutputColumns),
                        logicalDomColumns,
                    );
                }
                if (logicalDomColumns > visibleCols + 1) {
                    const logicalColumnsWithMargin = Math.min(MAX_HORIZONTAL_COLS, logicalDomColumns + 2);
                    dims.cols = Math.max(dims.cols, logicalColumnsWithMargin);
                    // FitAddon puede seguir proponiendo la rejilla preventiva
                    // (1024 columnas) porque el canvas anterior aún ocupa ese
                    // ancho. Cuando la salida ya está pintada y su fila lógica
                    // es menor, la dimensión correcta es la fila real: dejar
                    // que gane la propuesta vieja vuelve a crear un tramo sin
                    // glifos al desplazar hasta el final.
                    if (logicalDomColumns < currentDisplayCols()
                        && inputWideReservationColumns === 0
                        && !userEditing
                        && !inputLineSubmitted
                        && (outputBurstWide || reservedOutputColumns > visibleCols + 1)) {
                        dims.cols = Math.max(
                            visibleCols + 1,
                            logicalColumnsWithMargin,
                        );
                    }
                }
                // xterm refluye todo el scrollback incluso cuando recibe las
                // mismas dimensiones. Durante una salida muy ancha ese
                // reflow redundante puede descartar una línea corta que ya
                // estaba confirmada (la matriz conserva el texto largo, pero
                // pierde la orden inmediatamente posterior). Solo hay que
                // notificar al backend cuando cambió realmente la rejilla.
                if (forceReflow || dims.cols !== currentDisplayCols() || dims.rows !== term.rows) {
                    term.resize(dims.cols, dims.rows);
                }
                pendingOutputColumns = 0;
                const baseContentWidth = Math.max(terminalHost.clientWidth, Math.ceil(dims.cols * measuredCellWidth));
                // Aplicar únicamente un desbordamiento físico real de la fila
                // y limitarlo para que una medida contaminada por un frame
                // antiguo no pueda crecer indefinidamente.
                const screenElement = terminalHost.querySelector<HTMLElement>('.xterm-screen');
                // La rejilla de xterm tiene al menos CONPTY_MIN_COLS columnas
                // aunque se pidan menos, así que su `scrollWidth` mide esa
                // rejilla (antes fabricaba host+1024 px de espacio vacío).
                // Antes de compartir rejilla con ConPTY, el screen medía
                // exactamente las columnas pedidas: se usa ese ancho, que
                // incluye la reserva de una orden larga en edición.
                // Se escala el ancho REAL del screen (no columnas × celda
                // medida): el avance de los glifos del renderer DOM puede ser
                // mayor que la celda que publica xterm (7,6 frente a 7,0 px) y
                // ese ancho físico es el que mantiene visible el último dígito.
                const gridWidth = Math.ceil(term.cols * measuredCellWidth);
                const screenReflectsGrid = Boolean(screenElement)
                    && term.cols > 0
                    && screenElement!.scrollWidth >= gridWidth - Math.ceil(measuredCellWidth * 2);
                const screenScrollWidth = screenReflectsGrid
                    ? Math.ceil(screenElement!.scrollWidth * Math.min(1, dims.cols / term.cols))
                    : (screenElement?.scrollWidth ?? 0);
                const screenOverflowWidth = screenElement && screenScrollWidth > screenElement.clientWidth + 1
                    ? screenScrollWidth
                    : 0;
                // Tras reducir una rejilla preventiva, WebView2 puede
                // conservar durante un frame el `scrollWidth` antiguo del
                // screen. Usarlo como máximo vuelve a fabricar un margen
                // vacío después de la última cifra. Cuando conocemos una fila
                // lógica real, su anchura de celdas es el límite fiable; el
                // scrollWidth anterior solo se admite dentro de dos celdas de
                // ese límite para cubrir el redondeo del renderer.
                const logicalContentWidth = logicalDomColumns > visibleCols + 1
                    ? Math.ceil(logicalDomColumns * measuredCellWidth)
                    : 0;
                const boundedScreenOverflow = logicalContentWidth > 0
                    ? Math.min(screenOverflowWidth, logicalContentWidth + Math.ceil(measuredCellWidth * 2))
                    : screenOverflowWidth;
                const boundedDomContentWidth = logicalContentWidth > 0
                    ? Math.min(domMeasurement.contentWidth, logicalContentWidth + Math.ceil(measuredCellWidth * 2))
                    : domMeasurement.contentWidth;
                const trustedScreenOverflow = logicalContentWidth > 0
                    && screenOverflowWidth > logicalContentWidth + Math.ceil(measuredCellWidth * 16)
                    ? screenOverflowWidth
                    : 0;
                const trustedDomOverflow = logicalContentWidth > 0
                    && domMeasurement.contentWidth > logicalContentWidth + Math.ceil(measuredCellWidth * 16)
                    ? domMeasurement.contentWidth
                    : 0;
                const measuredOverflowWidth = Math.max(
                    boundedDomContentWidth,
                    boundedScreenOverflow,
                    logicalContentWidth,
                    trustedScreenOverflow,
                    trustedDomOverflow,
                );
                const logicalTailPadding = logicalContentWidth > 0
                    // El rectángulo de Range puede redondear hacia abajo las
                    // últimas celdas de una fila larga. Un margen corto de 40
                    // celdas mantiene los últimos glifos dentro del viewport
                    // sin recuperar la reserva de 1024 columnas.
                    ? Math.ceil(measuredCellWidth * 40)
                    : 0;
                const measuredPhysicalWidth = logicalContentWidth > 0
                    ? Math.max(
                        terminalHost.clientWidth,
                        logicalContentWidth + logicalTailPadding,
                        trustedScreenOverflow,
                        trustedDomOverflow,
                    )
                    : (measuredOverflowWidth > baseContentWidth
                        ? Math.min(measuredOverflowWidth, baseContentWidth + 1024)
                        : baseContentWidth);
                terminalHost.style.setProperty('--terminal-content-width', `${measuredPhysicalWidth}px`);
                syncTerminalRootWidth(measuredPhysicalWidth);
                updateHorizontalTailReservation(measuredCellWidth);
                // El reflow puede reducir el máximo, pero nunca debe saltar
                // al margen izquierdo ni ocultar el extremo que el usuario
                // estaba leyendo.
                requestAnimationFrame(() => {
                    updateHorizontalTailReservation(measuredCellWidth);
                    requestAnimationFrame(() => updateHorizontalTailReservation(measuredCellWidth));
                });
                if (viewport) {
                    const maximumScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
                    setHorizontalScrollLeft(
                        viewport,
                        restoreAtHorizontalEnd ? maximumScrollLeft : Math.min(restoreScrollLeft, maximumScrollLeft),
                        3,
                    );
                    // El ancho físico del xterm/spacer se publica después del
                    // reflow. Restaurar solo en este frame dejaba la barra en
                    // un máximo antiguo y el siguiente ResizeObserver la
                    // devolvía al inicio. Reafirmar dos frames conserva tanto
                    // la posición manual como el extremo derecho real.
                    const restoreHorizontalPosition = () => {
                        if (destroyed) return;
                        const currentMaximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
                        setHorizontalScrollLeft(
                            viewport,
                            restoreAtHorizontalEnd ? currentMaximum : Math.min(restoreScrollLeft, currentMaximum),
                            3,
                        );
                        scheduleHorizontalScrollState();
                    };
                    requestAnimationFrame(restoreHorizontalPosition);
                    requestAnimationFrame(() => requestAnimationFrame(restoreHorizontalPosition));
                }
                if (wasAtBottom) term.scrollToBottom();
                if (wasAtBottom) {
                    // ConPTY/xterm puede recalcular el scrollback un frame
                    // después del resize. Reafirmar el anclaje al final en el
                    // siguiente frame evita que una línea corta recién
                    // escrita vuelva a quedar fuera de la vista mientras el
                    // canvas termina de reenvolver una línea larga.
                    requestAnimationFrame(() => {
                        if (!destroyed && term) term.scrollToBottom();
                    });
                }
                // No volver a programar `fitAndReport` mientras la reserva
                // ancha siga activa. Un temporizador periódico aquí hacía que
                // WTERMSEQ reentrara en el reflow cada 180 ms aunque las
                // dimensiones ya fueran estables. La cola de salida inactiva
                // y `scheduleOutputGeometrySettle` ya cubren el único repintado
                // posterior que necesita el renderer.
            } else {
                fitAddon.fit();
                // Durante una transición de layout FitAddon puede no poder
                // proponer dimensiones todavía. La reserva solicitada por la
                // entrada no puede perderse por ese frame intermedio.
                if (minimumCols > currentDisplayCols()) term.resize(minimumCols, term.rows);
            }
            // Invalidar el rango visible tras cambiar la caja de xterm evita
            // residuos del canvas anterior en WebView2.
            const refreshRows = () => {
                if (destroyed || !term) return;
                term.refresh(0, Math.max(0, term.rows - 1));
            };
            refreshRows();
            requestAnimationFrame(refreshRows);
            scheduleTerminalRepaint();
            scheduleHorizontalScrollState();
            // El inspector del WebView y algunos gestores de ventanas cambian
            // el viewport sin emitir un resize convencional. Exponer las
            // dimensiones efectivas ayuda a que el smoke compare el espacio
            // pintado con el que recibió el backend.
            host.dataset.terminalCols = String(term.cols);
            host.dataset.terminalRows = String(term.rows);
            host.dataset.displayCols = String(currentDisplayCols());
            noteXtermGeometry();
        } catch (err) {
            console.error('[TerminalPane] fitAndReport error', err);
            return;
        }
        if (term.cols === lastSize.cols && term.rows === lastSize.rows) return;
        // El primer ajuste desbloquea la inicialización retenida del PTY. No
        // hay todavía una ráfaga de resize que agrupar, así que aplazarlo
        // 250 ms solo retrasa el primer prompt y el banner. Los ajustes que
        // llegan después conservan el debounce para no castigar el arrastre
        // del borde de la ventana.
        const isInitialResize = lastSize.cols === 0 && lastSize.rows === 0;
        if (isInitialResize) beginInitialResizeBarrier();
        lastSize = { cols: term.cols, rows: term.rows };
        if (resizeTimer) clearTimeout(resizeTimer);
        const cols = term.cols;
        const rows = term.rows;
        const resizeStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // Invalidar aquí, al programar, y no cuando vence el temporizador.
        // Las peticiones de entrada usan un retardo cero y podían quedar
        // encadenadas detrás de una redimensión anterior; si la shell empezaba
        // a escribir antes de vaciar esa cola, ConPTY reenvolvía la salida con
        // geometrías obsoletas y desaparecía el inicio de una línea larga.
        const sequence = ++resizeSequence;
        const runPtyResize = () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = undefined;
            if (pendingPtyResizeRun === runPtyResize) pendingPtyResizeRun = undefined;
            if (destroyed) return;
            // Mientras se edita una línea ancha, una medición normal del
            // ResizeObserver puede ser más pequeña que la reserva que acaba
            // de pedir la entrada. Esas columnas no se encogen (el eco se
            // envolvería antes de que exista scrollbar), pero las filas sí se
            // envían: antes se descartaba el resize completo y, como
            // `lastSize` ya coincidía con xterm, ConPTY se quedaba con las
            // filas viejas y el eco caía por debajo del prompt.
            if (!initialResizePending && ptyAlreadyHas(protectedPtyColumns(cols), rows)) return;
            resizeQueue = resizeQueue.then(async () => {
                if (destroyed || sequence !== resizeSequence) return;
                // Durante una ráfaga de salida no se cambia la geometría,
                // pero tampoco se pierde: se reintenta al quedar inactiva.
                if (terminalOutputBusy && !initialResizePending) {
                    ptySyncPendingAfterOutput = true;
                    return;
                }
                const targetCols = protectedPtyColumns(cols);
                if (!initialResizePending && ptyAlreadyHas(targetCols, rows)) {
                    // ConPTY ya tiene esa geometría; solo hay que alinear xterm.
                    if (term && (term.cols !== targetCols || term.rows !== rows)) term.resize(targetCols, rows);
                    return;
                }
                try {
                    await replayTransientShrink(rows);
                    await api.resize(tabId, targetCols, rows);
                    lastPtySize = { cols: targetCols, rows };
                    if (destroyed) return;
                    // El resize del PTY puede provocar un repintado propio de
                    // ConPTY después del resize local de xterm. Reaplicar la
                    // última geometría al terminar la llamada y refrescar en
                    // varios frames cierra la ventana en la que el prompt
                    // queda reenvuelto con una matriz de 2 columnas.
                    if (sequence === resizeSequence) {
                        // Aunque xterm ya tenga estas dimensiones, ConPTY ha
                        // podido emitir un último bloque con la rejilla que
                        // tenía antes de resolver la solicitud. Forzar una
                        // segunda reflow con la geometría confirmada hace
                        // que el prompt completo vuelva a ocupar sus celdas y
                        // no quede como `C:\\Users\\Adminis` tras un cambio
                        // de 2→3/3→4 paneles.
                        if (term) term.resize(targetCols, rows);
                        terminalPromptVisible();
                        scheduleTerminalRepaint();
                    }
                    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    perf.record('terminal.resize', 'duration', {
                        durationMs: Math.round(Math.max(0, now - resizeStartedAt) * 100) / 100,
                        status: 'ok',
                        tabId,
                        details: { cols, rows, sequence },
                    });
                } catch (error) {
                    if (destroyed) return;
                    console.error('[TerminalPane] resize failed', error);
                    perf.record('terminal.resize', 'duration', {
                        durationMs: Math.round(Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - resizeStartedAt) * 100) / 100,
                        status: 'error',
                        tabId,
                        details: { cols, rows, sequence, error: String(error).slice(0, 300) },
                    });
                } finally {
                    // Solo la última geometría pendiente puede liberar la
                    // entrada. Si una ResizeObserver posterior sustituyó la
                    // primera petición, su callback antiguo no debe abrir la
                    // compuerta con un tamaño obsoleto.
                    if (initialResizePending && sequence === resizeSequence) {
                        completeInitialResizeBarrier();
                    }
                }
            }).catch(() => undefined);
        };
        pendingPtyResizeRun = runPtyResize;
        resizeTimer = setTimeout(runPtyResize, minimumCols > 0 || isInitialResize ? 0 : 250);
    }

    onMount(() => {
        destroyed = false;
        host?.setAttribute('data-startup-ready', 'false');
        cursorVisible = true;
        terminalHost?.setAttribute('data-cursor-visible', 'true');
        startCursorBlinkTimer();
        perf.startPoint(`terminal-mounted:${tabId}`);
        const mountFinished = perf.start('terminal.xterm-mount', { tabId });
        const handshakeFinished = perf.start('terminal.ready-handshake', { tabId });
        const preferences = app.preferences;
        const initialCursor = preferences
            ? cursorOptions(preferences)
            : { cursorStyle: 'block' as const, cursorWidth: 1 };
        term = new Terminal({
            cursorBlink: preferences?.terminalCursorBlink ?? true,
            ...initialCursor,
            // El estilo inactivo es explícito: cada panel conserva un cursor
            // visible aunque otro panel tenga el foco del teclado.
            cursorInactiveStyle: preferences ? cursorInactiveStyle(preferences) : 'block',
            scrollOnUserInput: true,
            // SearchAddon usa las decoraciones propuestas para resaltar las
            // coincidencias del scrollback; habilitarlas evita un error de
            // WebView2 aunque el contador de resultados sí llegue a pintar.
            allowProposedApi: true,
            // Hipervínculos OSC 8: con el mismo Ctrl+clic y validación que
            // las URL detectadas (ver `syncTerminalLinks`).
            linkHandler: terminalLinkHandler(preferences?.terminalLinks !== false),
            scrollback: preferences?.terminalScrollback ?? 5000,
            fontFamily: preferences ? terminalFont(preferences, app.fonts) : 'monospace',
            fontSize: preferences?.terminalFontSize ?? 14,
            lineHeight: preferences?.terminalLineHeight ?? 1.5,
            letterSpacing: preferences?.terminalLetterSpacing ?? 0,
            fontWeight: preferences ? terminalFontWeight(preferences) : 400,
            scrollSensitivity: preferences?.terminalScrollSensitivity ?? 3,
            theme: preferences ? terminalTheme(preferences, app.themes) : undefined,
            // El PTY de Windows es ConPTY. Declararlo permite a xterm aplicar
            // sus heurísticas de wrapping al cambiar de 1 a varios paneles;
            // sin esta marca el reflow trata las filas como Unix y puede
            // perder fragmentos de líneas largas (por ejemplo «otros» en
            // :terminal) durante el resize. 21376 es el primer build de
            // ConPTY cuyo scrollback soporta reflow fiable; al declarar el
            // backend xterm usa sus heurísticas de wrapping en vez de tratar
            // las filas como Unix. En Linux la opción no se añade.
            ...(app.appInfo?.platform === 'windows'
                ? { windowsPty: { backend: 'conpty' as const, buildNumber: 21376 } }
                : {})
        });
        // La PTY nunca baja de `CONPTY_MIN_COLS` columnas (el backend lo
        // impone). Si xterm se estrechaba al ancho del panel, refluía en
        // varias filas líneas que ConPTY mantenía en una, y sus `ESC[fila;colH`
        // caían por debajo del prompt. Todas las rutas (FitAddon, reservas,
        // liberaciones) siguen pidiendo su ancho; solo la rejilla real queda
        // a la par de ConPTY y lo pedido se publica como ancho visible.
        const resizeGrid = term.resize.bind(term);
        term.resize = (cols: number, rows: number) => {
            displayCols = Math.max(1, Math.floor(cols));
            if (host) host.dataset.displayCols = String(displayCols);
            const gridCols = Math.max(CONPTY_MIN_COLS, displayCols);
            if (term && gridCols === term.cols && rows === term.rows) return;
            resizeGrid(gridCols, rows);
        };
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        searchAddon = new SearchAddon({ highlightLimit: 1000 });
        term.loadAddon(searchAddon);
        // Anchos de Unicode 11: los emoji y símbolos modernos ocupan dos
        // celdas, igual que los mide ConPTY. Con las tablas de Unicode 6 que
        // xterm usa de serie, muchos contaban una y el cursor de xterm y el de
        // ConPTY acababan en columnas distintas en esa misma línea.
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = '11';
        // Imágenes Sixel en línea (fastfetch, chafa, img2sixel…): xterm las
        // pinta en su propia capa; el decodificador es WebAssembly (CSP
        // `'wasm-unsafe-eval'`). Las de iTerm2 quedan fuera: ConPTY no las
        // interpreta, su cursor no bajaría con la imagen y el eco siguiente
        // saldría despegado. En Windows cada Sixel ocupa las filas que cuenta
        // ConPTY (`sixel-conpty.ts`).
        const imageAddon = new ImageAddon({ sixelSupport: true, iipSupport: false, storageLimit: 64 });
        term.loadAddon(imageAddon);
        if (app.appInfo?.platform === 'windows') alignSixelWithConpty(term, imageAddon);
        // URL http/https/file clicables con Ctrl+clic (Ajustes → Terminal).
        syncTerminalLinks(preferences?.terminalLinks !== false);
        searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
            if (resultCount === 0 && searchQuery && visibleRowsSearch(searchQuery)) {
                searchResultIndex = 0;
                searchResultCount = 1;
                return;
            }
            searchResultIndex = resultIndex;
            searchResultCount = resultCount;
        });
        term.open(terminalHost);
        // Imagen a la izquierda del banner: una decoración anclada al título
        // que ConPTY nunca ve (`banner-image.ts`).
        bannerImages = attachBannerImages(term, () => {
            const prefs = app.preferences;
            const info = app.appInfo;
            if (!prefs || !info) return null;
            return {
                enabled: prefs.bannerImage && prefs.showSystemBanner,
                title: `${info.name} ${info.version}`,
                url: app.bannerImageUrl,
            };
        });
        // Crear xterm con la matriz de trabajo antes del primer fit evita una
        // ventana inicial de 112 columnas. Si una ráfaga de teclado llega en
        // ese intervalo, ConPTY puede ecoarla con la rejilla estrecha y el
        // host acaba mostrando solo una cola o un canvas vacío al desplazarse.
        // El host permanece oculto hasta que exista una reserva horizontal
        // real, por lo que los comandos cortos no muestran una barra.
        if (term.cols < INPUT_PTY_WARMUP_COLS) {
            localInputGridPinned = true;
            term.resize(INPUT_PTY_WARMUP_COLS, term.rows);
            terminalHost.style.setProperty('--terminal-content-width', `${terminalHost.clientWidth}px`);
            terminalHost.style.overflowX = 'hidden';
        }
        void warmupPtyForInput();
        enforceSingleHorizontalScrollContainer();
        const xtermRoot = terminalHost.querySelector<HTMLElement>('.xterm');
        if (xtermRoot) {
            rootWidthObserver = new ResizeObserver(() => {
                if (destroyed || rootWidthSyncFrame !== undefined) return;
                rootWidthSyncFrame = window.requestAnimationFrame(() => {
                    rootWidthSyncFrame = undefined;
                    if (destroyed || !terminalHost || !xtermRoot.isConnected) return;
                    const rootWidth = xtermRoot.getBoundingClientRect().width;
                    const screenWidth = xtermRoot.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect().width ?? 0;
                    const cellWidth = terminalCellWidth();
                    const visibleColumns = cellWidth > 0
                        ? Math.max(1, Math.floor(terminalHost.clientWidth / cellWidth))
                        : currentDisplayCols();
                    const inputReservationActive = inputWideReservationColumns > visibleColumns;
                    const reservedInputWidth = inputReservationActive && cellWidth > 0
                        ? Math.ceil(inputWideReservationColumns * cellWidth)
                        : 0;
                    const styleWidth = Number.parseFloat(
                        terminalHost.style.getPropertyValue('--terminal-content-width'),
                    ) || 0;
                    const width = Math.max(
                        terminalHost.clientWidth,
                        Math.ceil(rootWidth),
                        Math.ceil(screenWidth),
                        reservedInputWidth,
                        inputReservationActive ? styleWidth : 0,
                    );
                    const spacer = terminalHost.querySelector<HTMLElement>('.terminal-width-spacer');
                    if (!spacer) return;
                    const cssWidth = `${width}px`;
                    if (spacer.style.width !== cssWidth) spacer.style.setProperty('width', cssWidth, 'important');
                    if (spacer.style.minWidth !== cssWidth) spacer.style.setProperty('min-width', cssWidth, 'important');
                    const renderedOverflow = inputReservationActive
                        || rootWidth > terminalHost.clientWidth + 1
                        || screenWidth > terminalHost.clientWidth + 1;
                    terminalHost.dataset.horizontalTail = String(renderedOverflow);
                    terminalHost.style.overflowX = renderedOverflow ? 'auto' : 'hidden';
                    const pane = terminalHost.closest<HTMLElement>('.tab-pane');
                    if (pane) pane.dataset.horizontalOverflow = String(renderedOverflow);
                    scheduleHorizontalScrollState();
                });
            });
            rootWidthObserver.observe(xtermRoot);
            const xtermScreen = xtermRoot.querySelector<HTMLElement>('.xterm-screen');
            if (xtermScreen) rootWidthObserver.observe(xtermScreen);
        }
        terminalSearchHandler = (event: KeyboardEvent) => {
            if (!terminalHost.contains(event.target as Node)
                || event.type !== 'keydown'
                // `??` y no `||`: un atajo vacío está desasignado a propósito;
                // el de fábrica solo cubre las preferencias aún sin cargar.
                || !matchesShortcut(event, app.preferences?.shortcutSearchTerminal ?? 'Ctrl+Shift+F')) return;
            event.preventDefault();
            event.stopPropagation();
            openSearch();
        };
        terminalHost.addEventListener('keydown', terminalSearchHandler, true);
        horizontalViewport = terminalHost;
        horizontalViewport?.addEventListener('scroll', onHorizontalViewportScroll, { passive: true });
        horizontalViewport?.addEventListener('wheel', onTerminalWheel, { capture: true, passive: false });
        term.textarea?.addEventListener('focus', () => {
            // El foco llega antes que la ráfaga de teclas. Enviar la reserva
            // al backend en este punto deja a cmd/PowerShell con una rejilla
            // amplia antes de que pueda ecoar la primera letra.
            void warmupPtyForInput();
        });
        term.onRender(() => {
            scheduleHorizontalScrollState();
            // El render es la señal común que confirma que el prompt y la
            // última fila del banner ya están pintados. Antes solo se
            // reevaluaba para REPL; tras un resize/división una shell normal
            // podía mostrar el prompt mientras `startupReady` seguía en
            // `false`, bloqueando la siguiente orden indefinidamente.
            if (!inputReady) {
                const startupReady = terminalStartupReady();
                if (startupReady && !environmentSwitchPending && !inputReleaseTimer) {
                    inputReleaseTimer = window.setTimeout(() => {
                        inputReleaseTimer = undefined;
                        void releaseInput();
                    }, 50);
                }
            }
        });
        term.onScroll(() => {
            // Mientras está oculta, el scroll lo mueve el navegador al aplicar
            // `display: none`, no el usuario.
            if (!active) return;
            // El salto de la reactivación no es el usuario subiendo: no debe
            // dejar `userScrolledBack` ni cortar el seguimiento de la salida.
            if (activationScrollPinned()) return;
            updateVerticalScrollIntent();
            scheduleHorizontalScrollState();
        });
        term.onCursorMove(() => {
            keepCursorHorizontallyVisible();
            scheduleHorizontalScrollState();
        });
        term.onRender(() => restoreScrollAfterRender());
        mountFinished('ok', { cols: term.cols, rows: term.rows });

        term.onData((data) => {
            // xterm puede activar el informe de foco y emitir ESC[I / ESC[O al
            // entrar o salir de un diálogo. Esas secuencias sí deben llegar a
            // la shell, pero no son texto editado: si envenenan `mirroredLine`
            // el siguiente `:comando` cae en Fish/cmd en vez de interceptarse.
            const editingData = data
                .replaceAll('\x1b[I', '')
                .replaceAll('\x1b[O', '');
            // Las respuestas VT generadas por xterm para las sondas de
            // arranque también llegan por onData en algunas versiones de
            // WebKit. No son edición del usuario: marcarlas como tal
            // bloqueaba la limpieza segura de una casilla que se encogía.
            const terminalResponse = /^(?:(?:\x1b\[[0-9;?]*[ -/]*[@-~])|(?:\x1bO.)|(?:\x1b\].*\x07))+$/u.test(editingData);
            // `onData` solo recibe teclas del usuario, no la salida de la
            // shell. Mantener este estado separado del espejo ASCII también
            // cubre nano, REPLs y entradas con teclas de control.
            if (terminalResponse) {
                // Mantener el estado de edición anterior; la respuesta se
                // reenvía abajo para no alterar el protocolo de la shell.
                // Si el espejo aún no conoce ninguna línea, una bandera
                // antigua solo puede proceder de una sonda VT agrupada con
                // esta respuesta; no hay entrada humana que proteger.
                if (mirroredLine === null) userEditing = false;
                exposeInputMirror('terminal-response');
                void api.sendInput(tabId, data);
                return;
            }
            if (!inputReady) {
                // La primera tecla puede llegar antes de que termine el
                // handshake del PTY. Marcarla como edición evita que el
                // reintento de prompt inyecte Enter mientras esa línea está
                // todavía encolada (en especial tras muchos espacios).
                userEditing = true;
                queuedInput += data;
                // No esperar a `releaseInput()` para reservar la matriz. En
                // una ráfaga larga (pegado o WebDriver) la shell puede
                // devolver el eco mientras el handshake aún está cerrando;
                // si la reserva se difiere, xterm pinta la entrada sobre las
                // columnas del viewport y el extremo derecho queda recortado
                // hasta que se pulsa Enter. Reservar aquí es idempotente y la
                // cola de entrada seguirá esperando la misma barrera antes
                // de enviarse a ConPTY.
                const queuedPrintableLength = queuedInput
                    .replace(/[\x00-\x1f\x7f]/g, '').length;
                if (queuedPrintableLength > 0) {
                    const viewport = getHorizontalViewport();
                    const cellWidth = terminalCellWidth();
                    const visibleColumns = viewport && cellWidth > 0
                        ? Math.max(1, Math.floor(viewport.clientWidth / cellWidth))
                        : currentDisplayCols();
                    if (queuedPrintableLength > visibleColumns && term) {
                        // El eco puede llegar antes de que termine la cola IPC.
                        // Fijar aquí la rejilla local evita que ese primer frame
                        // se pinte con 112 columnas y solo se repare después.
                        const requiredColumns = Math.min(
                            MAX_INPUT_RESERVATION_COLS,
                            Math.max(
                                INPUT_PTY_WARMUP_COLS,
                                Math.ceil((queuedPrintableLength + 4) / 64) * 64,
                            ),
                        );
                        inputWideReservationColumns = Math.max(
                            inputWideReservationColumns,
                            requiredColumns,
                        );
                        localInputGridPinned = true;
                        if (requiredColumns > term.cols) {
                            term.resize(requiredColumns, term.rows);
                            if (terminalHost && cellWidth > 0) {
                                const contentWidth = Math.ceil(requiredColumns * cellWidth);
                                terminalHost.style.setProperty(
                                    '--terminal-content-width',
                                    `${contentWidth}px`,
                                );
                                terminalHost.style.overflowX = 'auto';
                                terminalHost.dataset.horizontalTail = 'true';
                                syncTerminalRootWidth(contentWidth);
                            }
                            scheduleTerminalRepaint();
                        }
                    }
                    void reserveCurrentInputColumns(queuedPrintableLength);
                }
                exposeInputMirror('startup-queued');
                return;
            }
            // Si el usuario había desplazado el historial, cualquier entrada
            // nueva debe devolverle a la línea que está editando.
            // El bloqueo de 900 ms protege el gesto de rueda, pero no debe
            // sobrevivir a una tecla nueva: después de una orden larga el
            // host puede seguir desplazado al extremo derecho y ocultar el
            // prompt/curso mientras se escribe la siguiente orden. Liberarlo
            // antes de mover el cursor deja que `keepCursorHorizontallyVisible`
            // recoloque el viewport en la línea de edición.
            horizontalUserScrolled = false;
            horizontalScrollLockUntil = 0;
            // Teclear cierra la ventana del gesto anterior: el desplazamiento
            // nativo que provoca el eco ya no es el usuario leyendo.
            lastHorizontalGestureAt = 0;
            userScrolledBack = false;
            term?.scrollToBottom();
            if (editingData.includes('\r') || editingData.includes('\n') || editingData.includes('\u0003')) {
                userEditing = false;
                inputLineSubmitted = true;
                flushPendingBannerSettingsRefresh();
            } else if (editingData) {
                userEditing = true;
                inputLineSubmitted = false;
                submittedCommand = null;
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
            // Tras cambiar de pestaña WebKit puede haber entregado una
            // respuesta VT entre la tecla y el Enter, dejando el espejo en
            // estado desconocido aunque xterm conserve la línea visible.
            // Usarla como respaldo solo para un Enter recupera el interceptor
            // de comandos internos sin adivinar texto durante la edición.
            const mirroredCandidate = mirroredLine === null ? currentEditableLine() : mirroredLine;
            const observedCandidate = enterAt !== undefined && !afterEnter ? currentEditableLine() : null;
            const mirroredText = mirroredCandidate === null ? beforeEnter : mirroredCandidate + beforeEnter;
            const internalCandidates = [observedCandidate, mirroredText]
                .filter((value): value is string => value !== null && value !== undefined && value.length > 0
                    && (value.trimStart().startsWith(':') || isDirectCreditAlias(value)))
                .sort((left, right) => right.length - left.length);
            const candidate = internalCandidates[0] ?? mirroredText;
            if (enterAt !== undefined && !afterEnter
                && (candidate.trimStart().startsWith(':') || isDirectCreditAlias(candidate))) {
                const line = candidate;
                mirroredLine = '';
                inputLineSubmitted = true;
                exposeInputMirror('internal-enter');
                void runInternal(line)
                    .then(({ handled, shellPrintsPrompt }) => {
                        if (!handled) {
                            void api.sendInput(tabId, data);
                            return;
                        }
                        // Los comandos internos se ejecutan fuera de la shell,
                        // así que el prompt que contenía la línea interceptada
                        // queda arriba del resultado. Un Enter sobre la línea
                        // ya vacía fuerza a la shell a dibujar un prompt nuevo
                        // al final; :help/:alias ya lo generan por sí mismos.
                        if (!shellPrintsPrompt) void api.sendInput(tabId, '\r');
                        term?.scrollToBottom();
                        // El Enter de cierre y la salida interna son
                        // asíncronos. Dar un frame a ConPTY antes de volver a
                        // publicar el estado evita un prompt falso durante
                        // los cambios de preferencias.
                        window.setTimeout(() => {
                            if (destroyed) return;
                            terminalPromptVisible();
                            scheduleTerminalRepaint();
                        }, 90);
                    })
                    .catch((error) => {
                        // Si el backend no está disponible, conservar el
                        // comportamiento normal de la shell y no perder Enter.
                        console.error('[TerminalPane] internal command failed', error);
                        void api.sendInput(tabId, data);
                    });
                return;
            }
            if (enterAt !== undefined) {
                inputLineSubmitted = true;
                submittedCommand = candidate.trimStart().startsWith(':') || isDirectCreditAlias(candidate)
                    ? null
                    : candidate;
                mirroredLine = '';
            }
            else if (terminators.length > 1) mirroredLine = /[\r\n]$/.test(mirroredLineData) ? '' : null;
            else if (mirroredLineData === '\u007f') {
                inputLogicalLength = Math.max(0, inputLogicalLength - 1);
                if (mirroredLine !== null) mirroredLine = mirroredLine.slice(0, -1);
            }
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
            // Reservar toda la línea que se está editando evita que la shell
            // envuelva un `echo` largo en la matriz visible antes de que el
            // host pueda ofrecer su scroll horizontal. La reserva se mantiene
            // hasta el bloque de salida posterior al Enter. La barrera de
            // resize se consume más abajo, justo antes de enviar la entrada,
            // para que ConPTY ya conozca la anchura nueva cuando reciba el
            // carácter que cruza el borde.
            let inputResizeBarrier: Promise<void> | undefined;
            const printableInput = mirroredLineData.replace(/[\x00-\x1f\x7f]/g, '');
            if (printableInput) {
                const startsNewInputLine = candidate.length <= printableInput.length;
                const printableLength = Array.from(printableInput).length;
                if (startsNewInputLine && !terminalOutputBusy) {
                    inputLogicalLength = 0;
                    inputStartColumn = term?.buffer.active.cursorX ?? 0;
                }
                if (mirroredLine !== null) {
                    inputLogicalLength = Math.max(inputLogicalLength, candidate.length);
                } else {
                    inputLogicalLength = Math.min(MAX_INPUT_RESERVATION_COLS, inputLogicalLength + printableLength);
                }
                if (startsNewInputLine && !terminalOutputBusy) {
                    // No reducir la matriz al recibir la primera letra de una
                    // orden nueva. La salida anterior puede seguir ocupando
                    // una rejilla ancha; encogerla aquí, mientras las demás
                    // teclas aún están en la cola IPC, parte `echo` en `e` +
                    // `cho ...` y mezcla el prompt con la salida anterior.
                    // `onTerminalOutputIdle` libera la reserva después de que
                    // la orden completa y su prompt hayan quedado asentados.
                    if (fitQuietTimer !== undefined) {
                        window.clearTimeout(fitQuietTimer);
                        fitQuietTimer = undefined;
                    }
                    if (wideReleaseTimer !== undefined) {
                        window.clearTimeout(wideReleaseTimer);
                        wideReleaseTimer = undefined;
                    }
                    inputWideReservationColumns = 0;
                    inputPtyWarmupDone = false;
                    // El prompt nuevo siempre empieza en la primera columna.
                    // Si la orden anterior dejó el host en el extremo derecho,
                    // xterm puede conservar ese `scrollLeft` mientras entrega
                    // las primeras letras y dibujar `cls` a mitad de la fila,
                    // aunque el prompt real esté fuera del área visible.
                    // Restablecerlo al comenzar la edición sincroniza la
                    // posición física con cursorX antes de reservar columnas.
                    resetHorizontalPromptViewport();
                }
                // xterm no recibe el eco de la shell hasta después de este
                // callback. Si solo reservamos las columnas del carácter que
                // acaba de llegar, el cursor alcanza el borde antes de que la
                // siguiente pulsación pueda ampliar la rejilla y la shell
                // reenvuelve la línea. Usar la línea acumulada, y no solo el
                // lote actual, cubre tanto el tecleo rápido como WebDriver,
                // que puede entregar una pulsación por evento.
                const accumulatedInputLength = Math.max(
                    inputLogicalLength,
                    mirroredLine?.length ?? 0,
                    beforeEnter.length,
                    candidate.length,
                    printableInput.length,
                );
                // Crecer una columna por pulsación crea una cola de IPC enorme
                // en líneas pegadas o tecleadas muy rápido. Redondear por
                // bloques conserva margen suficiente para ConPTY y limita los
                // resizes a uno por cada 64 caracteres.
                inputResizeBarrier = reserveCurrentInputColumns(accumulatedInputLength);
            } else if (mirroredData === '\u007f') {
                const cursorColumn = term?.buffer.active.cursorX ?? 0;
                const inputLookahead = Math.max(64, inputLogicalLength + 2, (mirroredLine?.length ?? 0) + 2);
                inputWideReservationColumns = inputReservationColumns(
                    cursorColumn,
                    inputLookahead,
                    inputLookahead,
                    MAX_HORIZONTAL_COLS,
                );
                inputResizeBarrier = resizeQueue;
            }
            enqueueTerminalInput(data, inputResizeBarrier ?? resizeQueue);
        });

        // Las acciones de navegación no se resuelven aquí: App.svelte las
        // captura una sola vez, antes del textarea oculto de xterm, y consulta
        // el mapa configurable de preferencias. Mantener otra ruta fija por
        // panel hacía que una combinación pudiera navegar y, a la vez, llegar
        // a la shell según qué nodo recibiera primero el evento.
        // Devolver false impide que xterm procese además las acciones locales.
        term.attachCustomKeyEventHandler((event) => {
            if (event.type !== 'keydown') return true;
            // Con una selección dentro de lo escrito, Retroceso y Supr la
            // borran como en un editor; fuera de ella actúan como siempre.
            if ((event.key === 'Backspace' || event.key === 'Delete')
                && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
                && deleteEditableSelection(false)) {
                event.preventDefault();
                return false;
            }
            if (!event.ctrlKey || !event.shiftKey) return true;
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

        observer = new ResizeObserver(() => {
            // Añadir la barra horizontal cambia el alto útil del host. Si el
            // callback ajusta xterm dentro del mismo ciclo de ResizeObserver,
            // WebView2 emite «ResizeObserver loop completed». Sacar el fit al
            // siguiente frame deja que ambas barras estabilicen su geometría.
            if (resizeObserverFrame !== undefined) return;
            resizeObserverFrame = window.requestAnimationFrame(() => {
                resizeObserverFrame = undefined;
                fitAndReport();
            });
        });
        observer.observe(terminalHost);
        window.addEventListener('resize', onWindowResize);
        window.addEventListener('focus', onWindowFocus);
        document.addEventListener('visibilitychange', onDocumentVisibilityChange);

        registerTerminal(tabId, term);
        registerTerminalControls(tabId, { openSearch, submitLine: submitLineFromApp });
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
        window.addEventListener('winslim:environment-switch-started', onEnvironmentSwitchStarted);
        window.addEventListener('winslim:environment-switch-requested', onEnvironmentSwitchRequested);
        window.addEventListener('winslim:environment-switch-cancelled', onEnvironmentSwitchCancelled);
        window.addEventListener('winslim:open-current-directory', onOpenCurrentDirectory);
        void api.onCommandResize(onProgrammaticCommandResize).then((unlisten) => {
            if (destroyed) unlisten();
            else commandResizeUnlisten = unlisten;
        });

        // Algunas instalaciones de cmd tardan varios segundos en terminar
        // los alias de arranque y el canvas de xterm puede conservar una
        // fila vacía aunque el prompt ya esté en el buffer. La división de
        // paneles hace visible esta carrera porque la última shell nace
        // mientras las demás ya están estables. Mantener una sonda acotada
        // permite reparar ambos casos: desplazar al prompt existente y
        // solicitar un prompt cuando la shell terminó el inicializador sin
        // pintarlo. Nunca se envía Enter mientras hay edición o salida en
        // curso, para no ejecutar una orden parcial del usuario.
        const recoverInitialPrompt = (): void => {
            initialPromptTimer = undefined;
            if (destroyed) return;
            initialPromptRecoveryAttempts += 1;
            const promptVisible = terminalPromptVisible();
            // Algunos REPL no cierran el bloque de salida con el evento
            // `terminal-output-idle`. En ese caso el prompt ya está visible,
            // pero `startupReady` puede quedarse en `false` tras un cambio de
            // entorno y mantener la entrada bloqueada. Reevaluar aquí la
            // misma señal que usa la compuerta sincroniza el estado con el
            // buffer real, también para IRB/Ruby y REPL similares.
            const startupReady = terminalStartupReady();
            if (startupReady && !inputReady && !environmentSwitchPending && !inputReleaseTimer) {
                inputReleaseTimer = window.setTimeout(() => {
                    inputReleaseTimer = undefined;
                    void releaseInput();
                }, 50);
            }
            if (promptVisible) {
                term?.scrollToBottom();
                scheduleTerminalRepaint();
            } else if (!initialPromptRecoverySent
                && initialPromptRecoveryAttempts >= 6
                // Solo cuando la shell ya terminó su inicializador (hay
                // salida) y aun así no pintó el prompt. Con un inicializador
                // lento (5-10 s en un equipo cargado) el Enter quedaba en cola
                // y producía un segundo prompt; en una casilla de 1-2 filas
                // ese salto desplazaba el historial y, al crecer la casilla,
                // ConPTY recuperaba la fila oculta y xterm no: el eco de la
                // primera orden salía separado de su prompt.
                && firstShellOutputAt > 0
                && performance.now() - firstShellOutputAt >= 2000
                && (term?.rows ?? 0) < 12
                && !terminalOutputBusy
                && !userEditing) {
                // En una casilla baja (menos de doce filas) una shell nueva
                // puede terminar su inicializador después de que xterm ya
                // haya reducido la rejilla. Un Enter vacío queda encolado
                // detrás del script y hace que ConPTY pinte el prompt en
                // cuanto finaliza, sin duplicarlo cuando el prompt ya es
                // visible. El límite incluye 8 filas, que es el tamaño real
                // de una casilla al dividir la ventana mínima 480x270.
                initialPromptRecoverySent = true;
                void api.sendInput(tabId, '\r');
            }
            if (initialPromptRecoveryAttempts < 20 && !destroyed) {
                initialPromptTimer = window.setTimeout(recoverInitialPrompt, 500);
            }
        };
        initialPromptRecoveryAttempts = 0;
        initialPromptRecoverySent = false;
        initialPromptTimer = window.setTimeout(recoverInitialPrompt, 1500);

        // La sustitución rápida de una pestaña puede pintar el prompt después
        // del primer `onRender`/`fitAndReport`. En ese caso el canvas ya es
        // utilizable, pero el atributo startupReady aún conserva `false` y
        // bloquea la siguiente escritura. Sondear solo durante el arranque
        // mantiene la compuerta sincronizada con la superficie visible sin
        // enviar teclas ni provocar nuevos reajustes de la rejilla.
        startupReadinessTimer = window.setInterval(() => {
            // Durante la petición aún puede verse el prompt de la shell
            // anterior. Esperar al evento requested/handshake impide que una
            // salida antigua desbloquee prematuramente la sesión nueva.
            if (destroyed || inputReady || environmentSwitchPending) return;
            const startupReady = terminalStartupReady();
            if (startupReady && !inputReleaseTimer) {
                inputReleaseTimer = window.setTimeout(() => {
                    inputReleaseTimer = undefined;
                    void releaseInput();
                }, 50);
            }
        }, 100);

        // Solo ahora existe un xterm donde pintar: el backend suelta la salida
        // que el PTY escribió mientras se montaba la interfaz.
        void api.markTabReady(tabId)
            .then(() => api.revealWindow())
            .then(() => waitForFrontendReady())
            .then((ready) => {
                if (destroyed) return;
                if (!ready) throw new Error('La sesión PTY no confirmó el arranque dentro del tiempo permitido');
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
                scheduleInputReleaseFallback();
            })
            .catch((error) => {
                if (destroyed) return;
                handshakeFinished('error', { error: String(error).slice(0, 300) });
                console.error('[TerminalPane] ready handshake failed', error);
                // Si no hay PTY, enviar la cola ahora perdería pulsaciones
                // silenciosamente. Un cambio de entorno reinicia el handshake.
            });
    });

    onDestroy(() => {
        destroyed = true;
        observer?.disconnect();
        rootWidthObserver?.disconnect();
        window.removeEventListener('resize', onWindowResize);
        window.removeEventListener('focus', onWindowFocus);
        document.removeEventListener('visibilitychange', onDocumentVisibilityChange);
        if (resizeTimer) clearTimeout(resizeTimer);
        pendingPtyResizeRun = undefined;
        disposeVisibilityGate();
        closeActivationGeometryBarrier();
        releaseActivationScrollPin();
        if (cursorBlinkTimer !== undefined) {
            window.clearInterval(cursorBlinkTimer);
            cursorBlinkTimer = undefined;
        }
        if (linkNoticeTimer !== undefined) window.clearTimeout(linkNoticeTimer);
        linkNoticeTimer = undefined;
        if (initialResizeTimer !== undefined) window.clearTimeout(initialResizeTimer);
        initialResizeTimer = undefined;
        if (outputPtyResizeTimer !== undefined) window.clearTimeout(outputPtyResizeTimer);
        outputPtyResizeTimer = undefined;
        outputPtyEarlyResizeScheduled = false;
        pendingOutputPtyColumns = 0;
        if (terminalInputBatchTimer !== undefined) window.clearTimeout(terminalInputBatchTimer);
        terminalInputBatchTimer = undefined;
        pendingTerminalInputData = '';
        pendingTerminalInputBarrier = Promise.resolve();
        completeInitialResizeBarrier();
        outputInputBlocked = false;
        outputInputEpoch += 1;
        outputInputResolve?.();
        outputInputResolve = undefined;
        if (tinyLayoutFitTimer !== undefined) window.clearTimeout(tinyLayoutFitTimer);
        if (rootWidthSyncFrame !== undefined) window.cancelAnimationFrame(rootWidthSyncFrame);
        if (fitQuietTimer) window.clearTimeout(fitQuietTimer);
        if (wideReleaseTimer) window.clearTimeout(wideReleaseTimer);
        if (lateOutputFitTimer) window.clearTimeout(lateOutputFitTimer);
        if (repaintTimer) window.clearTimeout(repaintTimer);
        if (bannerActivationTimer) window.clearTimeout(bannerActivationTimer);
        if (inputReadyTimer) window.clearTimeout(inputReadyTimer);
        if (inputReleaseTimer) window.clearTimeout(inputReleaseTimer);
        if (initialPromptTimer) clearTimeout(initialPromptTimer);
        initialPromptTimer = undefined;
        if (startupReadinessTimer !== undefined) window.clearInterval(startupReadinessTimer);
        startupReadinessTimer = undefined;
        if (resizeObserverFrame !== undefined) window.cancelAnimationFrame(resizeObserverFrame);
        if (resumeRefreshFrame !== undefined) window.cancelAnimationFrame(resumeRefreshFrame);
        if (horizontalStateFrame !== undefined) window.cancelAnimationFrame(horizontalStateFrame);
        if (horizontalRepaintFrame !== undefined) window.cancelAnimationFrame(horizontalRepaintFrame);
        horizontalViewport?.removeEventListener('scroll', onHorizontalViewportScroll);
        horizontalViewport?.removeEventListener('wheel', onTerminalWheel, { capture: true });
        if (terminalSearchHandler) terminalHost?.removeEventListener('keydown', terminalSearchHandler, true);
        terminalSearchHandler = undefined;
        searchAddon?.dispose();
        searchAddon = undefined;
        searchOpen = false;
        window.removeEventListener('winslim:terminal-output-busy', onTerminalOutputBusy);
        window.removeEventListener('winslim:terminal-output-idle', onTerminalOutputIdle);
        window.removeEventListener('winslim:environment-switch-started', onEnvironmentSwitchStarted);
        window.removeEventListener('winslim:environment-switch-requested', onEnvironmentSwitchRequested);
        window.removeEventListener('winslim:environment-switch-cancelled', onEnvironmentSwitchCancelled);
        window.removeEventListener('winslim:open-current-directory', onOpenCurrentDirectory);
        commandResizeUnlisten?.();
        commandResizeUnlisten = undefined;
        unregisterTerminalControls(tabId);
        unregisterTerminal(tabId);
        bannerImages?.dispose();
        bannerImages = undefined;
        term?.dispose();
    });

    async function pasteFromClipboard(): Promise<void> {
        const text = await api.readClipboard();
        if (text) void api.sendInput(tabId, text);
    }

    /** Rango seleccionado en xterm (filas absolutas; `end` excluido), o null
     *  si no hay selección o está vacía. */
    function selectionRange() {
        const range = term?.getSelectionPosition();
        if (!range) return null;
        return range.start.x !== range.end.x || range.start.y !== range.end.y ? range : null;
    }

    /** Texto entre dos puntos del búfer, con un salto entre filas que no son
     *  continuación de la anterior (lo que la shell cuenta como un carácter). */
    function bufferTextBetween(from: BufferPoint, to: BufferPoint): string {
        const buffer = term?.buffer.active;
        if (!buffer) return '';
        let text = '';
        for (let y = from.y; y <= to.y; y += 1) {
            const line = buffer.getLine(y);
            if (!line) break;
            const startX = y === from.y ? from.x : 0;
            text += y === to.y ? line.translateToString(false, startX, to.x) : line.translateToString(true, startX);
            if (y < to.y && !buffer.getLine(y + 1)?.isWrapped) text += '\n';
        }
        return text;
    }

    /** Lo que se está escribiendo en la línea del cursor: desde el final del
     *  prompt (si se reconoce) o desde donde empezó a teclearse, hasta la
     *  última celda con texto. Con un programa a pantalla completa no hay
     *  prompt: solo vale una selección que toque el cursor. */
    function currentInputBounds(): { start: BufferPoint | null; end: BufferPoint; cursor: BufferPoint; cursorCellBlank: boolean } | null {
        const buffer = term?.buffer.active;
        if (!buffer) return null;
        const cursor = { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY };
        let firstY = cursor.y;
        while (firstY > 0 && buffer.getLine(firstY)?.isWrapped) firstY -= 1;
        let lastY = cursor.y;
        while (buffer.getLine(lastY + 1)?.isWrapped) lastY += 1;
        let start: BufferPoint | null = null;
        if (buffer.type === 'normal') {
            const first = buffer.getLine(firstY);
            const promptEnd = first ? promptInputStart(first.translateToString(true)) : null;
            if (first && promptEnd !== null) start = { x: columnAtTextIndex(first, promptEnd), y: firstY };
            else if (firstY === cursor.y && inputStartColumn > 0 && inputStartColumn <= cursor.x) start = { x: inputStartColumn, y: cursor.y };
        }
        const last = buffer.getLine(lastY);
        const contentEnd = { x: last ? contentEndColumn(last) : 0, y: lastY };
        const end = comparePoints(contentEnd, cursor) > 0 ? contentEnd : cursor;
        const cursorChars = buffer.getLine(cursor.y)?.getCell(cursor.x)?.getChars() ?? '';
        return { start, end, cursor, cursorCellBlank: !cursorChars || cursorChars === ' ' };
    }

    /** Teclas para quitar la selección de la línea que se escribe
     *  (`input-selection.ts`), o null si la selección no es editable. */
    function editableSelection(): InputSelectionEdit | null {
        const range = selectionRange();
        const bounds = currentInputBounds();
        if (!term || !range || !bounds) return null;
        return inputSelectionEdit({
            start: { x: range.start.x, y: range.start.y },
            end: { x: range.end.x, y: range.end.y },
            cursor: bounds.cursor,
            cursorCellBlank: bounds.cursorCellBlank,
            inputStart: bounds.start,
            inputEnd: bounds.end,
            textBetween: bufferTextBetween,
        });
    }

    /** Borra la selección de la línea que se está editando: lleva el cursor
     *  de la shell al final de la selección y manda un DEL (0x7f, lo que xterm
     *  envía por Retroceso) por carácter. Devuelve si había algo que borrar. */
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
        const searchText = selectionRange() ? selectionSearchText(term?.getSelection() ?? '') : '';
        return { hasSelection: selectionRange() !== null, editable: editableSelection() !== null, searchText };
    });

    /** «Buscar» del menú: abre la búsqueda con lo seleccionado ya escrito. */
    function searchSelection(text: string): void {
        if (text) searchQuery = text;
        openSearch();
    }

    function menuSearchLabel(text: string): string {
        if (!text) return app.t('menu.search', 'Buscar…');
        const characters = Array.from(text);
        const shown = characters.length > 24 ? `${characters.slice(0, 23).join('')}…` : text;
        return app.t('menu.searchSelection', 'Buscar «{text}»').replace('{text}', shown);
    }

    function onContextMenu(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        // El menú incluye la acción de carpeta y mide ~210x170: se aparta de
        // los bordes para que tampoco quede cortado en ventanas pequeñas.
        // El límite horizontal debe usar la anchura nueva (190px mínimo), no
        // la de la versión anterior del menú (150px).
        menu = {
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 276)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 240))
        };
        perf.mark('ui.context-menu.open', { tabId, x: event.clientX, y: event.clientY });
    }

    function runMenu(action: 'copy' | 'cut' | 'delete' | 'paste' | 'search' | 'openDirectory' | 'settings'): void {
        perf.mark('ui.context-menu.action', { tabId, action });
        const searchText = menuState.searchText;
        menu = null;
        if (action === 'search') {
            searchSelection(searchText);
            return;
        }
        if (action === 'copy' && selectionRange()) void api.writeClipboard(term?.getSelection() ?? '');
        else if (action === 'cut') deleteEditableSelection(true);
        else if (action === 'delete') deleteEditableSelection(false);
        else if (action === 'paste') void pasteFromClipboard();
        else if (action === 'openDirectory') {
            void openCurrentDirectory();
            return;
        }
        else if (action === 'settings') {
            window.dispatchEvent(new CustomEvent('winslim:open-settings'));
            return;
        }
        term?.focus();
    }

    /** Con la vista dividida hay varias terminales a la vista y solo una recibe
     *  lo que se teclea. La activa manda además en el selector de entorno y en
     *  los paneles: sin esto se escribía en una casilla y «Ejecutar script» iba
     *  a parar a otra. */
    let focusingFromApp = false;
    function focusActiveTerminal(): void {
        if (!term || term.textarea === document.activeElement) return;
        // `focusin` es síncrono. Una orden de foco lanzada por la propia app
        // no equivale a que el usuario haya elegido otra casilla.
        focusingFromApp = true;
        try { term.focus(); } finally { focusingFromApp = false; }
    }
    function tomarElFoco(event: Event): void {
        if (event.type === 'focusin' && focusingFromApp) return;
        console.debug('[TerminalPane] tomarElFoco', { tabId, appActive: app.activeTabId });
        if (app.activeTabId !== tabId) void app.activateTab(tabId);
        // El explorador sigue la pestaña cuando el usuario vuelve a trabajar
        // en ella, incluso si antes había navegado manualmente a otra carpeta.
        window.dispatchEvent(new CustomEvent('winslim:terminal-focused', { detail: { tabId } }));
    }

    // La imagen del banner sigue a sus ajustes y a la imagen elegida.
    $effect(() => {
        void app.bannerImageUrl;
        void app.preferences?.bannerImage;
        void app.preferences?.showSystemBanner;
        bannerImages?.refresh();
    });

    // Cuando esta casilla pasa a ser la activa, le damos el foco a su xterm.
    $effect(() => {
        if (active && app.activeTabId === tabId) {
            focusActiveTerminal();
        }
    });

    // Al ocultarse, recordar si la vista seguía el final o dónde estaba.
    $effect(() => {
        if (active || !term || hiddenScrollState) return;
        const buffer = term.buffer.active;
        hiddenScrollState = {
            atBottom: !userScrolledBack || buffer.viewportY >= buffer.baseY - 1,
            viewportY: buffer.viewportY,
        };
        if (host) host.dataset.hiddenScrollState = JSON.stringify(hiddenScrollState);
    });

    // Al volver a estar visible o cambiar el número de paneles hay que remedir.
    $effect(() => {
        if (!active) return;
        openActivationGeometryBarrier();
        if (hiddenScrollState) openVisibilityGate();
        const esLaActiva = app.activeTabId === tabId;
        // Se observa el número de paneles para volver a medir al dividir/unir ventanas
        const paneCount = app.panes.length;
        if (paneCount !== observedPaneCount) {
            observedPaneCount = paneCount;
            outputBurstWide = false;
            reservedOutputColumns = 0;
            inputWideReservationColumns = 0;
            inputLineSubmitted = false;
            pendingOutputColumns = 0;
        }
        const frame = requestAnimationFrame(() => {
            // Una activación posterior puede sustituir esta pestaña antes de
            // que llegue el frame. Enfocar la pestaña antigua dispararía
            // `focusin` y volvería a activarla; con dos paneles eso formaba
            // un ciclo de miles de tabs_activate y bloqueaba el E2E.
            if (destroyed || !active) {
                closeActivationGeometryBarrier();
                return;
            }
            fitAndReport();
            restoreScrollAfterActivation();
            if (!awaitingTerminalVisibility) closeActivationGeometryBarrier();
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
            if (esLaActiva && app.activeTabId === tabId) {
                // Cambiar de pestaña puede dejar el cursor de xterm en la fase
                // que tenía la pestaña anterior. Reiniciar la fase visual al
                // tomar el foco evita que parezca congelado hasta el siguiente
                // evento de teclado.
                cursorVisible = true;
                terminalHost?.setAttribute('data-cursor-visible', 'true');
                focusActiveTerminal();
            }
        });
        const timer = setTimeout(() => {
            fitAndReport();
            // Un segundo ajuste puede volver a reflowar con el scroll del DOM
            // a cero; restaurar de nuevo y prolongar la vigilancia.
            restoreScrollAfterActivation();
        }, 80);
        return () => {
            cancelAnimationFrame(frame);
            clearTimeout(timer);
            closeActivationGeometryBarrier();
        };
    });

    // Las preferencias visuales se aplican en caliente, sin recrear el xterm.
    $effect(() => {
        const preferences = app.preferences;
        if (!term || !preferences) return;
        const cursor = cursorOptions(preferences);
        term.options.cursorBlink = preferences.terminalCursorBlink;
        term.options.cursorStyle = cursor.cursorStyle;
        term.options.cursorWidth = cursor.cursorWidth;
        term.options.cursorInactiveStyle = cursorInactiveStyle(preferences);
        term.options.scrollback = preferences.terminalScrollback;
        term.options.fontFamily = terminalFont(preferences, app.fonts);
        term.options.fontSize = preferences.terminalFontSize;
        term.options.lineHeight = preferences.terminalLineHeight;
        term.options.letterSpacing = preferences.terminalLetterSpacing;
        term.options.fontWeight = terminalFontWeight(preferences);
        term.options.scrollSensitivity = preferences.terminalScrollSensitivity;
        term.options.theme = terminalTheme(preferences, app.themes);
        syncTerminalLinks(preferences.terminalLinks !== false);
        // Cambiar color/forma durante un parpadeo puede dejar la capa del
        // cursor en estado oculto hasta el siguiente tick. Refrescar solo la
        // fila visible evita recrear el terminal y mantiene el scrollback.
        term.refresh(0, Math.max(0, term.rows - 1));
        fitAndReport();
    });
    // Interceptamos eventos en fase de captura directamente en el nodo host:
    // xterm.js consume los eventos de ratón en su propio canvas con stopPropagation,
    // por lo que los manejadores de burbujeo normales nunca llegaban a ejecutarse.
    $effect(() => {
        if (!host) return;
        const activate = (event: Event) => tomarElFoco(event);
        host.addEventListener('pointerdown', activate, { capture: true });
        // La rueda o arrastrar la barra de scroll mandan sobre la posición
        // restaurada; un clic para enfocar la terminal, no.
        const releaseScrollPinOnUserScroll = (event: Event) => {
            if (event.type === 'wheel' || (event.target as Element | null)?.closest?.('.scrollbar')) {
                releaseActivationScrollPin();
            }
        };
        host.addEventListener('wheel', releaseScrollPinOnUserScroll, { capture: true, passive: true });
        host.addEventListener('pointerdown', releaseScrollPinOnUserScroll, { capture: true });
        host.addEventListener('mousedown', activate, { capture: true });
        host.addEventListener('focusin', activate, { capture: true });
        host.addEventListener('contextmenu', onContextMenu, { capture: true });
        // Gestos que sí son del usuario para el eje horizontal (ver
        // `onHorizontalViewportScroll`): puntero pulsado y rueda.
        const markGesture = () => { lastHorizontalGestureAt = performance.now(); };
        const pointerDown = () => { horizontalPointerDown = true; markGesture(); };
        const pointerUp = () => {
            if (!horizontalPointerDown) return;
            horizontalPointerDown = false;
            markGesture();
        };
        host.addEventListener('pointerdown', pointerDown, { capture: true });
        host.addEventListener('wheel', markGesture, { capture: true, passive: true });
        window.addEventListener('pointerup', pointerUp, { capture: true });
        window.addEventListener('pointercancel', pointerUp, { capture: true });
        return () => {
            host.removeEventListener('pointerdown', pointerDown, { capture: true });
            host.removeEventListener('wheel', markGesture, { capture: true });
            window.removeEventListener('pointerup', pointerUp, { capture: true });
            window.removeEventListener('pointercancel', pointerUp, { capture: true });
            host.removeEventListener('pointerdown', activate, { capture: true });
            host.removeEventListener('wheel', releaseScrollPinOnUserScroll, { capture: true });
            host.removeEventListener('pointerdown', releaseScrollPinOnUserScroll, { capture: true });
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
    role="presentation"
>
    <div
        class="terminal-host"
        data-testid="terminal-host"
        data-cursor-blink={app.preferences?.terminalCursorBlink ? 'true' : 'false'}
        data-cursor-visible={cursorVisible ? 'true' : 'false'}
        style:--wt-xterm-font-family={app.preferences ? terminalFont(app.preferences, app.fonts) : 'monospace'}
        style:--wt-xterm-font-size={`${app.preferences?.terminalFontSize ?? 14}px`}
        bind:this={terminalHost}
    >
        <!-- Elemento en flujo que publica el ancho real al scroll container.
             El canvas de xterm puede ser posicionado y no aumentar
             `scrollWidth` aunque su rectángulo ya sea más ancho; este
             espaciador mantiene el eje X medible sin crear una segunda barra. -->
        <div class="terminal-width-spacer" aria-hidden="true"></div>
    </div>
    {#if searchOpen}
        <div class="terminal-search" role="search" data-testid="terminal-search">
            <input
                bind:this={searchInput}
                value={searchQuery}
                oninput={(event) => updateSearch((event.currentTarget as HTMLInputElement).value)}
                onkeydown={onSearchKeydown}
                placeholder={app.t('terminal.searchPlaceholder', 'Buscar en el scrollback…')}
                aria-label={app.t('terminal.searchPlaceholder', 'Buscar en el scrollback…')}
                autocomplete="off"
                spellcheck="false"
            />
            <span class="terminal-search-count" data-testid="terminal-search-count" data-result-count={searchResultCount} aria-live="polite">
                {#if searchQuery && searchResultCount > 0}{searchResultIndex + 1}/{searchResultCount}
                {:else if searchQuery}{app.t('terminal.searchNoMatches', 'Sin coincidencias')}{/if}
            </span>
            <button type="button" data-testid="terminal-search-previous" onclick={() => searchNext(true)} title={app.t('terminal.searchPrevious', 'Coincidencia anterior')}>↑</button>
            <button type="button" data-testid="terminal-search-next" onclick={() => searchNext()} title={app.t('terminal.searchNext', 'Siguiente coincidencia')}>↓</button>
            <button type="button" data-testid="terminal-search-close" onclick={closeSearch} title={app.t('common.close', 'Cerrar')}>×</button>
        </div>
    {/if}
    <div
        class="horizontal-overflow-indicator"
        class:visible={horizontalCanScrollRight}
        aria-hidden="true"
    >
        <span>›</span>
    </div>
    {#if linkNotice}
        <div class="terminal-link-notice" role="status" data-testid="terminal-link-notice">{linkNotice}</div>
    {/if}
</div>

{#if menu}
    <!-- Cualquier clic fuera lo cierra, incluido el que elige una opción: el
         botón se atiende antes por estar encima. -->
    <div class="menu-backdrop" onmousedown={() => (menu = null)} role="presentation"></div>
    <div class="menu" style="left: {menu.x}px; top: {menu.y}px" role="menu" data-testid="terminal-context-menu">
        <button
            type="button"
            role="menuitem"
            data-testid="terminal-menu-copy"
            disabled={!menuState.hasSelection}
            onclick={() => runMenu('copy')}
        >
            <span>{app.t('menu.copy', 'Copiar')}</span><span class="menu-shortcut">Ctrl+Shift+C</span>
        </button>
        <button
            type="button"
            role="menuitem"
            data-testid="terminal-menu-cut"
            disabled={!menuState.editable}
            title={menuState.editable ? '' : app.t('menu.editableHint', 'Selecciona texto de la línea que estás escribiendo')}
            onclick={() => runMenu('cut')}
        >
            <span>{app.t('menu.cutInput', 'Cortar entrada')}</span><span class="menu-shortcut">Ctrl+Shift+X</span>
        </button>
        <button
            type="button"
            role="menuitem"
            data-testid="terminal-menu-delete"
            disabled={!menuState.editable}
            title={menuState.editable ? '' : app.t('menu.editableHint', 'Selecciona texto de la línea que estás escribiendo')}
            onclick={() => runMenu('delete')}
        >
            <span>{app.t('menu.deleteInput', 'Borrar entrada')}</span><span class="menu-shortcut">{app.t('menu.deleteKey', 'Supr')}</span>
        </button>
        <button type="button" role="menuitem" data-testid="terminal-menu-paste" onclick={() => runMenu('paste')}>
            <span>{app.t('menu.paste', 'Pegar')}</span><span class="menu-shortcut">Ctrl+Shift+V</span>
        </button>
        <button type="button" role="menuitem" data-testid="terminal-menu-search" onclick={() => runMenu('search')}>
            <span>{menuSearchLabel(menuState.searchText)}</span>{#if app.preferences?.shortcutSearchTerminal ?? 'Ctrl+Shift+F'}<span class="menu-shortcut">{app.preferences?.shortcutSearchTerminal ?? 'Ctrl+Shift+F'}</span>{/if}
        </button>
        <button type="button" role="menuitem" onclick={() => runMenu('settings')}>
            <span>{app.t('toolbar.settings', 'Ajustes')}</span>{#if app.preferences?.shortcutOpenSettings}<span class="menu-shortcut">{app.preferences.shortcutOpenSettings}</span>{/if}
        </button>
        <div class="menu-separator" role="separator"></div>
        {#if app.preferences?.showExplorerPanel !== false}<button
            type="button"
            role="menuitem"
            disabled={!canOpenCurrentDirectory}
            title={app.t('explorer.openInSystem', 'Abrir en el explorador del sistema')}
            onclick={() => runMenu('openDirectory')}
        >
            {app.t('explorer.openInSystem', 'Abrir en el explorador del sistema')}
        </button>{/if}
    </div>
{/if}

{#if linkDialog}
    <!-- Confirmación de un enlace: el destino completo y su host a la vista,
         para ver a dónde lleva de verdad antes de abrirlo. -->
    <div class="link-backdrop" onmousedown={() => closeLinkDialog(false)} role="presentation"></div>
    <div
        class="link-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`terminal-link-title-${tabId}`}
        data-testid="terminal-link-dialog"
        data-url={linkDialog.url}
        tabindex="-1"
        onkeydown={onLinkDialogKeydown}
    >
        <strong id={`terminal-link-title-${tabId}`}>{app.t('terminal.linkConfirmTitle', '¿Abrir este enlace?')}</strong>
        <code class="link-url" data-testid="terminal-link-url">{linkDialog.url}</code>
        {#if linkDialog.host}
            <span class="link-host">{app.t('terminal.linkConfirmHost', 'Destino')}: <b data-testid="terminal-link-host">{linkDialog.host}</b></span>
        {/if}
        <small>{linkDialog.scheme === 'file:'
            ? app.t('terminal.linkConfirmFile', 'La ruta se mostrará en el explorador de archivos; no se ejecuta nada.')
            : app.t('terminal.linkConfirmWeb', 'Se abrirá en el navegador predeterminado.')}</small>
        <div class="link-actions">
            <button type="button" class="link-cancel" data-testid="terminal-link-cancel" onclick={() => closeLinkDialog(false)}>
                {app.t('terminal.linkCancel', 'Cancelar')}
            </button>
            <button type="button" class="link-open" data-testid="terminal-link-open" bind:this={linkOpenButton} onclick={() => closeLinkDialog(true)}>
                {app.t('terminal.linkOpen', 'Abrir')}
            </button>
        </div>
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
        /* xterm mantiene el scroll vertical en `.xterm-viewport`. El host es
           la única superficie horizontal para la rejilla ancha; el viewport
           interno queda oculto en X para no crear una segunda barra. */
        overflow-x: auto;
        overflow-y: hidden;
    }

    .terminal-width-spacer {
        width: var(--terminal-content-width, 100%);
        min-width: var(--terminal-content-width, 100%);
        height: 1px;
        pointer-events: none;
        user-select: none;
    }

    /* El scroll vertical sigue siendo propiedad de xterm; no crear otro eje X
       en este elemento hermano evita dos barras que se desincronicen. */
    .terminal-host :global(.xterm .xterm-viewport),
    .terminal-host :global(.xterm .xterm-scrollable-element) {
        overflow-x: hidden !important;
    }

    .terminal-search {
        position: absolute;
        z-index: 8;
        top: 8px;
        right: 18px;
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: min(360px, calc(100% - 28px));
        padding: 4px;
        border: 1px solid var(--panel-border, #3d4148);
        border-radius: 5px;
        background: color-mix(in srgb, var(--panel-bg, #17191c) 96%, transparent);
        box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
    }

    .terminal-search input {
        min-width: 0;
        flex: 1;
        height: 26px;
        padding: 0 7px;
        border: 1px solid var(--input-border, #454a52);
        border-radius: 3px;
        outline: none;
        background: var(--input-bg, #101112);
        color: var(--text-primary, #e4e6e8);
        font: 12px var(--terminal-font);
    }

    .terminal-search input:focus {
        border-color: var(--accent, #62d6b5);
    }

    .terminal-search-count {
        min-width: 60px;
        color: var(--text-muted, #9aa0a8);
        font: 10px var(--terminal-font);
        text-align: center;
        white-space: nowrap;
    }

    .terminal-search button {
        width: 25px;
        height: 25px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 3px;
        background: transparent;
        color: var(--text-primary, #e4e6e8);
        cursor: pointer;
    }

    .terminal-search button:hover {
        border-color: var(--panel-border, #3d4148);
        background: var(--button-hover, #262a30);
    }

    /* La raíz de xterm debe conservar el ancho de la rejilla cuando supera la
       ventana; de lo contrario el host no tiene contenido físico que pueda
       desplazar aunque `term.cols` ya sea mayor. */
    /* Imagen del banner: encima del margen que deja el backend, sin tapar la
       selección ni los clics. */
    .terminal-host :global(.banner-image-decoration) {
        pointer-events: none;
    }
    .terminal-host :global(.banner-image-decoration img) {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
        object-position: center;
    }

    .terminal-host :global(.xterm) {
        width: var(--terminal-content-width, 100%) !important;
        min-width: var(--terminal-content-width, 100%) !important;
        max-width: none !important;
        flex: 0 0 auto !important;
    }

    /* El canvas/screen de xterm conserva a veces el ancho de las columnas
       anteriores aunque la raíz ya haya crecido. Igualarlo a la raíz evita
       que `.xterm-rows` se convierta en una segunda superficie horizontal:
       toda la rejilla ancha se desplaza desde `terminal-host`. */
    .terminal-host :global(.xterm .xterm-screen) {
        width: 100% !important;
        min-width: 100% !important;
        max-width: none !important;
        flex: 0 0 100% !important;
    }

    /* El margen de repintado solo existe mientras hay una cola horizontal
       real. Mantenerlo en una salida corta falsea la medida de FitAddon y
       deja una columna adicional después de un clear/resize. */
    :global(.terminal-host[data-horizontal-tail="true"] .xterm .xterm-screen) {
        width: calc(100% + 8px) !important;
        min-width: calc(100% + 8px) !important;
    }

    /* No añadir una cola física después de la rejilla. Ese margen artificial
       hacía que el máximo del host quedara más allá del final del canvas: al
       desplazar hasta el extremo se veía el espacio vacío de la cola y se
       recortaban precisamente los últimos glifos (por ejemplo 114–120). El
       ancho real de `.xterm-screen` ya reserva todas las columnas necesarias. */
    :global(.terminal-host[data-horizontal-tail="true"])::after {
        display: none;
    }

    /* Un pseudo-element en flujo hace que `scrollWidth` incluya la rejilla
       aunque el renderer de xterm pinte su screen en una capa posicionada.
       El eje horizontal sigue siendo el host y no se añade ningún viewport. */
    :global(.terminal-host[data-horizontal-tail="true"])::before {
        content: "";
        display: block;
        width: var(--terminal-content-width, 100%);
        min-width: var(--terminal-content-width, 100%);
        height: 1px;
        pointer-events: none;
    }

    /* El renderer DOM de xterm genera este estilo dinámicamente. En algunos
       WebKit release la regla no se aplica a tiempo y el navegador colapsa
       `          ` a un solo espacio, aunque el buffer y el PTY sean correctos.
       Fijarlo en la hoja estática conserva cada columna también durante los
       redibujados ANSI de Fish. */
    .terminal-host :global(.xterm .xterm-rows),
    .terminal-host :global(.xterm .xterm-rows span) {
        white-space: pre !important;
    }

    /* xterm fija la fuente de las filas en la hoja que inyecta con <style> en
       tiempo de ejecución. Si esa hoja no se aplica (Tauri volvió a añadir
       nonces a `style-src`; ver `dangerousDisableAssetCspModification`), las
       filas heredan el tamaño del contenedor (13 px) mientras xterm mide la
       celda con su `fontSize` (12 px): cursor, textarea y scroll horizontal se
       desfasan un 8 % por columna. Se repite aquí, con los mismos valores que
       recibe xterm, como red de seguridad. */
    .terminal-host :global(.xterm .xterm-rows) {
        font-family: var(--wt-xterm-font-family, monospace) !important;
        font-size: var(--wt-xterm-font-size, 14px) !important;
        font-kerning: none !important;
    }

    /* El host ya limita el eje X y ofrece el scroll. Las filas no son
       superficies desplazables: se dejan visibles para que una cola de
       glifos que xterm mide fuera del rectángulo del screen siga entrando en
       el único scroll horizontal del host. */
    .terminal-host :global(.xterm .xterm-rows),
    .terminal-host :global(.xterm .xterm-rows > div) {
        overflow: visible !important;
    }

    .horizontal-overflow-indicator {
        position: absolute;
        z-index: 5;
        top: 0;
        right: 0;
        bottom: 5px;
        display: flex;
        width: 24px;
        align-items: center;
        justify-content: flex-end;
        padding-right: 4px;
        background: linear-gradient(90deg, transparent, rgba(8, 8, 8, 0.92) 72%);
        color: var(--muted);
        font-size: 20px;
        line-height: 1;
        opacity: 0;
        pointer-events: none;
        transform: translateX(4px);
        transition: opacity 120ms ease, transform 120ms ease;
    }

    .horizontal-overflow-indicator.visible {
        opacity: 1;
        transform: translateX(0);
    }

    /* Mantener la capa de cursor por encima del canvas evita que un repintado
       de WebView2 la oculte. xterm hace transparente el cursor durante la fase
       apagada del parpadeo; un indicador tenue con la misma forma conserva la
       posición de escritura sin interferir con la geometría que calcula. */
    .terminal-host :global(.xterm-cursor-layer) {
        z-index: 4;
        pointer-events: none;
    }

    .terminal-host :global(.xterm-cursor) {
        position: relative;
        /* El cursor es una capa visual, nunca un destino de ratón. Si recibe
           el inicio del arrastre, xterm puede no completar la selección en la
           celda donde está colocado. */
        pointer-events: none;
        user-select: none;
        -webkit-user-select: none;
    }

    /* xterm recrea el <span> del cursor durante algunos repintados. Animar ese
       nodo directamente reiniciaba el ciclo y podía dejarlo siempre visible.
       La fase vive en el host estable y el cursor la hereda; el cursor activo
       queda en manos de xterm para no duplicar sus temporizadores. */
    @keyframes wterminal-cursor-blink {
        0%, 49% { --wterminal-cursor-opacity: 1; }
        50%, 100% { --wterminal-cursor-opacity: 0; }
    }

    /* La animación vive en el host, que no se recrea durante un reflow. El
       atributo de fase aporta además una señal determinista al E2E cuando el
       motor no expone currentTime para animaciones CSS de WebView2. */
    .terminal-host[data-cursor-blink="true"] {
        animation: wterminal-cursor-blink 1s steps(2, jump-none) infinite;
    }

    .terminal-host[data-cursor-blink="true"] :global(.xterm:not(.focus) .xterm-cursor) {
        opacity: var(--wterminal-cursor-opacity, 1);
    }

    .terminal-host[data-cursor-blink="true"][data-cursor-visible="false"] :global(.xterm:not(.focus) .xterm-cursor) {
        opacity: 0 !important;
    }

    /* WebKitGTK no siempre registra las reglas de posición/color que xterm 6
       inyecta en tiempo de ejecución. Mantener los glifos en una capa superior
       deja que el fondo de selección se vea detrás del texto, no encima. */
    .terminal-host :global(.xterm .xterm-rows) {
        position: relative;
        z-index: 2;
    }

    .terminal-host :global(.xterm .xterm-selection) {
        /* xterm 6 crea esta capa con posición absoluta desde su hoja dinámica.
           En WebKitGTK esa regla no siempre llega al CSSOM: sin este respaldo
           el nodo queda en el flujo después de las filas y el resaltado aparece
           debajo del viewport, aunque getSelection() sí devuelva el texto. */
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 100% !important;
        z-index: 1;
        pointer-events: none;
    }

    .terminal-host :global(.xterm .xterm-selection > div) {
        /* Las coordenadas top/left de cada celda vienen como estilos inline.
           Declarar la posición y el color estáticos garantiza que WebKit las
           aplique aunque no evalúe el CSS dinámico inyectado por xterm. */
        position: absolute !important;
        background-color: var(--terminal-selection, #4a4a4a) !important;
    }

    .terminal-host :global(.xterm-cursor::after) {
        content: "";
        position: absolute;
        box-sizing: border-box;
        pointer-events: none;
        opacity: 0.72;
    }

    .terminal-host :global(.xterm-cursor-block::after) {
        inset: 0;
        border: 1px solid var(--terminal-cursor);
    }

    .terminal-host :global(.xterm-cursor-bar::after) {
        inset: 0 auto 0 0;
        width: var(--terminal-cursor-width, 1px);
        background: var(--terminal-cursor);
    }

    .terminal-host :global(.xterm-cursor-underline::after) {
        inset: auto 0 0;
        height: var(--terminal-cursor-width, 1px);
        background: var(--terminal-cursor);
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
        min-width: 240px;
        max-width: min(340px, calc(100vw - 16px));
        flex-direction: column;
        padding: 4px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    .menu button {
        display: flex;
        gap: 16px;
        align-items: baseline;
        justify-content: space-between;
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

    .menu button > span:first-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* El atajo de cada acción, para no tener que sabérselo. */
    .menu-shortcut {
        flex: none;
        color: var(--muted);
        font-size: 11px;
    }

    .menu button:hover:not(:disabled) {
        background: var(--surface-hover);
    }

    .menu button:disabled {
        color: var(--muted);
        cursor: default;
    }

    .menu-separator {
        height: 1px;
        margin: 3px 4px;
        background: var(--border);
    }

    .link-backdrop {
        position: fixed;
        inset: 0;
        z-index: 62;
        background: rgb(0 0 0 / 35%);
    }

    .link-dialog {
        position: fixed;
        z-index: 63;
        top: 50%;
        left: 50%;
        display: flex;
        width: min(520px, calc(100vw - 32px));
        flex-direction: column;
        gap: 8px;
        padding: 14px 16px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        box-shadow: 0 12px 32px rgb(0 0 0 / 55%);
        color: var(--text);
        font-size: 12px;
        transform: translate(-50%, -50%);
    }

    .link-dialog strong {
        font-size: 13px;
    }

    /* La URL entera, partida donde haga falta: nada del destino queda oculto
       tras unos puntos suspensivos. */
    .link-url {
        max-height: 30vh;
        overflow: auto;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--terminal-bg);
        font: 12px var(--terminal-font, monospace);
        overflow-wrap: anywhere;
        user-select: text;
        white-space: pre-wrap;
    }

    .link-host b {
        color: var(--accent);
    }

    .link-dialog small {
        color: var(--muted);
    }

    .link-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
    }

    .link-actions button {
        min-width: 84px;
        padding: 5px 12px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: transparent;
        color: var(--text);
        font: inherit;
        cursor: pointer;
    }

    .link-actions button:hover {
        background: var(--surface-hover);
    }

    .link-actions .link-open {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--terminal-bg);
    }

    .link-actions button:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
    }

    .terminal-link-notice {
        position: absolute;
        z-index: 8;
        right: 18px;
        bottom: 14px;
        max-width: min(420px, calc(100% - 36px));
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: 5px;
        background: var(--surface);
        box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
        color: var(--text);
        font-size: 12px;
        pointer-events: none;
    }

    .tab-pane.hidden {
        /* `visibility` en vez de `display: none`: xterm necesita que su nodo
           siga teniendo caja para poder medirse cuando vuelva a mostrarse. */
        visibility: hidden;
        pointer-events: none;
    }
</style>
