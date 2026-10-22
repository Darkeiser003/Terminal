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
    'build-tools/build.sh',
    'build-tools/build.ps1',
    'src/PreviewApp.svelte',
    'scripts/build-preview.mjs',
    'scripts/preview.mjs',
    'scripts/test-preview.mjs',
    'scripts/verify-i18n.mjs',
    'scripts/verify-runtime-assets.mjs',
    'scripts/verify-build-scripts.mjs',
    'scripts/verify-logic-surface.mjs',
    'scripts/verify-contracts.mjs',
    'scripts/verify-e2e-report.mjs',
    'scripts/test-e2e-report.mjs',
    'scripts/test-e2e-url-matcher.mjs',
    'scripts/test-e2e-native-driver.mjs',
    'scripts/test-release-hash.mjs',
    'scripts/test-release-publish.mjs',
    'scripts/test-release-manifest.mjs',
    'scripts/test-windows-cross-release.mjs',
    'scripts/package-windows-cross.mjs',
    'scripts/test-release-signature.mjs',
    'scripts/update-release-hash.mjs',
    'scripts/publish-release-artifact.mjs',
    'scripts/create-release-manifest.mjs',
    'scripts/sign-release-manifest.mjs',
    'scripts/sign-release-ssh.mjs',
    'scripts/lib/ssh-signing.mjs',
    'scripts/test-release-ssh-signature.mjs',
    'scripts/test-frontend-logic.mjs',
    'scripts/test-preventive.mjs',
    'scripts/test-install-actions-preventive.mjs',
    'scripts/probe-windows-tools.ps1',
    'scripts/test-ltools-e2e.mjs',
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

for (const name of ['check', 'build', 'build:preview', 'preview', 'e2e', 'e2e:build', 'dist:win:linux', 'dist:win:linux:fast', 'dist:linux:fast', 'check:i18n', 'check:contracts', 'test:frontend-logic', 'test:preventive', 'test:install-actions-preventive', 'test:windows-tools', 'test:preview', 'test:build-menu', 'test:windows-cross-release', 'test:e2e-report', 'test:e2e-url-matcher', 'test:e2e-native-driver', 'test:e2e:ltools', 'test:release-hash', 'test:release-publish', 'test:release-manifest', 'test:release-signature', 'test:release-ssh-signature', 'check:docs', 'check:flows', 'check:encoding', 'check:metadata', 'check:architecture', 'check:build-scripts', 'check:github-security', 'check:logic']) {
    check(`package.json contiene el script ${name}`, typeof scripts[name] === 'string' && scripts[name].length > 0);
}
check('npm check incluye la verificación de la superficie de tests', scripts.check.includes('check:test-surface'));
check('npm check incluye la auditoría de superficie lógica', scripts.check.includes('check:logic') && scripts['check:logic'].includes('verify-logic-surface.mjs'));
check('npm check incluye la verificación de documentación', scripts.check.includes('check:docs'));
check('Las builds normales y con checks reducidos ejecutan la auditoría local de GitHub',
    scripts.check.includes('check:github-security')
        && read('linux/build.sh').includes('npm run check:github-security')
        && read('linux/build-windows.sh').includes('npm run check:github-security')
        && read('windows/build.ps1').includes("'check:github-security'"));
check('El escáner zizmor produce SARIF sobre .github y distingue notas informativas',
    read('scripts/verify-github-security.mjs').includes("'--format', 'sarif', '--collect=all', '.github'")
        && read('scripts/verify-github-security.mjs').includes("['note', 'none']")
        && read('scripts/verify-github-security.mjs').includes('LTERMINAL_REQUIRE_GITHUB_SECURITY_TOOLS'));
check('GitHub vuelve a escanear en cambios y publica resultados SARIF de zizmor',
    read('.github/workflows/workflow-security.yml').includes('pull_request:')
        && read('.github/workflows/workflow-security.yml').includes('security-events: write')
        && read('.github/workflows/workflow-security.yml').includes('zizmorcore/zizmor-action@'));
check('npm check ancla documentación y flujo al código', scripts.check.includes('check:flows') && read('scripts/verify-flow-documentation.mjs').includes('security::verify_signature'));
check('npm check concentra la documentación en README', !scripts.check.includes('check:source-index') && !scripts.check.includes('generate:source-index') && read('scripts/verify-flow-documentation.mjs').includes("read('README.md')"));
check('npm check incluye la política de codificación UTF-8', scripts.check.includes('check:encoding') && scripts['check:encoding'].includes('verify-encoding.mjs'));
check('npm check incluye la verificación de traducciones dinámicas', scripts.check.includes('check:i18n') && read('scripts/verify-i18n.mjs').includes('dynamicActionIds'));
check('npm check prueba contratos cruzados y lógica frontend ejecutable', scripts.check.includes('check:contracts') && scripts.check.includes('test:frontend-logic'));
check('npm check prueba el validador del informe E2E', scripts.check.includes('test:e2e-report'));
check('El validador acepta y verifica los informes E2E enfocados de matriz de shells',
    read('scripts/verify-e2e-report.mjs').includes("report.focusedScenario === 'environment-shell-matrix'")
        && read('scripts/test-e2e-report.mjs').includes('focusedShellMatrix'));
check('npm check prueba la actualización no destructiva de hashes', scripts.check.includes('test:release-hash') && read('scripts/test-release-hash.mjs').includes('se conservan las variantes'));
check('npm check prueba el reemplazo atómico del AppImage en ejecución', scripts.check.includes('test:release-publish') && scripts['check:local'].includes('test:release-publish') && read('scripts/test-release-publish.mjs').includes('la instancia abierta conserva el inode previo') && read('scripts/publish-release-artifact.mjs').includes('await rename(temporaryPath, destinationPath)'));
check('La publicación combina Linux y Windows en un manifiesto determinista antes de firmarlo', scripts.check.includes('test:release-manifest') && read('scripts/create-release-manifest.mjs').includes('SHA256SUMS.txt') && read('.github/workflows/release.yml').includes('needs: [linux, windows]'));
check('npm check prueba firma Ed25519 y detecta alteraciones', scripts.check.includes('test:release-signature') && read('scripts/sign-release-manifest.mjs').includes('createPrivateKey') && read('src-tauri/src/updater/security.rs').includes('UnparsedPublicKey'));
check('npm check prueba firma OpenSSH y detecta alteraciones', scripts.check.includes('test:release-ssh-signature') && read('scripts/sign-release-ssh.mjs').includes('verify') && read('src-tauri/src/updater/security.rs').includes('verify_ssh_signature'));
check('npm check incluye tests preventivos sin recompilar', scripts.check.includes('test:preventive') && read('scripts/test-preventive.mjs').includes('Tests preventivos OK'));
check('npm check incluye la auditoría preventiva del catálogo y de la última release',
    scripts.check.includes('test:install-actions-preventive')
        && read('scripts/test-install-actions-preventive.mjs').includes('Tests preventivos de acciones y release OK'));
check('npm check incluye tests Rust', scripts.check.includes('cargo test'));
check('npm check incluye clippy con warnings como errores', scripts.check.includes('clippy') && scripts.check.includes('-D warnings'));
check('Verificador de enlaces da más margen a Git y reintenta', links.includes('gitTimeoutMs') && links.includes('gitRetries') && links.includes('git ls-remote'));
// Un repo inexistente citado en el código no puede abrir Git Credential Manager
// (inicio de sesión en el navegador) en mitad del build.
check('Verificador de enlaces sondea Git sin pedir credenciales y los tests de gh usan una cuenta fixture',
    links.includes("const gitNoPromptArgs = ['-c', 'credential.helper=', '-c', 'core.askPass='];")
        && links.includes("GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'")
        && links.includes('[...gitNoPromptArgs, \'ls-remote\'')
        && links.includes('env: gitNoPromptEnv')
        && !read('src-tauri/src/projects/gh_cli.rs').includes('github.com/Romen'));

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
check('Biblioteca conserva ejecución directa de scripts', read('src/components/ScriptsPanel.svelte').includes('onclick={() => run(script, false)}'));
check('Biblioteca no empaqueta ni inyecta scripts operativos de LTerminal', (() => {
    const panelCommands = read('src-tauri/src/app/panel_commands.rs');
    const production = panelCommands.split('#[cfg(test)]')[0];
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    const resources = Object.keys(config.bundle?.resources ?? {});
    return !production.includes('bundled_operation_scripts')
        && !production.includes('scripts/operations')
        && !production.includes('scripts/containers')
        && resources.every((resource) => !resource.includes('scripts/operations') && !resource.includes('scripts/containers'));
})());
check('La ayuda PowerShell no arrastra la marca Linux', (() => {
    const aliases = read('src-tauri/src/terminal/aliases.rs');
    return aliases.includes('Show-TerminalHelp') && !aliases.includes('Show-LTerminalHelp');
})());
check('LTools es la única fuente de acciones fijadas en la Biblioteca', (() => {
    const scriptsPanel = read('src/components/ScriptsPanel.svelte');
    const settings = read('src/components/SettingsPanel.svelte');
    return scriptsPanel.includes('data-testid="scripts-ltools"')
        && !scriptsPanel.includes('data-testid="scripts-quick-operations"')
        && !scriptsPanel.includes('app.preferences?.showQuickActions')
        && !settings.includes('settings-show-quick-actions');
})());
check('La flecha de LTools se espeja como chevrón y no gira un glifo circular', (() => {
    const panel = read('src/components/ScriptsPanel.svelte');
    return panel.includes('class="operations-chevron" aria-hidden="true"></span>')
        && panel.includes('border-right: 1px solid var(--muted)')
        && panel.includes('transform: rotate(225deg)')
        && !panel.includes('transform: rotate(180deg)');
})());
check('LTools se integra desde un catálogo JSON extensible y con límites seguros', (() => {
    const backend = read('src-tauri/src/packages/ltools.rs');
    const types = read('src/lib/types.ts');
    const panel = read('src/components/ScriptsPanel.svelte');
    const selection = read('src/lib/ltools-selection.ts');
    const smoke = read('tests/e2e/smoke.mjs');
    const report = read('scripts/verify-e2e-report.mjs');
    return backend.includes('quick: bool')
        && backend.includes('optional_safe_text')
        && backend.includes('MAX_ARGUMENTS')
        && backend.includes('discovery_directories')
        && backend.includes('LTOOLS_PATH')
        && types.includes('quick: boolean')
        && !panel.includes('MAX_PINNED_LTOOLS_ACTIONS')
        && selection.includes('action.quick')
        && selection.includes('knownIds')
        && panel.includes('filteredLToolsActions')
        && panel.includes('ltoolsActionLabel')
        && panel.includes('ltoolsEnabled')
        && panel.includes('app.preferences?.ltoolsEnabled === true')
        && backend.includes('ltools_enabled')
        && backend.includes('disabled_catalog')
        && read('src-tauri/default_settings.toml').includes('ltoolsEnabled = false')
        && read('src/components/SettingsPanel.svelte').includes('settings-ltools-configure')
        && read('src/components/SettingsPanel.svelte').includes('settings-ltools-enabled')
        && read('src-tauri/src/terminal/internal_commands.rs').includes('"ltools" | "tools"')
        && panel.includes('data-testid="scripts-ltools"')
        && panel.includes('data-testid="scripts-ltools-action"')
        && panel.includes('installLTools')
        && panel.includes("lookupProject('Darkeiser003/Tools')")
        && panel.includes('ltoolsReleaseAsset')
        && smoke.includes('exerciseLToolsIntegration')
        && smoke.includes('exerciseLToolsSettingsRoute')
        && smoke.includes('E2E_LTOOLS_ONLY')
        && smoke.includes('E2E_LTOOLS_SETTINGS_ROUTE_ONLY')
        && smoke.includes('actions run ${chosen.id}')
        && smoke.includes('legacySelectorCount')
        && smoke.includes('installControlVisible')
        && report.includes("focusedScenario === 'ltools-catalog-integration'")
        && report.includes("focusedScenario === 'ltools-settings-route'")
        && read('scripts/test-ltools-e2e.mjs').includes('E2E_LTOOLS_INTEGRATION');
})());
check('El comando antiguo de acciones rápidas queda como compatibilidad sin mutar preferencias', (() => {
    const parser = read('src-tauri/src/terminal/internal_commands.rs');
    const terminal = read('src/components/TerminalPane.svelte');
    return parser.includes('quick-actions')
        && parser.includes('quickActions')
        && terminal.includes('configureQuickActions')
        && terminal.includes('Uso heredado')
        && !terminal.includes('savePreferences({ showQuickActions: next })');
})());
check('Biblioteca conserva Acceso rápido global y traducido', ['scripts.quickAccess', 'const pinned = $derived((data?.pinned ?? []).filter(matches))'].every((marker) => read('src/components/ScriptsPanel.svelte').includes(marker)));
check('Explorador contiene copiar, cortar, eliminar y pegar', ['explorer.copy', 'explorer.cut', 'explorer.trash', 'explorer.paste'].every((marker) => read('src/components/ExplorerSidebar.svelte').includes(marker)));
check('El menú contextual de la terminal abre Ajustes también en modo limpio', (() => {
    const terminal = read('src/components/TerminalPane.svelte');
    const smoke = read('tests/e2e/smoke.mjs');
    return terminal.includes("runMenu('settings')")
        && terminal.includes("winslim:open-settings")
        && smoke.includes("terminalMenuText.includes(settingsLabel)");
})());
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
check('El E2E conserva el historial anterior y exige cabecera en la pestaña nueva',
    read('tests/e2e/smoke.mjs').includes('const splitStatus = await assertPaneOutputStable(2,')
        && read('tests/e2e/smoke.mjs').includes('splitStatus.headers[1]')
        && read('tests/e2e/smoke.mjs').includes('La segunda pestaña no mostró su cabecera inicial'));
check('El E2E reproduce cierre rápido de pestaña y sincronización real del explorador', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    return smoke.includes("recordEvent('rapid-tab-replace'")
        && smoke.includes('createTabAndCloseImmediately(rapidOldId)')
        && smoke.includes("recordEvent('explorer-cwd-layout'")
        && smoke.includes("recordEvent('explorer-double-click'")
        && smoke.includes("gesture: 'pointerMove → pointerDown → pointerUp × 2'")
        && smoke.includes('async function doubleClick(element)')
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
check('Ajustes guarda cambios automáticamente y expone su estado', (() => {
    const settings = read('src/components/SettingsPanel.svelte');
    const smoke = read('tests/e2e/smoke.mjs');
    return settings.includes('scheduleAutoSave')
        && settings.includes('data-testid="settings-autosave"')
        && !settings.includes('data-testid="settings-save"')
        && smoke.includes('waitForSettingsAutosave');
})());
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
check('E2E enfocado valida modo de terminal limpia, layout y recuperación', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    const report = read('scripts/verify-e2e-report.mjs');
    const fixture = read('scripts/test-e2e-report.mjs');
    return smoke.includes('E2E_TERMINAL_ONLY_ONLY')
        && smoke.includes("recordEvent('terminal-only-mode'")
        && smoke.includes("captureScreenshot('terminal-only-mode')")
        && smoke.includes("captureScreenshot('terminal-only-restored')")
        && report.includes("focusedScenario === 'terminal-only-mode'")
        && fixture.includes('focusedTerminalOnly');
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
check('El modo de terminal limpia conserva una ruta de recuperación y ocupa la ventana completa', (() => {
    const appSource = read('src/App.svelte');
    const state = read('src/lib/appState.svelte.ts');
    const defaults = read('src-tauri/default_settings.toml');
    const es = read('src-tauri/locales/es.json');
    return appSource.includes('data-window-mode')
        && appSource.includes('main.terminal-only .workspace')
        && appSource.includes('main.terminal-only .grid')
        && appSource.includes('terminal-only-guide')
        && appSource.includes('terminal-only-guide-dismiss')
        && appSource.includes('terminal-only-guide-never')
        && appSource.includes('hideTerminalOnlyGuideForSession')
        && appSource.includes('showTerminalOnlyGuide')
        && read('src/components/SettingsPanel.svelte').includes('settings-terminal-only-guide')
        && defaults.includes('showTerminalOnlyGuide = true')
        && read('src/lib/shortcuts.ts').includes('shortcutToggleTerminalOnly')
        && defaults.includes('shortcutToggleTerminalOnly = "Ctrl+Shift+M"')
        && es.includes('Ctrl+Shift+M de fábrica');
})());
check('E2E comprueba que LTools sustituye las acciones heredadas', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    const report = read('scripts/verify-e2e-report.mjs');
    return smoke.includes(':quick-actions list')
        && smoke.includes('legacySelectorCount')
        && smoke.includes('legacy-quick-actions-compat')
        && smoke.includes('ocultación de LTools en Ruta actual')
        && report.includes("event?.type === 'ltools-ui-source'")
        && report.includes("event?.type === 'legacy-quick-actions-compat'")
        && report.includes("event?.type === 'ltools-disabled-by-default'")
        && smoke.includes('setLToolsEnabledForE2E(false)')
        && smoke.includes('panelVisibilityInitial');
})());
check('E2E cierra Ajustes antes de interactuar con la interfaz inferior', read('tests/e2e/smoke.mjs').includes('Ajustes es modal: cerrarlo siempre'));
check('Frontend registra métricas segmentadas', ['recordPerformance', 'app.initial-load', 'fastfetch.banner-visible'].every((marker) => read('src/lib/performance.ts').includes(marker) || app.includes(marker) || api.includes(marker) || read('src/components/TerminalPane.svelte').includes(marker)) && read('src/components/TerminalPane.svelte').includes('app.ready-for-input'));
check('Paneles registran apertura hasta geometría visible', ['ui.panel.visible', 'requestAnimationFrame'].every((marker) => read('src/components/Panel.svelte').includes(marker)));
check('Backend expone el comando de métricas frontend', lib.includes('log_frontend_performance') && read('src-tauri/src/app/commands.rs').includes('Métrica de rendimiento frontend'));
check('E2E verifica los espacios en la fila de xterm, no en un espejo diagnóstico', (() => {
    const smoke = read('tests/e2e/smoke.mjs');
    const terminal = read('src/components/TerminalPane.svelte');
    const start = smoke.indexOf('const spaceProbe =');
    const end = smoke.indexOf("recordEvent('space-input-length'", start);
    const probe = start >= 0 && end > start ? smoke.slice(start, end) : '';
    return probe.includes('activeTerminalRowSnapshot()')
        && probe.includes('spaceProbeSnapshot.rows[spaceProbeSnapshot.cursorRow]')
        && probe.includes('spaceProbeCursorRow.includes(spaceProbe)')
        && terminal.includes('white-space: pre !important');
})());
check('Atajos usan un contrato compartido', shortcuts.includes('SHORTCUT_PREFERENCE_KEYS') && shortcuts.includes('matchesShortcut') && app.includes('from "./lib/shortcuts"'));
check('Atajo de división usa la tecla física Backslash', shortcuts.includes("event.code === 'Backslash'") && shortcuts.includes('backslash'));
check('La entrada retenida solo se libera con PTY lista y el fallback conserva la cola', (() => {
    const terminal = read('src/components/TerminalPane.svelte');
    const release = terminal.slice(
        terminal.indexOf('function releaseInput()'),
        terminal.indexOf('function onTerminalOutputBusy'),
    );
    const fallback = terminal.slice(
        terminal.indexOf('function scheduleInputReleaseFallback()'),
        terminal.indexOf('function isSpaceKey'),
    );
    const initialHandshakeStart = terminal.indexOf('void api.markTabReady(tabId)');
    const initialHandshakeCatch = terminal.indexOf('.catch((error) => {', initialHandshakeStart);
    const initialHandshakeCatchEnd = terminal.indexOf('\n            });', initialHandshakeCatch);
    const initialHandshakeFailure = initialHandshakeStart >= 0 && initialHandshakeCatchEnd > initialHandshakeCatch
        ? terminal.slice(initialHandshakeCatch, initialHandshakeCatchEnd)
        : '';
    return release.includes('inputReady = true')
        && release.includes('reportStartupReady(true)')
        && release.includes('queuedInput =')
        && release.includes('api.sendInput(tabId, pending)')
        && fallback.includes('releaseInput()')
        && (fallback.includes('8000') || fallback.includes('35_000') || fallback.includes('35000'))
        && !initialHandshakeFailure.includes('releaseInput()')
        && (terminal.match(/releaseInput\(\)/g) ?? []).length >= 3;
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
check('La Biblioteca no inyecta scripts operativos heredados', (() => {
    const panelCommands = read('src-tauri/src/app/panel_commands.rs');
    const production = panelCommands.split('#[cfg(test)]')[0];
    return production.includes('fn library_panel')
        && !production.includes('fn bundled_operation_scripts')
        && !production.includes('scripts/operations')
        && !production.includes('scripts/containers');
})());
const updater = read('src-tauri/src/updater/self_update.rs');
const cargoBuild = read('src-tauri/build.rs');
const windowsPlatform = read('src-tauri/src/platform/windows/mod.rs');
check('El actualizador Windows rechaza payloads sin runtime', [
    updater.includes('windows_runtime_files'),
    updater.includes('WebView2Loader.dll'),
    !updater.includes('scripts/operations/'),
    !updater.includes('scripts/containers/'),
    updater.includes('La actualización Windows está incompleta')
].every(Boolean));
check('ConPTY solo se considera listo con DLL y host', windowsPlatform.includes('conpty.dll') && windowsPlatform.includes('OpenConsole.exe') && windowsPlatform.includes('dll.is_file() && host.is_file()'));
check('Cargo compara el contenido de ConPTY y no solo el tamaño', cargoBuild.includes('same_contents') && cargoBuild.includes('std::fs::read(a)') && !cargoBuild.includes('same_size'));
const dependenciesPanel = read('src/components/DependenciesPanel.svelte');
const settingsPanel = read('src/components/SettingsPanel.svelte');
const commonPanel = read('src/components/Panel.svelte');
const installCommands = read('src-tauri/src/packages/commands.rs');
const terminalTabs = read('src-tauri/src/terminal/tabs.rs');
const windowsIntegration = read('src-tauri/src/platform/windows_integration.rs');
check('Contador de dependencias cuenta entradas visibles y no acciones internas', dependenciesPanel.includes('visibleComponentCount') && dependenciesPanel.includes('groups.reduce') && !dependenciesPanel.includes('count={refreshing ? undefined : actions.length}'));
check('Contador de dependencias explica su significado al usuario', dependenciesPanel.includes("deps.visibleComponents") && commonPanel.includes('countLabel') && commonPanel.includes('aria-label={countLabel}'));
check('El catálogo inicial de dependencias es ligero y las sondas son explícitas',
    installCommands.includes('pub fn install_catalog')
        && installCommands.includes('pub fn install_check')
        && installCommands.includes('DetectionDepth::Catalog')
        && installCommands.includes('DetectionDepth::Full')
        && dependenciesPanel.includes('api.loadInstallCatalog()')
        && dependenciesPanel.includes('api.checkInstallAction(anchor)'));
check('Las reaperturas de Dependencias no redetectan automáticamente',
    dependenciesPanel.includes('if (!force && refreshedAt > 0)')
        && dependenciesPanel.includes('force\n            ? api.refreshInstallActions()')
        && dependenciesPanel.includes(': api.loadInstallCatalog()')
        && dependenciesPanel.includes('refreshInFlight === request'));
check('Dependencias se organiza por secciones de uso y no como una lista plana',
    dependenciesPanel.includes('SECTION_GROUPS')
        && dependenciesPanel.includes("id: 'environments'")
        && dependenciesPanel.includes("id: 'development'")
        && dependenciesPanel.includes("id: 'platforms'")
        && dependenciesPanel.includes('const sections = $derived.by')
        && dependenciesPanel.includes('data-testid="dependency-sections"')
        && dependenciesPanel.includes('data-testid="dependency-section"'));
check('Dependencias confirma y muestra los menús secuencialmente',
    dependenciesPanel.includes('confirmedSectionIds')
        && dependenciesPanel.includes('visibleSections')
        && dependenciesPanel.includes('async function revealSections')
        && dependenciesPanel.includes('requestAnimationFrame')
        && dependenciesPanel.includes('data-testid="dependency-detection-progress"'));
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
    terminalPane.includes('api.resize(tabId, targetCols, rows)')
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
    windowsIntegration.includes('Software\\Classes\\*\\shell\\WTerminal')
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
        && smoke.includes('hyprland-resizeactive-fallback')
        && smoke.includes("'resizeactive', 'exact'")
        && smoke.includes('window-resize-${process.platform}-${captureLabel}'));
check('E2E completo arrastra el ratón, verifica el resaltado visible y conserva una captura',
    smoke.includes("markPhase('selección de texto mediante arrastre real')")
        && smoke.includes('verifyMouseDragSelection')
        && smoke.includes("captureScreenshot('mouse-selection-drag')")
        && e2eReportVerifier.includes("type === 'terminal-mouse-selection'"));
check('E2E verifica salida PTY repintada sin cambiar layout y conserva captura',
    smoke.includes('terminalOutputRefreshSnapshot()')
        && smoke.includes("captureScreenshot('pty-output-repaint-no-layout-event')")
        && smoke.includes("recordEvent('terminal-output-repaint'")
        && e2eReportVerifier.includes("type === 'terminal-output-repaint'")
        && read('scripts/test-e2e-report.mjs').includes('missing-terminal-output-repaint'));
check('El repintado PTY se agrupa, refresca filas y se recupera al volver de segundo plano',
    read('src/lib/terminal-render.ts').includes('terminal.refresh(0, rows - 1)')
        && read('scripts/test-frontend-logic.mjs').includes('las salidas del mismo frame se agrupan por terminal')
        && read('src/App.svelte').includes('scheduleTerminalRefresh(settled')
        && read('src/components/TerminalPane.svelte').includes('function refreshAfterWindowResume()'));
check('El verificador E2E rechaza informes sin resize nativo sincronizado',
    e2eReportVerifier.includes("type === 'native-window-resize'")
        && e2eReportVerifier.includes('nativeChanged')
        && e2eReportVerifier.includes('viewportChanged')
        && e2eReportVerifier.includes('ptyChanged')
        && e2eReportVerifier.includes('window-resize-'));
check('Smoke E2E conserva capturas de la organización de Dependencias',
    smoke.includes("captureScreenshot('dependencias-secciones-plegadas')")
        && smoke.includes("captureScreenshot('dependencias-plataforma-desplegada')"));
check('Smoke E2E prueba varias shells con comandos reales y restaura la shell inicial',
    smoke.includes("markPhase('cambio de shell')")
        && smoke.includes('exerciseShellMatrix')
        && smoke.includes('environment-probe')
        && smoke.includes('environment-probe-skipped')
        && smoke.includes('probeOutputMarkerRows(output ?? \'\', probe.command, marker)')
        && read('scripts/e2e-environment-probes.mjs').includes('probeOutputContainsMarker')
        && read('scripts/e2e-environment-probes.mjs').includes('probeOutputMarkerRows')
        && smoke.includes('environment-shell-matrix')
        && smoke.includes('environment-switch-restore')
        && smoke.includes('availableOptions.map')
        && smoke.includes('safeEnvironmentMarker')
        && smoke.includes('document.activeElement === arguments[0]')
        && smoke.includes("return 'verified-pointer-fallback'")
        && smoke.includes('terminalFocusMethod')
        && smoke.includes("id === 'wine-cmd'")
        && !read('src-tauri/src/environments/languages.rs').includes('id: "kotlin"')
        && read('scripts/test-e2e-environment-probes.mjs').includes("!allLanguageIds.includes('kotlin')")
        && smoke.includes('originalCaptureLabel')
        && smoke.includes('shell-matrix-${process.platform}-original-selected')
        && toolbar.includes('data-testid="environment-option"'));
check('La matriz compara el nombre visible de la shell sin estrellas ni adornos del selector',
    smoke.includes('.env-copy strong')
        && smoke.includes('.env-select .env-current')
        && smoke.includes('normalizeLabel'));
check('Las sondas de entorno cubren todos los REPL del catálogo o explican un descarte seguro',
    packageJson.scripts?.['test:e2e-environment-probes'] === 'node scripts/test-e2e-environment-probes.mjs'
        && read('scripts/e2e-environment-probes.mjs').includes('serviceBackedRepls')
        && read('scripts/test-e2e-environment-probes.mjs').includes('allLanguageIds.length, 88')
        && read('scripts/test-e2e-environment-probes.mjs').includes("!allLanguageIds.includes('mercury')")
        && read('scripts/test-e2e-environment-probes.mjs').includes('probeOutputHasResultBeforeMarker')
        && smoke.includes('rawTerminalTextWithin(horizontalCell)')
        && e2eReportVerifier.includes('availableIds.some((id) => !accountedIds.includes(id))'));
check('La matriz reconoce prompts especiales de shells y REPLs, con edición de entrada probada',
    read('scripts/e2e-environment-probes.mjs').includes('interactiveReplShellIds')
        && smoke.includes("probe?.kind === 'repl'")
        && smoke.includes("id === 'lang:forth'")
        && smoke.includes("id === 'lang:groovy'")
        && smoke.includes('input-ready-no-prompt')
        && smoke.includes('startupHintVisible')
        && e2eReportVerifier.includes('startupHintCapture === \'shell-lang-forth-startup-help\'')
        && read('src/components/TerminalPane.svelte').includes('interactiveReplPromptIsVisible')
        && read('src/components/TerminalPane.svelte').includes('interactiveReplInputLine')
        && read('src/components/TerminalPane.svelte').includes('interactiveReplBannerSignalsReady')
        && ['specialReplPrompts', 'tcl:', 'maxima:', 'duckdb:', "'common-lisp-sbcl':", "'swi-prolog':", 'forth:']
            .every((marker) => read('src/lib/terminal-prompt.ts').includes(marker))
        && read('scripts/test-frontend-logic.mjs').includes('prompt derecho')
        && read('scripts/test-frontend-logic.mjs').includes('el espejo omite el prompt y conserva la línea editable')
        && read('scripts/test-frontend-logic.mjs').includes('backend dumb sin prompt_toolkit'));
check('La actualización de AppImage vuelve a habilitar ejecución en Linux',
    read('src-tauri/src/updater/commands.rs').includes('make_appimage_executable')
        && read('src-tauri/src/updater/commands.rs').includes('permissions.set_mode(0o755)')
        && read('src-tauri/src/updater/commands.rs').includes('permisos_de_ejecucion_antes_de_instalarse'));
check('Un fallo de la matriz de shells conserva captura antes de restaurar la original',
    smoke.includes('failure-before-restore')
        && smoke.indexOf('failure-before-restore') < smoke.indexOf('let restored = currentId === originalId'));
check('Las líneas largas conservan el scroll horizontal único y no pierden texto',
    read('src/lib/terminal-columns.ts').includes('longestVisibleLogicalLineWidth')
        && read('src/lib/terminal-columns.ts').includes('requiredTerminalColumns')
        && read('src/components/TerminalPane.svelte').includes('longestVisibleLineWidth()')
        && read('src/components/TerminalPane.svelte').includes('terminalHost.dataset.horizontalTail = String(renderContentColumns > visibleCols);')
        && read('src/components/TerminalPane.svelte').includes('let clearPending = false;')
        && read('src/components/TerminalPane.svelte').includes("detail?.kind === 'clear'")
        && read('src/components/TerminalPane.svelte').includes("overflow-x', 'hidden'")
        && read('src/components/TerminalPane.svelte').includes('previousScrollLeft')
        && /overflow-x:\s*auto/.test(read('src/components/TerminalPane.svelte'))
        && read('scripts/test-frontend-logic.mjs').includes('el PTY recupera su ancho mínimo')
        && read('scripts/test-frontend-logic.mjs').includes('una línea antigua fuera de pantalla no fuerza columnas adicionales')
        && smoke.includes("recordEvent('terminal-columns-reclaim'")
        && e2eReportVerifier.includes("type === 'terminal-columns-reclaim'"));
check('El reflow conserva la anchura del eco histórico de un comando largo', (() => {
    const terminal = read('src/components/TerminalPane.svelte');
    const rowMeasure = terminal.slice(terminal.indexOf('const logicalDomColumns ='),
        terminal.indexOf('if (outputBurstWide', terminal.indexOf('const logicalDomColumns =')));
    return rowMeasure.includes("(row.textContent ?? '').trimEnd().length")
        && !rowMeasure.includes('isShellInputLine')
        && smoke.includes('rightCols < Math.min(16384, longestHistoricalRow + 2)');
})());
check('El E2E no deja ventanas grises huérfanas y valida el cierre de su grupo aislado',
    smoke.includes('detached: process.platform !== \'win32\'')
        && smoke.includes('process.kill(-groupId, 0)')
        && smoke.includes("recordEvent('e2e-process-cleanup'")
        && e2eReportVerifier.includes("type === 'e2e-process-cleanup'")
        && smoke.includes('await sendTerminalLine(reclaimScriptCommand, horizontalCell)')
        && smoke.includes('posixPrintfLinesScript(reclaimOutputLines)')
        && smoke.includes('probeOutputMarkerRows(terminalText, reclaimScriptCommand, newestReclaimLine)')
        && smoke.includes('row.markerAfterEchoRemoval'));
check('La matriz E2E detecta errores de sintaxis en el bootstrap de shells alternativas',
    smoke.includes('defining function based on alias')
        && smoke.includes('parse error near')
        && smoke.includes('shell-${id}-initialization-error'));
check('La matriz E2E exige identificar la shell original por su marca seleccionada real',
    smoke.includes("option.getAttribute('aria-selected') === 'true'")
        && smoke.includes("option.classList.contains('selected')")
        && smoke.includes("const originalSource = 'aria-selected/class'")
        && e2eReportVerifier.includes("shellMatrix.originalSource !== 'aria-selected/class'"));
check('Smoke E2E reproduce ADB con dispositivo falso y valida varios repintados sin cambios de layout',
    smoke.includes('E2E_ADB_REFRESH_ONLY')
        && smoke.includes('LTERMINAL-FAKE-DEVICE')
        && smoke.includes('adb-progressive-output-repaint')
        && smoke.includes('pty-output-idle')
        && smoke.includes('layoutUnchanged: true')
        && smoke.includes("captureScreenshot(`adb-refresh-frame-${index + 1}`)")
        && read('README.md').includes('E2E_ADB_REFRESH_ONLY=1 npm run e2e'));
check('Smoke E2E valida una respuesta real de la shell', smoke.includes('LTERMINAL_E2E_COMMAND_OK') && smoke.includes('xterm-rows'));
check('Smoke E2E prueba refrescos consecutivos de entornos', smoke.includes('refresh-environments') && smoke.includes('for (let attempt') && smoke.includes('fin de refrescos concurrentes'));
check('Smoke E2E prueba clics concurrentes de división', smoke.includes('burstCount') && smoke.includes('crearon demasiados paneles'));
check('Smoke E2E registra tiempos por fase, shell, operación y métricas de aplicación',
    smoke.includes('phaseTimings')
        && smoke.includes('buildTimingReport')
        && smoke.includes('sincePreviousMs')
        && smoke.includes('E2E tiempos por shell/REPL')
        && smoke.includes('performance'));
check('Smoke E2E simula update/upgrade, mide el overflow y comprueba recuperar el ancho',
    smoke.includes('E2E_PROGRESS_LAYOUT_ONLY')
        && smoke.includes('exerciseProgressOutputLayout')
        && smoke.includes('progressCommand')
        && smoke.includes('progress-output-layout')
        && smoke.includes('progress-${scenario.id}-layout')
        && smoke.includes('const reclaimed =')
        && e2eReportVerifier.includes("type === 'progress-output-layout'")
        && read('scripts/test-e2e-report.mjs').includes('missing-progress-layout'));
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
    'salidas progresivas de actualización',
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
check('Smoke E2E prueba las acciones individuales y el reintento de detección sin ejecutarlas', smoke.includes('Compatibilidad Windows') && smoke.includes('data-testid="dependency-action"') && smoke.includes('aparece abierto antes') && smoke.includes('dependency-detection-retry') && !smoke.includes('dependency-bulk-install') && !smoke.includes('dependency-bulk-uninstall'));
check('Smoke E2E adapta el catálogo de dependencias a cada plataforma', smoke.includes('nativeWindows') && smoke.includes('Virtualización') && smoke.includes('platformGroupPattern'));
check('Smoke E2E comprueba nombres y descripciones del grupo de plataforma', smoke.includes('hasNamedTool') && smoke.includes('hasDescription') && smoke.includes('programa y descripción'));
check('La sugerencia de herramienta abre dependencias y traduce su nombre', app.includes('suggestion.actionId') && app.includes('panels.show("deps")') && app.includes('.replace("{tool}", suggestion.label)'));
check('Dependencias conserva Actualizaciones como única lista de mantenimiento', dependenciesPanel.includes("{ id: 'updates', keys: ['group.updates'] }") && dependenciesPanel.includes("case 'updates':") && !dependenciesPanel.includes("{ id: 'maintenance', keys: ['group.updates'] }") && smoke.includes("sectionIds.has('updates')") && smoke.includes("sectionIds.has('maintenance')"));
check('Dependencias muestra el contenido de Actualizaciones al abrirla',
    dependenciesPanel.includes("open={group.key === 'group.updates'")
        && dependenciesPanel.includes("{#if group.key === 'group.updates'}")
        && dependenciesPanel.includes("{@render selfUpdate()}")
        && !dependenciesPanel.includes('.updates-group:not([open]) > :not(.group-title)')
        && smoke.includes("contenido visible de Actualizaciones")
        && smoke.includes("updatesVisible: true"));
check('Dependencias clasifica contenedores y ADB en las secciones correctas',
    dependenciesPanel.includes("{ id: 'platforms', keys: ['group.containers', 'group.android', 'group.network', 'group.virt'] }")
        && dependenciesPanel.includes("Dispositivos, red y virtualización.")
        && read('src-tauri/src/config/i18n.rs').includes('("Contenedores y Kubernetes",            "group.containers")')
        && smoke.includes("groupSectionId('group.docker')")
        && smoke.includes("dockerSections.some((sectionId) => sectionId !== 'platforms')")
        && smoke.includes("Plataformas e integración no muestra juntos Docker y ADB")
        && smoke.includes("androidSectionId !== 'platforms'")
        && smoke.includes("recordEvent('dependency-taxonomy'"));
check('La terminal no copia automáticamente una selección y conserva el menú de edición',
    terminalPane.includes('function selectionRange')
        && terminalPane.includes('getSelectionPosition')
        && terminalPane.includes("action === 'cut'")
        && terminalPane.includes("action === 'delete'")
        && !terminalPane.includes('handleMouseUp')
        && !terminalPane.includes('copyOnSelect')
        && !terminalPane.includes('onmouseup={handleMouseUp}')
        && !settingsPanel.includes('settings.copyOnSelect'));
check('La comprobación manual de actualizaciones prueba una build con confianza embebida',
    dependenciesPanel.includes('data-testid="dependency-self-update"')
        && smoke.includes('E2E_UPDATE_RETRY_ONLY')
        && smoke.includes('signed-update-retry')
        && smoke.includes('no incluye las claves de confianza'));
check('Dependencias diferencia carga inicial de actualización y expone reintento explícito', dependenciesPanel.includes('loading && actions.length === 0') && dependenciesPanel.includes('refreshInFlight') && dependenciesPanel.includes('data-testid="dependency-refresh"') && dependenciesPanel.includes('detectingAgain'));
check('E2E ofrece auditoría completa y repetible del menú de Dependencias',
    smoke.includes('E2E_DEPENDENCY_AUDIT_ONLY')
        && smoke.includes('collectDependencyAudit')
        && smoke.includes('dependency-full-audit')
        && smoke.includes('dependencias-auditoria-primera-completa')
        && smoke.includes('dependencias-auditoria-segunda-completa')
        && smoke.includes('stableInventory')
        && smoke.includes('initialDurationMs')
        && read('scripts/verify-e2e-report.mjs').includes("focusedScenario === 'dependency-full-audit'"));
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
check('Build Linux y Windows exigen firma OpenSSH para releases oficiales', linuxBuild.includes('LTERMINAL_SSH_SIGNING_KEY_FILE') && linuxBuild.includes('SHA256SUMS.txt.sshsig') && windowsBuild.includes('LTERMINAL_SSH_SIGNING_KEY_FILE') && windowsBuild.includes('SHA256SUMS.txt.sshsig') && typeof scripts['test:release-ssh-signature'] === 'string');
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
check('El E2E fuerza AppImage sin FUSE y acota las peticiones WebDriver',
    linuxBuild.includes('APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"')
    && smoke.includes('E2E_WEBDRIVER_TIMEOUT_MS')
    // La petición recibe límites específicos (por ejemplo, DELETE corto) y
    // aplica el valor efectivo a la señal; no exigir el nombre de la
    // constante aquí evita que el contrato se rompa al añadir esos límites.
    && smoke.includes('timeoutMs = webdriverRequestTimeoutMs')
    && (smoke.includes('AbortSignal.timeout(timeoutMs)')
        || smoke.includes('AbortSignal.timeout(effectiveTimeoutMs)')));
// ble.sh imprime «updating tput cache» al regenerar su caché: cargado tras el
// banner dejaba a ConPTY una fila por debajo de xterm. Las sugerencias van
// antes del borrado, el backend realinea si aun así se desfasa y el E2E de
// sugerencias provoca siempre ese aviso en su ble.sh de /tmp.
{
    const aliases = read('src-tauri/src/terminal/aliases.rs');
    const buildStart = aliases.indexOf('pub fn build_init_script(');
    const assistAt = aliases.indexOf('lines.extend(options.assist_lines.iter().cloned());', buildStart);
    const clearAt = aliases.indexOf('lines.push(clear_command_with_marker(', buildStart);
    check('Las sugerencias de la línea de órdenes se cargan antes del borrado y el banner',
        buildStart >= 0 && assistAt > buildStart && clearAt > assistAt
        && aliases.includes('fn ble_sh_psreadline_y_los_plugins_de_zsh_se_cargan_antes_del_banner'));
    check('El backend realinea xterm con ConPTY si el arranque imprimió de más',
        tabs.includes('fn startup_alignment(')
        && tabs.includes('alignment = startup_alignment(row, col, expected_row)')
        && tabs.includes('fn un_aviso_tras_el_banner_se_corrige_alineando_xterm_con_conpty'));
    const wslSource = read('src-tauri/src/environments/wsl.rs');
    const languagesSource = read('src-tauri/src/environments/languages.rs');
    check('Los REPL de WSL se lanzan con el mismo PATH con el que se detectaron y sin intérpretes que no arrancan',
        languagesSource.includes('crate::wsl_env::repl_launch_args(distro, exe, args)')
        && !languagesSource.includes('distro.to_string(), "--".to_string()')
        && read('src-tauri/src/environments/mod.rs').includes('&distro.runnable_tools()')
        && wslSource.includes('fn el_repl_se_lanza_con_el_mismo_path_con_el_que_se_detecto')
        && wslSource.includes('fn un_interprete_que_el_kernel_no_ejecuta_no_se_ofrece_como_repl')
        && wslSource.includes(`timeout 3 sh -c 'exec "$0" --version'`));
    const aliasesSource = read('src-tauri/src/terminal/aliases.rs');
    check('ls/ll de Windows entienden opciones Unix y la función ls de PowerShell no queda tapada por el alias',
        aliasesSource.includes('pub const CMD_LS_SCRIPT')
        && aliasesSource.includes('POWERSHELL_FREE_LS_ALIAS')
        && aliasesSource.includes('fn ls_de_cmd_entiende_las_opciones_unix_de_verdad')
        && aliasesSource.includes('fn ls_de_powershell_entiende_las_opciones_unix_y_las_propias')
        && read('src-tauri/src/terminal/session_files.rs').includes('alias_profiles::cmd_ls_script()'));
    const processSource = read('src-tauri/src/infrastructure/process.rs');
    check('Windows PowerShell 5.1 recibe su PSModulePath y no el de PowerShell 7',
        processSource.includes('pub fn windows_powershell_module_path(')
        && processSource.includes('fn windows_powershell_51_no_hereda_las_carpetas_de_modulos_de_pwsh')
        && read('src-tauri/src/terminal/pty.rs').includes('current_windows_powershell_module_path()'));
    check('El runtime asíncrono tiene margen y las mediciones de carpetas no ocupan sus hilos',
        read('src-tauri/src/lib.rs').includes('fn install_async_runtime()')
        && read('src-tauri/src/lib.rs').includes('fn los_comandos_de_almacenamiento_no_ocupan_hilos_del_runtime')
        && read('src/lib/api.ts').includes('__wtPendingIpc')
        && smoke.includes('window.__wtPendingIpc'));
    check('El E2E de sugerencias fuerza el aviso de caché de ble.sh',
        read('scripts/prepare-e2e-shell-tools.mjs').includes('touch ${E2E_BLESH_PREFIX}/blesh/lib/init-term.sh')
        && smoke.includes("line.includes('Desalineación entre ConPTY y xterm tras el arranque')"));
}
// NSudo exige un padre elevado (sin él termina con -1). Se abre directo, a
// través de gsudo o del sudo de Windows «En línea», o sale deshabilitado con
// el motivo; la app puede relanzarse con UAC, pero nunca en pruebas ni en
// bucle; la marca RUNASADMIN (escudo en el icono) solo la pone el usuario
// desde Ajustes, nunca el arranque.
{
    const environmentsSource = read('src-tauri/src/environments/mod.rs');
    const elevationSource = read('src-tauri/src/platform/windows/elevation.rs');
    check('NSudo elige lanzador (directo, gsudo, sudo en línea) o se ofrece deshabilitado explicando qué hacer',
        environmentsSource.includes('pub fn nsudo_launcher(')
        && environmentsSource.includes('fn nsudo_se_eleva_con_gsudo_o_sudo_en_linea_o_se_ofrece_deshabilitado')
        && environmentsSource.includes('cmd.available = available;')
        && environmentsSource.includes('ps.available = available;')
        && elevationSource.includes('fn el_modo_de_sudo_sale_del_registro_y_de_que_exista_sudo_exe')
        && elevationSource.includes('fn los_argumentos_se_citan_como_los_lee_windows'));
    check('El arranque como administrador no se relanza en pruebas, en bucle ni siendo ya administrador',
        windowsIntegration.includes('pub fn should_relaunch(self)')
        && windowsIntegration.includes('fn solo_se_relanza_si_se_pidio_y_no_es_admin_ni_relanzamiento_ni_prueba')
        && windowsIntegration.includes('fn la_copia_elevada_recibe_los_mismos_argumentos_y_una_sola_marca')
        && lib.includes('["LTERMINAL_E2E_TESTING", "LTERMINAL_E2E_DISABLE_ADMIN"]')
        && lib.includes('if relaunch_elevated_on_start()')
        && lib.includes('platform::windows_integration::app_restart_as_admin')
        && lib.includes('platform::windows_integration::app_restart_unelevated')
        && windowsIntegration.includes('fn solo_se_vuelve_sin_elevar_si_nada_lo_volveria_a_elevar')
        && windowsIntegration.includes('fn la_copia_sin_elevar_pierde_la_marca_y_conserva_lo_demas')
        && elevationSource.includes('pub fn run_unelevated(')
        && elevationSource.includes('if token_is_elevated(shell_token.0) {')
        && read('src/components/SettingsPanel.svelte').includes('data-testid="settings-restart-unelevated"')
        && read('src/components/SettingsPanel.svelte').includes('role="radiogroup" data-testid="settings-admin-mode"')
        && smoke.includes("await chooseAdminMode(normalCss, { start: false, flag: false }, '«Sin permisos»');")
        && !lib.includes('RUNASADMIN')
        && windowsIntegration.includes('pub fn set_run_as_admin_flag(')
        && windowsIntegration.includes('fn la_marca_runasadmin_se_pone_y_quita_sin_tocar_las_demas'));
    check('gsudo se ofrece en el catálogo como puente opcional de NSudo',
        read('src-tauri/src/packages/actions.rs').includes('"winget-gsudo"')
        && read('src-tauri/src/packages/actions.rs').includes('let gsudo = buscar(&actions, "winget-gsudo");')
        && read('src-tauri/src/packages/descriptions.rs').includes('"winget-gsudo"'));
    check('El E2E compara la sección de permisos con el backend, restaura el arranque elevado y busca RUNASADMIN',
        smoke.includes('async function verifyAdminPermissions()')
        && smoke.includes("invokeJson('windows_integration_status')")
        && smoke.includes("recordEvent('windows-admin-permissions', event)")
        && smoke.includes('const runAsAdminFlag = /RUNASADMIN/i.test(compatibility);')
        && read('scripts/verify-e2e-report.mjs').includes('function validAdminPermissions(admin)'));
}

// Imagen a la izquierda del banner: el backend deja el margen (los mismos
// espacios en ConPTY y en xterm) y el frontend pinta una decoración que ConPTY
// nunca ve; la imagen propia se valida por su firma.
{
    const systemInfoSource = read('src-tauri/src/platform/system_info.rs');
    const bannerImageSource = read('src-tauri/src/terminal/banner_image.rs');
    check('El banner deja el margen de la imagen solo si el texto sigue cabiendo',
        systemInfoSource.includes('pub fn banner_image_padding(')
        && systemInfoSource.includes('fn la_imagen_reserva_su_margen_solo_si_el_texto_sigue_cabiendo')
        && systemInfoSource.includes('fn con_imagen_cada_linea_del_banner_empieza_tras_el_mismo_margen'));
    check('La imagen propia del banner se valida por firma y tamaño',
        bannerImageSource.includes('pub const MAX_BANNER_IMAGE_BYTES')
        && bannerImageSource.includes('fn la_imagen_se_reconoce_por_su_firma_y_no_por_la_extension')
        && bannerImageSource.includes('fn se_entrega_como_data_url_y_se_rechaza_lo_que_no_es_imagen')
        && lib.includes('terminal::banner_image::banner_image_read'));
    check('La imagen del banner es una decoración de xterm y tiene su E2E',
        read('src/lib/banner-image.ts').includes('terminal.registerDecoration({')
        && read('scripts/test-frontend-logic.mjs').includes("importTypeScript('src/lib/banner-image.ts')")
        && smoke.includes("smokeReport.focusedScenario = 'banner-image';")
        && read('tests/e2e/suites.mjs').includes("E2E_BANNER_IMAGE_ONLY: '1'"));
    // Centrada también en el banner completo, donde la limita el ancho.
    check('La imagen del banner va centrada en su margen también con el banner completo',
        read('src/lib/banner-image.ts').includes('export function bannerImageBox(')
        && read('src/lib/banner-image.ts').includes('x: box.x,')
        && read('scripts/test-frontend-logic.mjs').includes('bannerImage.bannerImageBox(22)')
        && smoke.includes("results.full = await expectBannerImage(22, isLogo, 'banner completo');")
        && smoke.includes('centered: Math.abs(leftGap - bannerGap * cellWidth) <= 2'));
}

// Menú contextual: «Buscar» con la selección y cortar/borrar cualquier parte
// de lo escrito (no solo lo que toca el cursor), con su E2E en cada shell.
check('Cortar o borrar una parte interior de lo escrito tiene lógica probada y E2E por shell',
    read('src/lib/input-selection.ts').includes('export function inputSelectionEdit(')
    && read('scripts/test-frontend-logic.mjs').includes("importTypeScript('src/lib/input-selection.ts')")
    && read('src/components/TerminalPane.svelte').includes('data-testid="terminal-menu-search"')
    && smoke.includes("smokeReport.focusedScenario = 'context-menu-edit';")
    && smoke.includes('async function exerciseInputSelection(shell, cell)')
    && read('tests/e2e/suites.mjs').includes("E2E_CONTEXT_MENU_EDIT_ONLY: '1'"));

// Mi GitHub: gh con argumentos fijos, nombres que no pueden pasar por opciones,
// solo repositorios de la propia cuenta y E2E con un gh simulado.
{
    const ghSource = read('src-tauri/src/projects/gh_cli.rs');
    check('Mi GitHub usa gh con argumentos validados y solo sobre repositorios de la cuenta',
        ghSource.includes('pub fn valid_new_repo_name(')
        && ghSource.includes("!name.starts_with('-')")
        && ghSource.includes('fn las_ordenes_de_gh_llevan_argumentos_fijos_y_validados')
        && ghSource.includes('fn solo_se_actua_sobre_repositorios_del_listado_y_borrar_pide_el_nombre')
        && ghSource.includes('fn el_listado_de_gh_se_convierte_en_repositorios_validos')
        && lib.includes('commands_projects::github_cli_terminal')
        && smoke.includes("smokeReport.focusedScenario = 'github-account';")
        && read('tests/e2e/suites.mjs').includes("E2E_GITHUB_ACCOUNT_ONLY: '1'"));
    // «Gestionar…» de Mi GitHub: gh con argumentos fijos y validados, git en
    // la copia local con su carpeta calculada por el backend, y su E2E.
    const ghManage = read('src-tauri/src/projects/gh_manage.rs');
    const gitLocal = read('src-tauri/src/projects/git_local.rs');
    check('Mi GitHub gestiona detalles, releases, git local, pull requests, issues y Actions con argumentos fijos',
        ghManage.includes('pub fn valid_ref_name(')
        && ghManage.includes('pub fn release_create_args(')
        && ghManage.includes('fn crear_una_release_pide_notas_y_valida_los_adjuntos')
        && ghManage.includes('fn solo_se_gestionan_repositorios_del_listado_de_la_cuenta')
        && ghManage.includes('gh_cli::own(full_name)')
        && gitLocal.includes('pub fn local_clone(')
        && gitLocal.includes('fn commit_y_ramas_en_una_copia_real')
        && gitLocal.includes('("GIT_TERMINAL_PROMPT", "0")')
        && read('src-tauri/src/projects/github.rs').includes('pub fn build_git_sync_command(')
        && read('src-tauri/src/projects/commands.rs').includes('pub fn github_git_terminal(')
        && lib.includes('projects::gh_manage::github_release_create')
        && lib.includes('projects::git_local::git_local_commit')
        && lib.includes('commands_projects::github_git_terminal')
        && read('src/components/ProjectsPanel.svelte').includes('<GithubRepoManager')
        && smoke.includes("const waitForArgs = async (expected, label) => {")
        && smoke.includes("results.manage = true;"));
    // La release se abre bajo su fila y se cierra (antes se quedaba al pie del
    // panel en todas las pestañas); el E2E la prueba con una API local.
    check('La release de un repositorio se abre bajo su fila y se cierra, probado sin red',
        read('src/components/ProjectsPanel.svelte').includes('{#if release?.release && release.fullName === fullName}')
        && read('src/components/ProjectsPanel.svelte').includes('data-testid="projects-release-close"')
        && read('src-tauri/src/projects/github.rs').includes('pub fn e2e_api_origin(')
        && read('src-tauri/src/projects/github.rs').includes('fn el_origen_de_la_api_solo_cambia_en_el_e2e_y_hacia_un_servidor_local')
        && smoke.includes("process.env.LTERMINAL_E2E_GITHUB_API = `http://127.0.0.1:${fakeGithubApi.address().port}`;")
        && smoke.includes("results.releaseCloses = true;"));
}

// Ajustes: buscador en todas las secciones, índice de apartados y explicación
// de cada fila al pasar el ratón, con lógica probada y E2E.
check('Ajustes tiene buscador, índice y explicaciones probados',
    read('src/lib/settings-search.ts').includes('export function settingsSearchVisibility(')
    && read('scripts/test-frontend-logic.mjs').includes("importTypeScript('src/lib/settings-search.ts')")
    && read('src/components/SettingsPanel.svelte').includes('data-testid="settings-search"')
    && read('src/components/SettingsPanel.svelte').includes('data-testid="settings-index"')
    && smoke.includes("smokeReport.focusedScenario = 'settings-search';"));
// Un apagado tras publicar dejó release\ a ceros: el build vuelca lo publicado
// a disco y la prueba del instalador comprueba su huella antes de instalar.
check('La release publicada se vuelca a disco y el instalador se comprueba contra SHA256SUMS antes de instalarlo',
    read('windows/build.ps1').includes('Sync-PublishedFiles $releaseOut')
    && read('windows/build.ps1').includes('try { $stream.Flush($true) } finally { $stream.Dispose() }')
    && read('scripts/test-installer.mjs').includes('export function installerIntegrity(')
    && read('scripts/test-installer.mjs').indexOf('installerIntegrity(await readFile(installer)')
        < read('scripts/test-installer.mjs').indexOf("const helper = join(projectRoot, 'windows', 'test-installer-elevated.ps1');")
    && read('scripts/test-e2e-suite.mjs').includes('/no tiene la huella/u'));
// La vista previa del limpiador ligero no puede sugerir la limpieza completa.
check('La vista previa del limpiador ligero sugiere la orden ligera, no la completa',
    read('scripts/clean-repository.ps1').includes('$applyHint = if ($Light) { "-Light -KeepDays $KeepDays -Apply" } else { \'-Apply\' }')
    && read('scripts/clean-repository.sh').includes('Ejecuta: scripts/clean-repository.sh --light --keep-days $keep_days --apply')
    && read('scripts/test-clean-repository.mjs').includes('--light --keep-days 3 --apply/u'));
// Dependencias: la pantalla de carga ya vista al abrir cuenta aunque la
// detección la quite enseguida (el E2E del portable la esperaba otra vez).
check('El E2E de Dependencias acepta la pantalla de carga vista al abrir',
    smoke.includes('let placeholderSeenOnOpen = false;')
    && smoke.includes('if (!placeholderSeenOnOpen && placeholderOnOpen === 0) {'));
// La cobertura WSL cuenta solo las distros: las variantes `wsl:<distro>:sh`
// se probaban y descuadraban la comparación con las distros instaladas.
check('La cobertura WSL del E2E cuenta solo distros y aparta las variantes de shell',
    smoke.includes('testedIds: wslDistroIds.filter((id) => testedIds.includes(id)),')
    && smoke.includes('shellVariantIds: testedIds.filter('));
// Todo centralizado de fábrica y las carpetas bin de las herramientas también
// en el PATH del usuario (solo las que añade WTerminal, que quita al apagarlo).
check('La carpeta propia lo centraliza todo de fábrica y publica las bin de herramientas en el PATH del usuario',
    read('src-tauri/default_settings.toml').includes('toolchainStoreTools = true')
    && read('src-tauri/default_settings.toml').includes('toolchainStoreReplHistory = true')
    && read('src-tauri/src/config/toolchain_store.rs').includes('fn de_fabrica_se_centraliza_todo_y_las_herramientas_llevan_su_bin')
    && read('src-tauri/src/config/toolchain_store.rs').includes('pub fn published_bin_dirs()')
    && read('src-tauri/src/platform/path_integration.rs').includes('pub fn path_with_tool_bins(')
    && read('src-tauri/src/platform/path_integration.rs').includes('fn las_carpetas_de_herramientas_entran_al_final_y_solo_salen_las_propias')
    && read('src-tauri/src/platform/path_integration.rs').includes('if cfg!(test) || e2e_skips_path_auto() {')
    && read('src-tauri/src/config/settings.rs').includes('crate::platform::path_integration::sync_tool_bins()')
    && read('src-tauri/src/lib.rs').includes('platform::path_integration::sync_tool_bins()')
    && smoke.includes("['npm_config_prefix', true], ['NODE_REPL_HISTORY', true]"));
// Dos guardados a la vez (el tamaño de la ventana y Ajustes) compartían el
// temporal y dejaban settings.json vacío: escritura y lectura bajo un cerrojo.
check('Los guardados simultáneos de settings.json se serializan y no pierden claves',
    read('src-tauri/src/config/settings.rs').includes('static SETTINGS_IO: Lazy<Mutex<()>>')
    && read('src-tauri/src/config/settings.rs').includes('let _io = SETTINGS_IO.lock();')
    && read('src-tauri/src/config/settings.rs').includes('fn guardados_simultaneos_no_se_pisan_ni_pierden_claves'));
// El pie sticky de Ajustes no puede tapar el control al que se desplaza el
// foco o el clic de WebDriver (la casilla de LTools quedó debajo del pie).
check('Los controles de Ajustes quedan por encima del pie fijo al desplazarse a ellos',
    /\.settings-form :global\(section \*\) \{\s*scroll-margin-bottom: 64px;/u.test(read('src/components/SettingsPanel.svelte'))
    && smoke.includes("await findWhenReady('[data-testid=\"settings-ltools-enabled\"]')")
    && smoke.includes("if (!/element click intercepted/iu.test(String(error?.message ?? error))) throw error;")
    && smoke.includes("recordEvent('driver-click-scrolled',"));

// Una pestaña nueva que arranca con un programa que pregunta (gh auth login y
// su Y/n) acepta teclas en cuanto se ve; y las pruebas lanzadas desde
// PowerShell 7 no rompen los powershell.exe 5.1 que usan.
check('Las pestañas que arrancan con un programa interactivo aceptan teclas y su E2E responde a gh',
    read('src/components/TerminalPane.svelte').includes('function shellPromptAfterBanner(')
    && read('src/components/TerminalPane.svelte').includes('terminalPromptVisible() || shellPromptAfterBanner(latestBanner)')
    && smoke.includes("'pregunta Y/n de gh auth login'")
    && smoke.includes("'la respuesta a la pregunta de gh llega a la terminal'"));
check('Las pruebas quitan el PSModulePath heredado de PowerShell 7 antes de usar Windows PowerShell 5.1',
    read('tests/e2e/powershell-env.mjs').includes('export function dropPowerShell7ModulePath(')
    && smoke.includes("import { dropPowerShell7ModulePath } from './powershell-env.mjs';")
    && read('scripts/run-e2e-suite.mjs').includes('dropPowerShell7ModulePath();')
    && read('scripts/prepare-e2e-shell-tools.mjs').includes('env: windowsPowerShellEnvironment()'));

if (failures.length) {
    console.error(`Superficie de tests incompleta (${failures.length}/${checks.length} comprobaciones fallidas):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}
console.log(`Superficie de tests verificada (${checks.length} contratos).`);
