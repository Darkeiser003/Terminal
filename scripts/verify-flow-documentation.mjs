#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Contrato documental ejecutable. No intenta demostrar el comportamiento por
// sí solo: comprueba que la documentación sigue apuntando a los puntos de
// entrada reales y que el orden delicado del arranque, IPC y actualización no
// desaparece durante una refactorización.
const root = process.cwd();
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const failures = [];
const checks = [];
const readme = read('README.md');
const readmeNormalized = readme.replace(/\s+/g, ' ');
const hasReadme = (marker) => readmeNormalized.includes(marker.replace(/\s+/g, ' '));

function check(name, condition) {
    checks.push(name);
    if (!condition) failures.push(name);
}

function position(source, marker) {
    return source.indexOf(marker);
}

const lib = read('src-tauri/src/lib.rs');
const api = read('src/lib/api.ts');
const tabs = read('src-tauri/src/terminal/tabs.rs');
const update = read('src-tauri/src/updater/commands.rs');
const security = read('src-tauri/src/updater/security.rs');
const updateUi = read('src/App.svelte');
const packageUpdates = read('src-tauri/src/updater/package_updates.rs');
const e2e = read('tests/e2e/smoke.mjs');

check('La documentación técnica vive en README', ['## Arquitectura', '## Contrato IPC', '## Seguridad', '## Pruebas'].every(hasReadme));
check('README documenta el arranque y el ciclo PTY', ['orden de arranque', 'ciclo de vida de una pestaña', 'primera PTY'].every(hasReadme));
check('README documenta las capas y dominios del proyecto', ['src-tauri/src/', 'src/', 'scripts/', 'terminal/', 'updater/'].every(hasReadme));
check('README documenta Linux/Wine/Windows', ['Linux', 'Wine', 'Windows'].every(hasReadme));
check('README documenta la matriz de pruebas y la evidencia', ['trece fases', 'capturas', 'informe JSON'].every(hasReadme));
check('README documenta alcance, evidencia y límites', ['Auditoría de release y comportamiento observable', 'límites de confianza', 'no se declara aprobado'].every(hasReadme));

for (const marker of ['migrate_local_data', 'frontend_ready', 'tabs.shutdown', 'generate_handler!']) {
    check(`El arranque real conserva ${marker}`, lib.includes(marker));
}
for (const marker of ['tauriInvoke', "listen<", "checkForUpdateOnStartup", "onData"]) {
    check(`El puente frontend conserva ${marker}`, api.includes(marker));
}
for (const marker of ['spawn_pty', 'pty-data', 'pty-exit', 'generation']) {
    check(`El ciclo PTY conserva ${marker}`, tabs.includes(marker));
}

const signatureAt = position(update, 'security::verify_signature');
const checksumAt = position(update, 'security::verify_checksum');
const treeAt = position(update, 'self_update::validate_payload_tree');
const applyAt = position(update, 'self_update::apply');
check('La actualización verifica firma antes del hash', signatureAt >= 0 && signatureAt < checksumAt);
check('La actualización verifica hash antes del árbol', checksumAt >= 0 && checksumAt < treeAt);
check('La actualización valida el árbol antes de aplicar', treeAt >= 0 && treeAt < applyAt);
check('El popup propio solo aparece después de autenticar manifiesto y SHA declarado', (() => {
    const checked = position(update, 'verified_release_manifest(&release)');
    const offered = position(update, 'status.available = true');
    return checked >= 0 && offered > checked
        && update.includes('stable_release_core(&release.tag).is_none()')
        && update.includes('asset_matches_release_version(&asset.name, &release.tag)');
})());
check('El aviso automático vuelve por IPC y no depende de un evento de arranque fugaz',
    update.includes('update_check_on_startup') && updateUi.includes('checkForUpdateOnStartup()')
        && !api.includes("'update-available'")
        && /status\.available\s*&&\s*status\.canSelfUpdate/.test(updateUi));
check('Las consultas de paquetes son solo lectura y tienen límite de tiempo',
    packageUpdates.includes('CHECK_TIMEOUT') && packageUpdates.includes('run_with_timeout_env')
        && packageUpdates.includes('query_command(manager)')
        && packageUpdates.includes('fn cada_sonda_usa_su_comando_de_consulta_permitido')
        && packageUpdates.includes('(\"apt\", \"apt-get\", &[\"-s\", \"upgrade\"])'));
check('El aviso de paquetes lleva al panel, no actualiza en segundo plano',
    updateUi.includes("panels.show('deps')") && updateUi.includes('checkPackageUpdatesOnStartup()'));
check('Los avisos de actualización se adaptan al ancho y no se pueden descartar durante la instalación',
    updateUi.includes('.update > span') && updateUi.includes('flex-wrap: wrap;')
        && updateUi.includes('disabled={updating} onclick={dismissUpdate}'));
check('La seguridad documenta Ed25519', security.includes('verify_signature') && readme.includes('Ed25519'));

for (const marker of ['captureScreenshot', 'smokeReport.captures', 'E2E_CAPTURE_DIR', 'verify-e2e-report']) {
    check(`El E2E conserva ${marker}`, e2e.includes(marker) || hasReadme(marker === 'verify-e2e-report' ? 'informe JSON' : marker));
}

if (failures.length) {
    console.error(`Documentación de flujo incompleta (${failures.length}/${checks.length} fallos):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Flujo documentado y anclado al código (${checks.length} comprobaciones).`);
