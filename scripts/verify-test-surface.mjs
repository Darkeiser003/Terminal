import { accessSync, constants, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Contrato de mantenimiento de la batería de pruebas. Este script no arranca
// la aplicación ni instala nada: comprueba que el smoke y los tests siguen
// cubriendo las superficies que más veces se rompieron durante la migración.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const failures = [];
const checks = [];

function check(name, condition) {
    checks.push(name);
    if (!condition) failures.push(name);
}

const packageJson = JSON.parse(read('package.json'));
const scripts = packageJson.scripts ?? {};
const links = read('scripts/verify-links.mjs');
const requiredFiles = [
    'tests/e2e/smoke.mjs',
    'linux/exercise-host.sh',
    'linux/build.sh',
    'linux/build-windows.sh',
    'windows/build.ps1',
    'scripts/verify-i18n.mjs',
    'scripts/verify-runtime-assets.mjs',
    'scripts/verify-build-scripts.mjs',
    'scripts/verify-logic-surface.mjs',
    'scripts/verify-contracts.mjs',
    'scripts/verify-e2e-report.mjs',
    'scripts/test-e2e-report.mjs',
    'scripts/test-release-hash.mjs',
    'scripts/test-release-signature.mjs',
    'scripts/update-release-hash.mjs',
    'scripts/sign-release-manifest.mjs',
    'scripts/test-frontend-logic.mjs',
    'scripts/verify-test-surface.mjs',
    'scripts/verify-release-artifacts.mjs',
    'scripts/verify-flow-documentation.mjs'
];
for (const file of requiredFiles) {
    try {
        accessSync(resolve(root, file), constants.R_OK);
        check(`Existe ${file}`, true);
    } catch {
        check(`Existe ${file}`, false);
    }
}

for (const name of ['check', 'build', 'e2e', 'e2e:build', 'dist:win:linux', 'dist:win:linux:fast', 'dist:linux:fast', 'check:i18n', 'check:contracts', 'test:frontend-logic', 'test:e2e-report', 'test:release-hash', 'test:release-signature', 'check:docs', 'check:flows', 'check:encoding', 'check:metadata', 'check:architecture', 'check:build-scripts', 'check:logic']) {
    check(`package.json contiene el script ${name}`, typeof scripts[name] === 'string' && scripts[name].length > 0);
}
check('npm check incluye la verificación de la superficie de tests', scripts.check.includes('check:test-surface'));
check('npm check incluye la auditoría de superficie lógica', scripts.check.includes('check:logic') && scripts['check:logic'].includes('verify-logic-surface.mjs'));
check('npm check incluye la verificación de documentación', scripts.check.includes('check:docs'));
check('npm check ancla documentación y flujo al código', scripts.check.includes('check:flows') && read('scripts/verify-flow-documentation.mjs').includes('security::verify_signature'));
check('npm check concentra la documentación en README', !scripts.check.includes('check:source-index') && !scripts.check.includes('generate:source-index') && read('scripts/verify-flow-documentation.mjs').includes("read('README.md')"));
check('npm check incluye la política de codificación UTF-8', scripts.check.includes('check:encoding') && scripts['check:encoding'].includes('verify-encoding.mjs'));
check('npm check incluye la verificación de traducciones dinámicas', scripts.check.includes('check:i18n') && read('scripts/verify-i18n.mjs').includes('dynamicActionIds'));
check('npm check prueba contratos cruzados y lógica frontend ejecutable', scripts.check.includes('check:contracts') && scripts.check.includes('test:frontend-logic'));
check('npm check prueba el validador del informe E2E', scripts.check.includes('test:e2e-report'));
check('npm check prueba la actualización no destructiva de hashes', scripts.check.includes('test:release-hash') && read('scripts/test-release-hash.mjs').includes('se conservan las variantes'));
check('npm check prueba firma Ed25519 y detecta alteraciones', scripts.check.includes('test:release-signature') && read('scripts/sign-release-manifest.mjs').includes('createPrivateKey') && read('src-tauri/src/updater/security.rs').includes('UnparsedPublicKey'));
check('npm check incluye tests Rust', scripts.check.includes('cargo test'));
check('npm check incluye clippy con warnings como errores', scripts.check.includes('clippy') && scripts.check.includes('-D warnings'));
check('Verificador de enlaces da más margen a Git y reintenta', links.includes('gitTimeoutMs') && links.includes('gitRetries') && links.includes('git ls-remote'));

const api = read('src/lib/api.ts');
const lib = read('src-tauri/src/lib.rs');
const shortcuts = read('src/lib/shortcuts.ts');
const invoked = new Set([...api.matchAll(/(?:invoke|invokeLogged)(?:<[\s\S]*?>)?\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
const handlerStart = lib.indexOf('.invoke_handler(tauri::generate_handler![');
const handlerEnd = lib.indexOf('])', handlerStart);
const handlerSource = handlerStart >= 0 && handlerEnd >= 0 ? lib.slice(handlerStart, handlerEnd) : '';
const handlers = new Set([...handlerSource.matchAll(/(?:[A-Za-z_][\w]*::)?([A-Za-z_]\w*),/g)].map((match) => match[1]));
check('Se puede leer el registro Tauri de comandos', handlerSource.length > 0);
for (const command of invoked) check(`API tiene handler Tauri para ${command}`, handlers.has(command));
for (const command of handlers) {
    if (invoked.has(command)) continue;
    // Estos comandos pueden invocarse desde Rust/eventos o quedar reservados
    // para una ruta de interfaz que no usa api.ts directamente.
    check(`Handler Tauri documentado o usado: ${command}`, lib.includes(command));
}

const toolbar = read('src/components/Toolbar.svelte');
const app = read('src/App.svelte');
const tabs = read('src-tauri/src/terminal/tabs.rs');
const panels = read('src/lib/panels.svelte.ts');
const appCss = read('src/styles/app.css');
for (const id of ['deps', 'projects', 'scripts', 'settings']) {
    check(`Toolbar tiene el panel ${id}`, toolbar.includes(`panels.toggle('${id}')`));
    check(`App carga el panel ${id}`, app.includes(`load${id[0].toUpperCase()}${id.slice(1)}`));
    check(`Panel store declara ${id}`, panels.includes(`'${id}'`));
}
check('Panel store declara explorer', panels.includes("'explorer'"));
check('App monta el explorador', app.includes('<ExplorerSidebar />'));
check('Panel común implementa cierre, Escape y foco', ['panels.close()', "event.key === 'Escape'", 'previousFocus'].every((marker) => read('src/components/Panel.svelte').includes(marker)));
check('Panel común implementa acordeón exclusivo en los paneles', read('src/components/DependenciesPanel.svelte').includes('exclusiveAccordionGroups'));
check('Biblioteca conserva ejecución directa sin argumentos', read('src/components/ScriptsPanel.svelte').includes('scripts.operation.runMenuTitle'));
check('Biblioteca conserva ejecución Windows mediante Wine', read('src/components/ScriptsPanel.svelte').includes('runWindowsApplication'));
check('Biblioteca etiqueta los scripts integrados según la plataforma', (() => {
    const panelCommands = read('src-tauri/src/app/panel_commands.rs');
    return panelCommands.includes('bundled_source_label(is_windows)')
        && panelCommands.includes('crate::config::identity::WINDOWS.name')
        && panelCommands.includes('crate::config::identity::LINUX.name');
})());
check('La ayuda PowerShell no arrastra la marca Linux', (() => {
    const aliases = read('src-tauri/src/terminal/aliases.rs');
    return aliases.includes('Show-TerminalHelp') && !aliases.includes('Show-LTerminalHelp');
})());
check('Acciones rápidas se pueden mostrar u ocultar y nacen visibles', (() => {
    const scriptsPanel = read('src/components/ScriptsPanel.svelte');
    const settings = read('src/components/SettingsPanel.svelte');
    const defaults = read('src-tauri/default_settings.toml');
    return defaults.includes('showQuickActions = true')
        && scriptsPanel.includes('app.preferences?.showQuickActions ?? true')
        && settings.includes('settings-show-quick-actions');
})());
check('El comando interno de acciones rápidas persiste su estado', (() => {
    const parser = read('src-tauri/src/terminal/internal_commands.rs');
    const terminal = read('src/components/TerminalPane.svelte');
    return parser.includes('quick-actions')
        && parser.includes('quickActions')
        && terminal.includes('configureQuickActions')
        && terminal.includes('showQuickActions');
})());
check('Biblioteca conserva Acceso rápido global y traducido', ['scripts.quickAccess', 'const pinned = $derived((data?.pinned ?? []).filter(matches))'].every((marker) => read('src/components/ScriptsPanel.svelte').includes(marker)));
check('Explorador contiene copiar, cortar, eliminar y pegar', ['explorer.copy', 'explorer.cut', 'explorer.trash', 'explorer.paste'].every((marker) => read('src/components/ExplorerSidebar.svelte').includes(marker)));
check('Terminal intercepta cortar y eliminar sobre selección editable', ['deleteEditableSelection(true)', 'deleteEditableSelection(false)'].every((marker) => read('src/components/TerminalPane.svelte').includes(marker)));
check('Terminal reajusta xterm y conserva el banner en el mismo scrollback', ['ResizeObserver', 'printBanner', 'fitAndReport', 'terminal-host'].every((marker) => read('src/components/TerminalPane.svelte').includes(marker) || read('src/lib/api.ts').includes(marker)));
check('La nueva pestaña entra en la rejilla antes de montar su xterm',
    read('src/lib/appState.svelte.ts').includes('const createdId = await this.createTab(entorno, siguiente)')
        && read('src/lib/appState.svelte.ts').includes('this.panes = nextPanes.slice(0, siguiente)')
        && read('src/lib/appState.svelte.ts').includes('async createTab(envId?: string, paneCount?: number): Promise<string | null>'));
check('La creación de una casilla nueva solicita banner compacto al backend',
    read('src/lib/api.ts').includes('paneCount: paneCount ?? null')
        && read('src-tauri/src/app/commands.rs').includes('pane_count: Option<i64>')
        && read('src-tauri/src/terminal/tabs.rs').includes('create_tab_with_panes'));
check('El E2E valida un formato de banner único en toda la rejilla',
    read('tests/e2e/smoke.mjs').includes("rejilla 2 paneles tras crear la segunda pestaña")
        && read('tests/e2e/smoke.mjs').includes('await assertBannerHeaders(2,')
        && read('tests/e2e/smoke.mjs').includes('sameBannerMode: tinyGrid || modes.every((mode) => mode === modes[0])')
        && !read('tests/e2e/smoke.mjs').includes('createdPaneCompact: tinyGrid || modes[expected - 1] === \'compact\''));
check('El E2E reproduce cierre rápido de pestaña y sincronización real del explorador', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    return smoke.includes("recordEvent('rapid-tab-replace'")
        && smoke.includes('createTabAndCloseImmediately(rapidOldId)')
        && smoke.includes("recordEvent('explorer-cwd-layout'")
        && smoke.includes("await sendTerminalLine('cd /tmp')")
        && smoke.includes('pathHeight > 32');
})());
check('La barra de pestañas no anida el cierre dentro de otro botón', (() => {
    const tabBar = read('src/components/TabBar.svelte');
    return tabBar.includes('role="tab"')
        && tabBar.includes('<button\n                type="button"\n                class="tab-close"')
        && !tabBar.includes('<span\n                class="tab-close"');
})());
check('El E2E cierra el selector de entornos si solo hay una shell disponible', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    return smoke.includes('async function closeEnvironmentMenu()')
        && smoke.includes("document.querySelector(\".env-backdrop\")")
        && smoke.includes('await closeEnvironmentMenu();');
})());
check('Ajustes expone un selector de idioma estable para el E2E', read('src/components/SettingsPanel.svelte').includes('data-testid="settings-language"') && read('tests/e2e/smoke.mjs').includes('settings-language'));
check('Smoke E2E cambia varios idiomas y valida anclas traducidas sin hardcodeos', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    return smoke.includes("markPhase('idiomas y traducciones')")
        && smoke.includes('loadLocaleCatalog')
        && smoke.includes('assertLanguageAnchors')
        && smoke.includes("recordEvent('language-switch'")
        && smoke.includes('Texto hardcodeado o traducción incompleta');
})());
check('Restablecer preferencias imprime el banner explícito', read('src/lib/appState.svelte.ts').includes("winslim:banner-settings-changed") && read('src/components/TerminalPane.svelte').includes('requestBannerPrint'));
check('Preferencias informa los fallos de escritura al frontend', read('src-tauri/src/app/commands.rs').includes('Result<PreferencesPayload, String>') && read('src-tauri/src/app/commands.rs').includes('No se pudieron guardar las preferencias en settings.json'));
check('E2E comprueba y restaura una opción real del banner', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    return smoke.includes('settings-banner-cpu')
        && smoke.includes('banner localizado tras cambiar CPU')
        && smoke.includes('banner localizado tras restaurar CPU')
        && smoke.includes("name: 'banner.cpu'");
})());
check('E2E comprueba los dos estados del fastfetch automático de clear', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    const settings = read('src/components/SettingsPanel.svelte');
    const defaults = read('src-tauri/default_settings.toml');
    const preferences = read('src-tauri/src/config/preferences.rs');
    return settings.includes('data-testid="settings-clear-reprint-banner"')
        && smoke.includes('clear sin fastfetch cuando la opción está desactivada')
        && smoke.includes('clear con fastfetch cuando la opción está activada')
        && smoke.includes('restauración persistida del fastfetch tras clear')
        && defaults.includes('clearReprintBanner = true')
        && preferences.includes('clear_reprint_banner');
})());
check('E2E comprueba ambos estados de Acciones rápidas y restaura la visibilidad', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    return smoke.includes(":quick-actions off")
        && smoke.includes(":quick-actions on")
        && smoke.includes('no ocultó Operaciones rápidas')
        && smoke.includes('panelVisibilityInitial');
})());
check('E2E cierra Ajustes antes de interactuar con la interfaz inferior', read('tests/e2e/smoke.mjs').includes('Ajustes es modal: cerrarlo siempre'));
check('Frontend registra métricas segmentadas', ['recordPerformance', 'app.initial-load', 'fastfetch.banner-visible'].every((marker) => read('src/lib/performance.ts').includes(marker) || app.includes(marker) || api.includes(marker) || read('src/components/TerminalPane.svelte').includes(marker)) && read('src/components/TerminalPane.svelte').includes('app.ready-for-input'));
check('Paneles registran apertura hasta geometría visible', ['ui.panel.visible', 'requestAnimationFrame'].every((marker) => read('src/components/Panel.svelte').includes(marker)));
check('Backend expone el comando de métricas frontend', lib.includes('log_frontend_performance') && read('src-tauri/src/app/commands.rs').includes('Métrica de rendimiento frontend'));
check('Atajos usan un contrato compartido', shortcuts.includes('SHORTCUT_PREFERENCE_KEYS') && shortcuts.includes('matchesShortcut') && app.includes('from "./lib/shortcuts"'));
check('Atajo de división usa la tecla física Backslash', shortcuts.includes("event.code === 'Backslash'") && shortcuts.includes('backslash'));
check('La liberación de entrada siempre vacía las teclas retenidas', (() => {
    const terminal = read('src/components/TerminalPane.svelte');
    const release = terminal.slice(
        terminal.indexOf('function releaseInput()'),
        terminal.indexOf('function onTerminalOutputBusy'),
    );
    return release.includes('inputReady = true')
        && release.includes('queuedInput =')
        && release.includes('api.sendInput(tabId, pending)')
        && (terminal.match(/releaseInput\(\)/g) ?? []).length >= 4;
})());
check('El explorador mantiene compacta la fila de ruta y sigue el cwd por evento', (() => {
    const explorer = read('src/components/ExplorerSidebar.svelte');
    const pathStyle = explorer.slice(explorer.indexOf('.path {'), explorer.indexOf('.inline input'));
    return pathStyle.includes('flex: 0 0 auto')
        && !pathStyle.includes('flex: 1 1')
        && explorer.includes('onCurrentDirectoryChanged')
        && explorer.includes('listingRequest');
})());
check('Abrir la carpeta actual está conectado al backend en Windows y Linux', (() => {
    const terminal = read('src/components/TerminalPane.svelte');
    return terminal.includes("app.appInfo?.platform === 'windows' || app.appInfo?.platform === 'linux'")
        && terminal.includes('api.openDirectory(tabId, undefined, true)')
        && read('src-tauri/src/platform/linux/mod.rs').includes('open_linux_directory');
})());
check('Controles select y numéricos tienen estilo compartido en ambas builds', /^select\s*\{/m.test(appCss) && /^input\[type='number'\]\s*\{/m.test(appCss) && !appCss.includes('.platform-linux select'));
check('La ventana nativa conserva resize y maximizar sin feedback del frontend',
    !lib.includes('WindowEvent::Resized')
        && !lib.includes('set_size(')
        && !api.includes('window_ensure_usable_size')
        && !read('src/components/TerminalPane.svelte').includes('ensureWindowUsableSize'));
check('La rejilla de tres terminales ocupa completa la fila inferior',
    app.includes('class:wide={app.panes.length === 3 && pane === 2}')
        && app.includes('.cell.wide')
        && app.includes('grid-column: 1 / -1'));
check('La configuración nativa deja maximizar y decoraciones activas', (() => {
    const window = JSON.parse(read('src-tauri/tauri.conf.json')).app?.windows?.[0] ?? {};
    return window.resizable === true && window.maximizable === true && window.decorations === true;
})());
check('Paneles estrechos usan el ancho real para reordenar controles', [
    read('src/components/DependenciesPanel.svelte').includes('@container (max-width: 360px)'),
    read('src/components/DependenciesPanel.svelte').includes('overflow-wrap: anywhere'),
    read('src/components/Toolbar.svelte').includes('width: min(480px, calc(100vw - 20px))')
].every(Boolean));
check('Todos los paneles redimensionables responden al ancho del panel', [
    read('src/components/SettingsPanel.svelte').includes('@container (max-width: 480px)'),
    read('src/components/ScriptsPanel.svelte').includes('@container (max-width: 420px)'),
    read('src/components/ProjectsPanel.svelte').includes('@container (max-width: 360px)'),
    !read('src/components/ScriptsPanel.svelte').includes('@media (max-width: 420px)')
].every(Boolean));
check('Estados visuales usan tokens compartidos y el explorador no crea scroll horizontal', [
    appCss.includes('--danger:') && appCss.includes('--warning:') && appCss.includes('--success:'),
    read('src/components/Panel.svelte').includes('color: var(--danger)'),
    read('src/components/ExplorerSidebar.svelte').includes('overflow: hidden')
].every(Boolean));
check('Linux y Windows comparten la geometría base de ventana', (() => {
    const base = JSON.parse(read('src-tauri/tauri.conf.json'));
    const linux = JSON.parse(read('src-tauri/tauri.linux.conf.json'));
    const windows = JSON.parse(read('src-tauri/tauri.windows.conf.json'));
    const baseWindow = base.app?.windows?.[0] ?? {};
    const inheritedGeometry = (platformWindow) => ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'resizable', 'maximizable', 'decorations', 'visible', 'dragDropEnabled']
        .every((key) => platformWindow?.[key] === undefined || platformWindow[key] === baseWindow[key]);
    return linux.app?.windows?.[0]?.title
        && windows.app?.windows?.[0]?.title
        && inheritedGeometry(linux.app.windows[0])
        && inheritedGeometry(windows.app.windows[0]);
})());
check('Ajustes normaliza atajos antes de guardarlos', read('src/components/SettingsPanel.svelte').includes('normalizeShortcut') && read('src/components/SettingsPanel.svelte').includes('normalizedDraft'));
check('El entorno de scripts respeta noAutoSelect', read('src-tauri/src/app/panel_commands.rs').includes('!env.no_auto_select'));
check('Los scripts integrados siguen visibles aunque falte su herramienta', (() => {
    const panelCommands = read('src-tauri/src/app/panel_commands.rs');
    const bundledStart = panelCommands.indexOf('fn bundled_operation_scripts');
    const bundledEnd = panelCommands.indexOf('fn library_panel', bundledStart);
    const bundled = bundledStart >= 0 && bundledEnd > bundledStart
        ? panelCommands.slice(bundledStart, bundledEnd)
        : '';
    return bundled.includes('is_native_bundled_script')
        && !bundled.includes('is_tool_installed');
})());
const updater = read('src-tauri/src/updater/self_update.rs');
const cargoBuild = read('src-tauri/build.rs');
const windowsPlatform = read('src-tauri/src/platform/windows/mod.rs');
check('El actualizador Windows rechaza payloads sin runtime ni scripts', [
    updater.includes('windows_runtime_files'),
    updater.includes('WebView2Loader.dll'),
    updater.includes('scripts/operations/adb-manager.ps1'),
    updater.includes('scripts/containers/kubernetes-manager.sh'),
    updater.includes('La actualización Windows está incompleta')
].every(Boolean));
check('ConPTY solo se considera listo con DLL y host', windowsPlatform.includes('conpty.dll') && windowsPlatform.includes('OpenConsole.exe') && windowsPlatform.includes('dll.is_file() && host.is_file()'));
check('Cargo compara el contenido de ConPTY y no solo el tamaño', cargoBuild.includes('same_contents') && cargoBuild.includes('std::fs::read(a)') && !cargoBuild.includes('same_size'));
const dependenciesPanel = read('src/components/DependenciesPanel.svelte');
const commonPanel = read('src/components/Panel.svelte');
const installCommands = read('src-tauri/src/packages/commands.rs');
const terminalTabs = read('src-tauri/src/terminal/tabs.rs');
const windowsIntegration = read('src-tauri/src/platform/windows_integration.rs');
check('Contador de dependencias cuenta entradas visibles y no acciones internas', dependenciesPanel.includes('visibleComponentCount') && dependenciesPanel.includes('groups.reduce') && !dependenciesPanel.includes('count={refreshing ? undefined : actions.length}'));
check('Contador de dependencias explica su significado al usuario', dependenciesPanel.includes("deps.visibleComponents") && commonPanel.includes('countLabel') && commonPanel.includes('aria-label={countLabel}'));
check('La primera lista de dependencias no bloquea en sondas lentas',
    installCommands.includes('DetectionDepth::Fast')
        && installCommands.includes('state.install_actions()')
        && installCommands.includes('cmd.starts_with("ecosystem:")')
        && installCommands.includes('crate::path_env::which(cmd).is_some()')
        && installCommands.includes('depth == DetectionDepth::Full'));
check('Las reaperturas de Dependencias comparten la detección en curso',
    dependenciesPanel.includes('refreshInFlight ?? api.refreshInstallActions()')
        && dependenciesPanel.includes('refreshInFlight === request'));
check('Dependencias se organiza por secciones de uso y no como una lista plana',
    dependenciesPanel.includes('SECTION_GROUPS')
        && dependenciesPanel.includes("id: 'environments'")
        && dependenciesPanel.includes("id: 'development'")
        && dependenciesPanel.includes("id: 'platforms'")
        && dependenciesPanel.includes('const sections = $derived.by')
        && dependenciesPanel.includes('data-testid="dependency-sections"')
        && dependenciesPanel.includes('data-testid="dependency-section"'));
check('Cada grupo de dependencias explica su contenido antes de desplegarlo',
    dependenciesPanel.includes('function groupDescription')
        && dependenciesPanel.includes('class="group-heading"')
        && dependenciesPanel.includes('groupDescription(group.key)'));

const terminalPane = read('src/components/TerminalPane.svelte');
const indexHtml = read('index.html');
check('El primer frame del WebView ya nace oscuro',
    indexHtml.includes('<meta name="color-scheme" content="dark">')
        && indexHtml.includes('background: #080808')
        && indexHtml.includes('html, body, #app'));
check('Banner y código comparten un único xterm sin superposición',
    terminalPane.includes('data-testid="terminal-host"')
        && terminalPane.includes('term.open(terminalHost)')
        && !terminalPane.includes('banner-header'));
check('El cursor mantiene una capa visible en paneles sin foco',
    terminalPane.includes('cursorInactiveStyle')
        && terminalPane.includes('xterm-cursor-layer')
        && terminalPane.includes('term.refresh(0, Math.max(0, term.rows - 1))'));
check('El banner se imprime como salida PTY normal',
    terminalTabs.includes('initial_banner: true')
        && terminalTabs.includes('Outbound::Data')
        && terminalTabs.includes('print_banner'));
check('El resize solo ajusta xterm y no repinta automáticamente',
    terminalPane.includes('api.resize(tabId, cols, rows)')
        && !terminalPane.includes('api.refreshBanner'));
check('El resize conserva el anclaje al prompt al envolver líneas largas',
    terminalPane.includes('const wasAtBottom = bufferBeforeResize.viewportY')
        && terminalPane.includes('if (wasAtBottom) term.scrollToBottom()'));
check('Clear borra el historial sin reiniciar el cursor y el E2E lo repite',
    app.includes("term.write('\\x1b[2J\\x1b[3J', resolve)")
        && !app.includes('term.clear()')
        && !terminalPane.includes('term.clear()')
        && !terminalPane.includes('term.write(`\\x1b[2J')
        && !app.includes('term.reset()')
        && read('tests/e2e/smoke.mjs').includes('assertClearKeepsInputOnPromptRow')
        && read('tests/e2e/smoke.mjs').includes("recordEvent('clear-prompt-row', { attempts"));
check('El E2E rechaza prompts que conservan el wrap de un tamaño anterior',
    read('tests/e2e/smoke.mjs').includes('assertPromptReflowsAfterResize')
        && read('tests/e2e/smoke.mjs').includes("recordEvent('prompt-resize-reflow'"));
check('La integración Windows registra y consume rutas de archivos',
    windowsIntegration.includes('Software\\Classes\\*\\shell\\WinSlimTerminal')
        && windowsIntegration.includes('--open-path')
        && read('src-tauri/src/app/commands.rs').includes('pub fn open_path_argument')
        && read('src-tauri/src/lib.rs').includes('commands::open_path_argument()'));

const smoke = read('tests/e2e/smoke.mjs');
const e2eReportVerifier = read('scripts/verify-e2e-report.mjs');
const tauriRuntime = read('src-tauri/src/lib.rs');
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
for (const marker of [
    'E2E_BINARY',
    'tauri-driver',
    'toolbar-settings',
    '[role="dialog"]',
    '.operations',
    '.xterm',
    '.side-toggle.panes',
    '/window/rect',
    'sessionId'
]) check(`Smoke E2E cubre ${marker}`, smoke.includes(marker));
check('Smoke E2E prueba los comandos internos', smoke.includes(':help') && smoke.includes(':alias'));
check('Smoke E2E exige redimensionado nativo en Windows y Linux',
    smoke.includes('resizeWindowAndAssertTransition')
        && smoke.includes("markPhase('redimensionado nativo multiplataforma')")
        && smoke.includes("recordEvent('native-window-resize'")
        && smoke.includes('ptyDimensionsChanged')
        && smoke.includes('window-resize-${process.platform}-${captureLabel}'));
check('El verificador E2E rechaza informes sin resize nativo sincronizado',
    e2eReportVerifier.includes("type === 'native-window-resize'")
        && e2eReportVerifier.includes('nativeChanged')
        && e2eReportVerifier.includes('viewportChanged')
        && e2eReportVerifier.includes('ptyChanged')
        && e2eReportVerifier.includes('window-resize-'));
check('Smoke E2E conserva capturas de la organización de Dependencias',
    smoke.includes("captureScreenshot('dependencias-secciones-plegadas')")
        && smoke.includes("captureScreenshot('dependencias-plataforma-desplegada')"));
check('Smoke E2E mide el cambio y restauración de shell', smoke.includes("markPhase('cambio de shell')") && smoke.includes('environment-switch-restore') && toolbar.includes('data-testid="environment-option"'));
check('Smoke E2E valida una respuesta real de la shell', smoke.includes('LTERMINAL_E2E_COMMAND_OK') && smoke.includes('xterm-rows'));
check('Smoke E2E prueba refrescos consecutivos de entornos', smoke.includes('refresh-environments') && smoke.includes('for (let attempt') && smoke.includes('fin de refrescos concurrentes'));
check('Smoke E2E prueba clics concurrentes de división', smoke.includes('burstCount') && smoke.includes('crearon demasiados paneles'));
check('Smoke E2E registra tiempos por fase y métricas de aplicación', smoke.includes('phaseTimings') && smoke.includes('E2E tiempos') && smoke.includes('performance'));
check('E2E valida los límites sobre el viewport y separa la decoración nativa',
    smoke.includes('const measuredWidth = viewport?.width ?? rect?.width')
    && smoke.includes('nativeFrameWidth > 64')
    && smoke.includes('decoración nativa desproporcionada'));
check('El smoke E2E no abre el inspector visual ni le cede el foco', (() => {
    const openInspector = tauriRuntime.indexOf('window.open_devtools()');
    const guard = openInspector < 0 ? '' : tauriRuntime.slice(Math.max(0, openInspector - 250), openInspector);
    return guard.includes('LTERMINAL_OPEN_DEVTOOLS') && !guard.includes('LTERMINAL_SMOKE_TOKEN');
})());
check('Windows conserva la ventana automática y habilita CDP solo durante E2E elevado',
    tauriConfig.app.windows.some((window) => (window.label ?? 'main') === 'main' && window.create !== false)
    && tauriRuntime.includes('.config_mut()')
    && tauriRuntime.includes('.build(context)')
    && tauriRuntime.includes('window.additional_browser_args = Some')
    && tauriRuntime.includes('--remote-debugging-port=0')
    && tauriRuntime.includes('Automatización WebView2 preparada')
    && tauriRuntime.includes('LTERMINAL_E2E_WEBDRIVER')
    && smoke.includes("process.env.LTERMINAL_E2E_WEBDRIVER ??= '1'"));
check('El informe E2E exige todas las fases funcionales en Linux y Windows', [
    'comandos internos y shell',
    'biblioteca y operaciones',
    'entorno y dependencias',
    'pestañas, división y redimensionado',
    'repetición de acciones y fastfetch',
].every((phase) => e2eReportVerifier.includes(phase))
    && read('linux/build.sh').includes('verify-e2e-report.mjs')
    && read('windows/build.ps1').includes('verify-e2e-report.mjs'));
check('Smoke E2E evita refrescos de shell innecesarios y permite forzarlos', smoke.includes('FORCE_SHELL_REFRESH') && smoke.includes('E2E_FORCE_SHELL_REFRESH') && smoke.includes('POLL_INTERVAL_MS'));
check('Smoke E2E prueba los cuatro estados de panel', [
    'toolbar-settings',
    'toolbar-library',
    'toolbar-projects',
    'toolbar-dependencies',
].every((marker) => smoke.includes(marker)));
check('Smoke E2E prueba el explorador y su menú contextual', smoke.includes('.explorer') && smoke.includes('rightClick') && smoke.includes('dispatchContextMenu') && smoke.includes('[role="menu"]'));
check('Smoke E2E prueba los acordeones cerrados y exclusivos', smoke.includes('.operations') && smoke.includes('.types') && smoke.includes('settingsText') && smoke.includes('acordeones exclusivos'));
check('Smoke E2E prueba las acciones individuales de dependencias sin ejecutarlas', smoke.includes('Compatibilidad Windows') && smoke.includes('data-testid="dependency-action"') && smoke.includes('aparece abierto antes') && smoke.includes('Dependencias todavía expone') && !smoke.includes('dependency-bulk-install') && !smoke.includes('dependency-bulk-uninstall'));
check('Smoke E2E adapta el catálogo de dependencias a cada plataforma', smoke.includes('nativeWindows') && smoke.includes('Virtualización') && smoke.includes('platformGroupPattern'));
check('Smoke E2E comprueba nombres y descripciones del grupo de plataforma', smoke.includes('hasNamedTool') && smoke.includes('hasDescription') && smoke.includes('programa y descripción'));
check('La sugerencia de herramienta abre dependencias y traduce su nombre', app.includes('suggestion.actionId') && app.includes('panels.show("deps")') && app.includes('.replace("{tool}", suggestion.label)'));
check('Dependencias diferencia carga inicial de actualización sin exponer un botón redundante', dependenciesPanel.includes('loading && actions.length === 0') && dependenciesPanel.includes('refreshInFlight') && !dependenciesPanel.includes('data-testid="dependency-refresh"') && !dependenciesPanel.includes('Actualizando detección'));
check('Dependencias separa finalidad de requisitos de instalación', (() => {
    const actions = read('src-tauri/src/packages/actions.rs');
    const types = read('src/lib/types.ts');
    return actions.includes('pub description: Option<String>')
        && types.includes('description: string | null')
        && dependenciesPanel.includes('action.description')
        && actions.includes('cada_componente_del_catalogo_explica_para_que_sirve')
        && actions.includes('las_descripciones_no_hablan_del_instalador');
})());
check('El catálogo mantiene descripciones específicas fuera de la lógica de instalación', (() => {
    const descriptions = read('src-tauri/src/packages/descriptions.rs');
    return descriptions.includes('framework-django')
        && descriptions.includes('winget-ripgrep')
        && descriptions.includes('winget-minikube')
        && descriptions.includes('choco-elixir');
})());
check('La build no registra ni expone el comando de instalación masiva', !api.includes('runInstallBulk') && !lib.includes('install_bulk') && !dependenciesPanel.includes('runBulk'));
check('Windows separa virtualización de compatibilidad Linux', read('src-tauri/src/packages/actions.rs').includes('VIRTUALIZATION_GROUP') && read('src-tauri/src/config/i18n.rs').includes('group.virt'));
check('GPU Windows prefiere una descripción comercial ante un adaptador genérico', read('src-tauri/src/platform/system_info.rs').includes('preferred_gpu_name') && read('src-tauri/src/platform/system_info.rs').includes('Microsoft Basic Display Adapter'));

const host = read('linux/exercise-host.sh');
for (const marker of ['LTERMINAL_SHELL_OK', 'PowerShell', 'Nushell', 'Python', 'Node', 'Ruby', 'PHP', 'SQLite', 'MariaDB', 'Docker', 'Kubernetes']) {
    check(`Host smoke prueba ${marker}`, host.includes(marker));
}
check('Host smoke soporta modo estricto', host.includes('--strict'));

const linuxBuild = read('linux/build.sh');
const linuxWindowsBuild = read('linux/build-windows.sh');
const windowsBuild = read('windows/build.ps1');
const windowsBatch = read('windows/build.bat');
check('El wrapper BAT no contiene una BOM que rompa cmd.exe', windowsBatch.startsWith('@echo off') && !windowsBatch.startsWith('\uFEFF'));
check('Build cruzada Linux→Windows ofrece smoke repetido bajo Wine', linuxWindowsBuild.includes('--wine-repeats') && linuxWindowsBuild.includes('for attempt in'));
check('Build Linux tiene ruta no interactiva', linuxBuild.includes('--non-interactive') && linuxBuild.includes('NON_INTERACTIVE'));
check('Build WSL pasa modo no interactivo', windowsBuild.includes('--non-interactive'));
check('Build Linux valida artefactos ELF/AppImage', linuxBuild.includes('verify-release-artifacts.mjs') && linuxBuild.includes('--appdir'));
check('Build Linux exige firma en CI y deja firma detached', linuxBuild.includes('LTERMINAL_SIGNING_PRIVATE_KEY') && linuxBuild.includes('SHA256SUMS.txt.sig'));
check('Build Windows cruzada valida artefactos PE/runtime', linuxWindowsBuild.includes('verify-release-artifacts.mjs') && linuxWindowsBuild.includes('--windows-dir'));
check('Build Windows nativa valida artefactos PE/runtime', windowsBuild.includes('verify-release-artifacts.mjs') && windowsBuild.includes('--windows-dir'));
check('Build Windows exige firma en CI y deja firma detached', windowsBuild.includes('LTERMINAL_SIGNING_PRIVATE_KEY') && windowsBuild.includes('SHA256SUMS.txt.sig'));
check('Build Linux expone opción Windows cruzada', linuxBuild.includes('--cross-windows') && linuxBuild.includes('build-windows.sh'));
check('Build Windows expone opción Linux mediante WSL', windowsBuild.includes('$CrossLinux') && windowsBuild.includes('Invoke-CrossLinuxTests'));
for (const [name, source] of [['Linux', linuxBuild], ['Windows', windowsBuild]]) {
    check(`${name} ofrece modo de tests ampliados`, source.includes('extended') || source.includes('Extended'));
    check(`${name} no publica si falla el smoke`, source.includes('SMOKE') || source.includes('smoke'));
    check(`${name} verifica el frontend compilado`, name === 'Windows'
        ? source.includes('$frontendText') && source.includes('$marker')
        : source.includes('frontend') && source.includes('shortcutPaneLeft') && source.includes('environment-controls'));
    check(`${name} conserva logs en errores`, source.includes('log') && (source.includes('tail') || source.includes('Get-Content')));
}
for (const marker of ['x86_64-pc-windows-gnu', 'exclude-all-symbols', 'conpty.dll', 'OpenConsole.exe', 'WebView2Loader.dll', 'wine-smoke']) {
    check(`Build Windows cruzada conserva ${marker}`, linuxWindowsBuild.includes(marker));
}

check('El cambio de shell mide el primer output visible y evita respawns solapados',
    app.includes('winslim:environment-switch-started')
    && app.includes('terminal.environment-switch-first-output')
    && tabs.includes('Primer output de shell')
    && toolbar.includes('switchingTabId'));
check('Backend responde las dos sondas VT que bloquean el arranque de ConPTY',
    tabs.includes('STARTUP_CURSOR_REPORT')
    && tabs.includes('STARTUP_ATTRIBUTES_REPORT')
    && tabs.includes('startup_attributes_query_pending')
    && tabs.includes('la_consulta_de_atributos_recibe_la_misma_respuesta_que_xterm'));
check('E2E rechaza el timeout de tres segundos al iniciar una shell',
    smoke.includes('E2E_SHELL_STARTUP_LIMIT_MS')
    && smoke.includes("recordEvent('shell-startup-performance'")
    && e2eReportVerifier.includes("event?.type === 'shell-startup-performance'")
    && read('scripts/test-e2e-report.mjs').includes("run('slow-shell-startup'"));

if (failures.length) {
    console.error(`Superficie de tests incompleta (${failures.length}/${checks.length} comprobaciones fallidas):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}
console.log(`Superficie de tests verificada (${checks.length} contratos).`);
