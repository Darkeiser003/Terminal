import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    environmentProbe,
    languageIdForEnvironment,
    parseWslDistroList,
    posixPrintfLinesScript,
    quotePosixShellArgument,
    probeOutputContainsMarker,
    probeOutputContainsExpectedText,
    probeOutputHasResultBeforeMarker,
    probeOutputMarkerRows,
    safeEnvironmentMarker,
    shouldUseWsl1X11Capture,
    wineProbeSkipReason,
} from './e2e-environment-probes.mjs';

const languageSource = await readFile('src-tauri/src/environments/languages.rs', 'utf8');
const smokeSource = await readFile('tests/e2e/smoke.mjs', 'utf8');
const languageIds = [...languageSource.matchAll(/LanguageDef\s*\{\s*id:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
const technologyCatalog = JSON.parse(await readFile('src-tauri/config/technology-catalog.json', 'utf8'));
const allLanguageIds = [...new Set([...languageIds, ...technologyCatalog.map(({ id }) => id)])];
const explicitSafeServiceSkips = new Set([
    'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis',
    'sqlserver', 'oracle-sql', 'neo4j', 'cassandra',
    'dart', 'swift', 'scala-cli', 'purescript',
]);

assert.equal(languageIdForEnvironment('lang:python'), 'python');
assert.equal(languageIdForEnvironment('plugin:lang:python'), 'python');
assert.equal(languageIdForEnvironment('wsl:Ubuntu:lang:python'), 'python');
assert.equal(languageIdForEnvironment('fish'), null);
assert.deepEqual(
    parseWslDistroList(Buffer.from('Ubuntu\r\narchlinux\r\ndocker-desktop\r\n\r\n', 'utf16le')),
    ['Ubuntu', 'archlinux'],
    'la salida UTF-16LE de WSL se analiza sin distros internas de Docker',
);
assert.deepEqual(parseWslDistroList('Ubuntu\nArch Linux\n'), ['Ubuntu', 'Arch Linux']);
assert.equal(quotePosixShellArgument("line with spaces and 'quotes'"), "'line with spaces and '\\''quotes'\\'''",
    'la sonda POSIX escapa argumentos sin perder espacios ni comillas');
assert.equal(posixPrintfLinesScript(['first line', "second 'line'"]), "printf '%s\\n' 'first line' 'second '\\''line'\\'''\n",
    'el fixture POSIX imprime todas las salidas por líneas sin concatenar comandos largos');
assert.equal(wineProbeSkipReason('linux', '4.4.0-26100-Microsoft').includes('WSL1'), true,
    'Wine se omite con una razón explícita en el kernel WSL1 sin mapeos de direcciones fijas');
assert.equal(wineProbeSkipReason('linux', '5.15.167.4-microsoft-standard-WSL2'), null,
    'la prueba de Wine se conserva en WSL2');
assert.equal(wineProbeSkipReason('linux', '6.14.0-arch1-1'), null,
    'la prueba de Wine se conserva en Linux nativo');
assert.equal(wineProbeSkipReason('win32', '10.0.26100-Microsoft'), null,
    'la prueba de Wine no afecta a las shells nativas de Windows');
assert.equal(shouldUseWsl1X11Capture('linux', '4.4.0-26100-Microsoft', ':99'), true,
    'la captura X11 nativa evita el cuelgue de WebKitWebDriver en WSL1/Xvfb');
assert.equal(shouldUseWsl1X11Capture('linux', '4.4.0-26100-Microsoft', ''), false,
    'sin DISPLAY no se intenta captura X11');
assert.equal(shouldUseWsl1X11Capture('linux', '4.4.0-26100-Microsoft', ':99', false), false,
    'sin ImageMagick el runner conserva la captura WebDriver');
assert.equal(shouldUseWsl1X11Capture('linux', '5.15.167.4-microsoft-standard-WSL2', ':0'), false,
    'WSL2 conserva las capturas del WebDriver');
assert.equal(shouldUseWsl1X11Capture('linux', '6.14.0-arch1-1', ':0'), false,
    'Linux nativo conserva las capturas del WebDriver');
assert.match(
    smokeSource,
    /const button = await findWhenReady\('\.env-select'\);\s*await waitUntil\(async \(\) => \(await attribute\([\s\S]*?'disabled',[\s\S]*?\) === null, \d+, 'inventario completo de shells, WSL y REPL'\);/,
    'la matriz E2E espera a que termine el inventario antes de recoger las opciones',
);
assert.match(smokeSource, /wsl-distro-selector-coverage/,
    'el E2E Windows informa y valida las distribuciones WSL instaladas');
assert.match(smokeSource, /async function dispatchTerminalWheel\(cell, deltaY, repeat = 1\)[\s\S]*?findAllWithin\(cell, '\.xterm-viewport'\)/,
    'el scroll vertical se origina en el viewport que escucha la rueda de xterm');
assert.match(smokeSource, /new WheelEvent\('wheel',[\s\S]*?deltaMode: WheelEvent\.DOM_DELTA_PIXEL/,
    'el E2E cubre WebKitWebDriver cuando acepta la rueda pero no la entrega a xterm');

const uncovered = [];
for (const id of allLanguageIds) {
    const marker = safeEnvironmentMarker(`lang:${id}`);
    const probe = environmentProbe({ id: `lang:${id}` }, marker);
    if (probe.kind === 'repl') {
        assert.equal(probe.language, id, `${id}: el sonda debe corresponder al REPL detectado`);
        assert.match(probe.command, new RegExp(marker), `${id}: el comando debe imprimir un marcador único`);
        assert.doesNotMatch(probe.command, /(?:sudo|docker|adb|rm\s+-rf)/i, `${id}: no debe ejecutar acciones externas`);
    } else if (probe.kind === 'skip') {
        assert.ok(probe.reason, `${id}: toda omisión debe explicar el motivo`);
        if (!explicitSafeServiceSkips.has(id) && id !== 'idris') uncovered.push(id);
    } else {
        assert.fail(`${id}: tipo de sonda inesperado ${probe.kind}`);
    }
}
assert.deepEqual(uncovered, [], 'cada REPL del catálogo debe tener una sonda o una omisión segura explícita');
assert.equal(allLanguageIds.length, 88, 'Kotlin y Mercury no se anuncian como REPL sin un intérprete interactivo válido');
assert.ok(!allLanguageIds.includes('kotlin'), 'Kotlin sigue disponible desde la shell, pero no como REPL que falla al arrancar');
assert.ok(!allLanguageIds.includes('mercury'), 'mmc es el compilador Mercury y en Windows colisiona con Microsoft Management Console; Mercury no ofrece aquí un REPL interactivo válido');
assert.deepEqual(environmentProbe({ id: 'lang:dart' }, 'LTERMINAL_DART_PROBE'), {
    kind: 'skip',
    language: 'dart',
    reason: 'el SDK de Dart es una CLI de proyectos y no ofrece un REPL interactivo',
}, 'Dart se conserva como herramienta, pero no se anuncia ni se prueba como REPL');
assert.deepEqual(environmentProbe({ id: 'lang:swift' }, 'LTERMINAL_SWIFT_PROBE'), {
    kind: 'skip',
    language: 'swift',
    reason: 'Swift para Windows se valida como compilador; su proceso sin argumentos no ofrece un REPL estable dentro de ConPTY',
}, 'Swift se conserva como compilador y no se fuerza un REPL inestable en ConPTY');
assert.deepEqual(environmentProbe({ id: 'lang:scala-cli' }, 'LTERMINAL_SCALA_CLI_PROBE'), {
    kind: 'skip',
    language: 'scala-cli',
    reason: 'Scala CLI necesita resolver artefactos Maven en el primer arranque y no ofrece una sonda interactiva determinista',
}, 'Scala CLI no debe bloquear la matriz por una resolución Maven externa');
assert.deepEqual(environmentProbe({ id: 'lang:purescript' }, 'LTERMINAL_PURESCRIPT_PROBE'), {
    kind: 'skip',
    language: 'purescript',
    reason: 'PureScript `purs repl` solo muestra ayuda; `pulp psci` requiere un proyecto Pulp y no es un REPL autónomo reproducible',
}, 'PureScript se conserva como herramienta, pero no se fuerza un REPL que termina inmediatamente');

for (const id of ['fish', 'bash', 'zsh', 'sh', 'pwsh', 'powershell', 'cmd', 'gitbash', 'wine-cmd']) {
    assert.deepEqual(environmentProbe({ id }, 'LTERMINAL_SHELL_PROBE'), {
        kind: 'shell', language: null, command: 'echo LTERMINAL_SHELL_PROBE',
    }, `${id}: debe usar una sonda de shell inocua`);
}
for (const id of ['nu', 'xonsh', 'elvish']) {
    assert.deepEqual(environmentProbe({ id }, 'LTERMINAL_SHELL_PROBE'), {
        kind: 'repl', language: id, command: 'echo LTERMINAL_SHELL_PROBE',
    }, `${id}: debe esperar el prompt de su REPL y no el banner POSIX`);
}
for (const [id, reasonPart] of [
    ['nsudo:cmd', 'runner E2E elevado'],
    ['nsudo:powershell', 'runner E2E elevado'],
    ['adb:DEVICE-1', 'dispositivo real'],
    ['docker:container:1', 'contenedor externo'],
    ['ai:claude', 'asistente de IA'],
    ['ai:ollama:qwen3.8:27b', 'modelo cargado'],
    ['lang:postgresql', 'servicio externo'],
    ['lang:future-repl', 'no hay una sonda'],
    ['future-environment', 'sin sonda'],
]) {
    const probe = environmentProbe({ id }, 'LTERMINAL_SAFE_SKIP');
    assert.equal(probe.kind, 'skip', `${id}: no se debe ejecutar automáticamente`);
    assert.match(probe.reason, new RegExp(reasonPart, 'i'), `${id}: omisión explicada`);
}
for (const [id, shellCommand] of [
    ['nsudo:cmd', (marker) => `whoami /user & echo ${marker}`],
    ['nsudo:powershell', (marker) => `whoami /user; echo ${marker}`],
]) {
    const marker = safeEnvironmentMarker(id);
    const probe = environmentProbe({ id }, marker, { allowNsudo: true });
    assert.equal(probe.kind, 'shell', `${id}: runner elevado ejecuta la shell TrustedInstaller`);
    assert.equal(probe.command, shellCommand(marker), `${id}: sonda inocua comprueba identidad y salida`);
    assert.equal(probe.expectedIdentity, 'TrustedInstaller');
}
assert.match(safeEnvironmentMarker('wsl:Ubuntu:lang:python'), /^LTERMINAL_ENV_WSL_UBUNTU_LANG_PYTHON$/);
assert.match(safeEnvironmentMarker('..\n'), /^LTERMINAL_ENV_UNKNOWN$/);
assert.equal(environmentProbe({ id: 'fish' }, 'bad marker').kind, 'skip');
assert.equal(probeOutputContainsMarker('echo LTERMINAL_PROBE\nLTERMINAL_PROBE', 'echo LTERMINAL_PROBE', 'LTERMINAL_PROBE'), true,
    'el eco del comando no oculta la línea de salida real');
assert.equal(probeOutputContainsMarker('~ ❯ echo LTERMINAL_PROBE LTERMINAL_PROBE ~ ❯', 'echo LTERMINAL_PROBE', 'LTERMINAL_PROBE'), true,
    'una respuesta WebDriver aplanada conserva la salida real tras quitar el eco completo');
assert.equal(probeOutputContainsMarker('echo LTERMINAL_PROBE', 'echo LTERMINAL_PROBE', 'LTERMINAL_PROBE'), false,
    'el eco de la orden no cuenta como ejecución');
assert.equal(probeOutputContainsMarker('System.out.println("LTERMINAL_PROBE");\nerror: malformed string', 'System.out.println("LTERMINAL_PROBE");', 'LTERMINAL_PROBE'), false,
    'el código repetido en un error de compilación no cuenta como salida');
assert.equal(probeOutputContainsMarker('System.out.println("LTERMINAL_PROBE"); error: System.out.println("LTERMINAL_PROBE"); malformed string', 'System.out.println("LTERMINAL_PROBE");', 'LTERMINAL_PROBE'), false,
    'el texto de compilación aplanado tampoco convierte el código repetido en salida');
assert.equal(probeOutputContainsMarker('trace: LTERMINAL_PROBE', 'builtins.trace "LTERMINAL_PROBE" null', 'LTERMINAL_PROBE'), true,
    'se admite el prefijo de salida trazada del REPL de Nix');
assert.equal(probeOutputContainsMarker('LTERMINAL_PROBE\u200b', 'echo LTERMINAL_PROBE', 'LTERMINAL_PROBE'), true,
    'los caracteres invisibles de las celdas xterm no impiden detectar la salida real');
assert.equal(probeOutputContainsMarker(['echo LTERMINAL_PROBE', 'LTERMINAL_PROBE'], 'echo LTERMINAL_PROBE', 'LTERMINAL_PROBE'), true,
    'las filas del DOM distinguen la salida del eco incluso cuando WebDriver aplana el texto total');
assert.equal(probeOutputContainsMarker(['echo LTERMINAL_PROBE'], 'echo LTERMINAL_PROBE', 'LTERMINAL_PROBE'), false,
    'una fila del DOM que solo contiene el eco no cuenta como salida');
assert.equal(probeOutputContainsExpectedText(
    ['whoami /user & echo marker', 'NT SERVICE\\TrustedInstaller  S-1-5-80-123', 'marker'],
    'whoami /user & echo marker', 'TrustedInstaller',
), true, 'la identidad debe venir de salida ejecutada y no del eco');
assert.equal(probeOutputContainsExpectedText(
    ['whoami /user & echo marker'], 'whoami /user & echo marker', 'TrustedInstaller',
), false, 'el eco no puede falsear la comprobación de identidad NSudo');
const flattenedKeyboardSafeOutput = '~❯ echo lterminal-width-reclaim-mu1smj8g-0lterminal-width-reclaim-mu1smj8g-0~❯';
assert.equal(probeOutputContainsMarker(
    flattenedKeyboardSafeOutput,
    'echo lterminal-width-reclaim-mu1smj8g-0',
    'lterminal-width-reclaim-mu1smj8g-0',
), true, 'el eco aplanado distingue el comando de la salida con marcador compatible con el layout');
assert.deepEqual(probeOutputMarkerRows('echo LTERMINAL_PROBE\nLTERMINAL_PROBE', 'echo LTERMINAL_PROBE', 'LTERMINAL_PROBE').slice(-2), [
    { length: 20, containsMarker: true, commandEcho: true, markerAfterEchoRemoval: false },
    { length: 15, containsMarker: true, commandEcho: false, markerAfterEchoRemoval: true },
], 'el diagnóstico indica si la fila fue eco, salida exacta o texto mezclado sin exponerlo');
for (const [id, expected] of [
    ['node', "console['log']('LTERMINAL_PROBE')"],
    ['java', 'System.out.println("LTERMINAL_PROBE");'],
    ['julia', 'println("LTERMINAL_PROBE")'],
    ['crystal', 'puts "LTERMINAL_PROBE"'],
    ['csharp', 'Console.WriteLine("LTERMINAL_PROBE");'],
    ['php', "echo 'LTERMINAL_PROBE' . PHP_EOL;"],
]) {
    assert.equal(environmentProbe({ id: `lang:${id}` }, 'LTERMINAL_PROBE').command, expected,
        `${id}: la sonda debe ser sintaxis válida y emitir una línea completa`);
}
assert.deepEqual(environmentProbe({ id: 'lang:forth' }, 'LTERMINAL_FORTH_PROBE'), {
    kind: 'repl',
    language: 'forth',
    command: '1 2 + . cr ." LTERMINAL_FORTH_PROBE" cr',
    expectedResultBeforeMarker: '3',
}, 'la sonda Forth debe comprobar cálculo real además de emitir su marcador');
assert.equal(probeOutputHasResultBeforeMarker(
    ['1 2 + . cr ." LTERMINAL_FORTH_PROBE" cr', '3', 'LTERMINAL_FORTH_PROBE'],
    '1 2 + . cr ." LTERMINAL_FORTH_PROBE" cr',
    '3',
    'LTERMINAL_FORTH_PROBE',
), true, 'el REPL Forth debe mostrar el resultado de la suma antes del marcador');
assert.equal(probeOutputHasResultBeforeMarker(
    ['1 2 + . cr ." LTERMINAL_FORTH_PROBE" cr', 'LTERMINAL_FORTH_PROBE'],
    '1 2 + . cr ." LTERMINAL_FORTH_PROBE" cr',
    '3',
    'LTERMINAL_FORTH_PROBE',
), false, 'el eco y el marcador no sustituyen la ejecución aritmética');

console.log(`Sondas E2E verificadas: ${allLanguageIds.length} REPLs catalogados, shell inocuas y omisiones seguras.`);
