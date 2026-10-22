#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// Contrato documental ejecutable. No intenta demostrar el comportamiento por
// sí solo: comprueba que la documentación sigue apuntando a los puntos de
// entrada reales y que el orden delicado del arranque, IPC y actualización no
// desaparece durante una refactorización.
const root = process.cwd();
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const failures = [];
const checks = [];
const readme = read('README.md');
// El mapa técnico vive en el README (sección «Mapa de archivos, llamadas y
// mantenimiento»): es la única documentación publicada junto al código.
const MAP_HEADING = '## Mapa de archivos, llamadas y mantenimiento';
const mapStart = readme.indexOf(`${MAP_HEADING}\n`);
const mapEnd = mapStart >= 0 ? readme.indexOf('\n## ', mapStart + MAP_HEADING.length) : -1;
const architecture = mapStart >= 0 ? readme.slice(mapStart, mapEnd < 0 ? undefined : mapEnd) : '';
const readmeNormalized = readme.replace(/\s+/g, ' ');
const hasReadme = (marker) => readmeNormalized.includes(marker.replace(/\s+/g, ' '));

function check(name, condition) {
    checks.push(name);
    if (!condition) failures.push(name);
}

function position(source, marker) {
    return source.indexOf(marker);
}

const lib = read('src-tauri/src/lib.rs');
const api = read('src/lib/api.ts');
const tabs = read('src-tauri/src/terminal/tabs.rs');
const update = read('src-tauri/src/updater/commands.rs');
const security = read('src-tauri/src/updater/security.rs');
const updateUi = read('src/App.svelte');
const packageUpdates = read('src-tauri/src/updater/package_updates.rs');
const e2e = read('tests/e2e/smoke.mjs');

check('La documentación técnica vive en README', ['## Arquitectura', '## Contrato IPC', '## Seguridad', '## Pruebas'].every(hasReadme));
check('README contiene el mapa técnico y lo enlaza desde la introducción',
    mapStart >= 0 && readme.slice(0, mapStart).includes('](#mapa-de-archivos-llamadas-y-mantenimiento)'));
check('README no enlaza documentación fuera del repositorio publicado',
    !readme.includes('ARCHITECTURE.md') && !/\]\((?:\.\/)?(?:docs|docs-ia|artifacts)\//u.test(readme));
check('El mapa mantiene diagramas de arranque, entrada y paneles',
    ['### Diagrama de arranque y terminal', '### Diagrama de entrada, salida y reflow',
        '### Diagrama de paneles e IPC', '### Builds, E2E y evidencia']
        .every((heading) => architecture.includes(heading))
    && (architecture.match(/```mermaid/g) ?? []).length >= 4);
const sourceFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
});
for (const path of [...sourceFiles(resolve(root, 'src')), ...sourceFiles(resolve(root, 'src-tauri/src'))]) {
    if (!/\.(?:css|rs|svelte|ts)$/.test(path)) continue;
    const name = relative(root, path).replaceAll('\\', '/');
    check(`El mapa describe ${name}`, architecture.includes(`\`${name}\``));
}
for (const directory of ['scripts', 'windows', 'linux', 'tests', 'build-tools']) {
    for (const path of sourceFiles(resolve(root, directory))) {
        const name = relative(root, path).replaceAll('\\', '/');
        check(`El mapa describe ${name}`, architecture.includes(`\`${name}\``));
    }
}
check('README documenta el arranque y el ciclo PTY', ['orden de arranque', 'ciclo de vida de una pestaña', 'primera PTY'].every(hasReadme));
check('README documenta las capas y dominios del proyecto', ['src-tauri/src/', 'src/', 'scripts/', 'terminal/', 'updater/'].every(hasReadme));
check('README documenta Linux/Wine/Windows', ['Linux', 'Wine', 'Windows'].every(hasReadme));
check('README documenta la matriz de pruebas y la evidencia', ['catorce fases', 'capturas', 'informe JSON'].every(hasReadme));
check('README documenta alcance, evidencia y límites', ['Auditoría de release y comportamiento observable', 'límites de confianza', 'no se declara aprobado'].every(hasReadme));

for (const marker of ['migrate_local_data', 'frontend_ready', 'tabs.shutdown', 'generate_handler!']) {
    check(`El arranque real conserva ${marker}`, lib.includes(marker));
}
for (const marker of ['tauriInvoke', "listen<", "checkForUpdateOnStartup", "onData"]) {
    check(`El puente frontend conserva ${marker}`, api.includes(marker));
}
for (const marker of ['spawn_pty', 'pty-data', 'pty-exit', 'generation']) {
    check(`El ciclo PTY conserva ${marker}`, tabs.includes(marker));
}

const signatureAt = position(update, 'security::verify_signature');
const sshSignatureAt = position(update, 'security::verify_ssh_signature');
const checksumAt = position(update, 'security::verify_checksum');
const treeAt = position(update, 'self_update::validate_payload_tree');
const applyAt = position(update, 'self_update::apply');
check('La actualización verifica firma antes del hash', signatureAt >= 0 && signatureAt < checksumAt);
check('La actualización exige también la firma SSH antes de ofrecer una release', sshSignatureAt >= 0 && sshSignatureAt < checksumAt && security.includes('SSH_NAMESPACE'));
check('La actualización verifica hash antes del árbol', checksumAt >= 0 && checksumAt < treeAt);
check('La actualización valida el árbol antes de aplicar', treeAt >= 0 && treeAt < applyAt);
check('El popup propio solo aparece después de autenticar manifiesto y SHA declarado', (() => {
    const checked = position(update, 'verified_release_manifest(&release)');
    const offered = position(update, 'status.available = true');
    return checked >= 0 && offered > checked
        && update.includes('stable_release_core(&release.tag).is_none()')
        && update.includes('asset_matches_release_version(&asset.name, &release.tag)');
})());
check('El aviso automático vuelve por IPC y no depende de un evento de arranque fugaz',
    update.includes('update_check_on_startup') && updateUi.includes('checkForUpdateOnStartup()')
        && !api.includes("'update-available'")
        && /status\.available\s*&&\s*status\.canSelfUpdate/.test(updateUi));
check('Las consultas de paquetes son solo lectura y tienen límite de tiempo',
    packageUpdates.includes('CHECK_TIMEOUT') && packageUpdates.includes('run_with_timeout_env')
        && packageUpdates.includes('query_command(manager)')
        && packageUpdates.includes('fn cada_sonda_usa_su_comando_de_consulta_permitido')
        && packageUpdates.includes('(\"apt\", \"apt-get\", &[\"-s\", \"upgrade\"])'));
check('El aviso de paquetes lleva al panel, no actualiza en segundo plano',
    updateUi.includes("panels.show('deps')") && updateUi.includes('checkPackageUpdatesOnStartup()'));
check('Los avisos de actualización se adaptan al ancho y no se pueden descartar durante la instalación',
    updateUi.includes('.update > span') && updateUi.includes('flex-wrap: wrap;')
        && updateUi.includes('disabled={updating} onclick={dismissUpdate}'));
check('La seguridad documenta Ed25519 y OpenSSH', security.includes('verify_signature') && security.includes('verify_ssh_signature') && readme.includes('Ed25519') && readme.includes('OpenSSH'));

for (const marker of ['captureScreenshot', 'smokeReport.captures', 'E2E_CAPTURE_DIR', 'verify-e2e-report']) {
    check(`El E2E conserva ${marker}`, e2e.includes(marker) || hasReadme(marker === 'verify-e2e-report' ? 'informe JSON' : marker));
}

// Diagramas detallados del README: cada uno existe, es Mermaid y cada función
// que cita sigue en el archivo que dice. Renombrar o mover una de ellas sin
// tocar el diagrama hace fallar el contrato.
const DETAILED_FLOWS = [
    ['Arranque, ciclo de una pestaña y PTY/ConPTY', {
        'src-tauri/src/lib.rs': ['migrate_local_data'],
        'src-tauri/src/app/commands.rs': ['fn tabs_list', 'fn settings_get', 'fn app_info', 'fn pty_resize', 'fn tabs_ready', 'fn frontend_ready'],
        'src-tauri/src/terminal/tabs.rs': ['fn create_tab', 'fn resize_from_frontend', 'viewport_confirmed', 'fn effective_startup_viewport', 'fn spawn_pty', 'pty-data'],
        'src-tauri/src/terminal/session_files.rs': ['fn write_session_files', 'assist_lines'],
        'src-tauri/src/terminal/pty.rs': ['CMD_FRAME_DIR_VAR', '"TERM"'],
        'src/components/TerminalPane.svelte': ['function fitAndReport', 'async function releaseInput'],
        'src/lib/appState.svelte.ts': ['async load()'],
    }],
    ['IPC por dominio', {
        'src/lib/api.ts': ['tauriInvoke', "listen<DataEvent>('pty-data'", "'pty-exit'", "'pty-clear'", "'tab-closed'", "'update-progress'"],
        'src-tauri/src/lib.rs': ['generate_handler!'],
        'src-tauri/src/app/commands.rs': ['fn pty_input', 'fn settings_save', 'fn profile_export'],
        'src-tauri/src/packages/commands.rs': ['fn install_list', 'fn install_check', 'fn install_run'],
        'src-tauri/src/updater/commands.rs': ['fn update_check(', 'fn update_check_on_startup'],
        'src-tauri/src/config/toolchain_store.rs': ['fn toolchain_store_status', 'fn toolchain_store_external_sizes'],
        'src-tauri/src/terminal/shell_assist.rs': ['fn shell_assist_status'],
    }],
    ['Detección de entornos y WSL', {
        'src-tauri/src/environments/mod.rs': ['fn detect_environments', 'fn detect_system_shells', 'fn default_env_id'],
        'src-tauri/src/environments/wsl.rs': ['fn get_wsl_context', 'fn parse_installed_distros', 'fn probe_distro', 'LISTING_SCRIPT', '--exec'],
        'src-tauri/src/terminal/tabs.rs': ['fn heal_unverified_wsl'],
        'src-tauri/src/environments/ai.rs': ['fn detect_ai_environments', 'fn installed_ollama_models', 'OLLAMA_MODELS'],
        'src-tauri/src/infrastructure/path_env.rs': ['pub fn which', 'fn known_install_location', 'claude-code'],
    }],
    ['Entorno y dependencias, con sus sondas', {
        'src-tauri/src/packages/commands.rs': ['fn install_context', 'fn filter_available_actions_with_depth', 'fn build_list', 'fn shell_tab', 'fn wrap_powershell_command', 'console_ui::decorate', 'write_command'],
        'src-tauri/src/packages/actions.rs': ['pub fn get_install_actions', 'fn ecosystem_probe'],
        'src-tauri/src/infrastructure/process.rs': ['pub fn winget_probe'],
        'src-tauri/src/terminal/console_ui.rs': ['pub fn decorate', 'fn cmd_framed', 'fn cmd_one_line', 'if errorlevel 1'],
    }],
    ['Sugerencias, colores y temas', {
        'src-tauri/src/config/preferences.rs': ['pub fn sanitize_preferences', 'pub fn effective_palette', 'NEUTRAL_THEME_ID'],
        'src-tauri/src/terminal/shell_assist.rs': ['pub fn from_preferences', 'pub fn init_lines', 'pub fn clink_default_settings', 'pub fn ensure_clink_profile_with', 'fn psreadline_style_lines', 'fn blesh_style_commands', 'fn zsh_highlight_styles', 'ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE'],
        'src/lib/theme.ts': ['export function effectivePalette', 'export function themePreferencePatch', 'export function applyTheme', 'export function terminalTheme', 'export function terminalFont'],
    }],
    ['Imágenes Sixel y símbolos', {
        'src/lib/sixel-conpty.ts': ['export function alignSixelWithConpty', 'export function sixelPixelAspect', 'export function conptySixelBox'],
        'src-tauri/src/config/preferences.rs': ['SYMBOL_FALLBACKS', "'WTerminal Symbols'"],
    }],
    ['Enlaces de la salida', {
        'src/components/TerminalPane.svelte': ['function syncTerminalLinks', 'function activateTerminalLink', 'const osc8LinkHandler', 'data-testid="terminal-link-dialog"', 'data-testid="terminal-link-notice"', 'api.openTerminalLink('],
        'src/lib/terminal-links.ts': ['export const TERMINAL_LINK_REGEX', 'export function checkTerminalLink', 'export function isLinkActivation'],
        'src/lib/api.ts': ["'terminal_open_link'"],
        'src-tauri/src/terminal/links.rs': ['pub fn terminal_open_link', 'pub fn validate_link', 'pub const ALLOWED_SCHEMES', 'crate::platform::open_directory', '.reveal_item_in_dir(path)', 'fn record_e2e_open', 'LTERMINAL_E2E_OPENED_LINKS'],
    }],
    ['Almacenamiento y cachés', {
        'src-tauri/src/config/toolchain_store.rs': ['pub fn status', 'fn app_locations', 'pub fn effective_root', 'fn external_locations', 'pub fn external_sizes', 'fn overrides_for', 'fn extra_path_dirs', 'fn system_location', 'pub enum Category', 'pub fn refresh_environment', 'pub fn clear_caches'],
        'src-tauri/src/infrastructure/process.rs': ['pub fn set_extra_path', 'pub fn path_with_extra'],
        'src-tauri/src/terminal/session_files.rs': ['pub fn prune_orphaned_sessions'],
        'src/components/SettingsPanel.svelte': ['settings-storage-tip', 'placeFloatingTip(', 'fitFloatingTip('],
        'src/lib/floating-tip.ts': ['export function placeFloatingTip', 'export function fitFloatingTip'],
    }],
    ['Paleta de comandos', {
        'src/App.svelte': ['paletteOpen = !paletteOpen', 'async function runAppAction', 'async function runPaletteEntry', 'function submitToActiveTerminal', 'api.parseInternalCommand(action.line)', 'api.runLToolsAction(tabId, action.actionId)'],
        'src/components/CommandPalette.svelte': ['role="combobox"', 'role="listbox"', 'aria-activedescendant', 'pinnedLToolsActions(', 'LTOOLS_CACHE_MS'],
        'src/lib/command-palette.ts': ['export function buildPaletteEntries', 'export function paletteResults', 'export function filterPaletteEntries'],
        'src/lib/ltools-selection.ts': ['export function pinnedLToolsActions'],
        'src/lib/terminalRegistry.ts': ['export function getTerminalControls', 'submitLine(line: string)'],
        'src/components/TerminalPane.svelte': ['function submitLineFromApp', 'term.input(line, true);'],
        'src-tauri/src/app/commands.rs': ['pub fn internal_command_parse'],
    }],
    ['Actualizador', {
        'src-tauri/src/updater/commands.rs': ['fn verified_release_manifest', 'security::verify_signature', 'security::verify_ssh_signature', 'security::verify_checksum'],
        'src-tauri/src/updater/self_update.rs': ['pub fn validate_payload_tree', 'pub fn apply', 'PackageKind::WindowsSingleFile'],
    }],
    ['Portable de un solo archivo', {
        'scripts/create-single-file-portable.mjs': ['WTPORT01'],
        'src-tauri/src/config/single_file.rs': ['pub fn current', 'pub fn is_single_file', 'pub fn materialize', 'pub fn runtime_cache_root', 'pub fn prune_runtime_cache'],
        'src-tauri/src/terminal/pty.rs': ['pub fn sideloaded_conpty'],
    }],
    ['Build y release', {
        'windows/build.ps1': ["'run', 'check'", 'function Invoke-TauriBuild', 'create-single-file-portable.mjs', 'sign-release-manifest.mjs', 'sign-release-ssh.mjs', 'test-install-actions-preventive.mjs', 'run-e2e-suite.mjs', 'function Write-BuildSummary'],
    }],
    ['E2E', {
        'tests/e2e/suites.mjs': ['export function planSuites'],
        'tests/e2e/run-scenario.mjs': ['export async function runSmokeScenario', 'E2E_CAPTURE_DIR'],
        'scripts/test-installer.mjs': ['export async function runInstallerTest'],
        'scripts/run-e2e-suite.mjs': ['summary.md', 'summary.json'],
    }],
];
const detailedStart = readme.indexOf('## Diagramas de flujo detallados');
const detailedEnd = readme.indexOf('\n## ', detailedStart + 3);
const detailed = detailedStart >= 0 ? readme.slice(detailedStart, detailedEnd) : '';
check('README tiene la sección de diagramas de flujo detallados', detailedStart >= 0);
for (const [heading, files] of DETAILED_FLOWS) {
    const at = detailed.indexOf(`### ${heading}\n`);
    const next = detailed.indexOf('\n### ', at + 4);
    const section = at >= 0 ? detailed.slice(at, next < 0 ? undefined : next) : '';
    check(`Diagrama «${heading}» presente y en Mermaid`, section.includes('```mermaid'));
    for (const [file, symbols] of Object.entries(files)) {
        const source = read(file);
        for (const symbol of symbols) {
            check(`«${heading}»: ${file} conserva ${symbol}`, source.includes(symbol));
        }
    }
}

if (failures.length) {
    console.error(`Documentación de flujo incompleta (${failures.length}/${checks.length} fallos):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Flujo documentado y anclado al código (${checks.length} comprobaciones).`);
