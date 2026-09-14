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
    import { panels, type PanelId } from '../lib/panels.svelte';
    import * as perf from '../lib/performance';
    import { retryUntilReady } from '../lib/terminal-ready';
    import { normalizeWheelDelta } from '../lib/terminal-scroll';
    import { longestVisibleLogicalLineWidth, occupiedTerminalColumns } from '../lib/terminal-columns';
    import { interactiveReplInputLine, interactiveReplPromptIsVisible } from '../lib/terminal-prompt';
    import { cursorInactiveStyle, cursorOptions, terminalFont, terminalFontWeight, terminalTheme } from '../lib/theme';
    import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry';
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
    let observer: ResizeObserver | undefined;
    let mirroredLine: string | null = '';
    // La shell puede aceptar teclas antes de que el banner inicial haya
    // terminado de llegar al xterm (sobre todo en pestañas creadas en segundo
    // plano). Retenerlas brevemente conserva la entrada del usuario y evita
    // que el eco se escriba dentro de una línea del banner.
    let inputReady = false;
    let queuedInput = '';
    let inputReleaseTimer: number | undefined;
    let environmentSwitchPending = false;
    let environmentSwitchRequestId: number | undefined;
    let environmentSwitchSnapshot: EnvironmentSwitchSnapshot | undefined;
    let terminalSpaceHandler: ((event: KeyboardEvent) => void) | undefined;
    let lastExplicitSpaceKeydownAt = Number.NEGATIVE_INFINITY;
    let pendingExplicitSpaces = 0;
    let explicitSpaceTimer: number | undefined;
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
    function writeInternal(text: string): void {
        term?.writeln(translated('terminal.dynamicOutput', '{text}', { text }));
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
            writeInternal('Uso: :theme <id> | :theme list');
            return;
        }
        const theme = app.themes.find((candidate) => candidate.id.toLowerCase() === wanted.toLowerCase()
            || foldLocalized(candidate.label, app.catalog.language) === foldLocalized(wanted, app.catalog.language));
        if (!theme) {
            writeInternal(`\r\n[No se encontró el tema «${wanted}». Usa :theme list.]`);
            return;
        }
        await app.savePreferences({ themeId: theme.id });
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
            ['cursor-blink', preferences.terminalCursorBlink], ['copy-on-select', preferences.copyOnSelect],
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
            'copy-on-select': 'copyOnSelect', copy: 'copyOnSelect', density: 'uiDensity',
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
        } else if (['terminalCursorBlink', 'copyOnSelect'].includes(field)) {
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
        await clearPromptInput(line);
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
        } else if (command.action === 'shell') {
            await configureShell(command.argument);
        } else if (command.action === 'banner') {
            await configureBanner(command.argument);
        } else if (command.action === 'quickActions') {
            await configureQuickActions(command.argument);
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
        } else if (command.action === 'darkeiser003' || command.action === 'christianlg97') {
            // Los créditos se generan en el mismo archivo de ayuda que usa la
            // shell. Ejecutarlos por el PTY, en vez de escribir directamente
            // en xterm, mantiene sincronizados el cursor real, el historial y
            // el prompt; además recoge el idioma actualizado al regenerarse
            // los archivos de sesión.
            await api.sendInput(tabId, 'ayuda creditos\r');
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
                term?.writeln(`\r\n${translated('terminal.helpFallback', 'Help{topic}: use :help from a terminal or consult the internal commands.', { topic: topic ? ` (${topic})` : '' })}`);
                term?.writeln(app.t('terminal.internalCommands', 'Internal commands: :help [section]  :config/:settings  :reload  :shell [list|current|<name>]  :repl <name>  :panel <panel|close>  :explorer-here  :theme [list|<id>]  :font [list|<id>]  :language [list|<id>]  :terminal [list|<key> <value>]  :panes [1|2|3|4|cycle]  :banner [options]  :quick-actions [options]'));
            }
        } else {
            term?.writeln(`\r\n${app.t('terminal.commandList', ':help  :config/:settings  :reload  :shell  :repl  :panel  :explorer-here  :theme  :font  :language  :terminal  :panes  :alias  :banner  :quick-actions')}`);
        }
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
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeObserverFrame: number | undefined;
    let resumeRefreshFrame: number | undefined;
    const onWindowResize = () => fitAndReport();
    let initialPromptTimer: number | undefined;
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
    let repaintTimer: number | undefined;
    let lastOutputFinishedAt = 0;
    let bannerActivationTimer: number | undefined;
    let inputReadyTimer: number | undefined;
    let pendingBannerPrint = false;
    // Mientras una solicitud sigue en vuelo no se encadena otra
    // desde el evento idle; así se evita trabajo duplicado durante un resize.
    let bannerRefreshInFlight = false;

    // xterm ajusta el ancho de la PTY al número de columnas visibles. Cuando
    // una salida ya ha creado una línea más larga, mantener esas columnas
    // permite desplazarla horizontalmente en vez de volver a partirla.
    const MAX_HORIZONTAL_COLS = 2048;
    let horizontalCanScrollRight = $state(false);
    let horizontalViewport: HTMLElement | undefined;
    let horizontalStateFrame: number | undefined;

    function getHorizontalViewport(): HTMLElement | undefined {
        // `.xterm-viewport` y `.xterm-screen` son hermanos: el primero solo
        // desplaza el scrollback vertical y nunca llega a contabilizar el
        // ancho del lienzo. El contenedor que sí envuelve ambos es
        // `terminalHost`, por lo que ahí vive el eje horizontal.
        return terminalHost ?? horizontalViewport;
    }

    function terminalCellWidth(): number {
        const core = (term as any)?._core;
        return core?._renderService?.dimensions?.css?.cell?.width ?? 0;
    }

    /** Solo las líneas de la pantalla actual pueden pedir ancho adicional.
     *
     * Las continuaciones visibles se reúnen para que Ayuda y salidas largas
     * sigan desplazándose horizontalmente sin saltos. Ignorar el scrollback
     * fuera del viewport evita que una línea antigua o un comando largo
     * mantenga la PTY sobredimensionada y haga que programas nuevos calculen
     * barras de progreso fuera de la ventana.
     */
    function longestVisibleLineWidth(): number {
        if (!term) return 0;
        const terminal = term;
        const buffer = terminal.buffer.active;
        const cursorAbsoluteRow = buffer.baseY + buffer.cursorY;
        return longestVisibleLogicalLineWidth(
            buffer.length,
            buffer.viewportY,
            terminal.rows,
            (row) => {
                const line = buffer.getLine(row);
                let columns = line
                    ? occupiedTerminalColumns(line, terminal.cols, MAX_HORIZONTAL_COLS)
                    : 0;
                if (row === cursorAbsoluteRow) {
                    // `translateToString(true)` recorta los espacios finales. En
                    // una línea que solo contiene espacios la posición del cursor
                    // es, por tanto, el único dato que conserva el ancho real de
                    // la edición. Reservar una celda extra cuando llega al borde
                    // evita que el siguiente espacio provoque un salto de línea.
                    const cursorWidth = buffer.cursorX + (buffer.cursorX >= terminal.cols - 1 ? 2 : 1);
                    columns = Math.max(columns, cursorWidth);
                }
                return line ? { columns, isWrapped: line.isWrapped } : undefined;
            },
            MAX_HORIZONTAL_COLS,
        );
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
            if (line && occupiedTerminalColumns(line, term.cols, MAX_HORIZONTAL_COLS) > visibleCols) return true;
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
        horizontalCanScrollRight = canScrollRight && visibleLineNeedsHorizontalScroll(viewport);
        if (host) host.dataset.horizontalOverflow = String(horizontalCanScrollRight);
    }

    function scheduleHorizontalScrollState(): void {
        if (horizontalStateFrame !== undefined) return;
        horizontalStateFrame = window.requestAnimationFrame(updateHorizontalScrollState);
    }

    function onHorizontalViewportScroll(): void {
        scheduleHorizontalScrollState();
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
        scheduleHorizontalScrollState();
    }

    function keepCursorHorizontallyVisible(): void {
        const viewport = getHorizontalViewport();
        const cellWidth = terminalCellWidth();
        if (!viewport || !cellWidth || !term) return;
        const cursorLeft = term.buffer.active.cursorX * cellWidth;
        const cursorRight = cursorLeft + cellWidth;
        if (cursorLeft < viewport.scrollLeft) viewport.scrollLeft = cursorLeft;
        else if (cursorRight > viewport.scrollLeft + viewport.clientWidth) {
            viewport.scrollLeft = cursorRight - viewport.clientWidth;
        }
        scheduleHorizontalScrollState();
    }

    function horizontalResizeNeeded(): boolean {
        const viewport = getHorizontalViewport();
        const cellWidth = terminalCellWidth();
        if (!viewport || !cellWidth || !term) return false;
        const visibleCols = Math.max(1, Math.floor(viewport.clientWidth / cellWidth));
        return longestVisibleLineWidth() > Math.max(visibleCols, term.cols);
    }

    // WebView2 puede conservar una textura parcial de xterm justo después de
    // cambiar el número de columnas. El árbol accesible ya contiene toda la
    // línea, pero el canvas aún muestra huecos (se pierden fragmentos de
    // «Muestra... scrollback» hasta el siguiente repintado). Invalidar la
    // atlas y refrescar en varios frames hace atómica la transición visual.
    function refreshTerminalViewport(): void {
        if (destroyed || !term) return;
        try {
            // Al dividir un panel, xterm puede conservar la columna horizontal
            // que estaba visible en la geometría anterior. La textura se
            // repinta correctamente, pero comienza a mitad de cada línea (el
            // síntoma era «r|close>» en vez de «:panel ... <close>»). Siempre
            // volver al margen izquierdo antes de invalidar el atlas.
            const viewport = getHorizontalViewport();
            if (viewport) viewport.scrollLeft = 0;
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

    function releaseInput(): void {
        if (destroyed || inputReady || environmentSwitchPending) return;
        inputReady = true;
        exposeInputMirror('ready');
        if (inputReadyTimer) window.clearTimeout(inputReadyTimer);
        inputReadyTimer = undefined;
        if (queuedInput) {
            const pending = queuedInput;
            queuedInput = '';
            void api.sendInput(tabId, pending);
        }
    }

    function scheduleInputReleaseFallback(): void {
        if (destroyed || inputReady) return;
        if (inputReadyTimer) window.clearTimeout(inputReadyTimer);
        inputReadyTimer = window.setTimeout(() => {
            inputReadyTimer = undefined;
            releaseInput();
        }, 8000);
    }

    function isSpaceKey(event: KeyboardEvent): boolean {
        // WebKitGTK release puede entregar una tecla física con `key` y
        // `code` vacíos, aunque conserva los códigos DOM heredados. Sin esta
        // última ruta xterm no recibe ningún `onData` para Space.
        return event.code === 'Space'
            || event.key === ' '
            || event.key === 'Spacebar'
            || event.keyCode === 32
            || event.charCode === 32
            || event.which === 32;
    }

    function sendExplicitSpace(): void {
        userEditing = true;
        if (mirroredLine !== null) mirroredLine += ' ';
        exposeInputMirror(inputReady ? 'ascii' : 'startup-space');
        if (!inputReady) {
            queuedInput += ' ';
            return;
        }
        term?.scrollToBottom();
        pendingExplicitSpaces += 1;
        if (explicitSpaceTimer === undefined) {
            explicitSpaceTimer = window.setTimeout(() => {
                explicitSpaceTimer = undefined;
                flushExplicitSpaces();
            }, 8);
        }
    }

    function flushExplicitSpaces(): void {
        if (pendingExplicitSpaces === 0) return;
        const spaces = ' '.repeat(pendingExplicitSpaces);
        pendingExplicitSpaces = 0;
        if (explicitSpaceTimer !== undefined) {
            window.clearTimeout(explicitSpaceTimer);
            explicitSpaceTimer = undefined;
        }
        void api.sendInput(tabId, spaces);
    }

    function onTerminalOutputBusy(event: Event): void {
        if (!eventBelongsToPane(event)) return;
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
        lastOutputFinishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        scheduleHorizontalScrollState();
        // La línea puede haber llegado partida con el ancho anterior. Esperar
        // al siguiente intervalo tranquilo deja que xterm termine de llenar
        // el buffer antes de calcular su ancho lógico y rehacer el fit.
        const needsHorizontalResize = horizontalResizeNeeded();
        if (needsHorizontalResize) fitAfterOutput = true;
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
                requestAnimationFrame(() => fitAndReport());
            }, needsHorizontalResize ? 0 : 250);
        }
        if (!pendingBannerPrint || userEditing || bannerRefreshInFlight) return;
        pendingBannerPrint = false;
        requestAnimationFrame(() => requestBannerPrint());
    }

    function onEnvironmentSwitchStarted(event: Event): void {
        const detail = (event as CustomEvent<{ tabId?: string; requestId?: number }>).detail;
        if (detail?.tabId !== tabId || typeof detail.requestId !== 'number') return;
        environmentSwitchRequestId = detail.requestId;
        if (!environmentSwitchPending) {
            environmentSwitchSnapshot = {
                inputReady,
                queuedInput,
                mirroredLine,
                userEditing,
            };
        }
        environmentSwitchPending = true;
        if (host) host.dataset.environmentSwitchRequestId = String(detail.requestId);
        // La sonda de recuperación pertenece a la shell inicial. Si sobrevive
        // a un cambio de entorno, podría enviar Enter a la shell nueva antes
        // de que termine su inicializador.
        if (initialPromptTimer) window.clearTimeout(initialPromptTimer);
        initialPromptTimer = undefined;
        // La misma instancia de xterm se reutiliza al cambiar de entorno. Su
        // estado de edición, temporizadores y cola de entrada también tienen
        // que empezar una nueva época; de lo contrario el prompt de la shell
        // anterior puede conservar un espejo de texto o liberar una tecla en la
        // sesión recién creada.
        mirroredLine = '';
        userEditing = false;
        queuedInput = '';
        inputReady = false;
        if (inputReleaseTimer) {
            window.clearTimeout(inputReleaseTimer);
            inputReleaseTimer = undefined;
        }
        if (explicitSpaceTimer !== undefined) {
            window.clearTimeout(explicitSpaceTimer);
            explicitSpaceTimer = undefined;
        }
        pendingExplicitSpaces = 0;
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
        environmentSwitchSnapshot = undefined;
        inputReady = false;
        queuedInput = '';
        mirroredLine = '';
        userEditing = false;
        pendingExplicitSpaces = 0;
        if (explicitSpaceTimer !== undefined) {
            window.clearTimeout(explicitSpaceTimer);
            explicitSpaceTimer = undefined;
        }
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
        const environmentId = app.tabs.find((tab) => tab.id === tabId)?.envId;
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
        return false;
    }

    function currentEditableLine(): string | null {
        if (!term) return null;
        const buffer = term.buffer.active;
        const cursorRow = buffer.baseY + buffer.cursorY;
        const line = buffer.getLine(cursorRow)?.translateToString(true).trimEnd() ?? '';
        if (!line) return null;
        const environmentId = app.tabs.find((tab) => tab.id === tabId)?.envId;
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

    function paneIsRepl(): boolean {
        const tab = app.tabs.find((candidate) => candidate.id === tabId);
        const environment = app.environments.find((candidate) => candidate.id === tab?.envId);
        // Durante los primeros frames `listEnvironments` puede seguir en
        // segundo plano y todavía no haber rellenado `app.environments`. La
        // etiqueta de la pestaña ya viene en `listTabs`/`env-changed`, así que
        // sirve como respaldo inequívoco para no volver a esperar un fastfetch
        // que ese REPL nunca va a recibir.
        return environment?.repl === true
            || environment?.kind === 'repl'
            || /(?:·|\u2022)\s*REPL\s*$/iu.test(tab?.label ?? '');
    }

    function terminalStartupReady(): boolean {
        if (!term) return false;
        // Las shells normales esperan a que termine el fastfetch para no
        // liberar el primer comando encima del banner. Un REPL no lo recibe:
        // su criterio de disponibilidad es únicamente que su prompt (`>>>`,
        // `irb(main):001>`, etc.) ya esté visible.
        if (paneIsRepl()) return terminalPromptVisible();
        // Si el usuario ha desactivado el banner, no existe ningún bloque que
        // esperar: exigir todavía el título de fastfetch retenía la entrada
        // hasta el temporizador de seguridad y hacía parecer que un resize o
        // el botón de dividir "despertaba" una shell que ya estaba lista.
        if (app.preferences?.showSystemBanner === false) return terminalPromptVisible();
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

    function fitAndReport(minimumCols = 0): void {
        if (destroyed || !term || !fitAddon || !active) return;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // Cuando el cursor alcanza el borde, esperar el debounce normal puede
        // dejar que el siguiente espacio se envuelva en una fila nueva antes
        // de ampliar la rejilla. Las ampliaciones horizontales se pueden
        // aplicar en cuanto xterm terminó de procesar la salida.
        const needsHorizontalResize = horizontalResizeNeeded();
        const needsImmediateInputResize = minimumCols > term.cols;
        if (!needsImmediateInputResize
            && (terminalOutputBusy || (now - lastOutputFinishedAt < 250 && !needsHorizontalResize))) {
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
                const longestLine = longestVisibleLineWidth();
                dims.cols = Math.min(
                    MAX_HORIZONTAL_COLS,
                    Math.max(dims.cols, longestLine, minimumCols),
                );
                term.resize(dims.cols, dims.rows);
                if (wasAtBottom) term.scrollToBottom();
            } else {
                fitAddon.fit();
                // Durante una transición de layout FitAddon puede no poder
                // proponer dimensiones todavía. La reserva solicitada por la
                // entrada no puede perderse por ese frame intermedio.
                if (minimumCols > term.cols) term.resize(minimumCols, term.rows);
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
                // El resize del PTY puede provocar un repintado propio de
                // ConPTY después del resize local de xterm. Volver a invalidar
                // el canvas cuando termina esa llamada evita que ese segundo
                // frame deje filas históricas parcialmente dibujadas.
                scheduleTerminalRepaint();
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
        }, minimumCols > 0 || isInitialResize ? 0 : 250);
    }

    onMount(() => {
        destroyed = false;
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
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(terminalHost);
        // En algunos WebView release la tecla Space no llega al manejador
        // interno de xterm. Capturarla en el DOM del panel, antes de xterm y
        // de los atajos globales, mantiene la entrada igual en AppImage y
        // Windows empaquetado.
        terminalSpaceHandler = (event: KeyboardEvent) => {
            if (event.type !== 'keydown'
                && event.type !== 'keypress') return;
            if (!terminalHost.contains(event.target as Node)
                || !isSpaceKey(event)
                || event.ctrlKey
                || event.altKey
                || event.metaKey) return;
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            // Algunos WebKit antiguos emiten keypress además de keydown. Es
            // la vía de respaldo cuando keydown no trae una tecla legible,
            // pero nunca debe duplicar una pulsación ya capturada.
            if (event.type === 'keypress') {
                if (now - lastExplicitSpaceKeydownAt < 100) {
                    // Consumir también el evento descartado: si llega a xterm,
                    // su manejador keypress volvería a enviar ese espacio.
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
            } else {
                lastExplicitSpaceKeydownAt = now;
            }
            event.preventDefault();
            event.stopPropagation();
            sendExplicitSpace();
        };
        window.addEventListener('keydown', terminalSpaceHandler, true);
        window.addEventListener('keypress', terminalSpaceHandler, true);
        horizontalViewport = terminalHost;
        horizontalViewport?.addEventListener('scroll', onHorizontalViewportScroll, { passive: true });
        horizontalViewport?.addEventListener('wheel', onTerminalWheel, { capture: true, passive: false });
        term.onRender(() => scheduleHorizontalScrollState());
        term.onScroll(() => scheduleHorizontalScrollState());
        term.onCursorMove(() => {
            keepCursorHorizontallyVisible();
            scheduleHorizontalScrollState();
        });
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
                exposeInputMirror('startup-queued');
                return;
            }
            // Los espacios capturados en el DOM se agrupan durante una ráfaga.
            // Vaciarla antes de cualquier otra tecla conserva el orden exacto
            // de `ls   -la` y evita perder eventos IPC consecutivos en builds
            // release de WebKit.
            flushExplicitSpaces();
            // Si el usuario había desplazado el historial, cualquier entrada
            // nueva debe devolverle a la línea que está editando.
            term?.scrollToBottom();
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
            // Reservar columnas antes de entregar la tecla a la PTY evita que
            // la shell alcance a ecoar el siguiente espacio con la anchura
            // antigua. Es especialmente importante al pegar una línea larga:
            // xterm puede ampliarse en este mismo frame y el backend recibe el
            // resize antes de pintar el eco.
            const printableInput = mirroredData.replace(/[\x00-\x1f\x7f]/g, '');
            if (printableInput) {
                const cursorColumn = term?.buffer.active.cursorX ?? 0;
                const requiredColumns = Math.min(MAX_HORIZONTAL_COLS, cursorColumn + printableInput.length + 2);
                if (requiredColumns > (term?.cols ?? 0)) fitAndReport(requiredColumns);
            }
            void api.sendInput(tabId, data);
        });

        // Las acciones de navegación no se resuelven aquí: App.svelte las
        // captura una sola vez, antes del textarea oculto de xterm, y consulta
        // el mapa configurable de preferencias. Mantener otra ruta fija por
        // panel hacía que una combinación pudiera navegar y, a la vez, llegar
        // a la shell según qué nodo recibiera primero el evento.
        // Devolver false impide que xterm procese además las acciones locales.
        term.attachCustomKeyEventHandler((event) => {
            // WebKitGTK en builds optimizadas puede no convertir la tecla
            // Space en un evento `onData`, aunque sí entregue las letras. La
            // consecuencia es especialmente engañosa: `ls` aparece, pero el
            // cursor no avanza al pulsar espacio. Consumir únicamente este
            // caso y reenviarlo explícitamente conserva el comportamiento de
            // la shell sin duplicarlo en las versiones que sí lo reportan.
            if (event.type === 'keydown'
                && isSpaceKey(event)
                && !event.ctrlKey
                && !event.altKey
                && !event.metaKey) {
                sendExplicitSpace();
                return false;
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

        // Algunas instalaciones de cmd tardan varios segundos en terminar
        // los alias de arranque y no emiten el primer prompt tras el marcador
        // de limpieza. Un único reintento tardío evita dejar el panel sin
        // entrada, sin participar en ningún resize posterior. Nunca debe
        // inyectar Enter mientras el usuario ya está editando una línea:
        // con una ráfaga larga de espacios ese Enter ejecutaría el comando a
        // mitad de la escritura y parecería que se han perdido teclas.
        initialPromptTimer = window.setTimeout(() => {
            initialPromptTimer = undefined;
            if (!destroyed
                && !userEditing
                && pendingExplicitSpaces === 0
                && !terminalPromptVisible()) {
                void api.sendInput(tabId, '\r');
                window.setTimeout(() => {
                    if (!destroyed) terminalPromptVisible();
                }, 300);
            }
        }, 4500);

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
        window.removeEventListener('resize', onWindowResize);
        window.removeEventListener('focus', onWindowFocus);
        document.removeEventListener('visibilitychange', onDocumentVisibilityChange);
        if (resizeTimer) clearTimeout(resizeTimer);
        if (fitQuietTimer) window.clearTimeout(fitQuietTimer);
        if (repaintTimer) window.clearTimeout(repaintTimer);
        if (bannerActivationTimer) window.clearTimeout(bannerActivationTimer);
        if (inputReadyTimer) window.clearTimeout(inputReadyTimer);
        if (inputReleaseTimer) window.clearTimeout(inputReleaseTimer);
        if (explicitSpaceTimer !== undefined) window.clearTimeout(explicitSpaceTimer);
        pendingExplicitSpaces = 0;
        if (initialPromptTimer) clearTimeout(initialPromptTimer);
        if (resizeObserverFrame !== undefined) window.cancelAnimationFrame(resizeObserverFrame);
        if (resumeRefreshFrame !== undefined) window.cancelAnimationFrame(resumeRefreshFrame);
        if (horizontalStateFrame !== undefined) window.cancelAnimationFrame(horizontalStateFrame);
        horizontalViewport?.removeEventListener('scroll', onHorizontalViewportScroll);
        horizontalViewport?.removeEventListener('wheel', onTerminalWheel, { capture: true });
        if (terminalSpaceHandler) {
            window.removeEventListener('keydown', terminalSpaceHandler, true);
            window.removeEventListener('keypress', terminalSpaceHandler, true);
        }
        terminalSpaceHandler = undefined;
        window.removeEventListener('winslim:terminal-output-busy', onTerminalOutputBusy);
        window.removeEventListener('winslim:terminal-output-idle', onTerminalOutputIdle);
        window.removeEventListener('winslim:environment-switch-started', onEnvironmentSwitchStarted);
        window.removeEventListener('winslim:environment-switch-requested', onEnvironmentSwitchRequested);
        window.removeEventListener('winslim:environment-switch-cancelled', onEnvironmentSwitchCancelled);
        window.removeEventListener('winslim:open-current-directory', onOpenCurrentDirectory);
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
        // El menú incluye la acción de carpeta y mide ~210x170: se aparta de
        // los bordes para que tampoco quede cortado en ventanas pequeñas.
        // El límite horizontal debe usar la anchura nueva (190px mínimo), no
        // la de la versión anterior del menú (150px).
        menu = {
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 206)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180))
        };
        perf.mark('ui.context-menu.open', { tabId, x: event.clientX, y: event.clientY });
    }

    function runMenu(action: 'copy' | 'cut' | 'delete' | 'paste' | 'openDirectory'): void {
        perf.mark('ui.context-menu.action', { tabId, action });
        menu = null;
        if (action === 'copy' && term?.hasSelection()) void api.writeClipboard(term.getSelection());
        else if (action === 'cut') deleteEditableSelection(true);
        else if (action === 'delete') deleteEditableSelection(false);
        else if (action === 'paste') void pasteFromClipboard();
        else if (action === 'openDirectory') {
            void openCurrentDirectory();
            return;
        }
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
        // El explorador sigue la pestaña cuando el usuario vuelve a trabajar
        // en ella, incluso si antes había navegado manualmente a otra carpeta.
        window.dispatchEvent(new CustomEvent('winslim:terminal-focused', { detail: { tabId } }));
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
        term.options.cursorInactiveStyle = cursorInactiveStyle(preferences);
        term.options.scrollback = preferences.terminalScrollback;
        term.options.fontFamily = terminalFont(preferences, app.fonts);
        term.options.fontSize = preferences.terminalFontSize;
        term.options.lineHeight = preferences.terminalLineHeight;
        term.options.letterSpacing = preferences.terminalLetterSpacing;
        term.options.fontWeight = terminalFontWeight(preferences);
        term.options.scrollSensitivity = preferences.terminalScrollSensitivity;
        term.options.theme = terminalTheme(preferences, app.themes);
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
    <div
        class="horizontal-overflow-indicator"
        class:visible={horizontalCanScrollRight}
        aria-hidden="true"
    >
        <span>›</span>
    </div>
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
           el único ancestro común del viewport y de `.xterm-screen`, así que
           debe proporcionar el eje X para que una rejilla ancha no se parta.
           El indicador se pinta por encima en el `.tab-pane`. */
        overflow-x: auto;
        overflow-y: hidden;
    }

    /* El scroll vertical sigue siendo propiedad de xterm; no crear otro eje X
       en este elemento hermano evita dos barras que se desincronicen. */
    .terminal-host :global(.xterm .xterm-viewport) {
        overflow-x: hidden;
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
        min-width: 190px;
        max-width: min(320px, calc(100vw - 16px));
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

    .menu-separator {
        height: 1px;
        margin: 3px 4px;
        background: var(--border);
    }

    .tab-pane.hidden {
        /* `visibility` en vez de `display: none`: xterm necesita que su nodo
           siga teniendo caja para poder medirse cuando vuelva a mostrarse. */
        visibility: hidden;
        pointer-events: none;
    }
</style>
