// Comprueba el ejecutor de suites E2E sin lanzar la aplicación: catálogo,
// niveles de validación, argumentos, resumen y la comparación de binarios
// de la prueba del instalador.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { planSuites, SUITES, VALIDATION_LEVELS } from '../tests/e2e/suites.mjs';
import { scenarioSummaryLine } from '../tests/e2e/run-scenario.mjs';
import { formatSummaryMarkdown, parseSuiteArgs } from './run-e2e-suite.mjs';
import { compareInstalledBinary, installerIntegrity } from './test-installer.mjs';
import { describeWindowsPathChange } from '../tests/e2e/windows-path-guard.mjs';

const smoke = await readFile('tests/e2e/smoke.mjs', 'utf8');

// Catálogo: identificadores únicos y cada variable E2E_* existe en el smoke.
const everyScenario = planSuites(Object.keys(SUITES).filter((name) => name !== 'installer'));
assert.equal(new Set(everyScenario.map((item) => `${item.suite}/${item.id}`)).size, everyScenario.length, 'identificadores de escenario repetidos');
for (const item of everyScenario) {
    assert(item.timeoutMs > 0, `${item.id} necesita un tiempo límite`);
    for (const key of Object.keys(item.env)) {
        assert(smoke.includes(key), `${item.id}: el smoke no reconoce ${key}`);
    }
}
// Los clics localizan y pulsan por selector con reintento ante «stale element
// reference»: un clic sobre un nodo ya localizado falla si Svelte lo rehace.
assert(smoke.includes('async function clickWhenReady(') && !/await click\(await findWhenReady\(/u.test(smoke),
    'los clics del smoke deben usar clickWhenReady (reintento ante nodos rehechos)');
const focused = planSuites(['focused']);
for (const id of ['settings-footer', 'toolchain-store', 'path-integration', 'resize-type', 'queued-input', 'new-tab-echo-forced-race', 'tiny-grow', 'input-follow', 'long-input', 'scrollback-output', 'unsplit', 'tab-tools', 'command-marks', 'horizontal', 'ansi-styles', 'cursor', 'mouse-selection', 'unicode-widths', 'inline-images', 'shell-assist', 'ai-environments', 'ai-tui', 'ai-real', 'terminal-links', 'command-palette', 'admin-permissions', 'banner-image', 'context-menu-edit', 'github-account', 'settings-search']) {
    assert(focused.some((item) => item.id === id), `la suite focused debe incluir ${id}`);
}
assert.equal(focused.filter((item) => item.scenario === 'new-tab-echo').length, 3, 'la primera orden en pestañas nuevas se repite tres veces');
assert.throws(() => planSuites(['inexistente']), /Suite desconocida/u);

// Modo reducido: cambia cómo se graba la auditoría, no lo que comprueba, y deja
// el modo largo tal cual. Sus variables también tienen que existir en el smoke.
const [longAudit] = planSuites(['dependency-audit']);
const [quickAudit] = planSuites(['dependency-audit'], { quick: true });
assert.equal(longAudit.env.E2E_DEPENDENCY_FIRST_PASS_COUNT_ONLY, undefined, 'el modo largo recorre las dos pasadas');
assert.equal(quickAudit.env.E2E_DEPENDENCY_FIRST_PASS_COUNT_ONLY, '1');
assert.equal(quickAudit.env.E2E_DEPENDENCY_AUDIT_ONLY, '1', 'el bloque reducido se suma al escenario, no lo sustituye');
assert(quickAudit.timeoutMs < longAudit.timeoutMs, 'el modo reducido tiene su propio límite');
for (const key of Object.keys(quickAudit.env)) assert(smoke.includes(key), `dependency-audit: el smoke no reconoce ${key}`);
assert.deepEqual(planSuites(['focused'], { quick: true }).map((item) => item.id), focused.map((item) => item.id), 'el modo reducido no quita regresiones enfocadas');
const distribution = planSuites(['distribution']);
assert(distribution.length > 0 && distribution.reduce((total, item) => total + item.timeoutMs, 0) <= 30 * 60_000, 'distribution es una prueba corta');
assert(distribution.some((item) => item.env.E2E_CAPTURE_VIDEO === '1'), 'cada forma de distribución deja su vídeo');
assert(!VALIDATION_LEVELS.quick.includes('video'), 'el recorrido con vídeo del modo reducido lo graba el build sobre la carpeta');

// Niveles: solo suites existentes; la validación de release lo cubre todo.
for (const [level, names] of Object.entries(VALIDATION_LEVELS)) {
    for (const name of names) assert(SUITES[name], `${level} usa la suite inexistente ${name}`);
}
for (const name of ['focused', 'video', 'downloads', 'dependency-audit', 'installer']) {
    assert(VALIDATION_LEVELS.release.includes(name), `la validación de release debe incluir ${name}`);
}

// Argumentos.
assert.deepEqual(parseSuiteArgs(['--binary', 'x.exe']).suites, ['focused']);
assert.deepEqual(parseSuiteArgs(['--only', 'appearance,shell-assist']).only, ['appearance', 'shell-assist']);
assert.throws(() => parseSuiteArgs(['--only', 'no-existe']), /Escenarios desconocidos/u);
assert.deepEqual(parseSuiteArgs(['--level', 'release']).suites, VALIDATION_LEVELS.release);
assert.equal(parseSuiteArgs(['--level', 'release']).quick, false);
assert.deepEqual(parseSuiteArgs(['--level', 'quick']).suites, VALIDATION_LEVELS.quick);
assert.equal(parseSuiteArgs(['--level', 'quick']).quick, true);
assert.equal(parseSuiteArgs(['--suite', 'dependency-audit', '--quick']).quick, true);
assert.deepEqual(parseSuiteArgs(['--suite', 'focused,video', '--suite', 'video']).suites, ['focused', 'video']);
assert.throws(() => parseSuiteArgs(['--suite', 'nada']), /Suite desconocida/u);
assert.throws(() => parseSuiteArgs(['--binary']), /Falta el valor/u);
assert.throws(() => parseSuiteArgs(['--opcion-rara']), /Opción desconocida/u);
assert.equal(parseSuiteArgs(['--help']).help, true);

// Línea de resumen de cada escenario.
assert.equal(scenarioSummaryLine('E2E fase: x\nE2E log OK: sesión\nE2E OK: ventana (10 ms).\n'), 'E2E OK: ventana (10 ms).');
assert.equal(scenarioSummaryLine('E2E OK: algo\nError: se rompió\n    at x'), 'Error: se rompió');

// Resumen en Markdown.
const markdown = formatSummaryMarkdown({
    binary: 'release/WTerminal-1.0.0/wterminal.exe',
    suites: ['focused'],
    startedAt: '2026-10-18T00:00:00.000Z',
    durationMs: 125_000,
    status: 'failed',
    counts: { passed: 1, failed: 1, skipped: 0 },
    warnings: ['Equipo cargado'],
    results: [
        { suite: 'focused', title: 'Uno', status: 'passed', durationMs: 5000, summary: 'E2E OK' },
        { suite: 'focused', title: 'Dos', status: 'failed', durationMs: 65_000, summary: 'Error: a | b' },
    ],
});
assert(markdown.includes('**CON FALLOS**') && markdown.includes('2 min 5 s') && markdown.includes('| focused | Dos | FALLO | 1 min 5 s | Error: a \\| b |'));
assert(markdown.includes('- Equipo cargado'));

// Prueba del instalador: solo puede cambiar la marca de tipo de paquete.
const marker = Buffer.from('xx__TAURI_BUNDLE_TYPE_VAR_UNKyy');
const nsis = Buffer.from('xx__TAURI_BUNDLE_TYPE_VAR_NSSyy');
assert.equal(compareInstalledBinary(nsis, marker).identical, true);
assert.deepEqual(compareInstalledBinary(nsis, marker).bundleMarker, { release: 'UNK', installed: 'NSS' });
assert.equal(compareInstalledBinary(Buffer.from('zx__TAURI_BUNDLE_TYPE_VAR_NSSyy'), marker).identical, false);
assert.equal(compareInstalledBinary(Buffer.from('xx'), marker).identical, false);
// Caso real: una constante «…_NSS» precede a la variable que se parchea.
const realRelease = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS__TAURI_BUNDLE_TYPE_VAR_UNKtext/css');
const realInstalled = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS__TAURI_BUNDLE_TYPE_VAR_NSStext/css');
assert.equal(compareInstalledBinary(realInstalled, realRelease).identical, true);
assert.deepEqual(compareInstalledBinary(realInstalled, realRelease).bundleMarker, { release: 'UNK', installed: 'NSS' });

// Antes de instalar, la huella del instalador debe coincidir con SHA256SUMS.txt
// (un apagado dejó su final a ceros y NSIS solo devolvía «código 2»).
const setup = Buffer.from('instalador de prueba');
const setupHash = createHash('sha256').update(setup).digest('hex');
assert.equal(installerIntegrity(setup, 'WTerminal-1.0.0-x64-setup.exe', undefined), null, 'sin manifiesto no se exige huella');
assert.deepEqual(installerIntegrity(setup, 'WTerminal-1.0.0-x64-setup.exe', `${setupHash}  WTerminal-1.0.0-x64-setup.exe\n`), { ok: true });
assert.deepEqual(installerIntegrity(setup, 'WTerminal-1.0.0-x64-setup.exe', `${setupHash.toUpperCase()} *WTerminal-1.0.0-x64-setup.exe\r\n`), { ok: true });
const damaged = Buffer.concat([setup.subarray(0, 10), Buffer.alloc(setup.length - 10)]);
assert.match(installerIntegrity(damaged, 'WTerminal-1.0.0-x64-setup.exe', `${setupHash}  WTerminal-1.0.0-x64-setup.exe`).message, /está dañado/u);
assert.match(installerIntegrity(setup, 'WTerminal-1.0.0-x64-setup.exe', '\0'.repeat(286)).message, /no tiene la huella/u);

// El aviso «el PATH cambió» dice qué cambió.
const pathBefore = { path: 'C:\\a;C:\\b', kind: 'ExpandString', stateExists: false, state: [], variables: [] };
assert.equal(describeWindowsPathChange(pathBefore, { ...pathBefore }), 'sin diferencias visibles');
assert.equal(describeWindowsPathChange(pathBefore, { ...pathBefore, path: 'C:\\a;C:\\c' }), 'añadidas: C:\\c; quitadas: C:\\b');
assert.match(describeWindowsPathChange(pathBefore, { ...pathBefore, kind: 'String' }), /tipo ExpandString → String/u);
assert.match(describeWindowsPathChange(pathBefore, { ...pathBefore, stateExists: true, state: [{ name: 'x' }] }), /^integración:/u);
assert.match(describeWindowsPathChange({ ...pathBefore, variables: [{ name: 'x' }] }, pathBefore), /^variables:/u);

console.log(`Suites E2E verificadas: ${Object.keys(SUITES).length} suites, ${everyScenario.length} escenarios y niveles ${Object.keys(VALIDATION_LEVELS).join('/')}.`);
