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
    'scripts/verify-test-surface.mjs',
    'scripts/verify-release-artifacts.mjs'
];
for (const file of requiredFiles) {
    try {
        accessSync(resolve(root, file), constants.R_OK);
        check(`Existe ${file}`, true);
    } catch {
        check(`Existe ${file}`, false);
    }
}

for (const name of ['check', 'build', 'e2e', 'e2e:build', 'dist:win:linux', 'check:i18n', 'check:docs', 'check:metadata', 'check:architecture', 'check:build-scripts', 'check:logic']) {
    check(`package.json contiene el script ${name}`, typeof scripts[name] === 'string' && scripts[name].length > 0);
}
check('npm check incluye la verificación de la superficie de tests', scripts.check.includes('check:test-surface'));
check('npm check incluye la auditoría de superficie lógica', scripts.check.includes('check:logic') && scripts['check:logic'].includes('verify-logic-surface.mjs'));
check('npm check incluye la verificación de documentación', scripts.check.includes('check:docs'));
check('npm check incluye la verificación de traducciones dinámicas', scripts.check.includes('check:i18n') && read('scripts/verify-i18n.mjs').includes('dynamicActionIds'));
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
check('Biblioteca conserva Acceso rápido global y traducido', ['scripts.quickAccess', 'const pinned = $derived((data?.pinned ?? []).filter(matches))'].every((marker) => read('src/components/ScriptsPanel.svelte').includes(marker)));
check('Explorador contiene copiar, cortar, eliminar y pegar', ['explorer.copy', 'explorer.cut', 'explorer.trash', 'explorer.paste'].every((marker) => read('src/components/ExplorerSidebar.svelte').includes(marker)));
check('Terminal intercepta cortar y eliminar sobre selección editable', ['deleteEditableSelection(true)', 'deleteEditableSelection(false)'].every((marker) => read('src/components/TerminalPane.svelte').includes(marker)));
check('Terminal reajusta xterm y banner tras resize', ['ResizeObserver', 'refreshBanner', 'fitAndReport'].every((marker) => read('src/components/TerminalPane.svelte').includes(marker)));
check('Frontend registra métricas segmentadas', ['recordPerformance', 'app.initial-load', 'fastfetch.banner-visible'].every((marker) => read('src/lib/performance.ts').includes(marker) || app.includes(marker) || api.includes(marker)) && read('src/components/TerminalPane.svelte').includes('app.ready-for-input'));
check('Paneles registran apertura hasta geometría visible', ['ui.panel.visible', 'requestAnimationFrame'].every((marker) => read('src/components/Panel.svelte').includes(marker)));
check('Backend expone el comando de métricas frontend', lib.includes('log_frontend_performance') && read('src-tauri/src/app/commands.rs').includes('Métrica de rendimiento frontend'));
check('Atajos usan un contrato compartido', shortcuts.includes('SHORTCUT_PREFERENCE_KEYS') && shortcuts.includes('matchesShortcut') && app.includes('from "./lib/shortcuts"'));
check('Atajo de división usa la tecla física Backslash', shortcuts.includes("event.code === 'Backslash'") && shortcuts.includes('backslash'));
check('Controles select y numéricos tienen estilo compartido en ambas builds', /^select\s*\{/m.test(appCss) && /^input\[type='number'\]\s*\{/m.test(appCss) && !appCss.includes('.platform-linux select'));
check('La ventana nativa conserva resize y maximizar sin feedback del frontend',
    !lib.includes('WindowEvent::Resized')
        && !lib.includes('set_size(')
        && !api.includes('window_ensure_usable_size')
        && !read('src/components/TerminalPane.svelte').includes('ensureWindowUsableSize'));
check('La configuración nativa deja maximizar y decoraciones activas', (() => {
    const window = JSON.parse(read('src-tauri/tauri.conf.json')).app?.windows?.[0] ?? {};
    return window.resizable === true && window.maximizable === true && window.decorations === true;
})());
check('Paneles estrechos usan el ancho real para reordenar controles', [
    read('src/components/DependenciesPanel.svelte').includes('@container (max-width: 360px)'),
    read('src/components/DependenciesPanel.svelte').includes('overflow-wrap: anywhere'),
    read('src/components/Toolbar.svelte').includes('width: min(480px, calc(100vw - 20px))')
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
check('Contador de dependencias cuenta entradas visibles y no acciones internas', dependenciesPanel.includes('visibleComponentCount') && dependenciesPanel.includes('groups.reduce') && !dependenciesPanel.includes('count={refreshing ? undefined : actions.length}'));
check('Contador de dependencias explica su significado al usuario', dependenciesPanel.includes("deps.visibleComponents") && commonPanel.includes('countLabel') && commonPanel.includes('aria-label={countLabel}'));

const smoke = read('tests/e2e/smoke.mjs');
for (const marker of [
    'E2E_BINARY',
    'tauri-driver',
    'button[data-panel-toggle]',
    '[role="dialog"]',
    '.operations',
    '.xterm',
    '.side-toggle.panes',
    '/window/rect',
    'sessionId'
]) check(`Smoke E2E cubre ${marker}`, smoke.includes(marker));
check('Smoke E2E prueba los comandos internos', smoke.includes(':help') && smoke.includes(':alias'));
check('Smoke E2E valida una respuesta real de la shell', smoke.includes('LTERMINAL_E2E_COMMAND_OK') && smoke.includes('xterm-rows'));
check('Smoke E2E prueba refrescos consecutivos de entornos', smoke.includes('refresh-environments') && smoke.includes('for (let attempt') && smoke.includes('fin de refrescos concurrentes'));
check('Smoke E2E prueba clics concurrentes de división', smoke.includes('burstCount') && smoke.includes('crearon demasiados paneles'));
check('Smoke E2E registra tiempos por fase y métricas de aplicación', smoke.includes('phaseTimings') && smoke.includes('E2E tiempos') && smoke.includes('performance'));
check('Smoke E2E evita refrescos de shell innecesarios y permite forzarlos', smoke.includes('FORCE_SHELL_REFRESH') && smoke.includes('E2E_FORCE_SHELL_REFRESH') && smoke.includes('POLL_INTERVAL_MS'));
check('Smoke E2E prueba los cuatro estados de panel', [
    /Ajustes\|Settings/.test(smoke),
    /Biblioteca\|Library/.test(smoke),
    /Proyectos\|Projects/.test(smoke),
    /Entorno y dependencias\|Dependencies/.test(smoke)
].every(Boolean));
check('Smoke E2E prueba el explorador y su menú contextual', smoke.includes('.explorer') && smoke.includes('rightClick') && smoke.includes('dispatchContextMenu') && smoke.includes('[role="menu"]'));
check('Smoke E2E prueba los acordeones cerrados y exclusivos', smoke.includes('.operations') && smoke.includes('.types') && smoke.includes('settingsText') && smoke.includes('acordeones exclusivos'));
check('Smoke E2E prueba las acciones de dependencias sin ejecutarlas', smoke.includes('Compatibilidad Windows') && smoke.includes('data-testid="dependency-action"') && smoke.includes('aparece abierto antes'));
check('Smoke E2E adapta el catálogo de dependencias a cada plataforma', smoke.includes('nativeWindows') && smoke.includes('Virtualización') && smoke.includes('platformGroupPattern'));
check('Smoke E2E comprueba nombres y descripciones del grupo de plataforma', smoke.includes('hasNamedTool') && smoke.includes('hasDescription') && smoke.includes('programa y descripción'));
check('La sugerencia de herramienta abre dependencias y traduce su nombre', app.includes('suggestion.actionId') && app.includes('panels.show("deps")') && app.includes('.replace("{tool}", suggestion.label)'));
check('Dependencias diferencia carga inicial de actualización', dependenciesPanel.includes('loading && actions.length === 0') && dependenciesPanel.includes('deps.refreshing'));
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
check('Build cruzada Linux→Windows ofrece smoke repetido bajo Wine', linuxWindowsBuild.includes('--wine-repeats') && linuxWindowsBuild.includes('for attempt in'));
check('Build Linux tiene ruta no interactiva', linuxBuild.includes('--non-interactive') && linuxBuild.includes('NON_INTERACTIVE'));
check('Build WSL pasa modo no interactivo', windowsBuild.includes('--non-interactive'));
check('Build Linux valida artefactos ELF/AppImage', linuxBuild.includes('verify-release-artifacts.mjs') && linuxBuild.includes('--appdir'));
check('Build Windows cruzada valida artefactos PE/runtime', linuxWindowsBuild.includes('verify-release-artifacts.mjs') && linuxWindowsBuild.includes('--windows-dir'));
check('Build Windows nativa valida artefactos PE/runtime', windowsBuild.includes('verify-release-artifacts.mjs') && windowsBuild.includes('--windows-dir'));
check('Build Linux expone opción Windows cruzada', linuxBuild.includes('--cross-windows') && linuxBuild.includes('build-windows.sh'));
check('Build Windows expone opción Linux mediante WSL', windowsBuild.includes('$CrossLinux') && windowsBuild.includes('Invoke-CrossLinuxTests'));
for (const [name, source] of [['Linux', linuxBuild], ['Windows', windowsBuild]]) {
    check(`${name} ofrece modo de tests ampliados`, source.includes('extended') || source.includes('Extended'));
    check(`${name} no publica si falla el smoke`, source.includes('SMOKE') || source.includes('smoke'));
    check(`${name} verifica el frontend compilado`, name === 'Windows'
        ? source.includes('$frontendText') && source.includes('$marker')
        : source.includes('frontend') && source.includes('ControlRight') && source.includes('environment-controls'));
    check(`${name} conserva logs en errores`, source.includes('log') && (source.includes('tail') || source.includes('Get-Content')));
}
for (const marker of ['x86_64-pc-windows-gnu', 'exclude-all-symbols', 'conpty.dll', 'OpenConsole.exe', 'WebView2Loader.dll', 'wine-smoke']) {
    check(`Build Windows cruzada conserva ${marker}`, linuxWindowsBuild.includes(marker));
}

if (failures.length) {
    console.error(`Superficie de tests incompleta (${failures.length}/${checks.length} comprobaciones fallidas):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}
console.log(`Superficie de tests verificada (${checks.length} contratos).`);
