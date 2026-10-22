#!/usr/bin/env node
/**
 * Guardas preventivas que no necesitan compilar ni abrir WTerminal.
 *
 * Son deliberadamente independientes de los tests Rust y del WebDriver: si
 * una futura limpieza mueve una ruta, reintroduce un botón, cambia una
 * categoría o relaja una protección de layout, este comando falla antes de
 * que el error llegue a una build o a una release.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative) => readFile(resolve(root, relative), 'utf8');

const [pkgText, windowsBuild, cargoManifest, app, settings, scriptsPanel, dependencies, terminalPane, columns, smoke, defaults, actions, catalogText, pty, consoleUi, shortcuts, api] = await Promise.all([
    read('package.json'),
    read('windows/build.ps1'),
    read('src-tauri/Cargo.toml'),
    read('src/App.svelte'),
    read('src/components/SettingsPanel.svelte'),
    read('src/components/ScriptsPanel.svelte'),
    read('src/components/DependenciesPanel.svelte'),
    read('src/components/TerminalPane.svelte'),
    read('src/lib/terminal-columns.ts'),
    read('tests/e2e/smoke.mjs'),
    read('src-tauri/default_settings.toml'),
    read('src-tauri/src/packages/actions.rs'),
    read('src-tauri/config/technology-catalog.json'),
    read('src-tauri/src/terminal/pty.rs'),
    read('src-tauri/src/terminal/console_ui.rs'),
    read('src/lib/shortcuts.ts'),
    read('src/lib/api.ts'),
]);
const pkg = JSON.parse(pkgText);
const catalog = JSON.parse(catalogText);
const languagesText = await read('src-tauri/src/environments/languages.rs');

// 1) El builder debe tolerar perfiles npm con allow-scripts y no depender de
// la configuración global de otro equipo.
assert.match(windowsBuild, /\$npmUserConfig\s*=\s*Join-Path/);
assert.match(windowsBuild, /\$npmConfigArgs\s*=\s*if\s*\(/);
assert.match(windowsBuild, /\$npmConfigArgs\s+\+\s+@\('ci'\)/);
assert.match(windowsBuild, /\$npmConfigArgs\s+\+\s+@\('install'\)/);
assert.match(windowsBuild, /Remove-Item Env:NPM_CONFIG_ALLOW_SCRIPTS/);
assert.match(windowsBuild, /\$env:NPM_CONFIG_ALLOW_SCRIPTS = \$previousNpmAllowScripts/);
assert.match(pkgText, /"allowScripts"\s*:/);
assert.match(cargoManifest, /\[\[bin\]\][\s\S]*?name\s*=\s*"wterminal"/);

// 2) No volver a introducir un VMware que no tiene instalador distribuible y
// cada entrada del catálogo mantiene un identificador/ejecutable único.
assert.doesNotMatch(actions, /InstallAction::new\(\s*["']vmware-/i);
assert.match(actions, /action\.id\.starts_with\("vmware-"\)/);
assert.match(actions, /SetEnvironmentVariable\('OCAMLLIB', \$lib, 'User'\)/);
assert.match(pty, /ends_with\("\\\\ocaml\.exe"\)/);
assert.match(pty, /command\.env\("OCAMLLIB", ocaml_lib\)/);
assert.match(languagesText, /typescript[\s\S]+--transpile-only[\s\S]+moduleResolution/);
assert.match(languagesText, /fn is_non_interactive_repl\(id: &str\)/);
assert.match(languagesText, /matches!\(id, "swift" \| "scala-cli" \| "purescript"\)/);
const ids = catalog.map((entry) => entry.id);
assert.equal(new Set(ids).size, ids.length, 'el catálogo no puede repetir IDs');
for (const entry of catalog) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.equal(typeof entry.windowsExe, 'string');
    assert.ok(entry.windowsExe.length > 0, `falta windowsExe para ${entry.id}`);
}

// 3) LTools sigue siendo experimental y oculto por defecto; configurar debe
// persistir antes de navegar a Biblioteca.
assert.match(defaults, /ltoolsEnabled\s*=\s*false/);
assert.match(settings, /settings-ltools-enabled/);
assert.match(settings, /async function openLToolsConfiguration/);
assert.match(settings, /draft\.ltoolsEnabled = true/);
assert.match(settings, /await saveDraft\(\)/);
assert.match(settings, /ltoolsEnabledAfterSave/);
assert.match(settings, /panels\.show\(['"]scripts['"]\)/);
assert.match(scriptsPanel, /app\.preferences\?\.ltoolsEnabled === true/);

// 4) Modo limpio: la guía es opcional, se puede cerrar esta vez o bloquear,
// y su fila pertenece al flujo de la ventana para no solaparse con WinGet.
assert.match(app, /data-testid="terminal-only-guide-dismiss"/);
assert.match(app, /data-testid="terminal-only-guide-never"/);
assert.match(app, /showTerminalOnlyGuide: false/);
assert.match(app, /class="terminal-only-guide"/);
assert.match(app, /position: relative/);
assert.doesNotMatch(app, /\.terminal-only-guide\s*\{[^}]*position:\s*fixed/s);
assert.match(smoke, /bottomBarOverlap/);
assert.match(smoke, /scala\(\?:\\s\*\\d\+/);
assert.ok(smoke.includes(String.raw`In\s+\[\d+\]:`));
assert.ok(smoke.includes(String.raw`octave:\d+>`));
assert.match(smoke, /promptLooksVisible\(await textOf\(rows\)\)/);

// 5) La matriz de columnas debe conservar contenido visible largo, acotar
// valores extremos y envolver las líneas largas dentro del viewport para que
// nunca desaparezcan el final del texto ni el cursor.
for (const marker of ['longestVisibleLogicalLineWidth', 'requiredTerminalColumns', 'inputReservationColumns', 'occupiedTerminalColumns']) {
    assert.match(columns, new RegExp(`export function ${marker}`));
}
for (const marker of ['longestVisibleLogicalLineWidth', 'requiredTerminalColumns', 'occupiedTerminalColumns']) {
    assert.match(terminalPane, new RegExp(`${marker}\\(`));
}
const sequence = Array.from({ length: 512 }, (_, index) => String(index).padStart(4, '0')).join('-');
const tokens = sequence.split('-');
assert.equal(tokens.length, 512);
assert.deepEqual(tokens, Array.from({ length: 512 }, (_, index) => String(index).padStart(4, '0')));
assert.match(smoke, /exerciseHorizontalSequenceIntegrity/);
assert.match(smoke, /E2E_CAPTURE_VIDEO/);
assert.match(smoke, /startDesktopVideo/);
assert.match(smoke, /stopDesktopVideo/);
assert.match(terminalPane, /MAX_HORIZONTAL_COLS\s*=\s*16384/);
assert.match(
    terminalPane,
    /terminalHost\.dataset\.horizontalTail\s*=\s*String\(\s*renderContentColumns\s*>\s*visibleCols/s,
);
assert.match(terminalPane, /data-horizontal-tail="true".*xterm-screen/s);
assert.match(terminalPane, /overflow-x', 'hidden'/);
assert.match(terminalPane, /overflow-x:\s*auto/);
assert.match(terminalPane, /previousScrollLeft/);
assert.match(smoke, /numericRangesToCheck[^\n]*2048|\[100, 150, 500, 2048\]/);
assert.match(smoke, /missingBeforeResize/);
assert.match(smoke, /missingAfterNarrow/);
assert.match(smoke, /missingAfterRestore/);
// La búsqueda de scrollback de Alacritty/WezTerm debe vivir sobre el mismo
// xterm y cerrarse sin tocar la entrada de la PTY ni crear otro viewport.
assert.equal(typeof pkg.dependencies?.['@xterm/addon-search'], 'string', 'falta el addon de búsqueda de xterm');
assert.match(terminalPane, /new SearchAddon/);
assert.match(terminalPane, /data-testid="terminal-search"/);
assert.match(terminalPane, /findPrevious\(/);
assert.match(terminalPane, /findNext\(/);
assert.match(terminalPane, /searchAddon\?\.clearDecorations/);
assert.match(terminalPane, /function bufferSearch/);
assert.match(terminalPane, /term\.buffer\.active\.getLine/);
assert.match(terminalPane, /visibleRowsSearch/);
assert.match(terminalPane, /querySelector\('\.xterm-rows'\)/);
assert.match(smoke, /terminal-search-scrollback/);
assert.match(smoke, /activeSearchTabId.*repaintAfter\.geometry\.tabId/);
assert.match(shortcuts, /shortcutSearchTerminal/);
assert.match(terminalPane, /shortcutSearchTerminal/);
assert.match(pkgText, /@xterm\/addon-search/);

// OSC 133 se analiza de forma pasiva y tolera escapes partidos. No debe
// modificar la salida que llega a xterm ni exigir integración de shell.
const semanticZones = await read('src-tauri/src/terminal/semantic_zones.rs');
const terminalModule = await read('src-tauri/src/terminal/mod.rs');
const tabs = await read('src-tauri/src/terminal/tabs.rs');
assert.match(semanticZones, /SemanticZoneSplitter/);
assert.match(semanticZones, /133;A/);
assert.match(semanticZones, /find_osc_terminator/);
assert.match(terminalModule, /pub mod semantic_zones/);
assert.match(tabs, /terminal-semantic-zone/);
assert.match(api, /onSemanticZone/);

// 6) Copiar al seleccionar no debe volver a aparecer; cortar y borrar se
// prueban sobre una selección editable incluso si contiene espacios.
assert.doesNotMatch(terminalPane, /copyOnSelect|handleMouseUp|onmouseup=\{handleMouseUp\}/);
assert.match(terminalPane, /deleteEditableSelection\(true\)/);
assert.match(terminalPane, /deleteEditableSelection\(false\)/);

// 7) Docker y ADB deben pertenecer a la misma sección visible de plataformas.
assert.match(dependencies, /id: 'platforms', keys: \['group\.containers', 'group\.android'/);
assert.match(dependencies, /confirmedSectionIds/);
assert.match(dependencies, /async function revealSections/);
assert.match(dependencies, /requestAnimationFrame/);
assert.match(dependencies, /dependency-detection-progress/);
// Abrir el panel otra vez debe reutilizar la detección confirmada. Solo el
// botón explícito puede pedir `install_refresh`.
assert.match(dependencies, /if \(!force && refreshedAt > 0\)/);
assert.match(dependencies, /force\s*\n\s*\? api\.refreshInstallActions\(\)\s*\n\s*: api\.loadInstallCatalog\(\)/);
assert.match(dependencies, /api\.checkInstallAction\(anchor\)/);
assert.match(dependencies, /checkingActions/);
assert.match(dependencies, /refreshInFlight === request/);
// El aviso de WinGet ejecuta la acción de actualización en la pestaña activa;
// no abre el catálogo para que la persona tenga que pulsar una segunda vez.
assert.match(app, /data-testid="package-update-now"/);
assert.match(app, /async function runPackageUpdates/);
assert.match(app, /'winget-upgrade'/);
assert.match(app, /'pkg-update'/);

// cmd recibe cada parte del decorado en una línea separada: las salidas largas
// no quedan atrapadas en una única línea horizontal del editor de ConPTY.
assert.match(consoleUi, /parts\.join\("\\r"\)/);
assert.match(actions, /--scope user/);
assert.match(actions, /Shell\.Application/);
assert.match(smoke, /dockerSections\.some\(\(sectionId\) => sectionId !== 'platforms'\)/);
assert.match(smoke, /androidSectionId !== 'platforms'/);

// La densidad tiene efectos medibles en espaciado y altura, sin cambiar la
// fuente: ambas variantes deben publicar sus variables y aplicarlas a paneles.
const theme = await read('src/lib/theme.ts');
const appCss = await read('src/styles/app.css');
assert.match(theme, /--ui-scale/);
assert.match(appCss, /body\[data-density='comfortable'\]/);
assert.match(appCss, /body\[data-density='compact'\]/);
assert.match(appCss, /--density-control-height/);
assert.match(appCss, /body\[data-density\] \.panel \.panel-header/);

// 8) El ajuste de maximizado no puede quedarse solo en el borrador: se aplica
// al arranque mediante el puente de ventana y se persiste con preferencias.
assert.match(settings, /settings-start-maximized/);
const appState = await read('src/lib/appState.svelte.ts');
assert.match(appState, /setWindowMaximized\(prefs\.preferences\.startMaximized\)/);
assert.match(appState, /environmentRefreshPromise/);
assert.match(appState, /if \(this\.environmentRefreshPromise\) return this\.environmentRefreshPromise/);

// 9) La ruta de release debe conservar las comprobaciones que evitan publicar
// un instalador sin pruebas, hashes o firmas. Estas guardas son estáticas y se
// ejecutan antes de volver a gastar tiempo en una compilación completa.
for (const script of ['dist:win', 'check:local', 'test:preventive', 'test:release-manifest', 'test:release-signature', 'test:release-ssh-signature']) {
    assert.match(pkgText, new RegExp(`"${script}"\\s*:`), `falta el script preventivo ${script}`);
}
assert.match(windowsBuild, /WTerminal-Unpacked-\$version/);
assert.match(windowsBuild, /WTerminal-\$version\$zipSuffix-x64-setup\.exe/);
assert.match(windowsBuild, /SHA256SUMS\.txt\.sig/);
assert.match(windowsBuild, /SHA256SUMS\.txt\.sshsig/);
assert.match(windowsBuild, /NSudoLC\.exe/);

console.log('Tests preventivos OK: builder, release, catálogo, LTools, modo limpio, scroll horizontal, edición, taxonomía y maximizado.');
