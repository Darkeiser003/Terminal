import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (file) => readFileSync(resolve(root, file), 'utf8');

const backend = read('src-tauri/src/packages/ltools.rs');
const api = read('src/lib/api.ts');
const panel = read('src/components/ScriptsPanel.svelte');
const catalog = JSON.parse(read('src-tauri/config/project-catalog.json'));

assert.match(backend, /ltools-actions-v1/);
assert.match(backend, /\["actions", "list", "--format", "json"\]/);
assert.match(backend, /action\.executable/);
assert.match(backend, /action\.args/);
assert.match(backend, /action\.shell == "none"/);
assert.match(backend, /requirements_available/);
assert.match(backend, /quick: bool/);
assert.match(backend, /optional_safe_text/);
assert.match(backend, /short_label/);
assert.match(backend, /quote_for_shell/);
assert.match(backend, /descarta_acciones_que_podrian_inyectar_otra_shell/);
assert.match(backend, /LTOOLS_PATH/);
assert.match(backend, /discovery_directories/);
assert.match(backend, /is_supported_filename/);
assert.match(backend, /-linux-/);
assert.match(backend, /appimage/);

assert.match(api, /ltools_actions_list/);
assert.match(api, /ltools_action_run/);
assert.match(panel, /lterminal\.ltools\.quick-actions\.v1/);
assert.match(panel, /loadLToolsSelection/);
assert.match(panel, /if \(selectedLToolsIds\.length > 0\) saveLToolsSelection\(\)/);
assert.match(panel, /runLToolsAction/);
assert.match(panel, /Obtener LTools/);
assert.match(panel, /installLTools/);
assert.match(panel, /ltoolsReleaseAsset/);
assert.match(panel, /requirementsAvailable/);
assert.match(panel, /MAX_PINNED_LTOOLS_ACTIONS/);
assert.match(panel, /action\.quick/);
assert.match(panel, /data-testid="scripts-ltools-action"/);
assert.match(panel, /data-testid="scripts-ltools-run"/);
assert.ok(catalog.repositories.includes('Darkeiser003/Tools'));

const liveE2e = read('scripts/test-ltools-e2e.mjs');
const smokeE2e = read('tests/e2e/smoke.mjs');
const reportVerifier = read('scripts/verify-e2e-report.mjs');
assert.match(liveE2e, /E2E_LTOOLS_ONLY/);
assert.match(liveE2e, /E2E_LTOOLS_INTEGRATION/);
assert.match(smokeE2e, /executionCompleted/);
assert.match(smokeE2e, /resultPromptVisible/);
assert.match(smokeE2e, /selectionStorageVerified/);
assert.match(reportVerifier, /ltools-catalog-integration/);

// Permite probar el CLI real sin convertirlo en una dependencia obligatoria
// del checkout. Las builds/CI pueden pasar LTOOLS_TEST_BINARY; el check local
// sigue siendo reproducible cuando LTools aún no está instalado.
const liveBinary = process.env.LTOOLS_TEST_BINARY;
if (liveBinary && existsSync(liveBinary)) {
    const liveEnvironment = {
        ...process.env,
        // La release Linux se distribuye como AppImage. En hosts de auditoría
        // mínimos puede no estar cargado FUSE; el modo oficial de AppImage
        // conserva la misma aplicación y evita confundir ese detalle del host
        // con un fallo del contrato LTools.
        ...(liveBinary.toLowerCase().endsWith('.appimage')
            ? { APPIMAGE_EXTRACT_AND_RUN: '1' }
            : {}),
    };
    const result = spawnSync(liveBinary, ['actions', 'list', '--format', 'json'], {
        encoding: 'utf8',
        timeout: 7000,
        env: liveEnvironment,
    });
    assert.equal(result.status, 0, result.stderr || 'El CLI de LTools terminó con error.');
    const live = JSON.parse(result.stdout);
    assert.equal(live.schema, 'ltools-actions-v1');
    assert.ok(Array.isArray(live.actions) && live.actions.length > 0);
    assert.ok(live.actions.some((action) => action.target === 'none'));
    assert.ok(live.actions.every((action) => typeof action.id === 'string' && Array.isArray(action.args)));
    console.log(`CLI LTools real verificado: ${live.actions.length} acciones publicadas.`);
}

console.log('Contrato LTools verificado: catálogo, selección, validación, ejecución visible y proyecto oficial.');
