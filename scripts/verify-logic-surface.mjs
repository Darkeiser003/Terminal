import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const failures = [];
const checks = [];

function check(name, condition) {
    checks.push(name);
    if (!condition) failures.push(name);
}

const app = read('src/App.svelte');
const settings = read('src/components/SettingsPanel.svelte');
const dependencies = read('src/components/DependenciesPanel.svelte');
const smoke = read('tests/e2e/smoke.mjs');
const windowsBuild = read('windows/build.ps1');
const actions = read('src-tauri/src/packages/actions.rs');
const testSurface = read('scripts/verify-test-surface.mjs');
const spanish = JSON.parse(read('src-tauri/locales/es.json'));
const baseConfig = JSON.parse(read('src-tauri/tauri.conf.json'));

// Un fallback de app.t() también es texto visible: si se cambia el catálogo y
// se olvida el fallback, una instalación sin el idioma activo vuelve a mostrar
// una frase antigua. Este caso concreto protege además contra la terminología
// de Docker que ya se eliminó de la interfaz.
const dockerHint = settings.match(/app\.t\(\s*["']settings\.autoDockerHint["']\s*,\s*["']([^"']+)["']/);
check('El fallback visible de Docker coincide con el catálogo español', dockerHint && dockerHint[1] === spanish['settings.autoDockerHint']);
check('La interfaz de Ajustes no vuelve a mostrar daemon', !/daemon/i.test(settings));
check('Las descripciones del banner pasan por el catálogo de idioma', settings.includes('bannerDescription(item)') && !settings.includes('<small>{item.description}</small>'));

// Una sugerencia de herramienta no debe ejecutar una instalación desde la
// barra de error: debe llevar al catálogo visible, que es el único sitio donde
// se puede explicar el origen, los permisos y los fallbacks disponibles.
const suggestionStart = app.indexOf('<div class="suggestion"');
const suggestionEnd = app.indexOf('</div>', suggestionStart);
const suggestion = suggestionStart >= 0 && suggestionEnd > suggestionStart
    ? app.slice(suggestionStart, suggestionEnd + 6)
    : '';
check('La sugerencia de herramienta siempre ofrece abrir Dependencias', suggestion.includes('panels.show("deps")') && suggestion.includes('loadDeps()'));
check('La sugerencia no ejecuta una instalación directa', !suggestion.includes('runInstallAction') && !suggestion.includes('runInstallBulk'));
check('La etiqueta de sugerencia rellena sus placeholders', suggestion.includes('.replace("{tool}", suggestion.label)') && suggestion.includes('.replace("{app}", suggestion.label)'));

// La detección rápida y la completa son estados distintos. Si se vuelve a
// cargar todo antes de pintar el inventario o se habilita un lote durante la
// sustitución, reaparece el salto engañoso de contadores y los clics pierden su
// elemento WebDriver.
check('Dependencias pinta la detección rápida antes de refrescar', dependencies.includes('const list = await api.listInstallActions()') && dependencies.includes('actions = list.actions') && dependencies.includes('await refresh()'));
check('Dependencias no habilita lotes hasta terminar la detección', dependencies.includes('detectionReady = ok') && dependencies.includes('!detectionReady || bulkInstallCount') && dependencies.includes('!detectionReady || bulkUninstallCount'));
check('Dependencias conserva la lista visible si falla el refresco', dependencies.includes('La instantánea rápida no se considera') && dependencies.includes('actions = list.actions'));
check('El contador no usa el número bruto de acciones internas', dependencies.includes('visibleComponentCount') && !dependencies.includes('count={actions.length}'));

// El E2E debe seguir el contrato de la plataforma. Un nombre de grupo escrito
// literalmente puede hacer fallar Windows después de una corrección válida de
// catálogo, que es exactamente el tipo de regresión que esta regla evita.
check('El E2E no fija el grupo de dependencias a una sola plataforma', smoke.includes('nativeWindows') && smoke.includes('platformGroupPattern'));
check('El E2E escribe informe y valida log en rutas separadas', smoke.includes('smokeReport.status') && smoke.includes('finally') && smoke.includes('assertCurrentLog'));

// Una sonda opcional no puede ocultar un E2E, y un informe E2E no debe terminar
// mezclado con la release ni depender de /tmp cuando la build es Windows.
const e2eIndex = windowsBuild.indexOf("Write-Step 'E2E ampliado");
const strictIndex = windowsBuild.indexOf('if ($strictProbeFailure)');
check('Windows ejecuta E2E antes de fallar por sondas estrictas', e2eIndex >= 0 && strictIndex > e2eIndex);
check('Windows fija el log del smoke al directorio de la release', windowsBuild.includes('$env:LTERMINAL_LOG_FILE = $logPath') && windowsBuild.includes('-WorkingDirectory $distDir'));
check('Windows fija una ruta propia para el informe E2E', windowsBuild.includes('$env:LTERMINAL_SMOKE_REPORT') && windowsBuild.includes('winslim-terminal-e2e-'));
check('Windows no da por pasado un E2E sin informe y log validados', windowsBuild.includes('Assert-E2eReport') && windowsBuild.includes("$report.status -ne 'passed'") && windowsBuild.includes('$report.logValidated -ne $true'));
check('La orden de release Windows solicita pruebas ampliadas', read('package.json').includes('dist:win') && read('package.json').includes('-FullTests') && read('package.json').includes('-InstallE2eDriver'));

// La copia de recursos se deriva del manifiesto, no de una lista paralela que
// pueda quedarse atrás cuando se añade un script integrado.
const resources = Object.keys(baseConfig.bundle?.resources ?? {});
check('El manifiesto declara recursos integrados', resources.length > 0);
check('Windows copia los recursos declarados por el manifiesto', windowsBuild.includes('$resourceMap') && windowsBuild.includes('Copy-Item $source $destination') && windowsBuild.includes('$resourceCount'));
check('La suite de superficie protege esta auditoría lógica', read('package.json').includes('check:logic') && testSurface.includes('verify-logic-surface.mjs'));

// La separación de categorías no debe volver a depender de una etiqueta de
// presentación: el grupo de Windows nativo tiene una constante propia y el
// test Rust cubre los IDs sensibles.
check('Windows separa virtualización de compatibilidad Linux', actions.includes('VIRTUALIZATION_GROUP') && actions.includes('la_virtualizacion_nativa_de_windows_no_se_presenta_como_compatibilidad'));
check('Windows ofrece AutoHotkey para desarrollar scripts AHK', actions.includes('AutoHotkey.AutoHotkey') && actions.includes('winget-autohotkey') && actions.includes('autohotkey_ofrece_instalador_y_deteccion_fuera_del_path'));
check('Windows amplía lenguajes mediante WinGet, MSYS2 y GHCup', actions.includes('HaxeFoundation.Haxe') && actions.includes('MSYS2_PACKAGES') && actions.includes('bootstrap-haskell.ps1') && actions.includes('windows_reincorpora_lenguajes_con_fuente_nativa_o_toolchain_real'));

if (failures.length) {
    console.error(`Superficie lógica con fallos (${failures.length}/${checks.length}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Superficie lógica verificada (${checks.length} comprobaciones).`);
