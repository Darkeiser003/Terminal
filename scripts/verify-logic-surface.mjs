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
const terminalPane = read('src/components/TerminalPane.svelte');
const api = read('src/lib/api.ts');
const appState = read('src/lib/appState.svelte.ts');
const keyedQueue = read('src/lib/keyed-serial-queue.ts');
const smoke = read('tests/e2e/smoke.mjs');
const commands = read('src-tauri/src/app/commands.rs');
const windowsBuild = read('windows/build.ps1');
const windowsBuildLower = windowsBuild.toLowerCase();
const actions = read('src-tauri/src/packages/actions.rs');
const testSurface = read('scripts/verify-test-surface.mjs');
const spanish = JSON.parse(read('src-tauri/locales/es.json'));
const baseConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const frontendReadyStart = commands.indexOf('pub fn frontend_ready(');
const frontendReadyEnd = commands.indexOf('\n/// Muestra la ventana cuando', frontendReadyStart);
const frontendReadyBlock = frontendReadyStart >= 0 && frontendReadyEnd > frontendReadyStart
    ? commands.slice(frontendReadyStart, frontendReadyEnd)
    : '';
const switchEnvironmentStart = appState.indexOf('switchEnvironment(tabId: string, envId: string): Promise<boolean> {');
const switchEnvironmentEnd = appState.indexOf('\n    async savePreferences(', switchEnvironmentStart);
const switchEnvironmentBlock = switchEnvironmentStart >= 0 && switchEnvironmentEnd > switchEnvironmentStart
    ? appState.slice(switchEnvironmentStart, switchEnvironmentEnd)
    : '';
const environmentSwitchStartedStart = terminalPane.indexOf('function onEnvironmentSwitchStarted(');
const environmentSwitchRequestedStart = terminalPane.indexOf('function onEnvironmentSwitchRequested(', environmentSwitchStartedStart);
const environmentSwitchStartedBlock = environmentSwitchStartedStart >= 0 && environmentSwitchRequestedStart > environmentSwitchStartedStart
    ? terminalPane.slice(environmentSwitchStartedStart, environmentSwitchRequestedStart)
    : '';

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
// cargar todo antes de pintar el inventario, reaparece el salto engañoso de
// contadores y los clics pierden su elemento WebDriver.
check('Dependencias pinta la detección rápida antes de refrescar', dependencies.includes('const list = await api.listInstallActions()') && dependencies.includes('actions = list.actions') && dependencies.includes('await refresh()'));
check('Dependencias conserva la lista visible si falla el refresco', dependencies.includes('actions = list.actions') && dependencies.includes('ok = false'));
check('Dependencias no expone instalación masiva en la build', !dependencies.includes('bulkRunning') && !dependencies.includes('runBulk') && !dependencies.includes('dependency-bulk-install') && !dependencies.includes('dependency-bulk-uninstall') && !dependencies.includes('bulk-actions'));
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
check('El smoke reintenta la espera asíncrona de una sesión PTY real', smoke.includes("'pty spawneado'") && commands.includes('return Ok(false)') && commands.includes('Result<bool, String>') && terminalPane.includes('waitForFrontendReady') && terminalPane.includes('retryUntilReady') && windowsBuild.includes('$attempt -lt 45') && windowsBuild.includes('Test-SmokeReady'));
check('El smoke exige la ventana principal y solo después registra éxito', frontendReadyBlock.includes('return Ok(false)') && frontendReadyBlock.includes('get_webview_window("main")') && frontendReadyBlock.includes('ok_or_else') && frontendReadyBlock.indexOf('.show()') >= 0 && frontendReadyBlock.indexOf('Frontend y terminal preparados') > frontendReadyBlock.indexOf('.show()') && api.includes("tauriInvoke<boolean>('frontend_ready'"));
const initialHandshakeStart = terminalPane.indexOf('void api.markTabReady(tabId)');
const initialHandshakeCatch = terminalPane.indexOf('.catch((error) => {', initialHandshakeStart);
const initialHandshakeCatchEnd = terminalPane.indexOf('\n            });', initialHandshakeCatch);
const initialHandshakeFailure = initialHandshakeStart >= 0 && initialHandshakeCatchEnd > initialHandshakeCatch
    ? terminalPane.slice(initialHandshakeCatch, initialHandshakeCatchEnd)
    : '';
check('La ventana aparece pronto y la entrada espera a la PTY inicial o nueva', terminalPane.indexOf('.then(() => api.revealWindow())') >= 0 && terminalPane.indexOf('.then(() => api.revealWindow())') < terminalPane.indexOf('.then(() => waitForFrontendReady())') && switchEnvironmentBlock.includes("switched ? 'winslim:environment-switch-requested' : 'winslim:environment-switch-cancelled'") && switchEnvironmentBlock.indexOf('await api.switchEnvironment') < switchEnvironmentBlock.indexOf('winslim:environment-switch-requested') && terminalPane.includes('waitForFrontendReady()\n            .then((ready) => {') && terminalPane.includes('scheduleInputReleaseFallback();') && !environmentSwitchStartedBlock.includes('setTimeout(') && environmentSwitchStartedBlock.includes('clearTimeout(initialPromptTimer)') && !initialHandshakeFailure.includes('releaseInput()'));
check('Un cambio de shell pendiente no libera teclas contra la sesión anterior y el rechazo la restaura', environmentSwitchStartedBlock.includes('environmentSwitchPending = true') && terminalPane.includes('!environmentSwitchPending && terminalStartupReady()') && terminalPane.includes("'winslim:environment-switch-cancelled', onEnvironmentSwitchCancelled") && terminalPane.includes('snapshot.queuedInput + typedWhilePending') && appState.includes("'winslim:environment-switch-cancelled'") && (terminalPane.match(/window\.addEventListener\('winslim:environment-switch-cancelled'/g) ?? []).length === 1 && (terminalPane.match(/window\.removeEventListener\('winslim:environment-switch-cancelled'/g) ?? []).length === 1);
check('Las respuestas atrasadas de cambios de shell no alteran el intento actual', appState.includes('private environmentSwitchRequest = 0') && appState.includes('const requestId = ++this.environmentSwitchRequest') && appState.includes('detail: { tabId, envId, requestId }') && terminalPane.includes('detail.requestId !== environmentSwitchRequestId') && terminalPane.includes('environmentSwitchRequestId = detail.requestId'));
check('Los cambios de shell se serializan por pestaña y preservan el orden de la PTY', appState.includes('createKeyedSerialQueue<string>()') && appState.includes('this.enqueueEnvironmentSwitch(tabId, () => this.performEnvironmentSwitch(tabId, envId))') && keyedQueue.includes('.catch(() => undefined)') && keyedQueue.includes('if (tails.get(key) === tail) tails.delete(key)'));
const failSwitchStart = terminalPane.indexOf('function failEnvironmentSwitch(');
const failSwitchEnd = terminalPane.indexOf('\n    function onEnvironmentSwitchRequested(', failSwitchStart);
const failSwitchBlock = failSwitchStart >= 0 && failSwitchEnd > failSwitchStart ? terminalPane.slice(failSwitchStart, failSwitchEnd) : '';
check('Los fallos o expiraciones de cambio limpian el estado pendiente', failSwitchBlock.includes('environmentSwitchPending = false') && failSwitchBlock.includes('environmentSwitchSnapshot = undefined') && failSwitchBlock.includes('queuedInput = \'\'') && terminalPane.includes('} else {\n                    failEnvironmentSwitch();\n                }') && terminalPane.includes('.catch((error) => {\n                if (detail.requestId === environmentSwitchRequestId) failEnvironmentSwitch(error);'));
check('Un rechazo de shell conserva inmediatamente una PTY previa ya lista', terminalPane.includes('if (snapshot?.inputReady)') && terminalPane.includes('environmentSwitchPending = false;\n            environmentSwitchRequestId = undefined;') && terminalPane.includes('releaseInput();\n            return;'));
check('El smoke de Windows cierra el PTY de forma ordenada', windowsBuild.includes('LTERMINAL_SMOKE_AUTO_EXIT') && commands.includes('smoke-graceful-exit') && windowsBuildLower.includes('se fuerza el cierre como último recurso'));
check('La orden de release Windows solicita pruebas ampliadas', read('package.json').includes('dist:win') && read('package.json').includes('-FullTests'));
check('Windows prepara automáticamente el driver que exige su E2E', windowsBuild.includes('se instalará automáticamente con cargo') && !windowsBuild.includes('-and $InstallE2eDriver -and'));
check('La división mínima valida geometría propia sin depender del compositor', smoke.includes('assertPaneGeometry') && smoke.includes('geometryValid: true') && !smoke.includes("'ampliación de la ventana al dividir'"));
check('El E2E identifica opciones del banner sin depender del idioma', settings.includes('settings-banner-${item.id}') && smoke.includes('settings-banner-cpu') && !smoke.includes('Ajustes no muestra la opción de CPU'));
check('Los informes de foco no rompen el siguiente comando interno', terminalPane.includes(".replaceAll('\\x1b[I', '')") && terminalPane.includes(".replaceAll('\\x1b[O', '')") && terminalPane.includes('if (!mirroredData)'));
check('CRLF cuenta como un solo Enter para comandos internos', terminalPane.includes("mirroredData.replaceAll('\\r\\n', '\\n')") && terminalPane.includes('terminators.length > 1'));

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
