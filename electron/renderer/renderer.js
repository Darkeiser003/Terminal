// renderer.js - UI de la terminal con xterm.js (una instancia por pestaña),
// conectada al pty vía preload.js. Cada pestaña tiene su propio proceso en
// main.js; este archivo solo enruta eventos por tabId y refleja el estado
// de la pestaña activa en la barra de entorno / paneles.
(function () {
    // Errores no capturados en el renderer se reenvían al log de main.js,
    // así quedan en el mismo archivo que los eventos de pty/instalación.
    window.addEventListener('error', function (e) {
        window.terminalAPI.reportRendererError({
            message: e.message,
            source: e.filename + ':' + e.lineno,
            stack: e.error && e.error.stack
        });
    });
    window.addEventListener('unhandledrejection', function (e) {
        window.terminalAPI.reportRendererError({
            message: 'unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))
        });
    });

    var THEME = {
        background: '#080808',
        foreground: '#d7d7d7',
        cursor: '#b8bec6',
        cursorAccent: '#080808',
        selectionBackground: '#4b5056',
        black: '#080808',
        brightBlack: '#555555'
    };
    var themeCatalog = [];
    var fontCatalog = [];
    var languageCatalog = [];
    var appIdentity = { name: 'Terminal', slug: 'terminal', platform: '', version: '' };

    /* ================= Idioma =================
     * El catálogo del idioma activo lo resuelve el proceso principal y llega
     * con las preferencias (ver catalogFor en main/i18n.js). Aquí no se decide
     * el idioma: solo se aplica.
     *
     * El español es el idioma de referencia y su catálogo está vacío a
     * propósito: el texto en español ya está escrito en index.html y en este
     * archivo, y se usa como respaldo. Así una clave sin traducir se ve en
     * español en vez de aparecer cruda en pantalla.
     */
    var strings = {};
    var activeLanguage = 'es';

    function t(key, params, fallback) {
        var text = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : (fallback || key);
        if (!params) return text;
        return text.replace(/\{(\w+)\}/g, function (match, name) {
            return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
        });
    }

    // Aplica el catálogo al HTML estático. Se vuelve a llamar entero al
    // cambiar de idioma en Ajustes, así que no hace falta reiniciar.
    function applyTranslations(root) {
        var scope = root || document;
        var pares = [
            ['data-i18n', function (el, texto) { el.textContent = texto; }],
            ['data-i18n-title', function (el, texto) { el.title = texto; }],
            ['data-i18n-placeholder', function (el, texto) { el.placeholder = texto; }],
            ['data-i18n-aria-label', function (el, texto) { el.setAttribute('aria-label', texto); }]
        ];
        pares.forEach(function (par) {
            var atributo = par[0];
            var aplicar = par[1];
            Array.prototype.forEach.call(scope.querySelectorAll('[' + atributo + ']'), function (el) {
                var clave = el.getAttribute(atributo);
                // Sin traducción se deja el texto original del HTML, que ya
                // está en el idioma de referencia.
                if (Object.prototype.hasOwnProperty.call(strings, clave)) aplicar(el, strings[clave]);
            });
        });
        document.documentElement.lang = activeLanguage;
    }

    // Los grupos (apartados del panel, familias del selector de entorno) los
    // genera el proceso principal en español y los usa además para ordenar.
    // Vienen acompañados de `groupKey`; si falta, se deja el nombre original.
    function translateGroup(name, key) {
        return key ? t(key, null, name) : name;
    }

    function applyLanguage(i18n) {
        strings = (i18n && i18n.strings) || {};
        activeLanguage = (i18n && i18n.language) || 'es';
        applyTranslations();
    }

    /* ================= Pestañas ================= */
    var terminalContainer = document.getElementById('terminal-container');
    var tabStrip = document.getElementById('tab-strip');
    var newTabBtn = document.getElementById('tab-new');
    var splitTabBtn = document.getElementById('tab-split');
    var terminalContextMenu = document.getElementById('terminal-context-menu');

    var tabs = {}; // tabId -> { id, term, fitAddon, pane, label, envId }
    var activeTabId = null;
    // Hasta cuatro sesiones a la vez, una por casilla de la rejilla. La lista
    // guarda qué pestaña ocupa cada casilla, en orden.
    var MAX_PANES = 4;
    var paneTabIds = [];
    var tabCreatePending = false;
    var splitCreatePending = false;
    var environmentRequestGeneration = 0;
    var scriptsHereDepth = 3;
    var uiPreferences = {
        scriptsHereDepth: 3,
        autoStartDocker: true,
        exclusiveAccordionGroups: true,
        autoOpenFirstGroup: false,
        showSystemBanner: true,
        themeId: 'silver',
        accentColor: '#b8bec6',
        terminalBackground: '#080808',
        terminalForeground: '#d7d7d7',
        terminalFontFamily: 'system-mono',
        terminalFontSize: 14,
        terminalLineHeight: 1.1,
        terminalLetterSpacing: 0,
        terminalCursorStyle: 'block',
        terminalFontWeight: 'normal',
        terminalPadding: 10,
        terminalScrollback: 5000,
        terminalCursorBlink: true,
        terminalScrollSensitivity: 3,
        copyOnSelect: false,
        uiDensity: 'comfortable',
        defaultEnvironmentId: ''
    };

    function activeThemePreset() {
        for (var i = 0; i < themeCatalog.length; i += 1) {
            if (themeCatalog[i].id === uiPreferences.themeId) return themeCatalog[i];
        }
        return themeCatalog[0] || {
            palette: {
                background: '#080808', surface: '#191919', surfaceAlt: '#111111',
                border: '#3b3d40', text: '#d7d7d7', muted: '#8b8e92',
                accent: '#b8bec6', accentSoft: '#34383d', selection: '#4b5056'
            }
        };
    }

    function activeFontCss() {
        for (var i = 0; i < fontCatalog.length; i += 1) {
            if (fontCatalog[i].id === uiPreferences.terminalFontFamily) return fontCatalog[i].css;
        }
        return "'Cascadia Code', Consolas, 'Courier New', monospace";
    }

    function setCssVariable(name, value) {
        document.documentElement.style.setProperty(name, value);
    }

    function refreshVisualTheme() {
        var palette = activeThemePreset().palette;
        setCssVariable('--app-bg', palette.background);
        setCssVariable('--surface', palette.surface);
        setCssVariable('--surface-alt', palette.surfaceAlt);
        setCssVariable('--surface-hover', palette.surfaceHover || palette.border);
        setCssVariable('--border', palette.border);
        setCssVariable('--text', palette.text);
        setCssVariable('--muted', palette.muted);
        setCssVariable('--accent', uiPreferences.accentColor);
        setCssVariable('--accent-soft', palette.accentSoft);
        setCssVariable('--terminal-bg', uiPreferences.terminalBackground);
        setCssVariable('--terminal-fg', uiPreferences.terminalForeground);
        setCssVariable('--terminal-padding', uiPreferences.terminalPadding + 'px');
        document.body.dataset.density = uiPreferences.uiDensity;

        THEME = {
            background: uiPreferences.terminalBackground,
            foreground: uiPreferences.terminalForeground,
            cursor: uiPreferences.accentColor,
            cursorAccent: uiPreferences.terminalBackground,
            selectionBackground: palette.selection,
            black: uiPreferences.terminalBackground,
            brightBlack: palette.muted
        };
    }

    function applyUiPreferences(preferences) {
        if (!preferences) return;
        // El idioma va primero: todo lo que se repinte a continuación
        // (paneles, listas, avisos) tiene que salir ya con el catálogo nuevo.
        if (preferences.i18n) applyLanguage(preferences.i18n);
        if (Array.isArray(preferences.languages)) languageCatalog = preferences.languages;
        if (Array.isArray(preferences.themes)) themeCatalog = preferences.themes;
        if (Array.isArray(preferences.fontFamilies)) fontCatalog = preferences.fontFamilies;
        if (preferences.appIdentity) {
            appIdentity = preferences.appIdentity;
            document.title = appIdentity.name || 'Terminal';
        }
        Object.keys(uiPreferences).forEach(function (key) {
            if (Object.prototype.hasOwnProperty.call(preferences, key)) uiPreferences[key] = preferences[key];
        });
        refreshVisualTheme();
        scriptsHereDepth = uiPreferences.scriptsHereDepth;
        Object.keys(tabs).forEach(function (tabId) {
            var term = tabs[tabId].term;
            term.options.fontFamily = activeFontCss();
            term.options.fontSize = uiPreferences.terminalFontSize;
            term.options.lineHeight = uiPreferences.terminalLineHeight;
            term.options.letterSpacing = uiPreferences.terminalLetterSpacing;
            term.options.cursorStyle = uiPreferences.terminalCursorStyle;
            term.options.fontWeight = uiPreferences.terminalFontWeight;
            term.options.scrollback = uiPreferences.terminalScrollback;
            term.options.cursorBlink = uiPreferences.terminalCursorBlink;
            term.options.scrollSensitivity = uiPreferences.terminalScrollSensitivity;
            term.options.theme = THEME;
        });
        setTimeout(scheduleFit, 0);
        if (typeof scriptsDepthSelect !== 'undefined' && scriptsDepthSelect) {
            scriptsDepthSelect.value = String(uiPreferences.scriptsHereDepth);
        }
    }

    // Cierra un panel cuando se pulsa fuera de él.
    //
    // La comprobación va en fase de CAPTURA, antes de que corran los
    // manejadores del propio panel. Al burbujear no servía: un botón que
    // redibuja su panel (por ejemplo «Ver repos», que reconstruye la lista de
    // perfiles) ya estaba fuera del DOM cuando llegaba aquí, contains()
    // devolvía falso y el panel se cerraba solo en vez de mostrar el resultado.
    function closeOnOutsideClick(panel, toggleButton) {
        document.addEventListener('click', function (event) {
            if (!panel || panel.classList.contains('hidden')) return;
            if (panel.contains(event.target)) return;
            if (toggleButton && (event.target === toggleButton || toggleButton.contains(event.target))) return;
            panel.classList.add('hidden');
        }, true);
    }

    function configureAccordion(group, container, index) {
        group.open = uiPreferences.autoOpenFirstGroup && index === 0;
        group.addEventListener('toggle', function () {
            if (!group.open || !uiPreferences.exclusiveAccordionGroups) return;
            Array.prototype.forEach.call(container.querySelectorAll('details'), function (other) {
                // Se cierran las listas hermanas, nunca el grupo que contiene a
                // esta ni los subgrupos que hay dentro: con listas anidadas,
                // cerrar «todo lo que no sea yo» plegaba el padre al abrir un
                // hijo y el subgrupo desaparecía en el mismo clic.
                if (other === group || other.contains(group) || group.contains(other)) return;
                other.open = false;
            });
        });
    }

    /* ---- Copiar / pegar (estilo consola de Windows) ----
     * En cmd.exe y PowerShell el botón derecho hace las dos cosas según el
     * contexto: si hay texto seleccionado lo copia (y deshace la selección),
     * y si no lo hay, pega lo que haya en el portapapeles en la línea de
     * entrada. Se replica exactamente eso, más los Ctrl+Shift+C/V que espera
     * cualquier terminal moderna (Ctrl+C a secas no puede usarse: en una
     * terminal significa "interrumpir el proceso").
     *
     * El pegado va por term.paste() y no por sendInput() a pelo: xterm
     * normaliza los saltos de línea y respeta el "bracketed paste" cuando la
     * aplicación que corre dentro (nano, vim, un REPL...) lo tiene activado,
     * que es lo que evita que un texto multilínea se ejecute a trozos.
     */
    function copySelection(term) {
        if (!term.hasSelection()) return false;
        var selection = term.getSelection();
        if (selection) window.terminalAPI.writeClipboard(selection);
        term.clearSelection();
        return true;
    }

    function pasteFromClipboard(term) {
        window.terminalAPI.readClipboard().then(function (text) {
            if (text) term.paste(text);
        });
    }

    function editableSelection(term) {
        if (!term.hasSelection()) return null;
        var text = term.getSelection();
        var range = term.getSelectionPosition();
        if (!text || !range || /[\r\n]/.test(text)) return null;
        var buffer = term.buffer.active;
        var cursorX = buffer.cursorX + 1;
        var cursorY = buffer.baseY + buffer.cursorY + 1;
        // Solo es seguro borrar si la selección termina exactamente en el
        // cursor. El historial ya emitido por el proceso es inmutable.
        if (range.end.x !== cursorX || range.end.y !== cursorY) return null;
        var length = Array.from(text).length;
        if (length < 1 || length > 4096) return null;
        return { text: text, length: length };
    }

    function deleteEditableSelection(term, tabId, copyFirst) {
        var editable = editableSelection(term);
        if (!editable) return false;
        if (copyFirst) window.terminalAPI.writeClipboard(editable.text);
        term.clearSelection();
        // DEL es la tecla Backspace que xterm envía a shells interactivas.
        window.terminalAPI.sendInput(tabId, new Array(editable.length + 1).join('\x7f'));
        return true;
    }

    var contextTerm = null;
    var contextTabId = null;

    function showTerminalContextMenu(event, term, tabId) {
        contextTerm = term;
        contextTabId = tabId;
        var hasSelection = term.hasSelection();
        var canDelete = !!editableSelection(term);
        Array.prototype.forEach.call(terminalContextMenu.querySelectorAll('button'), function (button) {
            var action = button.dataset.action;
            button.disabled = (action === 'copy' && !hasSelection)
                || ((action === 'cut' || action === 'delete') && !canDelete);
        });
        terminalContextMenu.classList.remove('hidden');
        var width = terminalContextMenu.offsetWidth;
        var height = terminalContextMenu.offsetHeight;
        terminalContextMenu.style.left = Math.min(event.clientX, window.innerWidth - width - 6) + 'px';
        terminalContextMenu.style.top = Math.min(event.clientY, window.innerHeight - height - 6) + 'px';
    }

    function enableCopyPaste(pane, term, tabId) {
        // xterm escucha `contextmenu` en su nodo interno y mueve el textarea
        // invisible bajo el puntero para implementar su pegado nativo. Como
        // La aplicación usa un menú propio; hay que interceptarlo en CAPTURA (antes
        // de que llegue a xterm); de lo contrario una composición IME puede
        // quedarse visible y desplazada al fondo de la ventana.
        pane.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            showTerminalContextMenu(e, term, tabId);
        }, true);

        // Devolver false impide que xterm procese además la pulsación (y la
        // mande al proceso como una tecla más).
        term.attachCustomKeyEventHandler(function (e) {
            if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
            var key = (e.key || '').toLowerCase();
            if (key === 'c' && term.hasSelection()) {
                copySelection(term);
                return false;
            }
            if (key === 'v') {
                pasteFromClipboard(term);
                return false;
            }
            if (key === 'x' && term.hasSelection()) {
                if (deleteEditableSelection(term, tabId, true)) return false;
            }
            return true;
        });
    }

    terminalContextMenu.addEventListener('click', function (event) {
        var button = event.target.closest('button');
        if (!button || button.disabled || !contextTerm || !contextTabId) return;
        var action = button.dataset.action;
        if (action === 'copy') copySelection(contextTerm);
        else if (action === 'cut') deleteEditableSelection(contextTerm, contextTabId, true);
        else if (action === 'delete') deleteEditableSelection(contextTerm, contextTabId, false);
        else if (action === 'paste') pasteFromClipboard(contextTerm);
        terminalContextMenu.classList.add('hidden');
        contextTerm.focus();
    });

    document.addEventListener('mousedown', function (event) {
        if (!terminalContextMenu.contains(event.target)) terminalContextMenu.classList.add('hidden');
    });

    function createXtermForTab(tabId) {
        var pane = document.createElement('div');
        pane.className = 'tab-pane';
        pane.dataset.tabId = tabId;
        terminalContainer.appendChild(pane);

        var term = new Terminal({
            cursorBlink: uiPreferences.terminalCursorBlink,
            cursorStyle: uiPreferences.terminalCursorStyle,
            scrollOnUserInput: true,
            scrollback: uiPreferences.terminalScrollback,
            fontFamily: activeFontCss(),
            fontSize: uiPreferences.terminalFontSize,
            lineHeight: uiPreferences.terminalLineHeight,
            letterSpacing: uiPreferences.terminalLetterSpacing,
            fontWeight: uiPreferences.terminalFontWeight,
            scrollSensitivity: uiPreferences.terminalScrollSensitivity,
            theme: THEME
        });
        var fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(pane);

        term.onData(function (data) {
            // Si el usuario había desplazado el historial, cualquier nueva
            // entrada debe devolverle a la línea que está editando.
            term.scrollToBottom();
            window.terminalAPI.sendInput(tabId, data);
        });

        enableCopyPaste(pane, term, tabId);

        // "Copiar al seleccionar": se copia al SOLTAR el ratón, no en cada
        // evento de selección. Mientras se arrastra, xterm emite uno por
        // celda, y copiar en todos deja el portapapeles con fragmentos.
        // A diferencia de Ctrl+Shift+C, la selección no se limpia: sigue
        // marcada para que se vea qué se copió.
        pane.addEventListener('mouseup', function () {
            if (!uiPreferences.copyOnSelect || !term.hasSelection()) return;
            var selection = term.getSelection();
            if (selection) window.terminalAPI.writeClipboard(selection);
        });

        pane.addEventListener('mousedown', function () {
            // Pulsar en cualquier panel visible le da el foco del teclado.
            if (tabId !== activeTabId && visiblePaneIds().indexOf(tabId) !== -1) activateTab(tabId);
        });

        return { pane: pane, term: term, fitAddon: fitAddon };
    }

    /* ---- Aviso de carga mientras arranca una sesión ----
     * Cambiar de entorno no es instantáneo: una distro WSL en frío o una
     * imagen Docker tardan segundos. En vez de un texto fijo que parece
     * colgado, el panel muestra un indicador en movimiento hasta que la
     * sesión nueva da señales de vida.
     */
    function hidePaneLoading(tabId) {
        var tab = tabs[tabId];
        if (!tab || !tab.loadingOverlay) return;
        if (tab.loadingTimer) clearTimeout(tab.loadingTimer);
        if (tab.loadingSettleTimer) clearTimeout(tab.loadingSettleTimer);
        tab.loadingTimer = null;
        tab.loadingSettleTimer = null;
        tab.loadingOverlay.remove();
        tab.loadingOverlay = null;
    }

    function showPaneLoading(tabId, label) {
        var tab = tabs[tabId];
        if (!tab) return;
        hidePaneLoading(tabId);

        var overlay = document.createElement('div');
        overlay.className = 'pane-loading';

        var spinner = document.createElement('div');
        spinner.className = 'pane-loading-spinner';
        overlay.appendChild(spinner);

        var text = document.createElement('div');
        text.className = 'pane-loading-text';
        text.appendChild(document.createTextNode(t('tabs.loadingPrefix', null, 'Cargando a: ')));
        var envName = document.createElement('span');
        envName.className = 'pane-loading-env';
        envName.textContent = label || t('tabs.someEnv', null, 'entorno');
        text.appendChild(envName);
        overlay.appendChild(text);

        var bar = document.createElement('div');
        bar.className = 'pane-loading-bar';
        bar.appendChild(document.createElement('span'));
        overlay.appendChild(bar);

        tab.pane.appendChild(overlay);
        tab.loadingOverlay = overlay;
        // Tope de seguridad: si la shell no llega a responder, el aviso no
        // puede quedarse puesto para siempre.
        tab.loadingTimer = setTimeout(function () { hidePaneLoading(tabId); }, 20000);
    }

    // El proceso principal devuelve la etiqueta definitiva del entorno (la del
    // selector puede quedarse corta); si el aviso ya no está, no se reabre.
    function updatePaneLoadingLabel(tabId, label) {
        var tab = tabs[tabId];
        if (!tab || !tab.loadingOverlay || !label) return;
        var envName = tab.loadingOverlay.querySelector('.pane-loading-env');
        if (envName) envName.textContent = label;
    }

    // La shell da señales de vida. Con archivo de inicialización, el aviso se
    // retira justo cuando limpia la pantalla para pintar el banner; sin él
    // (REPL, contenedores) basta con la primera salida, dejando un margen para
    // que no parpadee.
    function notePaneOutput(tabId, settled) {
        var tab = tabs[tabId];
        if (!tab || !tab.loadingOverlay) return;
        if (settled) {
            hidePaneLoading(tabId);
            return;
        }
        if (tab.loadingSettleTimer) return;
        tab.loadingSettleTimer = setTimeout(function () { hidePaneLoading(tabId); }, 900);
    }

    function addTab(tabId, label, envId) {
        if (tabs[tabId]) return tabs[tabId];
        var handles = createXtermForTab(tabId);
        tabs[tabId] = {
            id: tabId, term: handles.term, fitAddon: handles.fitAddon, pane: handles.pane,
            label: label || 'Terminal', envId: envId || null,
            // Todavía no se pide la salida pendiente: ver signalTabReady.
            readySignalled: false
        };
        // Red de seguridad: una pestaña que por lo que sea no llega a hacerse
        // visible no puede quedarse sin recibir nunca su salida.
        setTimeout(function () { signalTabReady(tabId); }, 1000);
        return tabs[tabId];
    }

    function activateReturnedTab(tab) {
        if (!tab || !tab.id) return;
        if (!tabs[tab.id]) addTab(tab.id, tab.label, tab.envId);
        renderTabStrip();
        activateTab(tab.id);
    }

    function renderTabStrip() {
        tabStrip.innerHTML = '';
        Object.keys(tabs).forEach(function (tabId) {
            var tab = tabs[tabId];
            var el = document.createElement('div');
            el.className = 'tab-item'
                + (tabId === activeTabId ? ' active' : '')
                + (tabId !== activeTabId && visiblePaneIds().indexOf(tabId) !== -1 ? ' secondary' : '');

            var label = document.createElement('span');
            label.className = 'tab-item-label';
            label.textContent = tab.label;
            el.appendChild(label);

            var closeBtn = document.createElement('button');
            closeBtn.className = 'tab-item-close';
            closeBtn.textContent = '✕';
            closeBtn.title = t('tabs.close', null, 'Cerrar pestaña');
            closeBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                window.terminalAPI.closeTab(tabId);
            });
            el.appendChild(closeBtn);

            el.addEventListener('click', function () {
                activateTab(tabId);
            });

            tabStrip.appendChild(el);
        });
    }

    /* Pide la salida que el pty haya escrito antes de que existiera este
     * xterm (banner, primer prompt...).
     *
     * No se pide al crear la pestaña sino cuando ya tiene su tamaño real. Un
     * xterm recién creado mide 80x24; si se le entregaba ahí el banner y el
     * prompt, al hacerse visible y reajustarse a las columnas de verdad todo
     * ese contenido se reflujaba, y era justo lo que dejaba el prompt colgado
     * en mitad de la pantalla y las líneas partidas donde no tocaba.
     */
    function signalTabReady(tabId) {
        var tab = tabs[tabId];
        if (!tab || tab.readySignalled) return;
        tab.readySignalled = true;
        window.terminalAPI.markTabReady(tabId);
    }

    function fitActiveTab() {
        visiblePaneIds().forEach(function (tabId) {
            var tab = tabs[tabId];
            if (!tab) return;
            if (!tab.pane.isConnected || tab.pane.clientWidth < 2 || tab.pane.clientHeight < 2) return;
            try {
                var buffer = tab.term.buffer.active;
                var wasAtBottom = buffer.viewportY >= buffer.baseY;
                tab.fitAddon.fit();
                // Si se estaba mirando el final, se sigue mirando el final:
                // al reajustar, xterm conserva la posición del buffer y con
                // menos filas la vista se quedaba por encima de la línea en la
                // que se está escribiendo.
                if (wasAtBottom) tab.term.scrollToBottom();
                window.terminalAPI.resize(tabId, tab.term.cols, tab.term.rows);
                // El tamaño ya es el definitivo y main.js lo conoce: ahora sí
                // puede entregar lo que tuviera pendiente.
                signalTabReady(tabId);
            } catch (error) {
                window.terminalAPI.reportRendererError({
                    message: 'No se pudo reajustar la terminal: ' + error.message,
                    source: 'renderer.js:fitActiveTab'
                });
            }
        });
    }

    var fitFrame = null;
    function scheduleFit() {
        if (fitFrame !== null) cancelAnimationFrame(fitFrame);
        fitFrame = requestAnimationFrame(function () {
            fitFrame = null;
            fitActiveTab();
        });
    }

    // Pestañas visibles a la vez, en orden de casilla. La activa siempre está
    // dentro; el resto acompaña en la rejilla.
    function visiblePaneIds() {
        var visible = paneTabIds.filter(function (tabId) { return !!tabs[tabId]; });
        if (activeTabId && tabs[activeTabId] && visible.indexOf(activeTabId) === -1) visible.unshift(activeTabId);
        return visible.slice(0, MAX_PANES);
    }

    function applyPaneLayout() {
        var visible = visiblePaneIds();
        paneTabIds = visible;
        var count = visible.length;
        terminalContainer.classList.toggle('split', count > 1);
        for (var n = 2; n <= MAX_PANES; n += 1) {
            terminalContainer.classList.toggle('split-' + n, count === n);
        }
        Object.keys(tabs).forEach(function (tabId) {
            var pane = tabs[tabId].pane;
            var slot = visible.indexOf(tabId);
            pane.classList.toggle('visible', slot !== -1);
            pane.classList.toggle('active', tabId === activeTabId);
            for (var i = 1; i <= MAX_PANES; i += 1) {
                pane.classList.toggle('pane-slot-' + i, slot === i - 1);
            }
            // `order` decide la casilla: sin esto el orden lo marcaría la
            // creación de las pestañas, no la posición elegida.
            pane.style.order = slot === -1 ? '' : String(slot);
        });
        if (splitTabBtn) {
            splitTabBtn.classList.toggle('active', count > 1);
            splitTabBtn.title = count >= MAX_PANES
                ? t('tabs.splitBackTitle', null, 'Volver a una sola sesión (Ctrl+Shift+\\)')
                : t('tabs.splitAddTitle', { max: MAX_PANES }, 'Añadir otra sesión a la vista, hasta {max} (Ctrl+Shift+\\)');
        }
    }

    function refreshEnvSelectForActiveTab(force) {
        if (!activeTabId) return Promise.resolve(null);
        var requestedTabId = activeTabId;
        var generation = ++environmentRequestGeneration;
        if (envRefreshBtn) envRefreshBtn.disabled = true;
        var request = force
            ? window.terminalAPI.refreshEnvironments(requestedTabId)
            : window.terminalAPI.listEnvironments(requestedTabId);
        return request.then(function (data) {
            if (generation !== environmentRequestGeneration || requestedTabId !== activeTabId) return data;
            renderEnvOptions(data);
            return data;
        }).catch(function (error) {
            window.terminalAPI.reportRendererError({ message: 'No se pudieron refrescar los entornos: ' + error.message });
            return null;
        }).finally(function () {
            if (generation === environmentRequestGeneration && envRefreshBtn) envRefreshBtn.disabled = false;
        });
    }

    function activateTab(tabId) {
        if (!tabs[tabId]) return;
        if (tabId === activeTabId) {
            tabs[tabId].term.focus();
            return;
        }
        var visible = visiblePaneIds();
        var slot = visible.indexOf(tabId);
        if (slot === -1) {
            // Una pestaña que no está a la vista ocupa la casilla de la activa;
            // el resto de la rejilla se queda como estaba.
            var current = visible.indexOf(activeTabId);
            if (current === -1) paneTabIds = [tabId];
            else {
                paneTabIds = visible.slice();
                paneTabIds[current] = tabId;
            }
        }
        activeTabId = tabId;
        applyPaneLayout();
        window.terminalAPI.activateTab(tabId);
        renderTabStrip();
        refreshEnvSelectForActiveTab();
        if (scriptsPanel && scriptsMode === 'here' && !scriptsPanel.classList.contains('hidden')) {
            loadScriptsForCurrentMode();
        }
        // Cada pestaña tiene su propio directorio: el explorador pasa a mostrar
        // el de la pestaña que acaba de activarse.
        loadExplorer();
        // El fit debe ocurrir tras hacerse visible el pane (display:none no
        // tiene tamaño real, xterm calcularía mal las columnas/filas).
        setTimeout(function () {
            fitActiveTab();
            tabs[tabId].term.focus();
        }, 0);
    }

    function removeTabUI(tabId, preferredNextId) {
        var tab = tabs[tabId];
        if (!tab) return;
        hidePaneLoading(tabId);
        tab.term.dispose();
        tab.pane.remove();
        delete tabs[tabId];
        paneTabIds = paneTabIds.filter(function (id) { return id !== tabId; });
        if (activeTabId === tabId) {
            activeTabId = null;
            var nextId = (preferredNextId && tabs[preferredNextId]) ? preferredNextId : Object.keys(tabs)[0];
            if (nextId) activateTab(nextId);
        }
        applyPaneLayout();
        renderTabStrip();
    }

    if (newTabBtn) {
        newTabBtn.addEventListener('click', function () {
            if (tabCreatePending) return;
            tabCreatePending = true;
            newTabBtn.disabled = true;
            var currentEnvId = activeTabId && tabs[activeTabId] ? tabs[activeTabId].envId : null;
            window.terminalAPI.createTab(currentEnvId).then(function (nueva) {
                if (!nueva) return;
                addTab(nueva.id, nueva.label, nueva.envId);
                renderTabStrip();
                activateTab(nueva.id);
            }).finally(function () {
                tabCreatePending = false;
                newTabBtn.disabled = false;
            });
        });
    }

    function refreshPanes() {
        applyPaneLayout();
        renderTabStrip();
        setTimeout(fitActiveTab, 0);
    }

    // El botón ▥ va sumando sesiones a la vista (2, 3 y 4, una por casilla) y,
    // al llegar al máximo, vuelve a dejar una sola. Si no hay pestañas libres
    // que colocar, se abre una nueva del mismo entorno.
    function cyclePaneCount() {
        var visible = visiblePaneIds();
        if (visible.length >= MAX_PANES) {
            paneTabIds = activeTabId ? [activeTabId] : [];
            refreshPanes();
            return;
        }
        var other = Object.keys(tabs).find(function (tabId) { return visible.indexOf(tabId) === -1; });
        if (other) {
            paneTabIds = visible.concat([other]);
            refreshPanes();
            return;
        }
        if (splitCreatePending) return;
        var currentEnvId = activeTabId && tabs[activeTabId] ? tabs[activeTabId].envId : null;
        splitCreatePending = true;
        if (splitTabBtn) splitTabBtn.disabled = true;
        window.terminalAPI.createTab(currentEnvId).then(function (tab) {
            if (!tab) return;
            addTab(tab.id, tab.label, tab.envId);
            paneTabIds = visiblePaneIds().concat([tab.id]);
            // createTab activa la nueva pestaña en main; la vista conserva la
            // original como principal y corrige allí el foco lógico.
            window.terminalAPI.activateTab(activeTabId);
            refreshPanes();
        }).finally(function () {
            splitCreatePending = false;
            if (splitTabBtn) splitTabBtn.disabled = false;
        });
    }

    if (splitTabBtn) {
        splitTabBtn.addEventListener('click', cyclePaneCount);
    }

    // Ctrl+Shift+T / Ctrl+Tab: atajos que no chocan con edición de línea de
    // las shells (Ctrl+W sí se usa para borrar palabra en bash/readline, por
    // eso no se usa aquí para cerrar pestaña).
    window.addEventListener('keydown', function (e) {
        var formField = e.target && !terminalContainer.contains(e.target)
            && (e.target.matches('input, textarea, select') || e.target.isContentEditable);
        if (formField && !(e.ctrlKey && e.key === 'Tab')) return;
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') {
            e.preventDefault();
            if (newTabBtn) newTabBtn.click();
        } else if (e.ctrlKey && e.key === 'Tab') {
            e.preventDefault();
            var ids = Object.keys(tabs);
            if (ids.length < 2) return;
            var idx = ids.indexOf(activeTabId);
            var delta = e.shiftKey ? -1 : 1;
            var next = ids[(idx + delta + ids.length) % ids.length];
            activateTab(next);
        } else if (e.ctrlKey && e.shiftKey && e.key === '\\') {
            e.preventDefault();
            cyclePaneCount();
        } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') {
            e.preventDefault();
            setExplorerVisible(!explorerVisible);
        }
    });

    /* ================= Eventos del pty, enrutados por tabId ================= */
    function isAtBottom(term) {
        var buffer = term.buffer.active;
        return buffer && typeof buffer.ydisp === 'number' && typeof buffer.ybase === 'number'
            ? buffer.ydisp >= buffer.ybase
            : buffer && typeof buffer.viewportY === 'number' && typeof buffer.baseY === 'number'
                ? buffer.viewportY >= buffer.baseY
                : true;
    }

    function keepTerminalCentered(term) {
        var buffer = term.buffer.active;
        if (!buffer || typeof buffer.ybase !== 'number' || typeof buffer.y !== 'number') return;
        var rows = term.rows || 24;
        var cursorLine = buffer.ybase + buffer.y;
        var target = cursorLine - Math.floor(rows / 2);
        if (target < 0) target = 0;
        if (typeof term.scrollToLine === 'function') {
            term.scrollToLine(target);
        } else if (typeof term.scrollLines === 'function') {
            var top = typeof buffer.ydisp === 'number' ? buffer.ydisp : (typeof buffer.viewportY === 'number' ? buffer.viewportY : 0);
            term.scrollLines(target - top);
        }
    }

    window.terminalAPI.onData(function (tabId, data) {
        var tab = tabs[tabId];
        if (!tab) return;
        var wasAtBottom = isAtBottom(tab.term);
        tab.term.write(data);
        if (wasAtBottom) keepTerminalCentered(tab.term);
        notePaneOutput(tabId, false);
    });

    // clear / cls: main.js entrega ahora el marcador ANTES del repintado de
    // la shell. Se resetea pantalla + historial y, acto seguido, llegan el
    // banner y un único prompt nuevos. El orden anterior conservaba el prompt
    // viejo de ConPTY y producía las dos líneas observadas en las capturas.
    if (window.terminalAPI.onClear) {
        window.terminalAPI.onClear(function (tabId) {
            var tab = tabs[tabId];
            if (!tab) return;
            tab.term.reset();
            // La shell ya ha cargado su inicialización y va a pintar el
            // banner: la sesión está lista de verdad.
            notePaneOutput(tabId, true);
        });
    }

    window.terminalAPI.onExit(function (tabId, code) {
        var tab = tabs[tabId];
        if (!tab) return;
        hidePaneLoading(tabId);
        tab.term.writeln('\r\n\x1b[33m' + t('tabs.exited', { code: code }, '[Proceso finalizado con código {code}]') + '\x1b[0m');
    });

    window.terminalAPI.onEnvironmentChanged(function (tabId, info) {
        var tab = tabs[tabId];
        if (!tab) return;
        tab.term.reset();
        // El aviso ya está puesto desde que se eligió el entorno; aquí solo se
        // afina el nombre con la etiqueta real que devuelve el proceso
        // principal. El resto lo dirá el banner de la sesión nueva, así que no
        // hace falta una línea fija más en el buffer.
        updatePaneLoadingLabel(tabId, info.label);
        tab.envId = info.id;
        tab.label = info.label;
        renderTabStrip();
        if (tabId === activeTabId) {
            var select = document.getElementById('env-select');
            if (select) select.value = info.id;
        }
    });

    window.addEventListener('resize', scheduleFit);
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(scheduleFit).observe(terminalContainer);
    }

    /* ================= Barra de entornos (pestaña activa) ================= */
    var envSelect = document.getElementById('env-select');
    var envRefreshBtn = document.getElementById('env-refresh');

    // Los entornos se agrupan por familia (shells del sistema, contenedores
    // Docker, imágenes Docker, dispositivos ADB). Sin separarlos, ver la
    // misma imagen como contenedor en marcha y como imagen suelta parecía un
    // duplicado, cuando son dos cosas distintas: entrar en el contenedor vivo
    // o crear uno nuevo y efímero.
    function renderEnvOptions(data) {
        envSelect.innerHTML = '';
        var grupos = {};
        (data.envs || []).forEach(function (env) {
            var nombre = translateGroup(env.group, env.groupKey) || t('env.groupOther', null, 'Otros');
            if (!grupos[nombre]) {
                var g = document.createElement('optgroup');
                g.label = nombre;
                grupos[nombre] = g;
                envSelect.appendChild(g);
            }
            var opt = document.createElement('option');
            opt.value = env.id;
            opt.textContent = env.label;
            opt.disabled = env.available === false;
            if (env.note) opt.title = env.note;
            grupos[nombre].appendChild(opt);
        });
        if (data.currentEnvId) {
            envSelect.value = data.currentEnvId;
            if (envSelect.value !== data.currentEnvId) {
                var currentGroup = document.createElement('optgroup');
                currentGroup.label = t('env.currentGone', null, 'Entorno actual (ya no detectado)');
                var currentOption = document.createElement('option');
                currentOption.value = data.currentEnvId;
                currentOption.textContent = tabs[activeTabId] ? tabs[activeTabId].label : data.currentEnvId;
                currentOption.disabled = true;
                currentOption.selected = true;
                currentGroup.appendChild(currentOption);
                envSelect.appendChild(currentGroup);
            }
        }
    }

    envSelect.addEventListener('change', function () {
        if (!activeTabId) return;
        var tabId = activeTabId;
        var previousEnvId = tabs[tabId].envId;
        var requestedEnvId = envSelect.value;
        var selectedOption = envSelect.options[envSelect.selectedIndex];
        envSelect.disabled = true;
        // El aviso se pone ya, sin esperar al proceso principal: matar el pty
        // anterior y arrancar el nuevo es justo la parte que tarda.
        showPaneLoading(tabId, selectedOption ? selectedOption.textContent : requestedEnvId);
        window.terminalAPI.switchEnvironment(tabId, requestedEnvId).then(function (result) {
            if (!result || !result.ok) {
                hidePaneLoading(tabId);
                if (tabId === activeTabId) envSelect.value = (result && result.currentEnvId) || previousEnvId;
                window.terminalAPI.reportRendererError({ message: (result && result.error) || 'No se pudo cambiar de entorno.' });
            }
        }).catch(function (error) {
            hidePaneLoading(tabId);
            if (tabId === activeTabId) envSelect.value = previousEnvId;
            window.terminalAPI.reportRendererError({ message: 'Cambio de entorno fallido: ' + error.message });
        }).finally(function () {
            envSelect.disabled = false;
            if (tabId === activeTabId && tabs[tabId]) tabs[tabId].term.focus();
        });
    });

    envRefreshBtn.addEventListener('click', function () {
        refreshEnvSelectForActiveTab(true);
    });

    // Docker puede tardar en arrancar: cuando su daemon responde, main.js
    // vuelve a detectar entornos y los empuja aquí, sin pulsar ⟳.
    if (window.terminalAPI.onEnvironmentsUpdated) {
        window.terminalAPI.onEnvironmentsUpdated(function (envs) {
            var current = activeTabId && tabs[activeTabId] ? tabs[activeTabId].envId : envSelect.value;
            renderEnvOptions({ envs: envs, currentEnvId: current });
        });
    }

    /* ========= Panel de entorno y dependencias adicionales ========= */
    var depsToggleBtn = document.getElementById('deps-toggle');
    var depsPanel = document.getElementById('deps-panel');

    function renderDepsPanel(data) {
        depsPanel.innerHTML = '';
        var actions = Array.isArray(data) ? data : ((data && data.actions) || []);
        var components = Array.isArray(data) ? [] : ((data && data.components) || []);

        var header = document.createElement('div');
        header.className = 'deps-panel-header';
        var headerText = document.createElement('div');
        var headerTitle = document.createElement('div');
        headerTitle.textContent = t('deps.header', null, 'Entorno y componentes');
        var headerSubtitle = document.createElement('div');
        headerSubtitle.className = 'deps-panel-subtitle';
        headerSubtitle.textContent = data && data.error
            ? data.error
            : t('deps.onlyApplicable', null, 'Solo se muestran acciones aplicables a este sistema.');
        if (data && data.error) headerSubtitle.classList.add('error');
        headerText.appendChild(headerTitle);
        headerText.appendChild(headerSubtitle);
        var pending = document.createElement('span');
        pending.className = 'script-group-count';
        pending.textContent = actions.length;
        header.appendChild(headerText);
        header.appendChild(pending);
        depsPanel.appendChild(header);

        if (components.length) {
            var summary = document.createElement('div');
            summary.className = 'deps-summary';
            components.forEach(function (component) {
                var chip = document.createElement('div');
                chip.className = 'deps-chip';
                var key = document.createElement('span');
                key.textContent = component.label;
                var value = document.createElement('strong');
                value.textContent = component.value;
                chip.appendChild(key);
                chip.appendChild(value);
                summary.appendChild(chip);
            });
            depsPanel.appendChild(summary);
        }

        if (!actions || actions.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'dep-empty';
            empty.textContent = t('deps.allReady', null, 'Todo lo detectado está listo; no hay instalaciones pendientes.');
            depsPanel.appendChild(empty);
            return;
        }

        var grouped = {};
        var order = [];
        actions.forEach(function (action) {
            var groupName = translateGroup(action.group, action.groupKey) || t('group.tools', null, 'Sistema y herramientas');
            if (!grouped[groupName]) { grouped[groupName] = []; order.push(groupName); }
            grouped[groupName].push(action);
        });

        // Una acción del panel: su texto, su botón y su aviso. `compact` es
        // para las que van dentro del subgrupo de una herramienta, donde el
        // nombre ya está en la cabecera y repetirlo en cada línea sobra.
        function buildDepItem(action, compact) {
            var item = document.createElement('div');
            item.className = 'dep-item';

            var row = document.createElement('div');
            row.className = 'dep-item-row';

            var label = document.createElement('span');
            label.className = 'dep-label';
            label.textContent = compact ? (action.shortLabel || action.label) : action.label;

            var btn = document.createElement('button');
            btn.className = 'dep-install-btn';
            btn.textContent = action.verb || t('verb.install', null, 'Instalar');
            btn.addEventListener('click', function () {
                if (!activeTabId) return;
                var tabId = activeTabId;
                var originalText = btn.textContent;
                btn.disabled = true;
                btn.textContent = t('deps.preparing', null, 'Preparando…');
                window.terminalAPI.runInstallAction(tabId, action.id).then(function (result) {
                    if (!result || !result.ok) {
                        btn.disabled = false;
                        btn.textContent = originalText;
                        headerSubtitle.textContent = (result && result.error) || t('deps.actionFailed', null, 'No se pudo preparar la acción.');
                        headerSubtitle.classList.add('error');
                        return;
                    }
                    depsPanel.classList.add('hidden');
                    // Desde un REPL la acción se envía a una shell real: hay
                    // que traer al frente la pestaña donde de verdad corre.
                    if (result.tab) activateReturnedTab(result.tab);
                    if (activeTabId && tabs[activeTabId]) tabs[activeTabId].term.focus();
                }).catch(function (error) {
                    btn.disabled = false;
                    btn.textContent = originalText;
                    headerSubtitle.textContent = error.message;
                    headerSubtitle.classList.add('error');
                });
            });

            row.appendChild(label);
            row.appendChild(btn);
            item.appendChild(row);

            if (action.hint) {
                var hint = document.createElement('div');
                hint.className = 'dep-hint';
                hint.textContent = action.hint;
                item.appendChild(hint);
            }
            return item;
        }

        function appendCount(summary, value) {
            var count = document.createElement('span');
            count.className = 'script-group-count';
            count.textContent = value;
            summary.appendChild(count);
        }

        // Dentro de un apartado manda el estado, no el orden del catálogo: lo
        // que ya está en el sistema va arriba (es donde se busca "ver versión"
        // o "desinstalar") y lo que falta, abajo. A igualdad de estado,
        // alfabético, que es lo único previsible cuando hay veinte entradas.
        // `installed` lo marca el proceso principal al filtrar (ver
        // filterAvailableActions en main.js), sin comprobaciones extra.
        function byStateThenName(a, b) {
            if (a.installed !== b.installed) return a.installed ? -1 : 1;
            return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
        }

        order.forEach(function (groupName, groupIndex) {
            var group = document.createElement('details');
            group.className = 'dep-group';
            configureAccordion(group, depsPanel, groupIndex);
            var heading = document.createElement('summary');
            heading.className = 'dep-group-title';
            heading.appendChild(document.createTextNode(groupName));
            appendCount(heading, grouped[groupName].length);
            group.appendChild(heading);

            // Segundo nivel: las herramientas que traen varias acciones
            // (instalar, actualizar, desinstalar, versión) se pliegan bajo su
            // propio nombre en vez de formar una lista larga y repetitiva.
            // Las sueltas entran en la misma lista de entradas para que el
            // orden salga de comparar todo junto, no de dos listas separadas.
            var subgroups = {};
            var entries = [];
            grouped[groupName].forEach(function (action) {
                if (!action.subgroup) {
                    entries.push({ name: action.label || '', installed: action.installed === true, actions: [action] });
                    return;
                }
                if (!subgroups[action.subgroup]) {
                    subgroups[action.subgroup] = { name: action.subgroup, installed: false, actions: [] };
                    entries.push(subgroups[action.subgroup]);
                }
                subgroups[action.subgroup].actions.push(action);
                // Basta con que UNA acción del subgrupo requiera la
                // herramienta para saber que está presente.
                if (action.installed === true) subgroups[action.subgroup].installed = true;
            });

            entries.sort(byStateThenName);

            entries.forEach(function (entry, entryIndex) {
                // Una herramienta con una sola acción disponible no gana nada
                // con un plegable propio: se muestra directamente.
                if (entry.actions.length === 1) {
                    group.appendChild(buildDepItem(entry.actions[0], false));
                    return;
                }
                var sub = document.createElement('details');
                sub.className = 'dep-subgroup';
                if (entry.installed) sub.classList.add('installed');
                configureAccordion(sub, group, entryIndex);
                var subHeading = document.createElement('summary');
                subHeading.className = 'dep-subgroup-title';
                subHeading.appendChild(document.createTextNode(entry.name));
                appendCount(subHeading, entry.actions.length);
                sub.appendChild(subHeading);
                entry.actions.forEach(function (action) { sub.appendChild(buildDepItem(action, true)); });
                group.appendChild(sub);
            });

            depsPanel.appendChild(group);
        });
    }

    function loadDependenciesPanel() {
        return window.terminalAPI.listInstallActions()
            .then(renderDepsPanel)
            .catch(function (error) {
                renderDepsPanel({ actions: [], components: [], error: t('deps.detectFailed', { error: error.message }, 'No se pudo detectar el entorno: {error}') });
            });
    }

    depsToggleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var willShow = depsPanel.classList.contains('hidden');
        scriptsPanel.classList.add('hidden'); // no dejar los dos paneles abiertos a la vez
        projectsPanel.classList.add('hidden');
        document.getElementById('settings-panel').classList.add('hidden');
        depsPanel.classList.toggle('hidden');
        // La lista se vuelve a pedir CADA vez que se abre el panel, no solo
        // la primera: lo que el usuario haya instalado desde aquí mientras
        // tanto debe dejar de ofrecerse como "Instalar" al volver a mirar.
        if (willShow) {
            loadDependenciesPanel();
        }
    });

    closeOnOutsideClick(depsPanel, depsToggleBtn);

    /* ================= Proyectos / GitHub ================= */
    var projectsToggleBtn = document.getElementById('projects-toggle');
    var projectsPanel = document.getElementById('projects-panel');
    var projectsModePinnedBtn = document.getElementById('projects-mode-pinned');
    var projectsModeExploreBtn = document.getElementById('projects-mode-explore');
    var projectsBrand = document.getElementById('projects-brand');
    var projectsFolder = document.getElementById('projects-folder');
    var projectsChooseFolderBtn = document.getElementById('projects-choose-folder');
    var projectsRefreshBtn = document.getElementById('projects-refresh');
    var projectsSearch = document.getElementById('projects-search');
    var projectsQuery = document.getElementById('projects-query');
    var projectsStatus = document.getElementById('projects-status');
    var projectsProfile = document.getElementById('projects-profile');
    var projectsList = document.getElementById('projects-list');
    var projectsFilterInput = document.getElementById('projects-filter');
    var projectsFilterClearBtn = document.getElementById('projects-filter-clear');
    var projectsMode = 'pinned';
    var lastProjectsState = null;
    // Último resultado de "Explorar GitHub": el filtro de la lupa se aplica
    // sobre él sin repetir la consulta (la API pública tiene un tope de
    // peticiones por hora y volver a pedirla por teclear una letra lo agota).
    var lastExploreResult = null;

    // Normaliza para que el filtro ignore mayúsculas y tildes: buscar "cafe"
    // tiene que encontrar "café", que es lo que espera cualquiera.
    function normalizeForFilter(value) {
        return String(value == null ? '' : value)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '');
    }

    // Todos los términos tienen que aparecer en alguno de los campos, en
    // cualquier orden: "term win" encuentra "WinSlim Terminal".
    function matchesFilter(query, fields) {
        var needles = normalizeForFilter(query).split(/\s+/).filter(Boolean);
        if (!needles.length) return true;
        var haystack = fields.filter(function (field) { return field; }).map(normalizeForFilter).join('   ');
        return needles.every(function (needle) { return haystack.indexOf(needle) !== -1; });
    }

    function projectsFilterQuery() {
        return projectsFilterInput ? projectsFilterInput.value.trim() : '';
    }

    function repositoryMatchesFilter(repo, query) {
        return matchesFilter(query, [repo.fullName, repo.name, repo.owner, repo.description, repo.language]);
    }

    function setProjectsStatus(message, error) {
        projectsStatus.textContent = message || '';
        projectsStatus.classList.toggle('error', !!error);
    }

    function openGithub(target) {
        window.terminalAPI.openGithub(target).then(function (error) {
            if (error) setProjectsStatus(error, true);
        });
    }

    function pinGithub(kind, value, pinned, onDone) {
        window.terminalAPI.pinGithub(kind, value, pinned).then(function (result) {
            if (!result || !result.ok) {
                setProjectsStatus((result && result.error) || t('projects.pinFailed', null, 'No se pudo actualizar el anclado.'), true);
                return;
            }
            lastProjectsState = result.state;
            if (onDone) onDone();
            if (projectsMode === 'pinned') renderPinnedProjects(result.state);
        });
    }

    function projectAction(repo) {
        if (!activeTabId) return;
        setProjectsStatus(repo.local ? t('projects.preparingUpdate', { repo: repo.fullName }, 'Preparando actualización de {repo}…') : t('projects.preparingClone', { repo: repo.fullName }, 'Preparando clonación de {repo}…'), false);
        window.terminalAPI.runGithubProject(activeTabId, repo.fullName).then(function (result) {
            if (!result || !result.ok) {
                setProjectsStatus((result && result.error) || t('projects.gitFailed', null, 'No se pudo preparar Git.'), true);
                if (result && result.suggestion) {
                    depsPanel.classList.remove('hidden');
                    window.terminalAPI.listInstallActions().then(renderDepsPanel);
                }
                return;
            }
            activateReturnedTab(result.tab);
            projectsPanel.classList.add('hidden');
        });
    }

    /* Actualizar un repositorio DESDE SU RELEASE, no desde el código fuente.
     *
     * Quien solo quiere usar la herramienta no necesita clonar ni compilar: le
     * basta el archivo que el autor publicó en la última release. Esto elige
     * ese archivo por él, en vez de obligarle a abrir la lista y reconocer cuál
     * de los adjuntos es el de su sistema.
     *
     * La elección es por puntos y no por una regla rígida, porque los nombres
     * de los adjuntos los pone cada proyecto a su manera
     * (WinSlimTerminal-Latest.zip, LTerminal-AppImage-Latest-x64.x86.tar.gz...).
     * Si nada encaja no se descarga nada a ciegas: se dice que hay que elegir a
     * mano en «Release».
     */
    function pickPlatformAsset(assets, platform) {
        var candidates = (assets || []).filter(function (asset) { return asset && asset.name; });
        if (!candidates.length) return null;

        // Nombres de OTROS sistemas: descartan el adjunto por completo, para no
        // ofrecer un AppImage en Windows por tener mejor puntuación.
        var foreign = {
            win32: /(?:appimage|\.deb$|\.rpm$|\.dmg$|linux|darwin|macos|\bmac\b)/i,
            linux: /(?:\.exe$|\.msi$|\.dmg$|win32|windows|\bwin\b|darwin|macos|\bmac\b)/i,
            darwin: /(?:\.exe$|\.msi$|appimage|\.deb$|\.rpm$|win32|windows|\bwin\b|linux)/i
        }[platform];
        var preferred = {
            win32: [/\.zip$/i, /(?:windows|win32|\bwin\b|winslim)/i],
            linux: [/\.appimage$/i, /appimage/i, /\.tar\.gz$/i, /linux/i],
            darwin: [/\.dmg$/i, /(?:darwin|macos|\bmac\b)/i, /\.zip$/i]
        }[platform];
        if (!preferred) return null;

        var best = null;
        candidates.forEach(function (asset) {
            if (foreign && foreign.test(asset.name)) return;
            var score = 0;
            preferred.forEach(function (pattern, index) {
                if (pattern.test(asset.name)) score += preferred.length - index;
            });
            if (score === 0) return;
            // A igualdad de puntos gana el más grande: es el binario, no un
            // .sha256 ni unas notas sueltas.
            if (!best || score > best.score || (score === best.score && asset.size > best.asset.size)) {
                best = { asset: asset, score: score };
            }
        });
        return best ? best.asset : null;
    }

    function updateFromLatestRelease(repo, button) {
        if (!activeTabId) return;
        var previous = button.textContent;
        button.disabled = true;
        button.textContent = t('projects.releaseLoading', null, 'Consultando la última release…');
        var restore = function () {
            button.disabled = false;
            button.textContent = previous;
        };

        window.terminalAPI.getLatestRelease(repo.fullName).then(function (result) {
            if (!result || !result.ok) {
                restore();
                setProjectsStatus((result && result.error) || t('projects.releaseFailed', null, 'No se pudo consultar la release.'), true);
                return;
            }
            if (!result.release) {
                restore();
                setProjectsStatus(t('projects.noRelease', null, 'Este repositorio no tiene ninguna release publicada.'), true);
                return;
            }
            var asset = pickPlatformAsset(result.release.assets, appIdentity.platform);
            if (!asset) {
                restore();
                setProjectsStatus(t('projects.noPlatformAsset', null,
                    'La última release no adjunta un archivo para este sistema. Ábrela con «Release» y elige uno.'), true);
                return;
            }

            button.textContent = t('projects.downloading', null, 'Descargando…');
            setProjectsStatus(t('projects.updatingFromRelease',
                { asset: asset.name, tag: result.release.tag },
                'Actualizando desde la release {tag}: {asset}'), false);

            return window.terminalAPI.downloadRelease(activeTabId, repo.fullName, asset.name).then(function (download) {
                restore();
                if (!download || !download.ok) {
                    setProjectsStatus((download && download.error) || t('projects.downloadFailed', null, 'No se pudo descargar el archivo.'), true);
                    return;
                }
                if (download.tab) activateReturnedTab(download.tab);
                setProjectsStatus(download.extracted
                    ? t('projects.downloadedExtracting', { path: download.path },
                        'Descargado en {path}. El comando para extraerlo está en la terminal.')
                    : t('projects.downloaded', { path: download.path }, 'Descargado en {path}.'), false);
            });
        }).catch(function (error) {
            restore();
            setProjectsStatus(error.message, true);
        });
    }

    function buildRepositoryCard(repo, pinnedView) {
        var card = document.createElement('div');
        card.className = 'github-repo-card';

        var info = document.createElement('div');
        info.className = 'github-repo-info';
        var name = document.createElement('div');
        name.className = 'github-repo-name';
        name.textContent = repo.fullName;
        if (repo.local) {
            var local = document.createElement('span');
            local.className = 'github-local-badge';
            local.textContent = t('projects.local', null, 'local');
            name.appendChild(local);
        } else if (repo.localConflict) {
            var conflict = document.createElement('span');
            conflict.className = 'github-official-badge';
            conflict.textContent = t('projects.folderBusy', null, 'carpeta ocupada');
            name.appendChild(conflict);
        }
        if (repo.official) {
            var official = document.createElement('span');
            official.className = 'github-official-badge';
            official.textContent = t('projects.official', null, 'Proyecto');
            name.appendChild(official);
        }
        var meta = document.createElement('div');
        meta.className = 'github-repo-meta';
        var metaParts = [];
        if (repo.language) metaParts.push(repo.language);
        if (repo.stars) metaParts.push('★ ' + repo.stars);
        if (repo.forks) metaParts.push('⑂ ' + repo.forks);
        if (repo.archived) metaParts.push(t('projects.archived', null, 'Archivado'));
        meta.textContent = metaParts.join(' · ') || (repo.local ? repo.localPath : t('projects.publicRepo', null, 'Repositorio público'));
        info.appendChild(name);
        info.appendChild(meta);
        if (repo.description) {
            var description = document.createElement('div');
            description.className = 'github-repo-description';
            description.textContent = repo.description;
            info.appendChild(description);
        }

        var actions = document.createElement('div');
        actions.className = 'github-repo-actions';
        var openBtn = document.createElement('button');
        openBtn.className = 'modal-btn';
        openBtn.textContent = 'GitHub';
        openBtn.addEventListener('click', function () { openGithub(repo.htmlUrl || repo.fullName); });
        actions.appendChild(openBtn);

        if (!repo.official) {
            var pinBtn = document.createElement('button');
            pinBtn.className = 'modal-btn';
            var isPinned = pinnedView || repo.pinned === true;
            pinBtn.textContent = isPinned ? t('projects.unpin', null, 'Desanclar') : t('projects.pin', null, 'Anclar');
            pinBtn.addEventListener('click', function () {
                pinGithub('repo', repo.fullName, !isPinned, function () {
                    repo.pinned = !isPinned;
                    pinBtn.textContent = repo.pinned ? t('projects.unpin', null, 'Desanclar') : t('projects.pin', null, 'Anclar');
                });
            });
            actions.appendChild(pinBtn);
        }

        // Descargar la release es la vía corta para quien solo quiere usar la
        // herramienta: ni clonar ni compilar. La lista de archivos se pide al
        // pulsar, no al pintar la tarjeta: son cien consultas más a la API
        // pública para algo que casi nunca se mira.
        var releaseBox = document.createElement('div');
        releaseBox.className = 'github-release hidden';

        var releaseBtn = document.createElement('button');
        releaseBtn.className = 'modal-btn';
        releaseBtn.textContent = t('projects.release', null, 'Release');
        releaseBtn.title = t('projects.releaseTitle', null, 'Ver la última versión publicada y sus archivos');
        releaseBtn.addEventListener('click', function () {
            if (!releaseBox.classList.contains('hidden')) {
                releaseBox.classList.add('hidden');
                return;
            }
            releaseBtn.disabled = true;
            releaseBox.textContent = t('projects.releaseLoading', null, 'Consultando la última release…');
            releaseBox.classList.remove('hidden');
            window.terminalAPI.getLatestRelease(repo.fullName).then(function (result) {
                releaseBtn.disabled = false;
                renderRelease(releaseBox, repo, result);
            }).catch(function (error) {
                releaseBtn.disabled = false;
                releaseBox.textContent = error.message;
            });
        });
        actions.appendChild(releaseBtn);

        // Actualizar desde la release publicada: es lo que quiere quien usa la
        // herramienta, frente a clonar/actualizar el código fuente, que es lo
        // que quiere quien la desarrolla. Los dos caminos conviven y cada botón
        // dice en su título exactamente qué va a hacer.
        var releaseUpdateBtn = document.createElement('button');
        releaseUpdateBtn.className = 'dep-install-btn';
        releaseUpdateBtn.textContent = t('projects.updateRelease', null, 'Actualizar release');
        releaseUpdateBtn.title = t('projects.updateReleaseTitle', null,
            'Descarga el archivo de la última release que corresponde a este sistema y lo extrae. No usa el código fuente.');
        releaseUpdateBtn.addEventListener('click', function () { updateFromLatestRelease(repo, releaseUpdateBtn); });
        actions.appendChild(releaseUpdateBtn);

        var runBtn = document.createElement('button');
        runBtn.className = 'modal-btn';
        runBtn.textContent = repo.local
            ? t('projects.updateSource', null, 'Actualizar fuente')
            : t('projects.clone', null, 'Clonar');
        runBtn.title = repo.local ? 'git pull --ff-only' : 'git clone';
        runBtn.disabled = (repo.archived === true && !repo.local) || repo.localConflict === true;
        runBtn.addEventListener('click', function () { projectAction(repo); });
        actions.appendChild(runBtn);

        card.appendChild(info);
        card.appendChild(actions);
        card.appendChild(releaseBox);
        return card;
    }

    // Contenido del desplegable de release: la versión publicada y un botón
    // por archivo. Los comprimidos avisan de que además se van a extraer, para
    // que nadie se encuentre con un comando en la terminal sin esperarlo.
    function renderRelease(box, repo, result) {
        box.innerHTML = '';
        if (!result || !result.ok) {
            box.textContent = (result && result.error) || t('projects.releaseFailed', null, 'No se pudo consultar la release.');
            return;
        }
        if (!result.release) {
            box.textContent = t('projects.noRelease', null, 'Este repositorio no tiene ninguna release publicada.');
            return;
        }

        var release = result.release;
        var title = document.createElement('div');
        title.className = 'github-release-title';
        title.textContent = release.name || release.tag;
        if (release.prerelease) title.textContent += ' · ' + t('projects.prerelease', null, 'versión previa');
        box.appendChild(title);

        if (!release.assets.length) {
            var vacio = document.createElement('div');
            vacio.className = 'dep-hint';
            vacio.textContent = t('projects.noAssets', null,
                'La release no adjunta archivos: solo está el código fuente, que se obtiene clonando.');
            box.appendChild(vacio);
            return;
        }

        release.assets.forEach(function (asset) {
            var row = document.createElement('div');
            row.className = 'github-release-asset';

            var name = document.createElement('span');
            name.className = 'github-release-asset-name';
            name.textContent = asset.name;
            name.title = asset.name;
            row.appendChild(name);

            var size = document.createElement('span');
            size.className = 'explorer-entry-size';
            size.textContent = formatSize(asset.size);
            row.appendChild(size);

            var btn = document.createElement('button');
            btn.className = 'dep-install-btn';
            btn.textContent = asset.archive
                ? t('projects.downloadExtract', null, 'Descargar y extraer')
                : t('projects.download', null, 'Descargar');
            btn.addEventListener('click', function () {
                if (!activeTabId) return;
                btn.disabled = true;
                var previo = btn.textContent;
                btn.textContent = t('projects.downloading', null, 'Descargando…');
                window.terminalAPI.downloadRelease(activeTabId, repo.fullName, asset.name).then(function (bajada) {
                    btn.disabled = false;
                    btn.textContent = previo;
                    if (!bajada || !bajada.ok) {
                        setProjectsStatus((bajada && bajada.error) || t('projects.downloadFailed', null, 'No se pudo descargar el archivo.'), true);
                        return;
                    }
                    if (bajada.tab) activateReturnedTab(bajada.tab);
                    setProjectsStatus(bajada.extracted
                        ? t('projects.downloadedExtracting', { path: bajada.path },
                            'Descargado en {path}. El comando para extraerlo está en la terminal.')
                        : t('projects.downloaded', { path: bajada.path }, 'Descargado en {path}.'), false);
                }).catch(function (error) {
                    btn.disabled = false;
                    btn.textContent = previo;
                    setProjectsStatus(error.message, true);
                });
            });
            row.appendChild(btn);
            box.appendChild(row);
        });
    }

    function renderOwnerRow(owner) {
        var row = document.createElement('div');
        row.className = 'github-owner-row';
        var info = document.createElement('div');
        info.className = 'github-repo-info';
        var name = document.createElement('div');
        name.className = 'github-repo-name';
        name.textContent = '@' + owner.login;
        if (owner.developer) {
            var developer = document.createElement('span');
            developer.className = 'github-developer-badge';
            developer.textContent = t('projects.developer', null, 'Desarrollador');
            name.appendChild(developer);
        }
        // El perfil oficial del catálogo es, además, el dueño del proyecto.
        if (owner.official) {
            var brand = document.createElement('span');
            brand.className = 'github-developer-badge github-brand-badge';
            brand.textContent = 'WinSlim';
            name.appendChild(brand);
        }
        info.appendChild(name);

        var actions = document.createElement('div');
        actions.className = 'github-repo-actions';
        var viewBtn = document.createElement('button');
        viewBtn.className = 'dep-install-btn';
        viewBtn.textContent = t('projects.viewRepos', null, 'Ver repos');
        viewBtn.addEventListener('click', function () {
            setProjectsMode('explore');
            projectsQuery.value = owner.login;
            lookupProjects(owner.login);
        });
        actions.appendChild(viewBtn);
        if (!owner.locked) {
            var unpinBtn = document.createElement('button');
            unpinBtn.className = 'modal-btn';
            unpinBtn.textContent = t('projects.unpin', null, 'Desanclar');
            unpinBtn.addEventListener('click', function () { pinGithub('owner', owner.login, false); });
            actions.appendChild(unpinBtn);
        }
        row.appendChild(info);
        row.appendChild(actions);
        return row;
    }

    function renderPinnedProjects(state) {
        lastProjectsState = state || lastProjectsState || {};
        state = lastProjectsState;
        projectsBrand.textContent = state.brand || t('toolbar.projects', null, 'Proyectos');
        projectsFolder.textContent = state.projectsFolder || '';
        projectsFolder.title = state.projectsFolder || '';
        projectsProfile.innerHTML = '';
        projectsList.innerHTML = '';

        var query = projectsFilterQuery();
        var allOwners = state.owners || [];
        var allRepositories = state.repositories || [];
        var owners = allOwners.filter(function (owner) { return matchesFilter(query, [owner.login]); });
        var repositories = allRepositories.filter(function (repo) { return repositoryMatchesFilter(repo, query); });

        owners.forEach(function (owner) { projectsList.appendChild(renderOwnerRow(owner)); });
        repositories.forEach(function (repo) { projectsList.appendChild(buildRepositoryCard(repo, true)); });

        var total = allOwners.length + allRepositories.length;
        var shown = owners.length + repositories.length;
        if (!shown) {
            var empty = document.createElement('div');
            empty.className = 'script-empty';
            empty.textContent = total
                ? t('projects.noFilterMatch', { query: query }, 'Ningún anclado coincide con «{query}».')
                : t('projects.noPins', null, 'Todavía no hay perfiles ni repositorios anclados. Añádelos desde Explorar GitHub.');
            projectsList.appendChild(empty);
        }
        setProjectsStatus(query && total
            ? t('projects.filterCount', { shown: shown, total: total }, '{shown} de {total} anclados')
            : t('projects.pinsNote', null, 'Los desarrolladores del catálogo son fijos; los demás anclados se guardan en settings.json.'), false);
    }

    function renderGithubProfile(profile) {
        projectsProfile.innerHTML = '';
        if (!profile) return;
        var card = document.createElement('div');
        card.className = 'github-profile';
        var avatar = document.createElement('div');
        avatar.className = 'github-avatar-fallback';
        avatar.textContent = profile.login.slice(0, 2).toUpperCase();
        var info = document.createElement('div');
        info.className = 'github-profile-info';
        var name = document.createElement('div');
        name.className = 'github-profile-name';
        name.textContent = profile.name ? profile.name + ' · @' + profile.login : '@' + profile.login;
        if (profile.developer) {
            var developerBadge = document.createElement('span');
            developerBadge.className = 'github-developer-badge';
            developerBadge.textContent = t('projects.developer', null, 'Desarrollador');
            name.appendChild(developerBadge);
        }
        var meta = document.createElement('div');
        meta.className = 'github-profile-meta';
        meta.textContent = profile.type + ' · ' + t('projects.profileMeta', { repos: profile.publicRepos, followers: profile.followers }, '{repos} repos públicos · {followers} seguidores');
        info.appendChild(name);
        info.appendChild(meta);
        if (profile.bio) {
            var bio = document.createElement('div');
            bio.className = 'github-profile-bio';
            bio.textContent = profile.bio;
            info.appendChild(bio);
        }
        var actions = document.createElement('div');
        actions.className = 'github-repo-actions';
        var pinBtn = document.createElement('button');
        pinBtn.className = 'modal-btn';
        pinBtn.textContent = profile.pinned ? t('projects.unpin', null, 'Desanclar') : t('projects.pinProfile', null, 'Anclar perfil');
        pinBtn.addEventListener('click', function () {
            pinGithub('owner', profile.login, !profile.pinned, function () {
                profile.pinned = !profile.pinned;
                pinBtn.textContent = profile.pinned ? t('projects.unpin', null, 'Desanclar') : t('projects.pinProfile', null, 'Anclar perfil');
            });
        });
        var openBtn = document.createElement('button');
        openBtn.className = 'modal-btn';
        openBtn.textContent = 'GitHub';
        openBtn.addEventListener('click', function () { openGithub(profile.htmlUrl); });
        if (!profile.locked) actions.appendChild(pinBtn);
        actions.appendChild(openBtn);
        card.appendChild(avatar);
        card.appendChild(info);
        card.appendChild(actions);
        projectsProfile.appendChild(card);
    }

    // Repinta el resultado de la última consulta aplicando el filtro local.
    function renderExploreResult() {
        var result = lastExploreResult;
        if (!result) return;
        var query = projectsFilterQuery();
        var all = result.repositories || [];
        var repositories = all.filter(function (repo) { return repositoryMatchesFilter(repo, query); });

        renderGithubProfile(result.profile);
        projectsList.innerHTML = '';
        repositories.forEach(function (repo) { projectsList.appendChild(buildRepositoryCard(repo, false)); });
        if (!repositories.length) {
            var empty = document.createElement('div');
            empty.className = 'script-empty';
            empty.textContent = all.length
                ? t('projects.noFilterMatch', { query: query }, 'Ningún anclado coincide con «{query}».')
                : t('projects.noPublicRepos', null, 'Este perfil no tiene repositorios públicos.');
            projectsList.appendChild(empty);
        }

        var remaining = result.rateLimit && result.rateLimit.remaining;
        var count = query
            ? t('projects.filterCount', { shown: repositories.length, total: all.length }, '{shown} de {total} anclados')
            : t(all.length === 1 ? 'projects.repoCount' : 'projects.repoCountPlural',
                { count: all.length }, all.length === 1 ? '{count} repositorio' : '{count} repositorios');
        var rate = remaining !== null && remaining !== undefined
            ? ' · ' + t('projects.rateRemaining', { count: remaining }, 'consultas públicas restantes: {count}')
            : '';
        setProjectsStatus(count + rate, false);
    }

    function lookupProjects(target) {
        var query = String(target || projectsQuery.value || '').trim();
        if (!query) return;
        setProjectsStatus(t('projects.querying', null, 'Consultando la API pública de GitHub…'), false);
        projectsProfile.innerHTML = '';
        projectsList.innerHTML = '';
        lastExploreResult = null;
        window.terminalAPI.lookupGithub(query).then(function (result) {
            if (!result || !result.ok) {
                setProjectsStatus((result && result.error) || t('projects.queryFailed', null, 'No se pudo consultar GitHub.'), true);
                return;
            }
            lastExploreResult = result;
            renderExploreResult();
        });
    }

    function setProjectsMode(mode) {
        projectsMode = mode === 'explore' ? 'explore' : 'pinned';
        projectsModePinnedBtn.classList.toggle('active', projectsMode === 'pinned');
        projectsModeExploreBtn.classList.toggle('active', projectsMode === 'explore');
        projectsSearch.classList.toggle('hidden', projectsMode !== 'explore');
        if (projectsMode === 'pinned') {
            window.terminalAPI.getProjectsState().then(renderPinnedProjects);
        } else if (lastExploreResult) {
            renderExploreResult();
        } else {
            projectsProfile.innerHTML = '';
            projectsList.innerHTML = '';
            setProjectsStatus(t('projects.searchHint', null, 'Busca un perfil para ver sus repositorios, o pega la URL de un repositorio concreto.'), false);
            setTimeout(function () { projectsQuery.focus(); }, 0);
        }
    }

    // Repinta con el filtro actual sin volver a pedir nada al proceso
    // principal ni a GitHub.
    function refreshProjectsFilterView() {
        if (projectsFilterClearBtn) projectsFilterClearBtn.classList.toggle('hidden', !projectsFilterQuery());
        if (projectsMode === 'pinned') renderPinnedProjects(null);
        else renderExploreResult();
    }

    if (projectsFilterInput) {
        projectsFilterInput.addEventListener('input', refreshProjectsFilterView);
        projectsFilterInput.addEventListener('keydown', function (e) {
            // Escape vacía el filtro en vez de cerrar el panel: cerrarlo
            // obligaría a reabrirlo y a repetir la búsqueda.
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (!projectsFilterInput.value) return;
            projectsFilterInput.value = '';
            refreshProjectsFilterView();
        });
    }
    if (projectsFilterClearBtn) {
        projectsFilterClearBtn.addEventListener('click', function () {
            projectsFilterInput.value = '';
            refreshProjectsFilterView();
            projectsFilterInput.focus();
        });
    }

    projectsToggleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var willShow = projectsPanel.classList.contains('hidden');
        depsPanel.classList.add('hidden');
        if (typeof scriptsPanel !== 'undefined' && scriptsPanel) scriptsPanel.classList.add('hidden');
        document.getElementById('settings-panel').classList.add('hidden');
        projectsPanel.classList.toggle('hidden');
        if (willShow) setProjectsMode(projectsMode);
    });
    projectsModePinnedBtn.addEventListener('click', function () { setProjectsMode('pinned'); });
    projectsModeExploreBtn.addEventListener('click', function () { setProjectsMode('explore'); });
    projectsSearch.addEventListener('submit', function (e) { e.preventDefault(); lookupProjects(); });
    projectsChooseFolderBtn.addEventListener('click', function () {
        window.terminalAPI.chooseProjectsFolder().then(function (state) {
            if (state) renderPinnedProjects(state);
        });
    });
    projectsRefreshBtn.addEventListener('click', function () {
        if (projectsMode === 'pinned') window.terminalAPI.getProjectsState().then(renderPinnedProjects);
        else if (projectsQuery.value.trim()) lookupProjects();
    });
    closeOnOutsideClick(projectsPanel, projectsToggleBtn);

    /* ========= Lanzador rápido de scripts ========= */
    var scriptsToggleBtn = document.getElementById('scripts-toggle');
    var scriptsPanel = document.getElementById('scripts-panel');
    var scriptsFolderPath = document.getElementById('scripts-folder-path');
    var scriptsModeLibraryBtn = document.getElementById('scripts-mode-library');
    var scriptsModeHereBtn = document.getElementById('scripts-mode-here');
    var scriptsChooseFolderBtn = document.getElementById('scripts-choose-folder');
    var scriptsRefreshBtn = document.getElementById('scripts-refresh');
    var scriptsList = document.getElementById('scripts-list');
    var scriptsStatus = document.getElementById('scripts-status');
    var scriptsTypeOptions = document.getElementById('scripts-type-options');
    var scriptsFilterCount = document.getElementById('scripts-filter-count');
    var scriptsFilterDefaultsBtn = document.getElementById('scripts-filter-defaults');
    var scriptsFilterAllBtn = document.getElementById('scripts-filter-all');
    var scriptsFilterNoneBtn = document.getElementById('scripts-filter-none');
    var scriptsDepthControl = document.getElementById('scripts-depth-control');
    var scriptsDepthSelect = document.getElementById('scripts-depth');
    var scriptsFilterInput = document.getElementById('scripts-filter');
    var scriptsFilterClearBtn = document.getElementById('scripts-filter-clear');
    var scriptsMode = 'library';
    var scriptsRequestSequence = 0;

    var lastScriptsData = null;
    var knownFileFilters = [];

    function selectedFileCategories() {
        if (!scriptsTypeOptions) return [];
        return Array.prototype.slice.call(scriptsTypeOptions.querySelectorAll('input[type="checkbox"]:checked'))
            .map(function (input) { return input.value; });
    }

    function updateFileFilterCount() {
        if (!scriptsFilterCount) return;
        scriptsFilterCount.textContent = selectedFileCategories().length + '/' + knownFileFilters.length;
    }

    function renderFileFilters(filters) {
        if (!scriptsTypeOptions || !Array.isArray(filters) || !filters.length) return;
        if (knownFileFilters.length) return;
        knownFileFilters = filters.slice();
        filters.forEach(function (filter) {
            var label = document.createElement('label');
            label.className = 'scripts-type-option';
            label.title = filter.label;
            var input = document.createElement('input');
            input.type = 'checkbox';
            input.value = filter.id;
            input.checked = filter.default === true;
            input.addEventListener('change', function () {
                updateFileFilterCount();
                loadScriptsForCurrentMode();
            });
            var text = document.createElement('span');
            text.textContent = filter.label;
            label.appendChild(input);
            label.appendChild(text);
            scriptsTypeOptions.appendChild(label);
        });
        updateFileFilterCount();
    }

    function setFileFilterSelection(mode) {
        if (!scriptsTypeOptions) return;
        Array.prototype.forEach.call(scriptsTypeOptions.querySelectorAll('input[type="checkbox"]'), function (input) {
            var filter = knownFileFilters.find(function (item) { return item.id === input.value; });
            input.checked = mode === 'all' || (mode === 'defaults' && filter && filter.default === true);
        });
        updateFileFilterCount();
        loadScriptsForCurrentMode();
    }

    function loadScriptsForCurrentMode() {
        var categories = selectedFileCategories();
        var categoryPayload = categories.length || knownFileFilters.length ? categories : undefined;
        var sequence = ++scriptsRequestSequence;
        var request = scriptsMode === 'here'
            ? (activeTabId ? window.terminalAPI.listScriptsHere(activeTabId, categoryPayload, scriptsHereDepth) : Promise.resolve({ mode: 'here', scripts: [], error: 'No hay una pestaña activa.' }))
            : window.terminalAPI.listScripts(categoryPayload);
        return request.then(function (data) {
            // Una búsqueda profunda puede tardar más que un cambio posterior
            // de filtro/modo. No se permite que su respuesta antigua pise la
            // vista más reciente.
            if (sequence === scriptsRequestSequence) renderScripts(data);
            return data;
        }).catch(function (error) {
            if (sequence === scriptsRequestSequence) renderScripts({
                mode: scriptsMode,
                scripts: [],
                error: 'No se pudo completar la búsqueda: ' + error.message
            });
        });
    }

    function setScriptsMode(mode) {
        scriptsMode = mode === 'here' ? 'here' : 'library';
        scriptsModeLibraryBtn.classList.toggle('active', scriptsMode === 'library');
        scriptsModeHereBtn.classList.toggle('active', scriptsMode === 'here');
        if (scriptsDepthControl) scriptsDepthControl.classList.toggle('hidden', scriptsMode !== 'here');
        lastScriptsData = null;
        loadScriptsForCurrentMode();
    }

    // Grupo al que pertenece un script: su origen y, dentro de la carpeta de
    // scripts del usuario, la subcarpeta donde está. Es lo que convierte una
    // lista plana enorme en secciones plegables manejables.
    function groupNameFor(script) {
        var origen = script.source || 'scripts';
        if (script.relDir) return origen + ' / ' + script.relDir;
        return origen;
    }

    function buildScriptItem(script) {
        var item = document.createElement('div');
        item.className = 'script-item';

        var row = document.createElement('div');
        row.className = 'script-item-row';

        var nameWrap = document.createElement('span');
        nameWrap.className = 'script-name';
        var badge = document.createElement('span');
        badge.className = 'script-type-badge';
        badge.textContent = script.interpreter || (script.ext ? script.ext.replace('.', '') : script.category || 'archivo');
        nameWrap.appendChild(badge);
        nameWrap.appendChild(document.createTextNode(script.name));

        var actions = document.createElement('div');
        actions.className = 'script-actions';

        // Fila de argumentos, oculta hasta que se pide: la mayoría de scripts
        // no necesitan ninguno, pero los que actúan sobre un archivo o una
        // carpeta no hacen nada sin él.
        var argsRow = document.createElement('div');
        argsRow.className = 'script-args hidden';

        var argsInput = document.createElement('input');
        argsInput.type = 'text';
        argsInput.className = 'script-args-input';
        argsInput.placeholder = t('scripts.argsPlaceholder', null, 'Argumentos (ej. "C:\\ruta\\archivo.txt")');

        var pickFileBtn = document.createElement('button');
        pickFileBtn.className = 'modal-btn';
        pickFileBtn.textContent = t('scripts.pickFile', null, 'Archivo…');
        pickFileBtn.title = t('scripts.pickFileTitle', null, 'Elegir un archivo y usarlo como argumento');

        var pickDirBtn = document.createElement('button');
        pickDirBtn.className = 'modal-btn';
        pickDirBtn.textContent = t('scripts.pickFolder', null, 'Carpeta…');
        pickDirBtn.title = t('scripts.pickFolderTitle', null, 'Elegir una carpeta y usarla como argumento');

        function pick(mode) {
            window.terminalAPI.pickScriptTarget(mode).then(function (chosen) {
                if (!chosen) return;
                argsInput.value = '"' + chosen + '"';
                argsInput.focus();
            });
        }
        pickFileBtn.addEventListener('click', function () { pick('file'); });
        pickDirBtn.addEventListener('click', function () { pick('directory'); });

        argsRow.appendChild(argsInput);
        argsRow.appendChild(pickFileBtn);
        argsRow.appendChild(pickDirBtn);

        var argsToggle = document.createElement('button');
        argsToggle.className = 'modal-btn script-args-toggle';
        argsToggle.textContent = '⋯';
        argsToggle.title = t('scripts.argsTitle', null, 'Añadir argumentos (archivo o carpeta sobre la que actuar)');
        argsToggle.addEventListener('click', function () {
            argsRow.classList.toggle('hidden');
            if (!argsRow.classList.contains('hidden')) argsInput.focus();
        });

        function run(asAdmin) {
            if (!activeTabId) return;
            window.terminalAPI.runScript(activeTabId, script.path, asAdmin, argsInput.value).then(function (result) {
                if (!result || !result.ok) {
                    scriptsStatus.textContent = (result && result.error) || 'No se pudo preparar la ejecución.';
                    scriptsStatus.classList.add('error');
                    if (result && result.missingShell) {
                        scriptsPanel.classList.add('hidden');
                        depsPanel.classList.remove('hidden');
                        window.terminalAPI.listInstallActions().then(renderDepsPanel);
                    }
                    return;
                }
                activateReturnedTab(result.tab);
                scriptsPanel.classList.add('hidden');
                tabs[activeTabId].term.focus();
            });
        }

        function cdToDirectory() {
            if (!activeTabId) return;
            window.terminalAPI.cdToItem(activeTabId, script.path);
            scriptsPanel.classList.add('hidden');
            tabs[activeTabId].term.focus();
        }

        var adminBtn = document.createElement('button');
        adminBtn.className = 'modal-btn';
        adminBtn.textContent = 'Admin';
        adminBtn.title = t('scripts.adminTitle', null, 'Ejecutar con permisos elevados (UAC / sudo)');
        adminBtn.addEventListener('click', function () { run(true); });

        var runBtn = document.createElement('button');
        runBtn.className = 'dep-install-btn';
        runBtn.textContent = t('scripts.run', null, 'Ejecutar');
        runBtn.title = t('scripts.runTitle', null, 'Escribe el comando en la pestaña activa');
        runBtn.addEventListener('click', function () { run(false); });

        // Enter en el campo de argumentos = Ejecutar, que es lo que se espera
        // después de escribir o elegir una ruta.
        argsInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') run(false);
        });

        var cdBtn = document.createElement('button');
        cdBtn.className = 'modal-btn';
        cdBtn.textContent = 'cd';
        cdBtn.title = t('scripts.cdTitle', null, 'Cambiar la terminal a la carpeta que contiene este archivo');
        cdBtn.addEventListener('click', cdToDirectory);
        actions.appendChild(cdBtn);

        if (script.openable) {
            var openBtn = document.createElement('button');
            openBtn.className = 'dep-install-btn';
            openBtn.textContent = t('explorer.open', null, 'Abrir');
            openBtn.title = script.instruction || 'Abrir con la aplicación predeterminada';
            openBtn.addEventListener('click', function () {
                window.terminalAPI.openItem(script.path).then(function (result) {
                    if (result && result.ok) {
                        scriptsPanel.classList.add('hidden');
                        return;
                    }
                    // Sin aplicación asociada se propone instalar un visor; el
                    // aviso se ve mejor con el panel cerrado.
                    if (result && result.suggestion) scriptsPanel.classList.add('hidden');
                    handleOpenResult(result, function (message) {
                        if (!scriptsStatus) return;
                        scriptsStatus.textContent = message;
                        scriptsStatus.classList.add('error');
                    });
                });
            });
            actions.appendChild(openBtn);
        }

        if (script.runnable) {
            actions.appendChild(argsToggle);
            actions.appendChild(adminBtn);
            actions.appendChild(runBtn);
        }
        row.appendChild(nameWrap);
        row.appendChild(actions);
        item.appendChild(row);
        if (script.runnable) item.appendChild(argsRow);

        if (script.instruction) {
            var instruction = document.createElement('div');
            instruction.className = 'script-instruction';
            instruction.textContent = script.instruction;
            item.appendChild(instruction);
        }

        if (script.hint) {
            var hint = document.createElement('div');
            hint.className = 'dep-hint';
            hint.textContent = script.hint;
            item.appendChild(hint);
        }

        return item;
    }

    function renderScripts(data) {
        if (data) lastScriptsData = data;
        data = lastScriptsData || {};
        renderFileFilters(data.filters);

        var dir = data.dir || '';
        var allScripts = (data.scripts || []).slice();
        // El filtro es local sobre el último escaneo: no vuelve a recorrer el
        // disco, que en "Aquí" puede costar segundos.
        var filterQuery = scriptsFilterInput ? scriptsFilterInput.value.trim() : '';
        if (scriptsFilterClearBtn) scriptsFilterClearBtn.classList.toggle('hidden', !filterQuery);
        var scripts = allScripts.filter(function (script) {
            return matchesFilter(filterQuery, [script.name, script.relDir, script.source, script.ext, script.type]);
        });
        if (data.mode === 'here' && Number.isInteger(data.depth)) {
            scriptsHereDepth = data.depth;
            if (scriptsDepthSelect) scriptsDepthSelect.value = String(data.depth);
        }
        if (scriptsDepthControl) scriptsDepthControl.classList.toggle('hidden', data.mode !== 'here');

        scriptsFolderPath.textContent = dir;
        scriptsFolderPath.title = dir;
        if (scriptsStatus) {
            // Con filtro activo manda el recuento: es la información que el
            // usuario acaba de pedir, y la nota de ámbito sigue estando a un
            // borrado de distancia.
            var scopeNote = data.mode === 'here'
                ? (data.limited
                    ? t('scripts.hereLimited', null, 'Se alcanzó el límite de resultados. Se omiten dependencias/artefactos; acota la carpeta o los tipos seleccionados.')
                    : t('scripts.hereNote', { depth: Number.isInteger(data.depth) ? data.depth : 3 },
                        'Hasta {depth} niveles y solo los tipos marcados. Dependencias/artefactos y código sin intención ejecutable se omiten. Aquí no crea alias.'))
                : t('scripts.libraryNote', null, 'Biblioteca persistente. Solo los scripts ejecutables se registran como alias; multimedia y HTML nunca crean alias.');
            scriptsStatus.textContent = data.error
                || (filterQuery && allScripts.length
                    ? t('scripts.filterCount', { shown: scripts.length, total: allScripts.length }, '{shown} de {total} archivos')
                    : scopeNote);
            scriptsStatus.classList.toggle('error', !!data.error);
            scriptsStatus.classList.remove('hidden');
        }

        scriptsList.innerHTML = '';
        if (scripts.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'script-empty';
            if (filterQuery && allScripts.length) {
                empty.textContent = t('scripts.noFilterMatch', { query: filterQuery }, 'Ningún archivo coincide con «{query}».');
            } else {
                empty.textContent = selectedFileCategories().length
                    ? t('scripts.noneInScope', null, 'No hay archivos de los tipos seleccionados en este ámbito.')
                    : t('scripts.noTypeSelected', null, 'Selecciona al menos un tipo de archivo.');
            }
            scriptsList.appendChild(empty);
            return;
        }

        // Agrupados por origen/carpeta y, dentro de cada grupo, por tipo de
        // archivo y nombre.
        var grupos = {};
        var orden = [];
        scripts.forEach(function (s) {
            var g = groupNameFor(s);
            if (!grupos[g]) { grupos[g] = []; orden.push(g); }
            grupos[g].push(s);
        });

        orden.sort().forEach(function (nombre, groupIndex) {
            var lista = grupos[nombre].sort(function (a, b) {
                if (a.ext !== b.ext) return a.ext.localeCompare(b.ext);
                return a.name.localeCompare(b.name);
            });

            var group = document.createElement('details');
            group.className = 'script-group';
            configureAccordion(group, scriptsList, groupIndex);

            var summary = document.createElement('summary');
            summary.className = 'script-group-title';
            summary.appendChild(document.createTextNode(nombre));
            var count = document.createElement('span');
            count.className = 'script-group-count';
            count.textContent = lista.length;
            summary.appendChild(count);
            group.appendChild(summary);

            lista.forEach(function (script) {
                group.appendChild(buildScriptItem(script));
            });
            scriptsList.appendChild(group);
        });
    }

    if (scriptsToggleBtn) {
        scriptsToggleBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var willShow = scriptsPanel.classList.contains('hidden');
            depsPanel.classList.add('hidden'); // no dejar los dos paneles abiertos a la vez
            projectsPanel.classList.add('hidden');
            document.getElementById('settings-panel').classList.add('hidden');
            scriptsPanel.classList.toggle('hidden');
            if (willShow) loadScriptsForCurrentMode();
        });
    }
    if (scriptsRefreshBtn) {
        scriptsRefreshBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            loadScriptsForCurrentMode();
        });
    }
    if (scriptsChooseFolderBtn) {
        scriptsChooseFolderBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var categories = selectedFileCategories();
            var request = scriptsMode === 'here'
                ? (activeTabId ? window.terminalAPI.chooseHereFolder(activeTabId, categories, scriptsHereDepth) : Promise.resolve(null))
                : window.terminalAPI.chooseScriptsFolder(categories);
            if (request) request.then(renderScripts);
        });
    }
    if (scriptsModeLibraryBtn) {
        scriptsModeLibraryBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            setScriptsMode('library');
        });
    }
    if (scriptsModeHereBtn) {
        scriptsModeHereBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            setScriptsMode('here');
        });
    }
    if (scriptsDepthSelect) {
        scriptsDepthSelect.addEventListener('change', function (e) {
            e.stopPropagation();
            scriptsHereDepth = Number(scriptsDepthSelect.value);
            if (scriptsMode === 'here') loadScriptsForCurrentMode();
        });
    }
    if (scriptsFilterInput) {
        scriptsFilterInput.addEventListener('input', function () { renderScripts(null); });
        scriptsFilterInput.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (!scriptsFilterInput.value) return;
            scriptsFilterInput.value = '';
            renderScripts(null);
        });
    }
    if (scriptsFilterClearBtn) {
        scriptsFilterClearBtn.addEventListener('click', function () {
            scriptsFilterInput.value = '';
            renderScripts(null);
            scriptsFilterInput.focus();
        });
    }
    if (scriptsFilterDefaultsBtn) scriptsFilterDefaultsBtn.addEventListener('click', function () { setFileFilterSelection('defaults'); });
    if (scriptsFilterAllBtn) scriptsFilterAllBtn.addEventListener('click', function () { setFileFilterSelection('all'); });
    if (scriptsFilterNoneBtn) scriptsFilterNoneBtn.addEventListener('click', function () { setFileFilterSelection('none'); });
    closeOnOutsideClick(scriptsPanel, scriptsToggleBtn);

    /* ================= Preferencias ================= */
    var settingsToggleBtn = document.getElementById('settings-toggle');
    var settingsPanel = document.getElementById('settings-panel');
    var settingsForm = document.getElementById('settings-form');
    var settingsAppName = document.getElementById('settings-app-name');
    var settingsVersion = document.getElementById('settings-version');
    var settingsThemeOptions = document.getElementById('settings-theme-options');
    var settingsPreview = document.getElementById('settings-preview');
    var settingsAccent = document.getElementById('settings-accent');
    var settingsTerminalBg = document.getElementById('settings-terminal-bg');
    var settingsTerminalFg = document.getElementById('settings-terminal-fg');
    var settingsDensity = document.getElementById('settings-density');
    var settingsLanguage = document.getElementById('settings-language');
    var settingsDefaultEnv = document.getElementById('settings-default-env');
    var settingsHereDepth = document.getElementById('settings-here-depth');
    var settingsFontFamily = document.getElementById('settings-font-family');
    var settingsFontSize = document.getElementById('settings-font-size');
    var settingsLineHeight = document.getElementById('settings-line-height');
    var settingsLetterSpacing = document.getElementById('settings-letter-spacing');
    var settingsCursorStyle = document.getElementById('settings-cursor-style');
    var settingsFontWeight = document.getElementById('settings-font-weight');
    var settingsScrollSensitivity = document.getElementById('settings-scroll-sensitivity');
    var settingsCopyOnSelect = document.getElementById('settings-copy-on-select');
    var settingsTerminalPadding = document.getElementById('settings-terminal-padding');
    var settingsScrollback = document.getElementById('settings-scrollback');
    var settingsCursorBlink = document.getElementById('settings-cursor-blink');
    var settingsShowBanner = document.getElementById('settings-show-banner');
    var settingsAutoDocker = document.getElementById('settings-auto-docker');
    var settingsExclusiveGroups = document.getElementById('settings-exclusive-groups');
    var settingsAutoOpenGroup = document.getElementById('settings-auto-open-group');
    var settingsAboutName = document.getElementById('settings-about-name');
    var settingsAboutMeta = document.getElementById('settings-about-meta');
    var settingsDevelopers = document.getElementById('settings-developers');
    var settingsPath = document.getElementById('settings-path');
    var settingsStatus = document.getElementById('settings-status');
    var settingsResetBtn = document.getElementById('settings-reset');
    var lastPreferenceState = null;

    function setSettingsStatus(message, isError) {
        settingsStatus.textContent = message || '';
        settingsStatus.classList.toggle('hidden', !message);
        settingsStatus.classList.toggle('error', !!isError);
    }

    function updateSettingsPreview() {
        if (!settingsPreview) return;
        settingsPreview.style.background = settingsTerminalBg.value;
        settingsPreview.style.color = settingsTerminalFg.value;
        settingsPreview.style.borderColor = settingsAccent.value;
        var accentParts = settingsPreview.querySelectorAll('span, strong, em');
        Array.prototype.forEach.call(accentParts, function (part) { part.style.color = settingsAccent.value; });
    }

    function markSelectedTheme(themeId) {
        Array.prototype.forEach.call(settingsThemeOptions.querySelectorAll('.settings-theme-card'), function (card) {
            card.classList.toggle('selected', card.dataset.themeId === themeId);
        });
    }

    function chooseTheme(theme) {
        if (!theme || !theme.palette) return;
        settingsAccent.value = theme.palette.accent;
        settingsTerminalBg.value = theme.palette.terminalBackground;
        settingsTerminalFg.value = theme.palette.terminalForeground;
        markSelectedTheme(theme.id);
        updateSettingsPreview();
    }

    function renderThemeOptions(selectedId) {
        settingsThemeOptions.innerHTML = '';
        themeCatalog.forEach(function (theme) {
            var card = document.createElement('label');
            card.className = 'settings-theme-card' + (theme.id === selectedId ? ' selected' : '');
            card.dataset.themeId = theme.id;
            card.title = theme.description || '';

            var radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'settings-theme';
            radio.value = theme.id;
            radio.checked = theme.id === selectedId;
            radio.addEventListener('change', function () {
                if (radio.checked) chooseTheme(theme);
            });

            var swatch = document.createElement('span');
            swatch.className = 'settings-theme-swatch';
            swatch.style.background = 'linear-gradient(135deg, ' + theme.palette.background + ' 0 64%, ' + theme.palette.accent + ' 64%)';
            var label = document.createElement('strong');
            label.textContent = theme.label;
            card.appendChild(radio);
            card.appendChild(swatch);
            card.appendChild(label);
            settingsThemeOptions.appendChild(card);
        });
    }

    function renderDevelopers(developers, owners) {
        settingsDevelopers.innerHTML = '';
        if (!developers || developers.length === 0) {
            settingsDevelopers.textContent = t('settings.developersPending', null, 'Pendiente de completar.');
            return;
        }
        var brandOwners = (owners || []).map(function (login) { return String(login).toLowerCase(); });
        developers.forEach(function (developer) {
            var badge = document.createElement('button');
            badge.type = 'button';
            badge.className = 'settings-developer';
            // Los perfiles oficiales del catálogo son además los dueños del
            // proyecto, no solo colaboradores del código.
            var roles = brandOwners.indexOf(String(developer).toLowerCase()) !== -1
                ? t('settings.roleOwner', null, 'Desarrollador · WinSlim')
                : t('settings.roleDeveloper', null, 'Desarrollador');
            badge.textContent = '@' + developer + ' · ' + roles;
            badge.title = t('settings.openProfile', { url: 'https://github.com/' + developer }, 'Abrir {url}');
            badge.addEventListener('click', function () { openGithub(developer); });
            settingsDevelopers.appendChild(badge);
        });
    }

    function renderPreferences(preferences) {
        if (!preferences) return;
        lastPreferenceState = preferences;
        if (Array.isArray(preferences.themes)) themeCatalog = preferences.themes;
        if (Array.isArray(preferences.fontFamilies)) fontCatalog = preferences.fontFamilies;
        if (preferences.appIdentity) appIdentity = preferences.appIdentity;

        settingsAppName.textContent = (appIdentity.name || 'Terminal') + ' · ' + t('settings.title', null, 'Preferencias');
        settingsVersion.textContent = appIdentity.version ? 'v' + appIdentity.version : '';
        settingsAboutName.textContent = appIdentity.name || 'Terminal';
        var platformNames = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
        settingsAboutMeta.textContent = [appIdentity.version ? 'v' + appIdentity.version : '', platformNames[appIdentity.platform] || appIdentity.platform || ''].filter(Boolean).join(' · ');
        renderDevelopers(
            preferences.credits && preferences.credits.developers,
            preferences.credits && preferences.credits.owners
        );
        renderThemeOptions(preferences.themeId);
        settingsAccent.value = preferences.accentColor;
        settingsTerminalBg.value = preferences.terminalBackground;
        settingsTerminalFg.value = preferences.terminalForeground;
        settingsDensity.value = preferences.uiDensity;

        // Idioma. `auto` sale con el nombre del idioma en el propio idioma
        // activo; los demás se llaman siempre igual (Español, English), que es
        // lo que espera quien busca su idioma en una lista.
        if (settingsLanguage) {
            settingsLanguage.innerHTML = '';
            languageCatalog.forEach(function (language) {
                var option = document.createElement('option');
                option.value = language.id;
                option.textContent = language.id === 'auto'
                    ? t('settings.languageAuto', null, language.label)
                    : language.label;
                settingsLanguage.appendChild(option);
            });
            settingsLanguage.value = preferences.language || 'auto';
        }

        settingsDefaultEnv.innerHTML = '';
        var automatic = document.createElement('option');
        automatic.value = '';
        automatic.textContent = t('settings.envAuto', null, 'Automático según el sistema');
        settingsDefaultEnv.appendChild(automatic);
        (preferences.environments || []).forEach(function (env) {
            var option = document.createElement('option');
            option.value = env.id;
            option.textContent = env.label;
            settingsDefaultEnv.appendChild(option);
        });
        settingsDefaultEnv.value = preferences.defaultEnvironmentId || '';
        settingsHereDepth.value = preferences.scriptsHereDepth;
        settingsFontFamily.innerHTML = '';
        fontCatalog.forEach(function (font) {
            var option = document.createElement('option');
            option.value = font.id;
            option.textContent = font.label;
            settingsFontFamily.appendChild(option);
        });
        settingsFontFamily.value = preferences.terminalFontFamily;
        settingsFontSize.value = preferences.terminalFontSize;
        settingsLineHeight.value = preferences.terminalLineHeight;
        settingsLetterSpacing.value = preferences.terminalLetterSpacing;
        settingsCursorStyle.value = preferences.terminalCursorStyle;
        if (settingsFontWeight) settingsFontWeight.value = preferences.terminalFontWeight;
        settingsTerminalPadding.value = preferences.terminalPadding;
        if (settingsScrollSensitivity) settingsScrollSensitivity.value = preferences.terminalScrollSensitivity;
        settingsScrollback.value = preferences.terminalScrollback;
        settingsCursorBlink.checked = preferences.terminalCursorBlink;
        if (settingsCopyOnSelect) settingsCopyOnSelect.checked = preferences.copyOnSelect;
        settingsShowBanner.checked = preferences.showSystemBanner;
        settingsAutoDocker.checked = preferences.autoStartDocker;
        settingsExclusiveGroups.checked = preferences.exclusiveAccordionGroups;
        settingsAutoOpenGroup.checked = preferences.autoOpenFirstGroup;
        settingsPath.textContent = preferences.settingsPath
            ? t('settings.file', null, 'Archivo') + ': ' + preferences.settingsPath
            : '';
        settingsPath.title = preferences.settingsPath || '';
        updateSettingsPreview();
    }

    // Lo que se pinta desde JavaScript no lleva data-i18n, así que cambiar de
    // idioma obliga a reconstruirlo. Los paneles cerrados no se tocan: se
    // rehacen enteros al abrirlos.
    function repaintTranslatedViews() {
        renderTabStrip();
        refreshEnvSelectForActiveTab(true);
        if (!depsPanel.classList.contains('hidden')) window.terminalAPI.listInstallActions().then(renderDepsPanel);
        if (!scriptsPanel.classList.contains('hidden')) loadScriptsForCurrentMode();
        if (!projectsPanel.classList.contains('hidden')) renderPinnedProjects(lastProjectsState);
        if (explorerVisible) loadExplorer();
    }

    function preferencesFromForm() {
        var selectedTheme = settingsThemeOptions.querySelector('input[name="settings-theme"]:checked');
        return {
            language: settingsLanguage ? settingsLanguage.value : 'auto',
            defaultEnvironmentId: settingsDefaultEnv.value,
            scriptsHereDepth: Number(settingsHereDepth.value),
            themeId: selectedTheme ? selectedTheme.value : (lastPreferenceState && lastPreferenceState.themeId) || 'silver',
            accentColor: settingsAccent.value,
            terminalBackground: settingsTerminalBg.value,
            terminalForeground: settingsTerminalFg.value,
            terminalFontFamily: settingsFontFamily.value,
            terminalFontSize: Number(settingsFontSize.value),
            terminalLineHeight: Number(settingsLineHeight.value),
            terminalLetterSpacing: Number(settingsLetterSpacing.value),
            terminalCursorStyle: settingsCursorStyle.value,
            terminalFontWeight: settingsFontWeight ? settingsFontWeight.value : 'normal',
            terminalPadding: Number(settingsTerminalPadding.value),
            terminalScrollback: Number(settingsScrollback.value),
            terminalScrollSensitivity: settingsScrollSensitivity ? Number(settingsScrollSensitivity.value) : 3,
            terminalCursorBlink: settingsCursorBlink.checked,
            copyOnSelect: settingsCopyOnSelect ? settingsCopyOnSelect.checked : false,
            showSystemBanner: settingsShowBanner.checked,
            uiDensity: settingsDensity.value,
            autoStartDocker: settingsAutoDocker.checked,
            exclusiveAccordionGroups: settingsExclusiveGroups.checked,
            autoOpenFirstGroup: settingsAutoOpenGroup.checked
        };
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-settings-tab]'), function (button) {
        button.addEventListener('click', function () {
            var tabName = button.dataset.settingsTab;
            Array.prototype.forEach.call(document.querySelectorAll('[data-settings-tab]'), function (other) {
                other.classList.toggle('active', other === button);
            });
            Array.prototype.forEach.call(document.querySelectorAll('[data-settings-section]'), function (section) {
                section.classList.toggle('active', section.dataset.settingsSection === tabName);
            });
        });
    });
    [settingsAccent, settingsTerminalBg, settingsTerminalFg].forEach(function (input) {
        input.addEventListener('input', updateSettingsPreview);
    });

    settingsToggleBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        var willShow = settingsPanel.classList.contains('hidden');
        depsPanel.classList.add('hidden');
        projectsPanel.classList.add('hidden');
        scriptsPanel.classList.add('hidden');
        settingsPanel.classList.toggle('hidden');
        if (willShow) {
            setSettingsStatus('', false);
            window.terminalAPI.getPreferences().then(renderPreferences);
        }
    });

    settingsForm.addEventListener('submit', function (event) {
        event.preventDefault();
        window.terminalAPI.savePreferences(preferencesFromForm()).then(function (result) {
            if (!result || !result.ok) {
                setSettingsStatus((result && result.error) || t('settings.saveFailed', null, 'No se pudieron guardar las preferencias.'), true);
                return;
            }
            // El idioma se aplica dentro de applyUiPreferences, así que va
            // ANTES de repintar el panel: si no, los rótulos que dibuja
            // renderPreferences saldrían con el catálogo anterior.
            applyUiPreferences(result.state);
            renderPreferences(result.state);
            repaintTranslatedViews();
            setSettingsStatus(t('settings.savedNote', null, 'Guardado. El entorno inicial y Docker se aplican en el próximo arranque.'), false);
        });
    });

    settingsResetBtn.addEventListener('click', function () {
        window.terminalAPI.resetPreferences().then(function (result) {
            if (!result || !result.ok) {
                setSettingsStatus((result && result.error) || t('settings.resetFailed', null, 'No se pudieron restablecer las preferencias.'), true);
                return;
            }
            applyUiPreferences(result.state);
            renderPreferences(result.state);
            repaintTranslatedViews();
            setSettingsStatus(t('settings.resetDone', null, 'Preferencias restablecidas.'), false);
        });
    });

    closeOnOutsideClick(settingsPanel, settingsToggleBtn);

    /* ================= Explorador de archivos ================= */
    var explorerPanel = document.getElementById('explorer');
    var explorerToggleBtn = document.getElementById('explorer-toggle');
    var explorerUpBtn = document.getElementById('explorer-up');
    var explorerFollowBtn = document.getElementById('explorer-follow');
    var explorerRefreshBtn = document.getElementById('explorer-refresh');
    var explorerCdBtn = document.getElementById('explorer-cd');
    var explorerNewFolderBtn = document.getElementById('explorer-new-folder');
    var explorerNewFileBtn = document.getElementById('explorer-new-file');
    var explorerCreateForm = document.getElementById('explorer-create');
    var explorerCreateName = document.getElementById('explorer-create-name');
    var explorerCreateSubmit = document.getElementById('explorer-create-submit');
    var explorerCreateCancel = document.getElementById('explorer-create-cancel');
    var explorerConfirm = document.getElementById('explorer-confirm');
    var explorerConfirmText = document.getElementById('explorer-confirm-text');
    var explorerConfirmAccept = document.getElementById('explorer-confirm-accept');
    var explorerConfirmCancel = document.getElementById('explorer-confirm-cancel');
    var explorerContextMenu = document.getElementById('explorer-context-menu');
    var explorerPath = document.getElementById('explorer-path');
    var explorerStatus = document.getElementById('explorer-status');
    var explorerList = document.getElementById('explorer-list');
    var explorerVisible = false;
    var explorerParent = null;
    var explorerCreateKind = 'directory';
    var explorerPending = false;
    var explorerTimer = null;
    // El formulario de nombre se reutiliza para crear y para renombrar; este
    // par de variables dice cuál de las dos cosas está haciendo ahora mismo.
    var explorerFormMode = 'create';
    var explorerRenameEntry = null;
    var explorerContextEntry = null;
    var explorerConfirmEntry = null;
    // Solo para pintar el menú: lo que se pega de verdad lo recuerda main.js.
    var explorerClipboardName = null;

    function setExplorerStatus(message) {
        explorerStatus.textContent = message || '';
        explorerStatus.classList.toggle('hidden', !message);
    }

    function formatSize(bytes) {
        if (!bytes) return '';
        var units = ['B', 'KB', 'MB', 'GB'];
        var value = bytes;
        var unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value = value / 1024;
            unit += 1;
        }
        return (unit === 0 ? value : value.toFixed(1)) + ' ' + units[unit];
    }

    function renderExplorer(data) {
        if (!data) return;
        explorerParent = data.parent || null;
        explorerPath.textContent = data.dir || '';
        explorerPath.title = data.dir || '';
        if (explorerUpBtn) explorerUpBtn.disabled = !explorerParent;
        if (explorerFollowBtn) explorerFollowBtn.classList.toggle('active', data.followsTab !== false);
        setExplorerStatus(data.error || (data.truncated ? t('explorer.truncated', null, 'Carpeta muy grande: se muestran los primeros resultados.') : ''));

        explorerList.innerHTML = '';
        var entries = data.entries || [];
        if (!entries.length) {
            var empty = document.createElement('div');
            empty.className = 'explorer-empty';
            empty.textContent = data.error ? '' : t('explorer.empty', null, 'Carpeta vacía.');
            explorerList.appendChild(empty);
            return;
        }
        entries.forEach(function (entry) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'explorer-entry'
                + (entry.kind === 'directory' ? ' is-directory' : '')
                + (entry.hidden ? ' is-hidden' : '');
            row.title = entry.path + (entry.link ? ' (enlace)' : '');

            var icon = document.createElement('span');
            icon.className = 'explorer-entry-icon';
            icon.textContent = entry.kind === 'directory' ? '▸' : '·';
            row.appendChild(icon);

            var name = document.createElement('span');
            name.className = 'explorer-entry-name';
            name.textContent = entry.name + (entry.link ? ' ↗' : '');
            row.appendChild(name);

            if (entry.kind === 'file') {
                var size = document.createElement('span');
                size.className = 'explorer-entry-size';
                size.textContent = formatSize(entry.size);
                row.appendChild(size);
            }

            row.addEventListener('click', function () { openExplorerEntry(entry); });
            row.addEventListener('contextmenu', function (event) {
                event.preventDefault();
                event.stopPropagation();
                showExplorerContextMenu(event, entry);
            });
            explorerList.appendChild(row);
        });
    }

    function openExplorerEntry(entry) {
        if (!activeTabId || !entry) return;
        if (entry.kind === 'directory') {
            loadExplorer(entry.path);
            return;
        }
        window.terminalAPI.openDirectoryEntry(activeTabId, entry.path).then(function (result) {
            handleOpenResult(result, setExplorerStatus);
        });
    }

    // Menú contextual: una carpeta se abre en el explorador del sistema
    // (Explorador de Windows, Finder, el gestor del escritorio en Linux). Para
    // seguir navegando dentro del panel están el clic normal y "Entrar en la
    // carpeta". Un archivo sigue abriéndose con su aplicación asociada.
    function openEntryFromMenu(entry) {
        if (!activeTabId || !entry) return;
        if (entry.kind !== 'directory') {
            openExplorerEntry(entry);
            return;
        }
        window.terminalAPI.openDirectoryInSystem(activeTabId, entry.path).then(function (result) {
            handleDirectoryOpenResult(result, entry);
        });
    }

    // En Linux puede no haber ningún gestor de archivos registrado (escritorio
    // mínimo, servidor): ahí no se puede abrir la carpeta y hay que preguntar.
    // Se ofrecen primero los que ya están instalados y, si no hay ninguno, los
    // que se pueden instalar desde el mismo panel de dependencias.
    function handleDirectoryOpenResult(result, entry) {
        if (!result || result.ok) return;
        var managers = result.managers;
        var instalados = (managers && managers.installed) || [];
        var instalables = (managers && managers.installable) || [];

        if (!instalados.length && !instalables.length) {
            setExplorerStatus(result.error || t('explorer.errorOpenFolder', null, 'No se pudo abrir la carpeta.'));
            return;
        }

        var choices = instalados.map(function (manager) {
            return {
                label: t('fileManager.openWith', { app: manager.app }, 'Abrir con {app}'),
                onSelect: function (done) {
                    window.terminalAPI
                        .openDirectoryWith(activeTabId, entry.path, manager.id, true)
                        .then(function (again) {
                            if (again && again.ok) {
                                done();
                                setExplorerStatus(t('explorer.openedWith', { app: manager.app }, 'Carpeta abierta con {app}.'));
                                return;
                            }
                            setExplorerStatus((again && again.error) || t('explorer.errorOpenFolder', null, 'No se pudo abrir la carpeta.'));
                            done();
                        });
                }
            };
        });

        instalables.forEach(function (manager) {
            choices.push({ label: t('fileManager.install', { app: manager.app }, 'Instalar {app}'), actionId: manager.actionId });
        });

        showSuggestion({
            message: instalados.length
                ? t('fileManager.chooseInstalled', null, 'El sistema no tiene un gestor de archivos predeterminado.'
                    + ' ¿Con cuál abro la carpeta? Se recordará para la próxima vez (se puede volver a preguntar restableciendo los ajustes).')
                : t('fileManager.chooseInstall', null, 'No hay ningún gestor de archivos instalado para abrir carpetas. ¿Instalar uno?'),
            choices: choices,
            timeoutMs: 30000
        });
    }

    function loadExplorer(directory) {
        if (!explorerVisible || !activeTabId || explorerPending) return;
        explorerPending = true;
        window.terminalAPI.listDirectory(activeTabId, directory || null)
            .then(renderExplorer)
            .catch(function (error) { setExplorerStatus(error.message); })
            .finally(function () { explorerPending = false; });
    }

    /* ---- Menú contextual del explorador ----
     * Copiar/cortar no mueven nada: solo dejan apuntado en el proceso
     * principal QUÉ se va a pegar (ver explorer:clip en main.js). Eliminar va
     * a la papelera del sistema, nunca borra directo, y aun así pide
     * confirmación antes. Renombrar reutiliza el mismo formulario de nombre
     * que "+ Carpeta" / "+ Archivo".
     */
    // Mientras hay un menú, un renombrado o una confirmación en marcha, el
    // refresco automático cada 3 s se queda quieto: repintar la lista debajo
    // del usuario es la forma más rápida de que borre lo que no quería.
    function explorerBusy() {
        return !explorerContextMenu.classList.contains('hidden')
            || !explorerConfirm.classList.contains('hidden')
            || (explorerFormMode === 'rename' && !explorerCreateForm.classList.contains('hidden'));
    }

    function hideExplorerContextMenu() {
        explorerContextMenu.classList.add('hidden');
        explorerContextEntry = null;
    }

    function showExplorerContextMenu(event, entry) {
        explorerContextEntry = entry || null;
        var isEntry = !!entry;
        Array.prototype.forEach.call(explorerContextMenu.querySelectorAll('button'), function (button) {
            var action = button.dataset.action;
            if (action === 'paste') {
                button.disabled = !explorerClipboardName;
                button.textContent = explorerClipboardName
                    ? t('explorer.pasteNamed', { name: explorerClipboardName }, 'Pegar "{name}"')
                    : t('explorer.paste', null, 'Pegar');
                return;
            }
            if (action === 'new-folder' || action === 'new-file') {
                button.disabled = false;
                return;
            }
            // Entrar en la carpeta es lo mismo que hace el clic normal sobre
            // la fila: solo tiene sentido en carpetas, y "Abrir carpeta" ya no
            // ocupa ese sitio porque ahora lanza el explorador del sistema.
            if (action === 'enter') {
                var esCarpeta = isEntry && entry.kind === 'directory';
                button.hidden = !esCarpeta;
                button.disabled = !esCarpeta;
                return;
            }
            // El resto de acciones necesitan un elemento sobre el que actuar.
            button.disabled = !isEntry;
            if (action === 'open') button.textContent = isEntry && entry.kind === 'directory' ? t('explorer.openFolder', null, 'Abrir carpeta') : t('explorer.open', null, 'Abrir');
        });
        explorerContextMenu.classList.remove('hidden');
        var width = explorerContextMenu.offsetWidth;
        var height = explorerContextMenu.offsetHeight;
        explorerContextMenu.style.left = Math.min(event.clientX, window.innerWidth - width - 6) + 'px';
        explorerContextMenu.style.top = Math.min(event.clientY, window.innerHeight - height - 6) + 'px';
    }

    function applyExplorerResult(result, fallbackMessage) {
        if (!result || !result.ok) {
            setExplorerStatus((result && result.error) || fallbackMessage);
            return false;
        }
        if (result.listing) renderExplorer(result.listing);
        else loadExplorer();
        return true;
    }

    function startExplorerRename(entry) {
        explorerFormMode = 'rename';
        explorerRenameEntry = entry;
        explorerConfirm.classList.add('hidden');
        explorerCreateName.value = entry.name;
        explorerCreateName.placeholder = t('explorer.newName', null, 'Nombre nuevo');
        if (explorerCreateSubmit) explorerCreateSubmit.textContent = t('explorer.rename', null, 'Renombrar');
        explorerCreateForm.classList.remove('hidden');
        explorerCreateName.focus();
        // Deja fuera la extensión al seleccionar: lo que casi siempre se
        // quiere cambiar es el nombre, no el ".md" del final.
        var dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1;
        explorerCreateName.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
    }

    function startExplorerDelete(entry) {
        explorerConfirmEntry = entry;
        explorerCreateForm.classList.add('hidden');
        explorerConfirmText.textContent = t('explorer.confirmTrash', { name: entry.name }, 'Enviar "{name}" a la papelera');
        explorerConfirm.classList.remove('hidden');
        explorerConfirmAccept.focus();
    }

    explorerContextMenu.addEventListener('click', function (event) {
        var button = event.target.closest('button');
        if (!button || button.disabled || !activeTabId) return;
        var action = button.dataset.action;
        var entry = explorerContextEntry;
        hideExplorerContextMenu();

        if (action === 'new-folder') { startExplorerCreate('directory'); return; }
        if (action === 'new-file') { startExplorerCreate('file'); return; }
        if (action === 'paste') {
            window.terminalAPI.pasteDirectoryEntry(activeTabId).then(function (result) {
                if (!applyExplorerResult(result, t('explorer.errorPaste', null, 'No se pudo pegar.'))) return;
                // Cortar es de un solo uso: main.js ya lo ha vaciado.
                if (result.move) explorerClipboardName = null;
                if (result.renamed) setExplorerStatus(t('explorer.pastedRenamed', { name: result.name }, 'Ya había un elemento con ese nombre: se pegó como "{name}".'));
            });
            return;
        }
        if (!entry) return;
        if (action === 'enter') { loadExplorer(entry.path); return; }
        if (action === 'open') { openEntryFromMenu(entry); return; }
        if (action === 'copy-path') { window.terminalAPI.writeClipboard(entry.path); return; }
        if (action === 'rename') { startExplorerRename(entry); return; }
        if (action === 'trash') { startExplorerDelete(entry); return; }
        if (action === 'copy' || action === 'cut') {
            window.terminalAPI.clipDirectoryEntry(activeTabId, entry.path, action).then(function (result) {
                if (!result || !result.ok) {
                    setExplorerStatus((result && result.error) || t('explorer.errorCopy', null, 'No se pudo copiar.'));
                    return;
                }
                explorerClipboardName = result.name;
                setExplorerStatus(result.move ? t('explorer.cutDone', { name: result.name }, 'Cortado: {name}') : t('explorer.copied', { name: result.name }, 'Copiado: {name}'));
            });
        }
    });

    // Click derecho en el hueco de la lista (o en la ruta): sin elemento
    // seleccionado, el menú solo ofrece pegar y crear.
    explorerList.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        showExplorerContextMenu(event, null);
    });

    document.addEventListener('mousedown', function (event) {
        if (!explorerContextMenu.contains(event.target)) hideExplorerContextMenu();
    });

    if (explorerConfirmCancel) {
        explorerConfirmCancel.addEventListener('click', function () {
            explorerConfirm.classList.add('hidden');
            explorerConfirmEntry = null;
        });
    }
    if (explorerConfirmAccept) {
        explorerConfirmAccept.addEventListener('click', function () {
            if (!activeTabId || !explorerConfirmEntry) return;
            var entry = explorerConfirmEntry;
            explorerConfirmAccept.disabled = true;
            window.terminalAPI.trashDirectoryEntry(activeTabId, entry.path).then(function (result) {
                explorerConfirmAccept.disabled = false;
                explorerConfirm.classList.add('hidden');
                explorerConfirmEntry = null;
                if (!applyExplorerResult(result, t('explorer.errorDelete', null, 'No se pudo eliminar.'))) return;
                if (explorerClipboardName === entry.name) explorerClipboardName = null;
                setExplorerStatus(t('explorer.trashed', { name: entry.name }, '"{name}" está en la papelera.'));
            });
        });
    }

    // El cwd de la pestaña se deduce del prompt, así que cambia sin avisar:
    // mientras el panel está abierto se relee la carpeta cada pocos segundos.
    function setExplorerVisible(visible) {
        explorerVisible = visible;
        explorerPanel.classList.toggle('hidden', !visible);
        if (explorerToggleBtn) explorerToggleBtn.classList.toggle('active', visible);
        if (explorerTimer) {
            clearInterval(explorerTimer);
            explorerTimer = null;
        }
        if (visible) {
            loadExplorer();
            explorerTimer = setInterval(function () {
                if (explorerBusy()) return;
                loadExplorer();
            }, 3000);
        } else {
            hideExplorerContextMenu();
        }
        setTimeout(scheduleFit, 0);
    }

    function startExplorerCreate(kind) {
        explorerFormMode = 'create';
        explorerRenameEntry = null;
        explorerCreateKind = kind;
        explorerConfirm.classList.add('hidden');
        explorerCreateName.value = '';
        explorerCreateName.placeholder = kind === 'directory' ? 'Nombre de la carpeta' : 'Nombre del archivo';
        if (explorerCreateSubmit) explorerCreateSubmit.textContent = t('explorer.create', null, 'Crear');
        explorerCreateForm.classList.remove('hidden');
        explorerCreateName.focus();
    }

    if (explorerToggleBtn) {
        explorerToggleBtn.addEventListener('click', function () { setExplorerVisible(!explorerVisible); });
    }
    if (explorerUpBtn) {
        explorerUpBtn.addEventListener('click', function () {
            if (explorerParent) loadExplorer(explorerParent);
        });
    }
    if (explorerRefreshBtn) explorerRefreshBtn.addEventListener('click', function () { loadExplorer(); });
    if (explorerFollowBtn) {
        explorerFollowBtn.addEventListener('click', function () {
            if (!activeTabId) return;
            window.terminalAPI.followTerminalDirectory(activeTabId).then(renderExplorer);
        });
    }
    if (explorerCdBtn) {
        explorerCdBtn.addEventListener('click', function () {
            if (!activeTabId) return;
            window.terminalAPI.cdToExplorerDirectory(activeTabId).then(function (result) {
                if (!result || !result.ok) {
                    setExplorerStatus((result && result.error) || 'No se pudo cambiar de carpeta.');
                    return;
                }
                if (tabs[activeTabId]) tabs[activeTabId].term.focus();
            });
        });
    }
    if (explorerNewFolderBtn) explorerNewFolderBtn.addEventListener('click', function () { startExplorerCreate('directory'); });
    if (explorerNewFileBtn) explorerNewFileBtn.addEventListener('click', function () { startExplorerCreate('file'); });
    if (explorerCreateCancel) {
        explorerCreateCancel.addEventListener('click', function () {
            explorerCreateForm.classList.add('hidden');
            explorerFormMode = 'create';
            explorerRenameEntry = null;
        });
    }
    if (explorerCreateForm) {
        explorerCreateForm.addEventListener('submit', function (e) {
            e.preventDefault();
            if (!activeTabId) return;
            var name = explorerCreateName.value;
            var pending = explorerFormMode === 'rename' && explorerRenameEntry
                ? window.terminalAPI.renameDirectoryEntry(activeTabId, explorerRenameEntry.path, name)
                : window.terminalAPI.createDirectoryEntry(activeTabId, name, explorerCreateKind);
            var fallback = explorerFormMode === 'rename' ? 'No se pudo renombrar.' : 'No se pudo crear.';
            pending.then(function (result) {
                if (!applyExplorerResult(result, fallback)) return;
                explorerCreateForm.classList.add('hidden');
                explorerFormMode = 'create';
                explorerRenameEntry = null;
            });
        });
    }

    /* ================= Logs ================= */
    var logsBtn = document.getElementById('logs-open');
    if (logsBtn) {
        logsBtn.addEventListener('click', function () {
            window.terminalAPI.openLogFolder();
            if (activeTabId) tabs[activeTabId].term.focus();
        });
    }

    /* ========= Sugerencia de comando no encontrado ========= */
    var suggestionBox = document.getElementById('cmd-suggestion');
    var suggestionTimer = null;

    function hideSuggestion() {
        if (suggestionTimer) {
            clearTimeout(suggestionTimer);
            suggestionTimer = null;
        }
        suggestionBox.classList.add('hidden');
        suggestionBox.innerHTML = '';
    }

    // Aviso con botones de decisión. Lo comparten la sugerencia de "comando no
    // encontrado", la de instalar un visor y la elección de gestor de
    // archivos: en todos los casos hace falta el visto bueno del usuario antes
    // de tocar nada del sistema, y ninguna opción se ejecuta sola.
    //
    // Una opción puede llevar `actionId` (escribe una instalación en la
    // terminal) o `onSelect` (la resuelve el propio renderer, como abrir la
    // carpeta con un gestor concreto). `acceptLabel` + `actionId` sueltos
    // siguen valiendo como la opción única de siempre.
    function showSuggestion(options) {
        suggestionBox.innerHTML = '';

        var text = document.createElement('div');
        text.className = 'suggestion-text';
        text.textContent = options.message;
        suggestionBox.appendChild(text);

        var actionsRow = document.createElement('div');
        actionsRow.className = 'suggestion-actions';

        var dismissBtn = document.createElement('button');
        dismissBtn.className = 'modal-btn';
        dismissBtn.textContent = t('suggestion.dismiss', null, 'Ignorar');
        dismissBtn.addEventListener('click', hideSuggestion);
        actionsRow.appendChild(dismissBtn);

        var choices = options.choices
            || (options.actionId ? [{ label: options.acceptLabel, actionId: options.actionId }] : []);

        choices.forEach(function (choice, index) {
            var btn = document.createElement('button');
            // El primero es el camino recomendado; los demás, alternativas.
            btn.className = 'modal-btn' + (index === 0 ? ' modal-btn-primary' : '');
            btn.textContent = choice.label;
            btn.addEventListener('click', function () {
                if (!activeTabId) return;
                btn.disabled = true;
                var reactivar = function () { btn.disabled = false; };

                if (choice.onSelect) {
                    choice.onSelect(hideSuggestion);
                    return;
                }
                window.terminalAPI.runInstallAction(activeTabId, choice.actionId).then(function (result) {
                    if (!result || !result.ok) {
                        reactivar();
                        text.textContent = (result && result.error) || t('suggestion.installFailed', null, 'No se pudo preparar la instalación.');
                        return;
                    }
                    hideSuggestion();
                    if (result.tab) activateReturnedTab(result.tab);
                    if (activeTabId && tabs[activeTabId]) tabs[activeTabId].term.focus();
                }).catch(function (error) {
                    reactivar();
                    text.textContent = error.message;
                });
            });
            actionsRow.appendChild(btn);
        });

        if (!choices.length && options.noActionMessage) {
            var noAuto = document.createElement('div');
            noAuto.className = 'suggestion-text';
            noAuto.textContent = options.noActionMessage;
            suggestionBox.appendChild(noAuto);
        }

        suggestionBox.appendChild(actionsRow);
        suggestionBox.classList.remove('hidden');

        if (suggestionTimer) clearTimeout(suggestionTimer);
        suggestionTimer = setTimeout(hideSuggestion, options.timeoutMs || 15000);
    }

    // Resultado de abrir un archivo con la aplicación del sistema. Si no hay
    // ninguna asociada, se ofrece instalar el visor recomendado para ese tipo.
    function handleOpenResult(result, onPlainError) {
        if (!result || result.ok) return;
        if (result.suggestion) {
            showSuggestion({
                message: t('suggestion.noViewer', { category: result.suggestion.categoryLabel, app: result.suggestion.app },
                    'No hay ninguna aplicación para abrir este archivo de {category}. ¿Instalar {app}?'),
                acceptLabel: t('suggestion.install', { app: result.suggestion.app }, 'Instalar {app}'),
                actionId: result.suggestion.actionId,
                timeoutMs: 25000
            });
            return;
        }
        if (onPlainError) onPlainError(result.error);
    }

    if (suggestionBox && window.terminalAPI.onCommandNotFound) {
        window.terminalAPI.onCommandNotFound(function (tabId, suggestion) {
            showSuggestion({
                message: t('suggestion.notFound', { tool: suggestion.tool, label: suggestion.label },
                    "No se encontró '{tool}'. ¿Instalar {label}?"),
                acceptLabel: t('suggestion.install', { app: suggestion.label }, 'Instalar {app}'),
                actionId: suggestion.actionId,
                noActionMessage: t('suggestion.noAutoInstall', null, 'No hay instalación automática disponible para esto todavía.')
            });
        });
    }

    /* ================= Arranque: cargar pestañas ya creadas por main.js ================= */
    Promise.all([
        window.terminalAPI.listTabs(),
        window.terminalAPI.getProjectsState(),
        window.terminalAPI.getPreferences()
    ]).then(function (results) {
        var data = results[0];
        lastProjectsState = results[1];
        applyUiPreferences(results[2]);
        renderPreferences(results[2]);
        (data.tabs || []).forEach(function (inicial) {
            addTab(inicial.id, inicial.label, inicial.envId);
        });
        renderTabStrip();

        var startId = (data.activeTabId && tabs[data.activeTabId]) ? data.activeTabId : Object.keys(tabs)[0];
        if (startId) activateTab(startId);
        window.terminalAPI.signalRendererReady();
    });

    // Confirmación de main.js de que una pestaña se cerró de verdad (al
    // pulsar la ✕): ahora sí se quita del DOM y, si era la activa, se activa
    // la que main.js eligió como reemplazo.
    if (window.terminalAPI.onTabClosed) {
        window.terminalAPI.onTabClosed(function (tabId, newActiveTabId) {
            removeTabUI(tabId, newActiveTabId);
        });
    }
})();
