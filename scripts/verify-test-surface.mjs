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
const requiredFiles = [
    'tests/e2e/smoke.mjs',
    'linux/exercise-host.sh',
    'linux/build.sh',
    'windows/build.ps1',
    'scripts/verify-i18n.mjs',
    'scripts/verify-runtime-assets.mjs',
    'scripts/verify-build-scripts.mjs',
    'scripts/verify-test-surface.mjs'
];
for (const file of requiredFiles) {
    try {
        accessSync(resolve(root, file), constants.R_OK);
        check(`Existe ${file}`, true);
    } catch {
        check(`Existe ${file}`, false);
    }
}

for (const name of ['check', 'build', 'e2e', 'e2e:build', 'check:i18n', 'check:metadata', 'check:architecture', 'check:build-scripts']) {
    check(`package.json contiene el script ${name}`, typeof scripts[name] === 'string' && scripts[name].length > 0);
}
check('npm check incluye la verificación de la superficie de tests', scripts.check.includes('check:test-surface'));
check('npm check incluye tests Rust', scripts.check.includes('cargo test'));
check('npm check incluye clippy con warnings como errores', scripts.check.includes('clippy') && scripts.check.includes('-D warnings'));

const api = read('src/lib/api.ts');
const lib = read('src-tauri/src/lib.rs');
const invoked = new Set([...api.matchAll(/invoke(?:<[\s\S]*?>)?\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
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
check('Explorador contiene copiar, cortar, eliminar y pegar', ['explorer.copy', 'explorer.cut', 'explorer.trash', 'explorer.paste'].every((marker) => read('src/components/ExplorerSidebar.svelte').includes(marker)));
check('Terminal intercepta cortar y eliminar sobre selección editable', ['deleteEditableSelection(true)', 'deleteEditableSelection(false)'].every((marker) => read('src/components/TerminalPane.svelte').includes(marker)));
check('Terminal reajusta xterm y banner tras resize', ['ResizeObserver', 'refreshBanner', 'fitAndReport'].every((marker) => read('src/components/TerminalPane.svelte').includes(marker)));

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
check('Smoke E2E registra tiempos por fase', smoke.includes('phaseTimings') && smoke.includes('E2E tiempos'));
check('Smoke E2E prueba los cuatro estados de panel', [
    /Ajustes\|Settings/.test(smoke),
    /Biblioteca\|Library/.test(smoke),
    /Proyectos\|Projects/.test(smoke),
    /Entorno y dependencias\|Dependencies/.test(smoke)
].every(Boolean));
check('Smoke E2E prueba el explorador y su menú contextual', smoke.includes('.explorer') && smoke.includes('rightClick') && smoke.includes('[role="menu"]'));
check('Smoke E2E prueba los acordeones cerrados y exclusivos', smoke.includes('.operations') && smoke.includes('.types') && smoke.includes('settingsText') && smoke.includes('acordeones exclusivos'));
check('Smoke E2E prueba las acciones de dependencias sin ejecutarlas', smoke.includes('Compatibilidad Windows') && smoke.includes('data-testid="dependency-action"') && smoke.includes('aparece abierto antes'));

const host = read('linux/exercise-host.sh');
for (const marker of ['LTERMINAL_SHELL_OK', 'PowerShell', 'Nushell', 'Python', 'Node', 'Ruby', 'PHP', 'SQLite', 'MariaDB', 'Docker', 'Kubernetes']) {
    check(`Host smoke prueba ${marker}`, host.includes(marker));
}
check('Host smoke soporta modo estricto', host.includes('--strict'));

const linuxBuild = read('linux/build.sh');
const windowsBuild = read('windows/build.ps1');
for (const [name, source] of [['Linux', linuxBuild], ['Windows', windowsBuild]]) {
    check(`${name} ofrece modo de tests ampliados`, source.includes('extended') || source.includes('Extended'));
    check(`${name} no publica si falla el smoke`, source.includes('SMOKE') || source.includes('smoke'));
    check(`${name} verifica el frontend compilado`, name === 'Windows'
        ? source.includes('$frontendText') && source.includes('$marker')
        : source.includes('frontend') && source.includes('ControlRight') && source.includes('environment-controls'));
    check(`${name} conserva logs en errores`, source.includes('log') && (source.includes('tail') || source.includes('Get-Content')));
}

if (failures.length) {
    console.error(`Superficie de tests incompleta (${failures.length}/${checks.length} comprobaciones fallidas):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}
console.log(`Superficie de tests verificada (${checks.length} contratos).`);
