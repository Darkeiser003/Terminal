import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    environmentProbe,
    languageIdForEnvironment,
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

for (const id of ['fish', 'bash', 'zsh', 'sh', 'pwsh', 'powershell', 'cmd', 'gitbash', 'nu', 'xonsh', 'elvish', 'wine-cmd']) {
    assert.deepEqual(environmentProbe({ id }, 'LTERMINAL_SHELL_PROBE'), {
        kind: 'shell', language: null, command: 'echo LTERMINAL_SHELL_PROBE',
    }, `${id}: debe usar una sonda de shell inocua`);
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

console.log(`Sondas E2E verificadas: ${allLanguageIds.length} REPLs catalogados, shells inocuas y omisiones seguras.`);
