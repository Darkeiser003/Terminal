import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    environmentProbe,
    languageIdForEnvironment,
    probeOutputContainsMarker,
    probeOutputMarkerRows,
    safeEnvironmentMarker,
} from './e2e-environment-probes.mjs';

const languageSource = await readFile('src-tauri/src/environments/languages.rs', 'utf8');
const languageIds = [...languageSource.matchAll(/LanguageDef\s*\{\s*id:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
const technologyCatalog = JSON.parse(await readFile('src-tauri/config/technology-catalog.json', 'utf8'));
const allLanguageIds = [...new Set([...languageIds, ...technologyCatalog.map(({ id }) => id)])];
const explicitSafeServiceSkips = new Set([
    'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis',
    'sqlserver', 'oracle-sql', 'neo4j', 'cassandra',
]);

assert.equal(languageIdForEnvironment('lang:python'), 'python');
assert.equal(languageIdForEnvironment('plugin:lang:python'), 'python');
assert.equal(languageIdForEnvironment('wsl:Ubuntu:lang:python'), 'python');
assert.equal(languageIdForEnvironment('fish'), null);

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
assert.equal(allLanguageIds.length, 91, 'el test debe detectar nuevas altas en las fuentes de entornos');

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
    ['nsudo:admin', 'elevación'],
    ['adb:DEVICE-1', 'dispositivo real'],
    ['docker:container:1', 'contenedor externo'],
    ['lang:postgresql', 'servicio externo'],
    ['lang:future-repl', 'no hay una sonda'],
    ['future-environment', 'sin sonda'],
]) {
    const probe = environmentProbe({ id }, 'LTERMINAL_SAFE_SKIP');
    assert.equal(probe.kind, 'skip', `${id}: no se debe ejecutar automáticamente`);
    assert.match(probe.reason, new RegExp(reasonPart, 'i'), `${id}: omisión explicada`);
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
assert.deepEqual(probeOutputMarkerRows('echo LTERMINAL_PROBE\nLTERMINAL_PROBE', 'echo LTERMINAL_PROBE', 'LTERMINAL_PROBE').slice(-2), [
    { length: 20, containsMarker: true, commandEcho: true, markerAfterEchoRemoval: false },
    { length: 15, containsMarker: true, commandEcho: false, markerAfterEchoRemoval: true },
], 'el diagnóstico indica si la fila fue eco, salida exacta o texto mezclado sin exponerlo');
for (const [id, expected] of [
    ['java', 'System.out.println("LTERMINAL_PROBE");'],
    ['kotlin', 'println("LTERMINAL_PROBE")'],
    ['julia', 'println("LTERMINAL_PROBE")'],
    ['csharp', 'Console.WriteLine("LTERMINAL_PROBE");'],
    ['php', "echo 'LTERMINAL_PROBE' . PHP_EOL;"],
]) {
    assert.equal(environmentProbe({ id: `lang:${id}` }, 'LTERMINAL_PROBE').command, expected,
        `${id}: la sonda debe ser sintaxis válida y emitir una línea completa`);
}

console.log(`Sondas E2E verificadas: ${allLanguageIds.length} REPLs catalogados, shells inocuas y omisiones seguras.`);
