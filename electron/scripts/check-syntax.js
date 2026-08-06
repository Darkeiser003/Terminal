// Comprueba la sintaxis de todas las fuentes JavaScript propias sin depender
// de un linter ni recorrer node_modules/dist.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ignored = new Set(['node_modules', 'dist']);
const files = [];

function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        // electron-builder puede usar salidas versionadas durante la
        // verificación (dist-verify, dist-1.1.0, etc.). Tampoco son fuentes
        // propias y pueden contener miles de JS de dependencias.
        if (ignored.has(entry.name) || (entry.isDirectory() && entry.name.startsWith('dist-'))) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
    });
}

walk(root);
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Sintaxis válida: ${files.length} archivos JavaScript.`);
