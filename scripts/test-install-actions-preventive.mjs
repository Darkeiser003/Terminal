#!/usr/bin/env node
/**
 * Guardas preventivas para el catálogo de acciones y la última release.
 *
 * No compila, no instala paquetes y no abre WTerminal. Revisa el contrato
 * que debe seguir cumpliendo el catálogo antes de que una futura edición
 * vuelva a ocultar categorías, rompa una acción o publique artefactos sin
 * validar.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative) => readFile(join(root, relative), 'utf8');
const releaseRoot = process.env.LTERMINAL_RELEASE_DIR
    ? resolve(root, process.env.LTERMINAL_RELEASE_DIR)
    : join(root, 'release');

const [pkgText, actions, dependencies, settingsPanel, smoke, reportValidator, surface, buildScript, windowsProbe] = await Promise.all([
    read('package.json'),
    read('src-tauri/src/packages/actions.rs'),
    read('src/components/DependenciesPanel.svelte'),
    read('src/components/SettingsPanel.svelte'),
    read('tests/e2e/smoke.mjs'),
    read('scripts/verify-e2e-report.mjs'),
    read('scripts/verify-test-surface.mjs'),
    read('windows/build.ps1'),
    read('scripts/probe-windows-tools.ps1'),
]);
const pkg = JSON.parse(pkgText);

function check(condition, message) {
    assert.ok(condition, message);
}

// Catálogo: todas las plataformas pasan por el mismo ensamblador, con orden
// estable y una taxonomía explícita. El recuento evita que desaparezca por
// accidente una familia entera de instaladores al editar actions.rs.
const expectedGroups = [
    'Actualizaciones',
    'Shells',
    'Sistema y herramientas',
    'Lenguajes',
    'Frameworks',
    'Visores de archivos',
    'Virtualización',
    'Compatibilidad Windows',
    'WSL',
    'Contenedores y Kubernetes',
    'Android · ADB',
    'Red y acceso remoto',
];
for (const group of expectedGroups) check(actions.includes(`"${group}"`), `falta el grupo ${group}`);
check(actions.includes('"windows" => windows_actions'), 'falta el catálogo Windows');
check(actions.includes('"macos" => mac_actions'), 'falta el catálogo macOS');
check(actions.includes('linux_actions('), 'falta el catálogo Linux');
check(/\.map\(default_group\)\s*\.map\(describe_action\)/.test(actions), 'las acciones no pasan por normalización');
check(actions.includes('sort_by_group('), 'las acciones no pasan por orden estable');
check((actions.match(/InstallAction::new\(/g) ?? []).length >= 100, 'el catálogo de acciones parece truncado');
check(!/InstallAction::new\(\s*["']vmware-/i.test(actions), 'VMware no debe volver al catálogo Windows');
check(actions.includes('const PAKET_COMMAND: &str = "dotnet tool install --global paket --version 9.0.2"'), 'Paket debe fijar una versión compatible');
check(actions.includes('fn windows_virtualization_actions'), 'falta el bloque de virtualización Windows');
check(actions.includes('fn windows_msys2_toolchain_actions'), 'falta el bloque MSYS2');
check(actions.includes('fn windows_haskell_actions'), 'falta el bloque GHCup/Haskell');

// UI: las categorías padre no pueden desaparecer cuando queda una sola
// acción, y Docker/ADB deben compartir el grupo visual de plataformas.
check(/id:\s*'platforms',\s*keys:\s*\['group\.containers',\s*'group\.android'/s.test(dependencies), 'Docker y ADB no comparten sección de plataformas');
check(dependencies.includes('isSubgroup'), 'falta la marca de subgrupo');
check(dependencies.includes('subgroupItem'), 'falta el segundo nivel de frameworks');
check(dependencies.includes('dependency-detection-placeholder'), 'el panel puede mostrar secciones antes de confirmar la detección completa');
check(dependencies.includes('Comprobando todas las secciones antes de mostrarlas'), 'falta el estado visible de detección atómica');
check(dependencies.includes('actions = list.actions'), 'el catálogo no se publica tras la confirmación de la detección');
check(settingsPanel.includes('pathCommandLabel'), 'la etiqueta del comando PATH no normaliza la extensión del ejecutable');
check(actions.includes('pub subgroup_item: Option<String>'), 'el catálogo no declara el framework hijo');
check(actions.includes('.subgroup_item(item)'), 'las acciones de frameworks no conservan su categoría hija');
check(dependencies.includes('{#if !entry.isSubgroup}'), 'una categoría padre se ocultaría al tener una sola acción');
check(smoke.includes('framework-paket'), 'E2E no protege la acción Paket');
check(smoke.includes('Dependencias mostró grupos antes de terminar'), 'E2E no protege el menú atómico durante la detección');
check(smoke.includes('La etiqueta del comando PATH no es portable'), 'E2E no protege la etiqueta PATH sin .exe');
check(smoke.includes('framework-parent-categories'), 'E2E no protege las categorías padre de frameworks');
check(smoke.includes('data-subgroup-level="child"'), 'E2E no protege las categorías hijas de frameworks');
check(smoke.includes('E2E_FRAMEWORK_CATEGORIES_ONLY'), 'falta el E2E enfocado de categorías de frameworks');
check(smoke.includes('exerciseHorizontalSequenceIntegrity'), 'E2E no protege la secuencia horizontal');
check(smoke.includes('bottomBarOverlap'), 'E2E no protege el solapamiento inferior del modo limpio');
check(smoke.includes('sandbox'), 'E2E no protege Windows Sandbox');

// La batería preventiva debe seguir siendo parte de check: no basta con que
// exista un archivo que nadie ejecute.
for (const name of ['test:install-actions-preventive', 'test:preventive', 'test:e2e-report', 'test:release-manifest', 'test:release-signature', 'test:release-ssh-signature']) {
    check(typeof pkg.scripts?.[name] === 'string', `falta el script ${name}`);
}
check(pkg.scripts.check.includes('test:install-actions-preventive'), 'npm check no ejecuta el test preventivo del catálogo');
check(surface.includes('test-install-actions-preventive.mjs'), 'la superficie de tests no registra el test preventivo del catálogo');
check(buildScript.includes('SHA256SUMS.txt.sig') && buildScript.includes('SHA256SUMS.txt.sshsig'), 'la release no conserva las dos firmas');
check(windowsProbe.includes("C:\\WSCore\\Components\\Hooks\\NSudo\\NSudoLC.exe"), 'la sonda Windows no busca NSudo en su ruta fija');
check((windowsProbe.match(/@\{\s*Name\s*=/g) ?? []).length === 54, 'la sonda Windows no cubre las 54 herramientas del builder');

// Validación del informe E2E más reciente. El chequeo previo a la compilación
// no puede exigirlo porque el informe lo genera el E2E de la release recién
// construida. En ese punto se valida todo con WTERMINAL_REQUIRE_E2E_REPORT=1;
// fuera de una build, la ausencia se informa como validación diferida en vez
// de convertir un checkout limpio en un falso fallo.
const requireE2eReport = process.env.WTERMINAL_REQUIRE_E2E_REPORT === '1';
const temp = process.env.TEMP ?? process.env.TMP ?? '';
const candidates = process.env.WTERMINAL_E2E_REPORT
    ? [process.env.WTERMINAL_E2E_REPORT]
    : temp
        ? (await readdir(temp))
            .filter((name) => /^(?:wterminal-e2e|lterminal-smoke-e2e)-.*\.json$/i.test(name))
            .map((name) => join(temp, name))
        : [];
// Sin ningún candidato (checkout limpio o TEMP vaciado) se aplica la misma
// regla que sin informe completo: solo falla cuando la build lo exige.
if (requireE2eReport) check(candidates.length > 0, 'no existe un informe E2E para validar');
const reports = [];
for (const file of candidates) {
    try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        const info = await stat(file);
        reports.push({ file, report: parsed, mtime: info.mtimeMs });
    } catch {
        // Un informe truncado o de una ejecución abortada no puede validar una
        // release; se conserva el resto de candidatos para elegir el completo.
    }
}
const completeReports = reports.filter(({ report }) =>
    report.status === 'passed'
    && report.logValidated === true
    && Array.isArray(report.events)
    && report.events.length >= 250
    && Array.isArray(report.phases)
    && report.phases.length >= 18,
);
// Un informe anterior puede seguir teniendo estado `passed` pero apuntar a
// capturas temporales que ya fueron limpiadas. No debe bloquear una build
// nueva antes de que su propio E2E genere el informe; solo se conserva como
// candidato si todas sus capturas declaradas siguen siendo legibles.
const completeReportsWithCaptures = [];
for (const candidate of completeReports) {
    let capturesPresent = Array.isArray(candidate.report.captures)
        && candidate.report.captures.length >= 40;
    if (capturesPresent) {
        for (const capture of candidate.report.captures) {
            try {
                const info = await stat(capture.path);
                if (!info.isFile() || info.size <= 100) {
                    capturesPresent = false;
                    break;
                }
            } catch {
                capturesPresent = false;
                break;
            }
        }
    }
    if (capturesPresent) completeReportsWithCaptures.push(candidate);
}
if (completeReportsWithCaptures.length === 0) {
    if (requireE2eReport) {
        check(false, 'no existe un informe E2E completo para validar');
    }
    console.log('Tests preventivos de acciones OK: catálogo y contratos verificados; la validación E2E queda diferida hasta compilar la release.');
    process.exit(0);
}
const reportPath = completeReportsWithCaptures
    .sort((a, b) => b.mtime - a.mtime)[0]
    .file;
const report = reports.find(({ file }) => file === reportPath).report;
check(report.status === 'passed', `el informe E2E no está aprobado: ${report.status}`);
check(report.logValidated === true, 'el informe E2E no valida el log');
check(Array.isArray(report.events) && report.events.length >= 250, 'el informe E2E tiene muy pocos eventos');
check(Array.isArray(report.phases) && report.phases.length >= 18, 'faltan fases E2E');
const requiredPhases = ['arranque de interfaz', 'redimensionado nativo multiplataforma', 'cambio de shell', 'ajustes', 'entorno y dependencias', 'acordeones y listas', 'pestañas, división y redimensionado'];
for (const phase of requiredPhases) check(report.phases.some((item) => item.name === phase), `falta la fase E2E ${phase}`);
const failures = (report.events ?? []).filter((event) => event.passed === false);
for (const failure of failures) {
    check(failure.skipped === true && typeof failure.reason === 'string' && failure.reason.length > 0,
        `evento E2E fallido sin justificación: ${failure.type ?? failure.name ?? 'desconocido'}`);
}
const intentionalColonSkip = failures.find((event) => event.type === 'internal-configuration-commands');
if (intentionalColonSkip) check(intentionalColonSkip.reason.includes('parser queda cubierto por tests unitarios'), 'el skip del parser interno no está documentado');

// Cada captura declarada debe seguir existiendo y tener contenido. Esto
// detecta rutas rotas, capturas vacías y reportes incompletos sin abrir el UI.
check(Array.isArray(report.captures) && report.captures.length >= 40, 'faltan capturas E2E');
for (const capture of report.captures) {
    check(typeof capture.label === 'string' && capture.label.length > 0, 'captura E2E sin etiqueta');
    check(typeof capture.path === 'string' && capture.path.length > 0, `captura ${capture.label} sin ruta`);
    const info = await stat(capture.path);
    check(info.isFile() && info.size > 100, `captura E2E vacía o inexistente: ${capture.path}`);
}

// Artefactos publicados: comprueba hashes y presencia de las firmas sin
// volver a ejecutar el builder. Solo en la validación final: en los checks
// iniciales la carpeta release es la de la build anterior (quizá a medias,
// por ejemplo sin firma SSH porque faltaba la clave) y esta misma build la
// regenera; validarla ahí bloqueaba la build con un estado caducado.
if (!requireE2eReport) {
    console.log(`Tests preventivos de acciones OK: catálogo, contratos e informe E2E (${report.events.length} eventos, ${report.captures.length} capturas) verificados; la release se valida en la comprobación final.`);
    process.exit(0);
}
const sumsPath = join(releaseRoot, 'SHA256SUMS.txt');
check(await stat(sumsPath).then((info) => info.isFile()).catch(() => false), 'falta SHA256SUMS.txt');
const sums = (await readFile(sumsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
// El build indica qué artefactos publicó (ZIP y, según la build, portable de un solo .exe
// e instalador). Sin esa lista, una release completa tiene al menos dos.
const expectedArtifacts = (process.env.WTERMINAL_EXPECTED_RELEASE_ARTIFACTS ?? '').split(';').map((name) => name.trim()).filter(Boolean);
if (expectedArtifacts.length) {
    for (const name of expectedArtifacts) {
        check(sums.some((line) => line.match(/^[a-f0-9]{64}\s+(.+)$/i)?.[1].trim() === name), `SHA256SUMS.txt no incluye ${name}`);
    }
} else {
    check(sums.length >= 2, 'el manifiesto de hashes está incompleto');
}
for (const line of sums) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    check(match, `línea inválida en SHA256SUMS.txt: ${line}`);
    const file = join(releaseRoot, match[2]);
    const data = await readFile(file).catch(() => null);
    check(data !== null, `falta el artefacto publicado ${match[2]}`);
    const hash = createHash('sha256').update(data).digest('hex');
    check(hash.toLowerCase() === match[1].toLowerCase(), `hash incorrecto para ${match[2]}`);
}
for (const signature of ['SHA256SUMS.txt.sig', 'SHA256SUMS.txt.sshsig']) {
    const info = await stat(join(releaseRoot, signature)).catch(() => null);
    check(info !== null && info.size > 32, `firma ausente o vacía: ${signature}`);
}

console.log(`Tests preventivos de acciones y release OK: ${report.events.length} eventos, ${report.captures.length} capturas, ${sums.length} artefactos con hash, ${failures.length} omisiones documentadas.`);
