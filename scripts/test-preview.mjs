#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const [main, preview, buildPreview, previewServer, vite, packageJson, menuSh, menuPs1] = await Promise.all([
    readFile(resolve(root, 'src/main.ts'), 'utf8'),
    readFile(resolve(root, 'src/PreviewApp.svelte'), 'utf8'),
    readFile(resolve(root, 'scripts/build-preview.mjs'), 'utf8'),
    readFile(resolve(root, 'scripts/preview.mjs'), 'utf8'),
    readFile(resolve(root, 'vite.config.ts'), 'utf8'),
    readFile(resolve(root, 'package.json'), 'utf8'),
    readFile(resolve(root, 'build-tools/build.sh'), 'utf8'),
    readFile(resolve(root, 'build-tools/build.ps1'), 'utf8'),
]);
const packageData = JSON.parse(packageJson);

assert.match(main, /VITE_LTERMINAL_PREVIEW/);
assert.match(main, /PreviewApp/);
assert.match(preview, /backend simulado/);
assert.match(preview, /update/);
assert.match(preview, /upgrade/);
assert.match(preview, /aria-label="Comando de preview"/);
assert.match(buildPreview, /VITE_LTERMINAL_PREVIEW: '1'/);
assert.match(buildPreview, /VITE_OUT_DIR: 'dist-preview'/);
assert.match(previewServer, /dist-preview\/index\.html/);
assert.match(vite, /process\.env\.VITE_OUT_DIR \|\| 'dist'/);
assert.equal(packageData.scripts['build:preview'], 'node scripts/build-preview.mjs');
assert.equal(packageData.scripts.preview, 'node scripts/preview.mjs');
for (const menu of [menuSh, menuPs1]) {
    assert.match(menu, /preview web funcional/);
    assert.match(menu, /sin pruebas ampliadas/);
    assert.match(menu, /build:preview/);
}
console.log('OK: preview web aislado, build selectiva y menú de pruebas verificados.');
