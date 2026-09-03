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
const e2e = read('tests/e2e/smoke.mjs');

check('La documentación técnica vive en README', ['## Arquitectura', '## Contrato IPC', '## Seguridad', '## Pruebas'].every(hasReadme));
check('README documenta el arranque y el ciclo PTY', ['orden de arranque', 'ciclo de vida de una pestaña', 'primera PTY'].every(hasReadme));
check('README documenta las capas y dominios del proyecto', ['src-tauri/src/', 'src/', 'scripts/', 'terminal/', 'updater/'].every(hasReadme));
check('README documenta Linux/Wine/Windows', ['Linux', 'Wine', 'Windows'].every(hasReadme));
check('README documenta la matriz de pruebas y la evidencia', ['once fases', 'capturas', 'informe JSON'].every(hasReadme));
check('README documenta alcance, evidencia y límites', ['Auditoría de release y comportamiento observable', 'límites de confianza', 'no se declara aprobado'].every(hasReadme));

for (const marker of ['migrate_local_data', 'frontend_ready', 'tabs.shutdown', 'generate_handler!']) {
    check(`El arranque real conserva ${marker}`, lib.includes(marker));
}
for (const marker of ['tauriInvoke', "listen<", "onUpdateAvailable", "onData"]) {
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
check('La seguridad documenta Ed25519', security.includes('verify_signature') && readme.includes('Ed25519'));

for (const marker of ['captureScreenshot', 'smokeReport.captures', 'E2E_CAPTURE_DIR', 'verify-e2e-report']) {
    check(`El E2E conserva ${marker}`, e2e.includes(marker) || hasReadme(marker === 'verify-e2e-report' ? 'informe JSON' : marker));
}

for (const filename of [
    '01-arranque-banner.png',
    '02-dependencias-contraidas.png',
    '03-dependencias-desplegadas.png',
    '04-cuatro-paneles.png',
    '05-responsive.png',
    '06-fastfetch-final.png',
]) {
    const imagePath = resolve(root, 'docs/evidence', filename);
    let isPng = false;
    try {
        const bytes = readFileSync(imagePath);
        isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } catch {
        isPng = false;
    }
    check(`La evidencia visual es PNG válido: ${filename}`, isPng);
}

if (failures.length) {
    console.error(`Documentación de flujo incompleta (${failures.length}/${checks.length} fallos):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Flujo documentado y anclado al código (${checks.length} comprobaciones).`);
