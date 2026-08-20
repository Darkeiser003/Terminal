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
            const wanted = command.argument!.toLocaleLowerCase();
            const environment = app.environments.find((env) =>
                env.repl && [env.id, env.language ?? '', env.label]
                    .some((value) => value.toLocaleLowerCase().includes(wanted))
            );
            if (environment) await app.createTab(environment.id);
            else term?.writeln(`\r\n\x1b[33m[REPL no detectado: ${command.argument}]\x1b[0m`);
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
                term?.writeln('\r\nAyuda' + (topic ? ' (' + topic + ')' : '') + ': usa :help desde la terminal o consulta los comandos internos.');
                term?.writeln('Comandos internos: :config  :reload  :repl <nombre>  :alias  :help [sección]');
            }
        } else {
            term?.writeln('\r\n:config  :reload  :repl <nombre>  :alias  :help');
        }
        return true;
    }

    function completeRepl(line: string): boolean {
        const match = /^\s*:repl\s+([\w-]*)$/i.exec(line);
        if (!match) return false;
        const partial = match[1].toLocaleLowerCase();
        const names = [...new Set(app.environments
            .filter((env) => env.repl && env.available)
            .map((env) => env.language ?? env.id.replace(/^.*:/, '')))]
            .filter((name) => name.toLocaleLowerCase().startsWith(partial))
            .sort();
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
    // El fastfetch es salida visual, pero la línea que el usuario está
    // editando pertenece al PTY. Nunca se debe repintar el banner mientras esa
    // línea está viva: si el banner crece al estrechar la ventana, podría
    // ocupar justamente las filas donde xterm ha envuelto el texto escrito.
    let userEditing = false;

    function fitAndReport(): void {
        if (!term || !fitAddon || !active) return;
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
            term.scrollToBottom();
        } catch (err) {
            console.error('[TerminalPane] fitAndReport error', err);
            return;
        }
        if (term.cols === lastSize.cols && term.rows === lastSize.rows) return;
        lastSize = { cols: term.cols, rows: term.rows };
        const serial = ++bannerRefreshSerial;
        const editingAtResize = userEditing;
        // No resetear xterm antes del resize: la shell todavía conserva la
        // posición real de su prompt y ConPTY la repinta al recibir SIGWINCH.
        // Si se vacía solo el frontend aquí, ese prompt aparece en la fila
        // actual y el repintado del banner puede restaurarlo dentro de sus
        // secciones. `refresh_banner` limpia las filas antiguas de forma
        // coordinada y conserva el historial posterior.
        term.scrollToBottom();
        if (resizeTimer) clearTimeout(resizeTimer);
        const cols = term.cols;
        const rows = term.rows;
        resizeTimer = setTimeout(() => {
            resizeTimer = undefined;
            void api.resize(tabId, cols, rows).then(() => {
                if (serial !== bannerRefreshSerial) return;
                // Dar un pequeño margen a la shell para procesar el resize y
                // repintar su prompt antes de guardar/restaurar el cursor del
                // banner. Evita que la salida de SIGWINCH quede intercalada.
                window.setTimeout(() => {
                    if (serial !== bannerRefreshSerial) return;
                    // También se conserva el estado capturado al empezar el
                    // resize: si había texto en edición, no se repinta justo
                    // después de Enter, cuando todavía puede estar saliendo
                    // la respuesta del comando.
                    if (editingAtResize || userEditing) return;
                    void api.refreshBanner(
                        tabId,
                        cols,
                        rows,
                        Math.max(1, app.panes.length),
                        term?.buffer.active.cursorY ?? 0,
                    );
                }, 120);
            });
        }, 60);
    }

    onMount(() => {
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

        term.onData((data) => {
            // Si el usuario había desplazado el historial, cualquier entrada
            // nueva debe devolverle a la línea que está editando.
            term?.scrollToBottom();
            // `onData` solo recibe teclas del usuario, no la salida de la
            // shell. Mantener este estado separado del espejo ASCII también
            // cubre nano, REPLs y entradas con teclas de control.
            if (data.includes('\r') || data.includes('\n') || data.includes('\u0003')) {
                userEditing = false;
            } else if (data) {
                userEditing = true;
            }
            const mirroredData = data
                .replaceAll('\x1b[200~', '')
                .replaceAll('\x1b[201~', '');
            if (mirroredData === '\t' && mirroredLine !== null && completeRepl(mirroredLine)) return;

            // xterm puede entregar Enter separado (tecleo normal) o junto a la
            // línea completa (pegado, IME y algunas configuraciones de Fish).
            // Solo se intercepta una línea única; un pegado multilínea sigue
            // viajando intacto a la shell.
            const terminators = [...mirroredData.matchAll(/[\r\n]/g)];
            const enterAt = terminators.length === 1 ? terminators[0].index : undefined;
            const beforeEnter = enterAt === undefined ? mirroredData : mirroredData.slice(0, enterAt);
            const afterEnter = enterAt === undefined ? '' : mirroredData.slice(enterAt + 1);
            const candidate = mirroredLine === null ? beforeEnter : mirroredLine + beforeEnter;
            if (enterAt !== undefined && !afterEnter && candidate.trimStart().startsWith(':')) {
                const line = candidate;
                mirroredLine = '';
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
            else if (mirroredData === '\u007f' && mirroredLine !== null) mirroredLine = mirroredLine.slice(0, -1);
            else if (/^[\x20-\x7e]+$/.test(mirroredData) && mirroredLine !== null) mirroredLine += mirroredData;
            else mirroredLine = null;
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

        registerTerminal(tabId, term);
        fitAndReport();

        // Solo ahora existe un xterm donde pintar: el backend suelta todo lo
        // que el pty escribió mientras tanto (banner + primer prompt).
        void api.markTabReady(tabId)
            .then(() => api.markFrontendReady(tabId))
            .catch((error) => console.error('[TerminalPane] ready handshake failed', error));
    });

    onDestroy(() => {
        observer?.disconnect();
        if (resizeTimer) clearTimeout(resizeTimer);
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
    }

    function runMenu(action: 'copy' | 'cut' | 'delete' | 'paste'): void {
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
></div>

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
