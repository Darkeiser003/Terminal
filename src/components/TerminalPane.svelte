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
    import { cursorOptions, terminalFont, terminalTheme } from '../lib/theme';
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

    /** Último tamaño enviado al backend. Evita mandar un resize por cada píxel
     *  mientras se arrastra el borde de la ventana. */
    let lastSize = { cols: 0, rows: 0 };

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
        void api.resize(tabId, term.cols, term.rows);
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
            fontWeight: preferences?.terminalFontWeight ?? 'normal',
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
            void api.sendInput(tabId, data);
        });

        // Devolver false impide que xterm procese además la pulsación (y la
        // mande al proceso como una tecla más).
        term.attachCustomKeyEventHandler((event) => {
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
        void api.markTabReady(tabId);
    });

    onDestroy(() => {
        observer?.disconnect();
        unregisterTerminal(tabId);
        term?.dispose();
    });

    async function pasteFromClipboard(): Promise<void> {
        const text = await api.readClipboard();
        if (text) void api.sendInput(tabId, text);
    }

    /** La parte de la selección que la shell todavía puede borrar.
     *
     *  Solo es segura si la selección TERMINA exactamente en el cursor: lo que
     *  el proceso ya ha emitido es historial inmutable, y mandar borrados por
     *  encima de él dejaría la línea descuadrada. Tampoco vale si abarca varias
     *  líneas: no hay forma de saber cuántos borrados hacen falta. */
    function editableSelection(): { text: string; length: number } | null {
        if (!term?.hasSelection()) return null;
        const text = term.getSelection();
        const range = term.getSelectionPosition();
        if (!text || !range || /[\r\n]/.test(text)) return null;
        const buffer = term.buffer.active;
        if (range.end.x !== buffer.cursorX + 1 || range.end.y !== buffer.baseY + buffer.cursorY + 1) {
            return null;
        }
        const length = [...text].length;
        if (length < 1 || length > 4096) return null;
        return { text, length };
    }

    /** Borra la selección de la línea que se está editando mandando tantos
     *  DEL (0x7f) como caracteres tenga: es lo que xterm envía por Backspace a
     *  una shell interactiva. Devuelve si había algo que borrar. */
    function deleteEditableSelection(copyFirst: boolean): boolean {
        const editable = editableSelection();
        if (!editable) return false;
        if (copyFirst) void api.writeClipboard(editable.text);
        term?.clearSelection();
        void api.sendInput(tabId, '\x7f'.repeat(editable.length));
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
        term.options.fontWeight = preferences.terminalFontWeight;
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
